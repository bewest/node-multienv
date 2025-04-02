
const templates = require('../templates');
const createStoragePhaseHandler = require('./tenant-phases/storage');
const createMigrationPhaseHandler = require('./tenant-phases/migration');
const createResourcesPhaseHandler = require('./tenant-phases/resources');

function createTenantWebhookHandler(k8s, namespace, config = {}) {
  const handleStoragePhase = createStoragePhaseHandler(config);
  const handleMigrationPhase = createMigrationPhaseHandler(config);
  const handleResourcesPhase = createResourcesPhaseHandler(config);

  function addCondition(response, type, status, reason, message) {
    response.status.conditions = response.status.conditions || [];
    response.status.conditions.push({
      type,
      status,
      reason,
      message,
      lastTransitionTime: new Date().toISOString()
    });
  }

  return {
    handleSync: function(parent, children = {}) {
      if (!parent.metadata || !parent.metadata.name) {
        throw new Error('Parent resource must have metadata.name');
      }

      const response = {
        status: {
          observedGeneration: parent.metadata.generation || 0,
          phase: parent.status?.phase || 'Pending',
          ready: false,
          conditions: parent.status?.conditions || []
        },
        children: []
      };

      try {
        switch(response.status.phase) {
          case 'Pending':
            handleStoragePhase(parent, children, response);
            addCondition(response, 'StorageInitiated', 'True', 'StorageRequested', 
              'Storage provisioning initiated');
            break;

          case 'StorageProvisioning': {
            const initJob = children.Job?.find(j => j.metadata.labels.purpose === 'storage-init');
            if (initJob?.status?.failed) {
              addCondition(response, 'StorageFailed', 'True', 'JobFailed',
                `Storage init job failed: ${initJob.status.message || 'Unknown error'}`);
              response.status.phase = 'Failed';
            } else if (initJob?.status?.succeeded) {
              handleMigrationPhase(parent, children, response);
              addCondition(response, 'StorageReady', 'True', 'StorageProvisioned',
                'Storage successfully provisioned');
            }
            break;
          }

          case 'Migrating': {
            const migrationJob = children.Job?.find(j => j.metadata.labels.purpose === 'migration');
            if (migrationJob?.status?.failed) {
              addCondition(response, 'MigrationFailed', 'True', 'JobFailed',
                `Migration job failed: ${migrationJob.status.message || 'Unknown error'}`);
              response.status.phase = 'Failed';
            } else if (migrationJob?.status?.succeeded) {
              handleResourcesPhase(parent, children, response);
              addCondition(response, 'MigrationComplete', 'True', 'MigrationSucceeded',
                'Data migration completed successfully');
            }
            break;
          }

          case 'Ready':
            response.status.ready = true;
            handleResourcesPhase(parent, children, response);
            addCondition(response, 'ResourcesReady', 'True', 'DeploymentComplete',
              'All resources successfully deployed');
            break;

          case 'Failed':
            // Keep failed state and conditions
            break;
        }
      } catch (error) {
        addCondition(response, 'Error', 'True', 'HandlerError',
          `Phase handler error: ${error.message}`);
        response.status.phase = 'Failed';
      }

      return response;
    }
  };
}

module.exports = createTenantWebhookHandler;
