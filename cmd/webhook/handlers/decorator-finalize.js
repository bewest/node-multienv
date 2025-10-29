const k8s = require('@kubernetes/client-node');

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const snapshotApi = kc.makeApiClient(k8s.CustomObjectsApi);

async function decoratorFinalize(req, res, next) {
  const { object, attachments } = req.body;
  
  console.log('Decorator finalize for PVC:', object.metadata?.name);
  
  try {
    const backupPolicy = object.metadata?.annotations?.['ns.mdn.io/backup-policy'] || 'snapshot';
    
    if (backupPolicy === 'skip') {
      console.log('Backup policy is skip, removing finalizer');
      res.send({
        finalized: true,
        attachments: []
      });
      return next();
    }

    const namespace = object.metadata.namespace;
    const pvcName = object.metadata.name;
    const snapshotName = `${pvcName}-final-snapshot`;

    let snapshotReady = false;
    const existingSnapshots = attachments || [];
    
    for (const snapshot of existingSnapshots) {
      if (snapshot.kind === 'VolumeSnapshot' && snapshot.metadata.name === snapshotName) {
        snapshotReady = snapshot.status?.readyToUse === true;
        console.log(`VolumeSnapshot ${snapshotName} exists, ready:`, snapshotReady);
        break;
      }
    }

    if (!snapshotReady) {
      console.log(`Creating VolumeSnapshot ${snapshotName} for PVC ${pvcName}`);
      
      // Get snapshot class from PVC annotation or use default
      const snapshotClass = object.metadata?.annotations?.['ns.mdn.io/backup-snapshot-class'] || 'csi-snapclass';
      
      // Get metadata from PVC labels
      const tenantId = object.metadata?.labels?.['ns.mdn.io/tenant'] || 'unknown';
      const version = object.metadata?.labels?.['app.kubernetes.io/version'] || 'unknown';
      
      const tier = object.metadata?.labels?.['ns.mdn.io/tier'] || 'unknown';
      const dataClass = object.metadata?.labels?.['ns.mdn.io/data-class'] || 'unknown';
      const createdAt = object.metadata?.annotations?.['ns.mdn.io/created-at'] || '';
      const tenantEmail = object.metadata?.annotations?.['ns.mdn.io/tenant-email'] || '';
      
      const volumeSnapshot = {
        apiVersion: 'snapshot.storage.k8s.io/v1',
        kind: 'VolumeSnapshot',
        metadata: {
          name: snapshotName,
          namespace: namespace,
          labels: {
            'app.kubernetes.io/name': 'volume-snapshot',
            'app.kubernetes.io/component': 'backup',
            'app.kubernetes.io/part-of': 'nightscout-tenant',
            'app.kubernetes.io/instance': tenantId,
            'app.kubernetes.io/version': version,
            'app.kubernetes.io/managed-by': 'metacontroller',
            'ns.mdn.io/tenant': tenantId,
            'ns.mdn.io/backup-type': 'final',
            'ns.mdn.io/tier': tier,
            'ns.mdn.io/data-class': dataClass
          },
          annotations: {
            'ns.mdn.io/snapshot-created': new Date().toISOString(),
            'ns.mdn.io/source-pvc': pvcName,
            'ns.mdn.io/source-created-at': createdAt,
            'ns.mdn.io/tenant-email': tenantEmail,
            'ns.mdn.io/backup-trigger': 'pvc-deletion'
          }
        },
        spec: {
          volumeSnapshotClassName: snapshotClass,
          source: {
            persistentVolumeClaimName: pvcName
          }
        }
      };

      res.send({
        finalized: false,
        attachments: [volumeSnapshot]
      });
      return next();
    }

    console.log(`VolumeSnapshot ${snapshotName} is ready, removing finalizer`);
    res.send({
      finalized: true,
      attachments: existingSnapshots
    });
    return next();

  } catch (error) {
    console.error('Error in decorator finalize:', error);
    res.send(500, { error: error.message });
    return next();
  }
}

module.exports = decoratorFinalize;
