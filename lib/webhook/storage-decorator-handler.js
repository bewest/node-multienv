const templates = require('../templates');
const _ = require('lodash');

const defaultLabels = {
  storageLabel: process.env.STORAGE_LABEL || 'storage.nightscout.org/account'
};

function createStorageDecoratorHandler (config) {
  const labels = { ...defaultLabels, ...config.labels };

  var Kinds = {
    pvc: 'PersistentVolumeClaim.v1'
  };

  function handle_customize (req, res, next) {
    const { object: secret } = req.body;
    console.log('CUSTOMIZING FOR', req.body);
    const account = secret?.metadata.labels[labels.storageLabel];

    res.json({
      relatedResources: [{
        apiVersion: 'snapshot.storage.k8s.io/v1',
        resource: 'volumesnapshots',
        labelSelector: {
          matchLabels: {
            [labels.storageLabel]: account
          }
        }
      }]
    });
    next();
  }


  function handle_webhook (req, res, next) {
    var response = template_decorator_sync(req.body);
    res.json(response);
    next( );
  }

  function template_decorator_sync (incoming) {

    const { object: secret, attachments, related, finalizing } = incoming;
    const account = secret.metadata.labels[labels.storageLabel];

    console.log("ALL OBSERVED", attachments);
    console.log("RELATED", related);
    var observed = _.flatMap(attachments, function (resources, kind) {
      return _.map(resources, (resource, name) => ({
        ...resource
        // ..._.omit(resource, 'status')
      }));
    });
    // Forward all existing attachments by default
    var response = {
      attachments: [ ]
    };

    // Find existing PVC
    var expected_name = `pvc-${account}-mongodb-data`;

    // var is_target_pvc = _.matches({ metadata: { name: expected_name, [labels.storageLabel]: account } });
    // const pvc = _.find(attachments['PersistentVolumeClaim/v1'], is_target_pvc);
    const pvc = attachments[Kinds.pvc][expected_name];

    console.log("FOUND PVC", pvc);
    console.log("FOUND PVC", pvc && pvc.metadata.name == expected_name, pvc && pvc.metadata.labels[labels.storageLabel] == account, pvc);


    if (finalizing) {
      console.log("FINALIZING");
      // somehow no pvc, which means we can remove finalizer and allow deletion
      if (!pvc) {
        return {
          finalized: true,
          attachments: [ ]
        };

      }
      // Check if delete challenge exists
      const deleteChallenge = secret.metadata.labels['storage.nightscout.org/deleteChallenge'];
      const deleteResponse = secret.metadata.labels['storage.nightscout.org/deleteResponse'];

      if (!deleteChallenge) {
        // Set delete challenge if not exists
        const challenge = Math.random().toString(36).substring(2, 15);
        response.labels = { };
        response.labels['storage.nightscout.org/deleteChallenge'] = challenge;
        // response.attachments.push(pvc);
      }

      // Check if snapshot exists and challenge matches
      const hasSnapshot = _.find(related['VolumeSnapshot.snapshot.storage.k8s.io/v1'], s => 
        s.metadata.labels[labels.storageLabel] === account);

      if ((deleteChallenge && deleteResponse === deleteChallenge) && (!pvc || pvc.metadata.deletionTimestamp) && hasSnapshot) {
        pvc.metadata.finalizers = _.without(pvc.metadata.finalizers, 'storage.nightscout.org/tenant-storage');
        return {
          finalized: true,
          attachments: pvc ? [pvc] : []
        };
      }
      console.log("SNAPSHOT ANALYSIS", hasSnapshot);
      if (!hasSnapshot) {
        var new_snapshot_template = {
          apiVersion: 'snapshot.storage.k8s.io/v1',
          kind: 'VolumeSnapshot',
          metadata: {
            name: `eol-${pvc.metadata.name}`,
            labels: {
              [labels.storageLabel]: account,
              role: 'eol'
            }
          },
          spec: {
						volumeSnapshotClassName: 'do-block-storage',
						source: {
							persistentVolumeClaimName: pvc.metadata.name
						}
          }

        };
        console.log("RECOMMENDING SNAPSHOT", new_snapshot_template);
        response.attachments.push(new_snapshot_template);
      }

      response.finalized = false;
      /*
      return {
        finalized: false,
        attachments: pvc ? [pvc] : []
      };
      */
    }

    var pvc_template = {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        finalizers: ['storage.nightscout.org/tenant-storage'],
        name: `pvc-${account}-mongodb-data`,
        labels: {
          [labels.storageLabel]: account,
          'storage.nightscout.org/role': 'tenant-pvc',
          'storage.nightscout.org/fromSecret': secret.metadata.name,
          app: 'tenant'
        }
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        storageClassName: 'do-block-storage-xfs-retain',
        resources: {
          requests: {
            storage: '2Gi'
          }
        }
      }
    };
    // Handle normal sync - ensure PVC exists
    if (!pvc) {
      response.attachments.push(pvc_template);
    } else {
      // monitor for labels, annotations or other mandated properties
      if (!pvc.metadata.finalizers.includes('storage.nightscout.org/tenant-storage')) {
        console.log("pvc was missing finalizer");
        pvc.metadata.finalizers.push('storage.nightscout.org/tenant-storage');
        // response.attachments.push(pvc);
        // response.attachments.push(pvc_template);
      }
    }

    console.log("PRE OBSERVED", observed.length);
		var remaining = _(observed).reject((child) => {
			return _.some(response.attachments, (excluded) => {
				hasSameName = excluded.metadata.name == child.metadata.name;
				isSameKind = excluded.kind == child.kind;
				return hasSameName && isSameKind;
				
			});
    }).value( );
    console.log("REMAINING", remaining.length);

    // pass through any attachments not subject to our policies
    response.attachments.push(...remaining);

    return response;
  }

  return { handle_customize, handle_webhook, template_decorator_sync };
}

module.exports = createStorageDecoratorHandler;
