const templates = require('../templates');
const storagePhase = require('./tenant-phases/storage');
const migrationPhase = require('./tenant-phases/migration');
const resourcePhase = require('./tenant-phases/resources');

function createTenantWebhookHandler(config) {
  const handleStoragePhase = storagePhase(config);
  const handleMigrationPhase = migrationPhase(config);
  const handleResourcePhase = resourcePhase(config);

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

  return function handleSync(request) {
    const { parent, children } = request;
    const response = { status: {}, children: [] };

    try {
      switch(parent.status?.phase || 'Initial') {
        case 'Initial':
          handleStoragePhase(parent, children, response);
          break;

        case 'StorageProvisioning':
          if (checkStorageReady(children)) {
            handleMigrationPhase(parent, children, response);
          } else if (checkStorageFailed(children)) {
            response.status = {
              phase: 'Failed',
              conditions: [{
                type: 'StorageReady',
                status: 'False',
                reason: 'ProvisioningFailed',
                message: 'Storage initialization job failed'
              }]
            };
          }
          break;

        case 'MigrationInProgress':
          if (checkMigrationComplete(children)) {
            handleResourcePhase(parent, children, response);
          }
          break;

        case 'Failed':
          // Handle recovery or manual intervention needed
          break;

        default:
          handleResourcePhase(parent, children, response);
      }
    } catch (err) {
      response.status = {
        phase: 'Failed',
        conditions: [{
          type: 'Reconciliation',
          status: 'False',
          reason: 'ReconciliationError',
          message: err.message
        }]
      };
    }

    return response;
  };
}

function checkStorageReady(children) {
  return children.Job?.some(job => 
    job.metadata.labels?.type === 'storage-init' && 
    job.status?.succeeded);
}

function checkStorageFailed(children) {
  return children.Job?.some(job =>
    job.metadata.labels?.type === 'storage-init' &&
    job.status?.failed);
}

function checkMigrationComplete(children) {
  return children.Job?.some(job =>
    job.metadata.labels?.type === 'migration' &&
    job.status?.succeeded);
}

module.exports = createTenantWebhookHandler;