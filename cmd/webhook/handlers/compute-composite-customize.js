/**
 * Compute Composite Controller - Customize Hook
 * 
 * Tells Metacontroller which related resources to fetch for compute composite sync.
 * 
 * Returns relatedResources list based on parent ComputeInstance CRD metadata.
 */

function createComputeCompositeCustomize(config) {
  return async function computeCompositeCustomize(req, res) {
    const { parent } = req.body;
    
    const tenantId = parent.metadata.name;
    const storageAccountName = parent.spec?.storageAccountRef?.name;
    const storageAccountLabel = parent.metadata.labels?.['storage.nightscout.org/account'];
    
    console.log('Compute composite customize for tenant:', tenantId, 'storage account:', storageAccountName);
    
    try {
      const response = {
        relatedResources: [
          {
            // Discover StorageAccount CRD (for storage metadata)
            apiVersion: 'nightscout.io/v1alpha1',
            resource: 'storageaccounts',
            names: storageAccountName ? [storageAccountName] : []
          },
          {
            // Discover app-credentials Secret (provides MongoDB credentials for Nightscout)
            apiVersion: 'v1',
            resource: 'secrets',
            labelSelector: {
              matchLabels: {
                'storage.nightscout.org/account': storageAccountLabel,
                'nightscout.io/tenant': tenantId,
                'ns.mdn.io/credential-type': 'application'
              }
            }
          },
          {
            apiVersion: 'v1',
            resource: 'configmaps',
            labelSelector: {
              matchLabels: {
                'component': 'config',
                'tenant': tenantId
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
