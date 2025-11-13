/**
 * Storage Initialization Decorator - Customize Hook
 * 
 * Defines related resources for the storage-initialization-decorator
 * This hook tells Metacontroller which resources to fetch and pass to the sync hook
 */

function createStorageInitializationDecoratorCustomize(config) {
  return function(req, res, next) {
    const { parent: secret } = req.body;
    
    // Extract storage account ID from Secret labels
    const storageAccountId = secret.metadata.labels?.['storage.nightscout.org/account'];
    
    console.log(`Storage initialization decorator customize for Secret: ${secret.metadata.name}`);
    console.log(`  Storage account: ${storageAccountId}`);
    
    if (!storageAccountId) {
      // No storage account label - return empty related resources
      res.send({ relatedResources: [] });
      return next();
    }
    
    // Define related resources to fetch
    const relatedResources = [
      // StorageAccount CRD - to check status conditions
      {
        apiVersion: 'nightscout.io/v1alpha1',
        resource: 'storageaccounts',
        // namespace: secret.metadata.namespace,
        // names: [storageAccountId],
        labelSelector: {
          matchLabels: {
            'storage.nightscout.org/account': storageAccountId,
            // 'app.kubernetes.io/component': 'init-job',
          },
        },
      },
      // init-mongo-cluster Jobs - to detect completion
      {
        apiVersion: 'batch/v1',
        resource: 'jobs',
        // namespace: secret.metadata.namespace,
        labelSelector: {
          matchLabels: {
            'storage.nightscout.org/account': storageAccountId,
            'app.kubernetes.io/component': 'init-job',
          },
        },
      },
      // ComputeInstance CRD - to detect migration annotation origin
      {
        apiVersion: 'nightscout.io/v1alpha1',
        resource: 'computeinstances',
        // namespace: secret.metadata.namespace,
        labelSelector: {
          matchLabels: {
            'storage.nightscout.org/account': storageAccountId,
          },
        },
      },
    ];
    
    console.log(`  Requesting ${relatedResources.length} related resource types`);
    
    res.send({ relatedResources });
    return next();
  };
}

module.exports = { createStorageInitializationDecoratorCustomize };
