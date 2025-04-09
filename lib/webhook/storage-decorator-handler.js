const templates = require('../templates');
const _ = require('lodash');

const defaultLabels = {
  storageLabel: process.env.STORAGE_LABEL || 'storage.nightscout.org/account'
};

function createStorageDecoratorHandler(config) {
  const labels = { ...defaultLabels, ...config.labels };

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

    if (finalizing) {
      const pvc = attachments.PersistentVolumeClaim?.find(p => 
        p.metadata.labels[labels.storageLabel] === account);

      // Check if delete challenge exists
      const deleteChallenge = secret.metadata.labels['storage.nightscout.org/deleteChallenge'];
      const deleteResponse = secret.metadata.labels['storage.nightscout.org/deleteResponse'];

      if (!deleteChallenge) {
        // Set delete challenge if not exists
        const challenge = Math.random().toString(36).substring(2, 15);
        return {
          attachments: [{
            apiVersion: 'v1',
            kind: 'PersistentVolumeClaim',
            metadata: {
              name: `${account}-mongodb-data`,
              labels: {
                [labels.storageLabel]: account,
                'storage.nightscout.org/deleteChallenge': challenge
              }
            },
            spec: {
              accessModes: ['ReadWriteOnce'],
              resources: {
                requests: {
                  storage: '1Gi'
                }
              }
            }
          }]
        };
      }

      // Check if challenge matches response
      if (deleteResponse === deleteChallenge && (!pvc || pvc.metadata.deletionTimestamp)) {
        return {
          finalized: true,
          attachments: []
        };
      }

      return {
        finalized: false,
        attachments: [pvc]
      };
    }

    return {
      attachments: [
        templates.template_persistent_volume_claim({
          WEB_NAME: account,
          labels: {
            [labels.storageLabel]: account
          }
        })
      ]
    };
  }

  return handle_webhook;
}

module.exports = createStorageDecoratorHandler;