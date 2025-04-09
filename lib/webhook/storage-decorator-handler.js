
const templates = require('../templates');
const _ = require('lodash');

const defaultLabels = {
  storageLabel: process.env.STORAGE_LABEL || 'storage.nightscout.org/account'
};

function createStorageDecoratorHandler(config) {
  const labels = { ...defaultLabels, ...config.labels };

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

  function handle_webhook(req, res, next) {
    const { object: secret, attachments, finalizing } = req.body;
    console.log("INCOMING STORAGE WEBHOOK", req.body);
    
    const description = handle_storage_sync(req.body);
    console.log("STORAGE WEBHOOK RESPONSE", description);
    res.json(description);
    next();
  }

  function handle_storage_sync(request) {
    const { object: secret, attachments, finalizing } = request;
    const account = secret.metadata.labels[labels.storageLabel];
    const response = { attachments: [], patches: [] };

    if (finalizing) {
      const pvc = attachments.PersistentVolumeClaim?.find(p => 
        p.metadata.labels[labels.storageLabel] === account);
      
      if (!pvc || pvc.metadata.deletionTimestamp) {
        response.patches.push({
          op: 'remove',
          path: '/metadata/finalizers',
          value: 'storage.nightscout.k8s/protect-data'
        });
      }
      return response;
    }

    if (!secret.metadata.finalizers?.includes('storage.nightscout.k8s/protect-data')) {
      response.patches.push({
        op: 'add',
        path: '/metadata/finalizers',
        value: ['storage.nightscout.k8s/protect-data']
      });
    }

    response.attachments.push({
      apiVersion: 'nightscout.k8s/v1alpha1',
      kind: 'TenantStorage',
      metadata: {
        name: account,
        labels: {
          [labels.storageLabel]: account
        }
      },
      spec: {
        storageAccount: account,
        needsProvisioning: true
      }
    });

    response.attachments.push(
      templates.template_persistent_volume_claim({
        WEB_NAME: account,
        labels: {
          [labels.storageLabel]: account
        }
      })
    );

    return response;
  }

  return handle_webhook;
}

module.exports = createStorageDecoratorHandler;
