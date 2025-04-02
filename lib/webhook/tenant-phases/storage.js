
const templates = require('../../templates');

function handleStoragePhase(parent, children, response) {
  if (parent.spec.parameters.needsProvisioning) {
    response.children.push(
      templates.template_init_storage_job(
        { WEB_NAME: parent.metadata.name },
        process.env.MONGODB_ROOT_URI,
        `http://deployment-controller:3000/storage/initialized/${parent.metadata.name}`
      )
    );
    response.status.phase = 'StorageProvisioning';
  }
}

module.exports = handleStoragePhase;
