/**
 * Compute Composite Controller - Customize Hook
 * 
 * Tells Metacontroller which related resources to fetch for compute composite sync.
 * 
 * Returns relatedResources list based on parent ConfigMap metadata.
 */

function createComputeCompositeCustomize(config) {
  return async function computeCompositeCustomize(req, res) {
    const { parent } = req.body;
    
    const tenantId = parent.metadata.name;
    const storageAccountLabel = parent.metadata.labels?.['storage.nightscout.org/account'];
    
    console.log('Compute composite customize for tenant:', tenantId, 'storage account:', storageAccountLabel);
    
    try {
      const response = {
        relatedResources: [
          {
            // Discover storage Secret (for storage type metadata)
            apiVersion: 'v1',
            resource: 'secrets',
            labelSelector: {
              matchLabels: {
                'storage.nightscout.org/account': storageAccountLabel,
                'ns.mdn.io/composite': 'storage'
              }
            }
          },
          {
            // Discover app-credentials Secret (provides MongoDB credentials for Nightscout)
            apiVersion: 'v1',
            resource: 'secrets',
            labelSelector: {
              matchLabels: {
                'storage.nightscout.org/account': storageAccountLabel,
                'ns.mdn.io/credential-type': 'application'
              }
            }
          },
          {
            // Discover MongoDB StatefulSet (blast radius protection)
            apiVersion: 'apps/v1',
            resource: 'statefulsets',
            labelSelector: {
              matchLabels: {
                'storage.nightscout.org/account': storageAccountLabel,
                'app.kubernetes.io/name': 'mongodb'
              }
            }
          }
        ]
      };
      
      res.send(response);
    } catch (error) {
      console.error('Error in compute composite customize:', error);
      res.send(500, { error: error.message });
    }
  };
}

module.exports = createComputeCompositeCustomize;
