
const templates = require('../../templates');

function createMigrationPhaseHandler(config) {
  return function handleMigrationPhase(parent, children, response) {
    if (parent.spec.parameters.migrateFrom) {
      const data = { WEB_NAME: parent.metadata.name };
      const newMongoUri = `mongodb://${data.WEB_NAME}-mongodb:27017/${data.WEB_NAME}`;
      
      response.children.push(
        templates.template_migration_job(
          data,
          parent.spec.parameters.migrateFrom,
          newMongoUri,
          `${config.CONTROLLER_URL || 'http://deployment-controller:3000'}/migration/completed/${data.WEB_NAME}`
        )
      );
      response.status.phase = 'Migrating';
    }
  };
}

module.exports = createMigrationPhaseHandler;
