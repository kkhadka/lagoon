// @flow

const R = require('ramda');
const keycloakClient = require('../../clients/keycloakClient');
const kibanaClient = require('../../clients/kibanaClient');
const searchguardClient = require('../../clients/searchguardClient');
const sqlClient = require('../../clients/sqlClient');
const logger = require('../../logger');
const {
  ifNotAdmin,
  inClauseOr,
  prepare,
  query,
  whereAnd,
  isPatchEmpty,
} = require('../../util/db');

const { getCustomerById } = require('../customer/helpers');

const Helpers = require('./helpers');
const KeycloakOperations = require('./keycloak');
const Sql = require('./sql');

/* ::

import type {ResolversObj} from '../';

*/

const getAllProjects = async (
  root,
  args,
  {
    credentials: {
      role,
      permissions: { customers, projects },
    },
  },
) => {
  // We need one "WHERE" keyword, but we have multiple optional conditions
  const where = whereAnd([
    args.createdAfter ? 'created >= :created_after' : '',
    args.gitUrl ? 'git_url = :git_url' : '',
    ifNotAdmin(
      role,
      `(${inClauseOr([['customer', customers], ['project.id', projects]])})`,
    ),
  ]);

  const prep = prepare(sqlClient, `SELECT * FROM project ${where}`);
  const rows = await query(sqlClient, prep(args));

  return rows;
};

const getProjectByEnvironmentId = async (
  { id: eid },
  args,
  {
    credentials: {
      role,
      permissions: { customers, projects },
    },
  },
) => {
  const prep = prepare(
    sqlClient,
    `SELECT
        p.*
      FROM environment e
      JOIN project p ON e.project = p.id
      WHERE e.id = :eid
      ${ifNotAdmin(
    role,
    `AND (${inClauseOr([['p.customer', customers], ['p.id', projects]])})`,
  )}
      LIMIT 1
    `,
  );

  const rows = await query(sqlClient, prep({ eid }));

  return rows ? rows[0] : null;
};

const getProjectByGitUrl = async (
  root,
  args,
  {
    credentials: {
      role,
      permissions: { customers, projects },
    },
  },
) => {
  const str = `
      SELECT
        *
      FROM project
      WHERE git_url = :git_url
      ${ifNotAdmin(
    role,
    `AND (${inClauseOr([
      ['customer', customers],
      ['project.id', projects],
    ])})`,
  )}
      LIMIT 1
    `;

  const prep = prepare(sqlClient, str);
  const rows = await query(sqlClient, prep(args));

  return rows ? rows[0] : null;
};

const getProjectByName = async (
  root,
  args,
  {
    credentials: {
      role,
      permissions: { customers, projects },
    },
  },
) => {
  const str = `
      SELECT
        *
      FROM project
      WHERE name = :name
      ${ifNotAdmin(
    role,
    `AND (${inClauseOr([
      ['customer', customers],
      ['project.id', projects],
    ])})`,
  )}
    `;

  const prep = prepare(sqlClient, str);

  const rows = await query(sqlClient, prep(args));
  return rows[0];
};

