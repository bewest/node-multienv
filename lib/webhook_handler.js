const templates = require('./templates/index');
const createStoragePhaseHandler = require('./webhook/tenant-phases/storage');
const createMigrationPhaseHandler = require('./webhook/tenant-phases/migration');
const createResourcesPhaseHandler = require('./webhook/tenant-phases/resources');

function createWebhookHandler(k8s, namespace, config = {}) {
  const handleStoragePhase = createStoragePhaseHandler(config);
  const handleMigrationPhase = createMigrationPhaseHandler(config);
  const handleResourcesPhase = createResourcesPhaseHandler(config);
  return {
    handleSync: function(parent, children = {}) {
      if (!parent.metadata || !parent.metadata.name) {
        throw new Error('Parent resource must have metadata.name');
      }

      const response = {
        status: {
          observedGeneration: parent.metadata.generation || 0,
          phase: parent.status?.phase || 'Pending',
          ready: false
        },
        children: []
      };

      switch(response.status.phase) {
        case 'Pending':
          handleStoragePhase(parent, children, response);
          break;

        case 'StorageProvisioning':
          if (children.Job?.find(j => j.metadata.labels.purpose === 'storage-init')?.status?.succeeded) {
            handleMigrationPhase(parent, children, response);
          }
          break;

        case 'Migrating':
          if (children.Job?.find(j => j.metadata.labels.purpose === 'migration')?.status?.succeeded) {
            handleResourcesPhase(parent, children, response);
          }
          break;

        case 'Ready':
          response.status.ready = true;
          handleResourcesPhase(parent, children, response);
          break;
      }

      return response;
    }
  };
}

module.exports = createWebhookHandler;