const templates = require('../templates');
const _ = require('lodash');

const defaultLabels = {
  storageLabel: process.env.STORAGE_LABEL || 'storage.nightscout.org/account'
};

function createStorageDecoratorHandler(config) {
  const labels = { ...defaultLabels, ...config.labels };

  var Kinds = {
    pvc: 'PersistentVolumeClaim/v1'
  };
  function handle_webhook(req, res, next) {
    const { object: secret, attachments, related, finalizing } = req.body;
    const account = secret.metadata.labels[labels.storageLabel];

    console.log("ALL OBSERVED", attachments);
    consoole.log("RELATED", related);
    var observed = _.flatMap(attachments, resources => resources);
    // Forward all existing attachments by default
    const response = {
      status: {},
      children:  [ ]
    };

    // Find existing PVC
    var expected_name = `pvc-${account}-mongodb-data`,

    // var is_target_pvc = _.matches({ metadata: { name: expected_name, [labels.storageLabel]: account } });
    // const pvc = _.find(attachments['PersistentVolumeClaim/v1'], is_target_pvc);
    const pvc = attachments[Kinds.pvc][expected_name];

    console.log("FOUND PVC", pvc.metadata.name == expected_name, pvc.metadata.labels[labels.storageLabel] == account, pvc);


    if (finalizing) {
      // Check if delete challenge exists
      const deleteChallenge = secret.metadata.labels['storage.nightscout.org/deleteChallenge'];
      const deleteResponse = secret.metadata.labels['storage.nightscout.org/deleteResponse'];

      if (!deleteChallenge) {
        // Set delete challenge if not exists
        const challenge = Math.random().toString(36).substring(2, 15);
        pvc.metadata.labels['storage.nightscout.org/deleteChallenge'] = challenge;
        response.attachments.push(pvc);
      }

      // Check if snapshot exists and challenge matches
      const hasSnapshot = _.find(related['VolumeSnapshot/snapshot.storage.k8s.io/v1'], s => 
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
      response.attachments.push({
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: {
          name: `pvc-${account}-mongodb-data`,
          labels: {
            [labels.storageLabel]: account,
            'storage.nightscout.org/role': 'tenant-pvc',
            'storage.nightscout.org/fromSecret': secret.metadata.name
            app: 'tenant'
          }
        },
        spec: {
          accessModes: ['ReadWriteOnce'],
          storageClassName: 'do-block-storage-xfs-retain'
          resources: {
            requests: {
              storage: '2Gi'
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
