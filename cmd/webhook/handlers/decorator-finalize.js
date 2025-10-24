const k8s = require('@kubernetes/client-node');

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const snapshotApi = kc.makeApiClient(k8s.CustomObjectsApi);

async function decoratorFinalize(req, res) {
  const { object, attachments } = req.body;
  
  console.log('Decorator finalize for PVC:', object.metadata?.name);
  
  try {
    const backupPolicy = object.metadata?.annotations?.['ns.mdn.io/backup-policy'] || 'snapshot';
    
    if (backupPolicy === 'skip') {
      console.log('Backup policy is skip, removing finalizer');
      return res.json({
        finalized: true,
        attachments: []
      });
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
      
      const volumeSnapshot = {
        apiVersion: 'snapshot.storage.k8s.io/v1',
        kind: 'VolumeSnapshot',
        metadata: {
          name: snapshotName,
          namespace: namespace,
          labels: {
            'app.kubernetes.io/part-of': 'nightscout-tenant',
            'ns.mdn.io/backup-type': 'final'
          }
        },
        spec: {
          volumeSnapshotClassName: 'csi-snapclass',
          source: {
            persistentVolumeClaimName: pvcName
          }
        }
      };

      return res.json({
        finalized: false,
        attachments: [volumeSnapshot]
      });
    }

    console.log(`VolumeSnapshot ${snapshotName} is ready, removing finalizer`);
    return res.json({
      finalized: true,
      attachments: existingSnapshots
    });

  } catch (error) {
    console.error('Error in decorator finalize:', error);
    res.status(500).json({ error: error.message });
  }
}

module.exports = decoratorFinalize;