const addProject = async (
  root,
  { input },
  {
    credentials: {
      role,
      permissions: { customers },
    },
  },
) => {
  const cid = input.customer.toString();

  if (role !== 'admin' && !R.contains(cid, customers)) {
    throw new Error('Project creation unauthorized.');
  }

  const prep = prepare(
    sqlClient,
    `CALL CreateProject(
        :id,
        :name,
        :customer,
        :git_url,
        ${input.subfolder ? ':subfolder' : 'NULL'},
        :openshift,
        ${
  input.openshiftProjectPattern ? ':openshift_project_pattern' : 'NULL'
},
        ${
  input.activeSystemsDeploy
    ? ':active_systems_deploy'
    : '"lagoon_openshiftBuildDeploy"'
},
        ${
  input.activeSystemsPromote
    ? ':active_systems_promote'
    : '"lagoon_openshiftBuildDeploy"'
},
        ${
  input.activeSystemsRemove
    ? ':active_systems_remove'
    : '"lagoon_openshiftRemove"'
},
        ${input.branches ? ':branches' : '"true"'},
        ${input.pullrequests ? ':pullrequests' : '"true"'},
        ${input.productionEnvironment ? ':production_environment' : 'NULL'},
        ${input.autoIdle ? ':auto_idle' : '1'},
        ${input.storageCalc ? ':storage_calc' : '1'},
        ${
  input.developmentEnvironmentsLimit
    ? ':development_environments_limit'
    : '5'
}
      );
    `,
  );

  console.log(`CALL CreateProject(
    :id,
    :name,
    :customer,
    :git_url,
    ${input.subfolder ? ':subfolder' : 'NULL'},
    :openshift,
    ${input.openshiftProjectPattern ? ':openshift_project_pattern' : 'NULL'},
    ${
  input.activeSystemsDeploy
    ? ':active_systems_deploy'
    : '"lagoon_openshiftBuildDeploy"'
},
    ${
  input.activeSystemsPromote
    ? ':active_systems_promote'
    : '"lagoon_openshiftBuildDeploy"'
},
    ${
  input.activeSystemsRemove
    ? ':active_systems_remove'
    : '"lagoon_openshiftRemove"'
},
    ${input.branches ? ':branches' : '"true"'},
    ${input.pullrequests ? ':pullrequests' : '"true"'},
    ${input.productionEnvironment ? ':production_environment' : 'NULL'},
    ${input.autoIdle ? ':auto_idle' : '1'},
    ${input.storageCalc ? ':storage_calc' : '1'},
    ${
  input.developmentEnvironmentsLimit
    ? ':development_environments_limit'
    : '5'
}

  );
`);

  const rows = await query(sqlClient, prep(input));
  const project = R.path([0, 0], rows);

  try {
    // Create a group in Keycloak named the same as the project
    const name = R.prop('name', project);
    await keycloakClient.groups.create({
      name,
    });
    logger.debug(`Created Keycloak group with name "${name}"`);
  } catch (err) {
    if (err.response.status === 409) {
      logger.warn(
        `Failed to create already existing Keycloak group "${R.prop(
          'name',
          project,
        )}"`,
      );
    } else {
      logger.error(`SearchGuard create role error: ${err}`);
      throw new Error(`SearchGuard create role error: ${err}`);
    }
  }

  const customer = await getCustomerById(project.customer);

  try {
    // Create a new SearchGuard Role for this project with the same name as the Project
    await searchguardClient.put(`roles/${project.name}`, {
      body: {
        indices: {
          [`*-${project.name}-*`]: {
            '*': ['READ'],
          },
        },
        tenants: {
          [customer.name]: 'RW',
        },
      },
    });
  } catch (err) {
    logger.error(`SearchGuard create role error: ${err}`);
    throw new Error(`SearchGuard create role error: ${err}`);
  }

  // Create index-patterns for this project
  for (const log of [
    'application-logs',
    'router-logs',
    'container-logs',
    'lagoon-logs',
  ]) {
    try {
      await kibanaClient.post(
        `saved_objects/index-pattern/${log}-${project.name}-*`,
        {
          body: {
            attributes: {
              title: `${log}-${project.name}-*`,
              timeFieldName: '@timestamp',
            },
          },
          headers: {
            sgtenant: customer.name,
          },
        },
      );
    } catch (err) {
      // 409 Errors are expected and mean that there is already an index-pattern with that name defined, we ignore them
      if (err.statusCode !== 409) {
        logger.error(
          `Kibana Error during setup of index pattern ${log}-${
            project.name
          }-*: ${err}`,
        );
        // Don't fail if we have Kibana Errors, as they are "non-critical"
      }
    }
  }

  try {
    const currentSettings = await kibanaClient.get('kibana/settings', {
      headers: {
        sgtenant: customer.name,
      },
    });

    // Define a default Index if there is none yet
    if (!currentSettings.body.settings.defaultIndex) {
      await kibanaClient.post('kibana/settings', {
        body: {
          changes: {
            defaultIndex: `container-logs-${project.name}-*`,
            'telemetry:optIn': false, // also opt out of telemetry from xpack
          },
        },
        headers: {
          sgtenant: customer.name,
        },
      });
    }
  } catch (err) {
    logger.error(`Kibana Error during config of default Index: ${err}`);
    // Don't fail if we have Kibana Errors, as they are "non-critical"
  }

  return project;
};

