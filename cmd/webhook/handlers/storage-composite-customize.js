/**
 * Storage Composite Controller - Customize Hook
 * 
 * Tells Metacontroller which related resources to fetch for storage composite sync.
 * 
 * Returns relatedResources list based on parent StorageAccount CRD metadata.
 */

function createStorageCompositeCustomize(config) {
  return async function storageCompositeCustomize(req, res) {
    const { parent } = req.body;
    
    const storageAccount = parent.metadata.name;
    const storageAccountLabel = parent.metadata.labels?.['storage.nightscout.org/account'];
    
    console.log('Storage composite customize for account:', storageAccount);
    
    try {
      const response = {
        relatedResources: [
          {
            // Discover PVCs created by StatefulSet (blast radius protection)
            apiVersion: 'v1',
            resource: 'persistentvolumeclaims',
            labelSelector: {
              matchLabels: {
                'storage.nightscout.org/account': storageAccount
              }
            }
          },
          {
            // Discover tenant ComputeInstances using this storage (for auditing)
            // ComputeInstances must be labeled with storage.nightscout.org/account: <storageaccount-name>
            apiVersion: 'nightscout.io/v1alpha1',
            resource: 'computeinstances',
            labelSelector: {
              matchLabels: {
                'storage.nightscout.org/account': storageAccount
              }
            }
          }
        ]
      };
      
      res.send(response);
    } catch (error) {
      console.error('Error in storage composite customize:', error);
      res.send(500, { error: error.message });
    }
  };
}

module.exports = createStorageCompositeCustomize;
