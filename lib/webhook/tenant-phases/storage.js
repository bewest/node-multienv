
const templates = require('../../templates');

function createStoragePhaseHandler(config) {
  return function handleStoragePhase(parent, children, response) {
    response.children.push(
      templates.template_init_storage_job(
        { WEB_NAME: parent.metadata.name },
        config.MONGODB_ROOT_URI || process.env.MONGODB_ROOT_URI,
        `${config.CONTROLLER_URL || 'http://deployment-controller:3000'}/storage/initialized/${parent.metadata.name}`
      )
    );
    response.status.phase = 'StorageProvisioning';
  };
}

module.exports = createStoragePhaseHandler;