const deleteProject = async (
  root,
  { input: { project } },
  {
    credentials: {
      role,
      permissions: { projects },
    },
  },
) => {
  // Will throw on invalid conditions
  const pid = await Helpers.getProjectIdByName(project);

  if (role !== 'admin') {
    if (!R.contains(pid, projects)) {
      throw new Error('Unauthorized.');
    }
  }

  const prep = prepare(sqlClient, 'CALL DeleteProject(:project)');
  await query(sqlClient, prep({ project }));

  await KeycloakOperations.deleteGroup(project);

  try {
    // Delete SearchGuard Role for this project with the same name as the Project
    await searchguardClient.delete(`roles/${project}`);
  } catch (err) {
    logger.error(`SearchGuard delete role error: ${err}`);
    throw new Error(`SearchGuard delete role error: ${err}`);
  }
  // TODO: maybe check rows for changed result
  return 'success';
};

const updateProject = async (
  root,
  {
    input: {
      id,
      patch,
      patch: {
        name,
        customer,
        gitUrl,
        subfolder,
        activeSystemsDeploy,
        activeSystemsRemove,
        branches,
        productionEnvironment,
        autoIdle,
        storageCalc,
        pullrequests,
        openshift,
        openshiftProjectPattern,
        developmentEnvironmentsLimit,
      },
    },
  },
  {
    credentials: {
      role,
      permissions: { projects },
    },
  },
) => {
  if (role !== 'admin' && !R.contains(id.toString(), projects)) {
    throw new Error('Unauthorized');
  }

  if (isPatchEmpty({ patch })) {
    throw new Error('input.patch requires at least 1 attribute');
  }

  const originalProject = await Helpers.getProjectById(id);
  const originalName = R.prop('name', originalProject);
  const originalCustomer = parseInt(R.prop('customer', originalProject));

  // If the project will be updating the `name` or `customer` fields, update Keycloak groups and users accordingly
  if (typeof customer === 'number' && customer !== originalCustomer) {
    // Delete Keycloak users from original projects where given user ids do not have other access via `project_user` (projects where the user loses access if they lose customer access).
    await Helpers.mapIfNoDirectProjectAccess(
      id,
      originalCustomer,
      async ({
        keycloakUserId,
        keycloakUsername,
        keycloakGroupId,
        keycloakGroupName,
      }) => {
        await keycloakClient.users.delFromGroup({
          id: keycloakUserId,
          groupId: keycloakGroupId,
        });
        logger.debug(
          `Removed Keycloak user ${keycloakUsername} from group "${keycloakGroupName}"`,
        );
      },
    );
  }

  await query(
    sqlClient,
    Sql.updateProject({
      id,
      patch: {
        name,
        customer,
        gitUrl,
        subfolder,
        activeSystemsDeploy,
        activeSystemsRemove,
        branches,
        productionEnvironment,
        autoIdle,
        storageCalc,
        pullrequests,
        openshift,
        openshiftProjectPattern,
        developmentEnvironmentsLimit,
      },
    }),
  );

  if (typeof name === 'string' && name !== originalName) {
    const groupId = await KeycloakOperations.findGroupIdByName(originalName);

    await keycloakClient.groups.update({ id: groupId }, { name });
    logger.debug(
      `Renamed Keycloak group ${groupId} from "${originalName}" to "${name}"`,
    );
  }

  if (typeof customer === 'number' && customer !== originalCustomer) {
    // Add Keycloak users to new projects where given user ids do not have other access via `project_user` (projects where the user loses access if they lose customer access).
    await Helpers.mapIfNoDirectProjectAccess(
      id,
      customer,
      async ({
        keycloakUserId,
        keycloakUsername,
        keycloakGroupId,
        keycloakGroupName,
      }) => {
        await keycloakClient.users.addToGroup({
          id: keycloakUserId,
          groupId: keycloakGroupId,
        });
        logger.debug(
          `Added Keycloak user ${keycloakUsername} to group "${keycloakGroupName}"`,
        );
      },
    );
  }

  return Helpers.getProjectById(id);
};

const deleteAllProjects = async (root, args, { credentials: { role } }) => {
  if (role !== 'admin') {
    throw new Error('Unauthorized.');
  }

  const projectNames = await Helpers.getAllProjectNames();

  await query(sqlClient, Sql.truncateProject());

  for (const name of projectNames) {
    await KeycloakOperations.deleteGroup(name);
  }

  // TODO: Check rows for success
  return 'success';
};

const Resolvers /* : ResolversObj */ = {
  deleteProject,
  addProject,
  getProjectByName,
  getProjectByGitUrl,
  getProjectByEnvironmentId,
  getAllProjects,
  updateProject,
  deleteAllProjects,
};

module.exports = Resolvers;