

function createMigrationPhaseHandler(config) {
  var image = config.tenant.storage_migration_job_image;
  var init_command = config.tenant.storage_migration_job_command;

  function template_migration_job (data, newMongoUri, webhookUrl) {
    return ({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: `${data.WEB_NAME}-migration`,
        labels: {
          app: 'tenant',
          tenant: data.WEB_NAME,
          component: 'migration'
        }
      },
      spec: {
        backoffLimit: 4,
        template: {
          spec: {
            containers: [{
              name: 'migration',
              image: image,
              command: [init_command],
              env: [
                {
                  name: 'NEW_MONGO_URI',
                  value: newMongoUri
                },
                {
                  name: 'MIGRATED_DB_WEBHOOK',
                  value: webhookUrl
                }
              ]
            }],
            restartPolicy: 'OnFailure'
          }
        }
      }
    });
  }
  return function handleMigrationPhase(parent, children, response) {
    const data = { WEB_NAME: parent.metadata.name };
    const newMongoUri = `mongodb://${data.WEB_NAME}-mongodb:27017/${data.WEB_NAME}`;
    
    response.children.push(
      template_migration_job(
        data,
        newMongoUri,
        `${config.CONTROLLER_URL || 'http://deployment-controller:3000'}/migration/completed/${data.WEB_NAME}`
      )
    );
    response.status.phase = 'Migrating';
  };
}

module.exports = createMigrationPhaseHandler;
