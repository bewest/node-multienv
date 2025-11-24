/**
 * Tenant Initialization Decorator - Customize Hook (Gen 5)
 * 
 * Defines related resources for the tenant-initialization-decorator
 * This hook tells Metacontroller which resources to fetch and pass to the sync hook
 * 
 * Identity Field Pattern:
 * - resourceName (CR name): Used for Job naming prefixes
 * - spec.storage: Required, used for ns.mdn.io/storage label lookups
 * - spec.tenant: Optional, used for ns.mdn.io/tenant label when set
 */

function createTenantInitializationDecoratorCustomize(config) {
  return function(req, res, next) {
    const { parent: tenant } = req.body;
    
    const resourceName = tenant.metadata.name;
    const namespace = tenant.metadata.namespace;
    const storageId = tenant.spec?.storage;
    const tenantId = tenant.spec?.tenant;
    const configMapRef = tenant.spec?.configMapRef;
    
    console.log(`Tenant initialization decorator customize for: ${resourceName}`);
    console.log(`  Storage ID: ${storageId}`);
    console.log(`  Tenant ID: ${tenantId || '(not set)'}`);
    
    // Early validation - spec.storage is required
    if (!storageId) {
      console.error(`  ERROR: spec.storage is required but not provided`);
      res.send({ relatedResources: [] });
      return next();
    }
    
    // Define related resources to fetch
    const relatedResources = [];
    
    // ConfigMap for compute activation detection (via spec.configMapRef)
    if (configMapRef?.name) {
      relatedResources.push({
        apiVersion: 'v1',
        resource: 'configmaps',
        names: [configMapRef.name],
        namespace: configMapRef.namespace || namespace
      });
      console.log(`  ConfigMap ref: ${configMapRef.name}`);
    }
    
    // Init replica set Jobs - lookup by storage label (always present)
    relatedResources.push({
      apiVersion: 'batch/v1',
      resource: 'jobs',
      labelSelector: {
        matchLabels: {
          'ns.mdn.io/storage': storageId,
          'app.kubernetes.io/component': 'database',
          'app.kubernetes.io/name': 'mongodb-init'
        }
      }
    });
    
    // Create user Jobs - lookup by storage label (always present)
    relatedResources.push({
      apiVersion: 'batch/v1',
      resource: 'jobs',
      labelSelector: {
        matchLabels: {
          'ns.mdn.io/storage': storageId,
          'app.kubernetes.io/component': 'user-initialization'
        }
      }
    });
    
    // mongo-auth Secret - lookup by storage label (always present)
    relatedResources.push({
      apiVersion: 'v1',
      resource: 'secrets',
      labelSelector: {
        matchLabels: {
          'ns.mdn.io/storage': storageId,
          'ns.mdn.io/composite': 'mongodb-auth'
        }
      }
    });
    
    console.log(`  Requesting ${relatedResources.length} related resource types`);
    
    res.send({ relatedResources });
    return next();
  };
}

module.exports = { createTenantInitializationDecoratorCustomize };
