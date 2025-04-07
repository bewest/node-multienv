const templates = require('../templates');
const storagePhase = require('./tenant-phases/storage');
const migrationPhase = require('./tenant-phases/migration');
const resourcePhase = require('./tenant-phases/resources');

const defaultLabels = {
  appLabel: process.env.TENANT_APP_LABEL || 'tenant',
  componentLabel: process.env.TENANT_COMPONENT_LABEL || 'app',
  // tenantIdLabel: process.env.TENANT_ID_LABEL || 'tenant-id',
  migrationBatchLabel: process.env.MIGRATION_BATCH_LABEL || 'batch'
};

function createTenantWebhookHandler(config) {

  var selected_namespace = config.MULTIENV_K8S_NAMESPACE;
  const labels = { ...defaultLabels, ...config.labels };
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

  function handle_webhook (req, res, next) {
    var { parent, children, related, finalizing } = req.body;
    console.log("INCOMING WEBHOOK", req.body);
    console.log("INCOMING WEBHOOK PARENT", parent);
    console.log("INCOMING WEBHOOK CHILDREN", children);
    console.log("INCOMING WEBHOOK RELATED", related);
    var description = template_instance_sync(req.body);
    console.log("WEBHOOK RESPONSE", description);
    res.json(description);
    next( );
  }

  function template_instance_sync (request) {
    const { parent, children, related } = request;
    const response = { status: {}, children: [] };

    switch(parent.status?.phase || 'Initial') {
      case 'Initial':
        handleStoragePhase(parent, children, related, response);
        break;

      case 'StorageProvisioning':
        if (checkStorageFailed(parent, children)) {
          response.status = {
            phase: 'Failed',
            conditions: [{
              type: 'StorageReady',
              status: 'False',
              reason: 'ProvisioningFailed',
              message: 'Storage initialization job failed'
            }]
          };
        } else if (checkStorageReady(parent, children)) {
          handleMigrationPhase(parent, children, response);
        } else {
          handleStoragePhase(parent, children, related, response);
        }
        break;

      case 'MigrationInProgress':
        if (checkMigrationComplete(children)) {
          handleResourcePhase(parent, children, response);
        } else {
          handleMigrationPhase(parent, children, response);
        }
        break;

      case 'Failed':
        // Echo back existing children to maintain stability
        // response.children = Object.values(children).flat();
        response.status = {
          phase: 'Failed',
          conditions: parent.status?.conditions || [{
            type: 'Reconciliation',
            status: 'False',
            reason: 'Failed',
            message: 'Resource is in failed state, manual intervention required',
            lastTransitionTime: new Date().toISOString()
          }]
        };
        break;

      default:
        handleResourcePhase(parent, children, response);
    }
    /*
    response.status = {
      phase: 'Failed',
      conditions: [{
        type: 'Reconciliation',
        status: 'False',
        reason: 'ReconciliationError',
        message: err.message
      }]
    };
    */

    return response;
  };
  return handle_webhook;
}

function checkStorageReady(parent, children) {
  var child = children['Job.batch/v1'][`${parent.spec.webName}-storage-init`];
  console.log("IS CHILD READY", children['Job.batch/v1'], child);
  return child?.status?.succeeded;
  return children['Job.batch/v1'].some(job => {
    console.log("JOB STORAGE READY?", job);
    return job.metadata.labels?.type === 'storage-init' && job.status?.succeeded;
    });
}

function checkStorageFailed(parent, children) {
  var child = children['Job.batch/v1'][`${parent.spec.webName}-storage-init`];
  return child?.status?.failed > 0 && !child.status?.succeeded;
  return children['Job.batch/v1'].some(job =>
    job.metadata.labels?.type === 'storage-init' &&
    job.status?.failed);
}

function checkMigrationComplete(children) {
  return children.Job?.some(job =>
    job.metadata.labels?.type === 'migration' &&
    job.status?.succeeded);
}

module.exports = createTenantWebhookHandler;
