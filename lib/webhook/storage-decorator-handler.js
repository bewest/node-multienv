
const { template_persistent_volume_claim } = require('../templates/pvc');

function handleStorageDecorator(request) {
  const { object: secret, attachments, finalizing } = request;
  const account = secret.metadata.labels['storage.nightscout.org/account'];
  
  if (finalizing) {
    // Only remove finalizer if PVC is gone or marked for deletion
    const pvc = attachments.PersistentVolumeClaim?.find(p => 
      p.metadata.labels['storage.nightscout.org/account'] === account);
    
    if (!pvc || pvc.metadata.deletionTimestamp) {
      return {
        attachments: [],
        patches: [{
          op: 'remove',
          path: '/metadata/finalizers',
          value: 'storage.nightscout.k8s/protect-data'
        }]
      };
    }
    return { attachments: [] }; // Keep finalizer
  }

  // Add finalizer if not present
  const patches = [];
  if (!secret.metadata.finalizers?.includes('storage.nightscout.k8s/protect-data')) {
    patches.push({
      op: 'add',
      path: '/metadata/finalizers',
      value: ['storage.nightscout.k8s/protect-data']
    });
  }

  return {
    attachments: [{
      apiVersion: 'nightscout.k8s/v1alpha1',
      kind: 'TenantStorage',
      metadata: {
        name: account,
        labels: {
          'storage.nightscout.org/account': account
        }
      },
      spec: {
        storageAccount: account,
        needsProvisioning: true
      }
    },
    template_persistent_volume_claim({
      WEB_NAME: account,
      labels: {
        'storage.nightscout.org/account': account
      }
    })],
    patches
  };
}

module.exports = handleStorageDecorator;
