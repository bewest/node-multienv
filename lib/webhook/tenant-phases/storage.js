
const templates = require('../../templates');

function createStoragePhaseHandler(config) {
  var image = config.tenant.storage_init_job_image;
  var init_command = config.tenant.storage_init_job_command;
  function template_init_storage_job (data, rootMongoUri, webhookUrl) {
    return ({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: `${data.WEB_NAME}-storage-init`,
        labels: {
          app: 'tenant',
          tenant: data.WEB_NAME,
          role: 'storage-init',
          phase: 'StorageProvisioning',
          component: 'storage'
        }
      },
      spec: {
        backoffLimit: 4,
        template: {
          spec: {
            containers: [{
              name: 'storage-init',
              image: image,
              command: [init_command],
              envFrom: [
                {
                  secretRef: {
                    name: data.seed_name
                  }
                }
              ],
              env: [
                {
                  name: 'MONGODB_ROOT_URI',
                  value: rootMongoUri
                },
                {
                  name: 'INITIALIZED_STORAGE_WEBHOOK',
                  value: webhookUrl
                },
                {
                  name: 'TENANT_ID',
                  value: data.WEB_NAME
                }
              ]
            }],
            restartPolicy: 'OnFailure'
          }
        }
      }
    });
  }

  return function handleStoragePhase(parent, children, related, response) {
    console.log("HANDLE STORAGE", parent);
    var seed_name = `${parent.spec.storageAccount}-secret`;
    var seed_secret = related['Secret.v1'][seed_name];
    console.log("HANDLE STORAGE SEED %j", seed_secret);
    response.children.push(
      template_init_storage_job(
        { WEB_NAME: parent.metadata.name, seed_name, seed_secret },
        config.MONGODB_ROOT_URI || process.env.MONGODB_ROOT_URI,
        `${config.CONTROLLER_URL || 'http://deployment-controller:3000'}/storage/initialized/${parent.metadata.name}`
      )
    );
    response.status.phase = 'StorageProvisioning';
  };
}

module.exports = createStoragePhaseHandler;
