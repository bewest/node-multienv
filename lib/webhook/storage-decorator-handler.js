const templates = require('../templates');
const _ = require('lodash');

const defaultLabels = {
  storageLabel: process.env.STORAGE_LABEL || 'storage.nightscout.org/account'
};

function createStorageDecoratorHandler(config) {
  const labels = { ...defaultLabels, ...config.labels };

  function handle_webhook(req, res, next) {
    const { object: secret, attachments, finalizing } = req.body;
    const account = secret.metadata.labels[labels.storageLabel];

    // Forward all existing attachments by default
    const response = {
      status: {},
      children: _.flatMap(attachments, resources => resources)
    };

    // Find existing PVC
    const pvc = _.find(attachments.PersistentVolumeClaim, p => 
      p.metadata.labels[labels.storageLabel] === account);

    if (finalizing) {
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

      // Check if snapshot exists and challenge matches
      const hasSnapshot = req.body.related?.VolumeSnapshot?.some(s => 
        s.metadata.labels[labels.storageLabel] === account);

      if (deleteResponse === deleteChallenge && (!pvc || pvc.metadata.deletionTimestamp) && hasSnapshot) {
        return {
          finalized: true,
          attachments: []
        };
      }

      return {
        finalized: false,
        attachments: pvc ? [pvc] : []
      };
    }

    // Handle normal sync - ensure PVC exists
    if (!pvc) {
      response.children.push({
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: {
          name: `${account}-mongodb-data`,
          labels: {
            [labels.storageLabel]: account
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
      });
    }

    return response;
  }

  return handle_webhook;
}

module.exports = createStorageDecoratorHandler;