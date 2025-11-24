/**
 * Tenant Initialization Decorator - Customize Hook (Gen 5)
 * 
 * Defines related resources for the tenant-initialization-decorator
 * This hook tells Metacontroller which resources to fetch and pass to the sync hook
 */

function createTenantInitializationDecoratorCustomize(config) {
  return function(req, res, next) {
    const { parent: tenant } = req.body;
    
    const tenantId = tenant.metadata.name;
    const namespace = tenant.metadata.namespace;
    const selector = tenant.spec?.selector || {};
    
    console.log(`Tenant initialization decorator customize for: ${tenantId}`);
    console.log(`  Selector: ${JSON.stringify(selector)}`);
    
    // Define related resources to fetch
    const relatedResources = [
      // ConfigMaps matching spec.selector - to detect compute activation
      {
        apiVersion: 'v1',
        resource: 'configmaps',
        labelSelector: {
          matchLabels: selector
        }
      },
      // Init replica set Jobs - to track initialization completion
      {
        apiVersion: 'batch/v1',
        resource: 'jobs',
        labelSelector: {
          matchLabels: {
            'ns.mdn.io/tenant': tenantId,
            'app.kubernetes.io/component': 'database',
            'app.kubernetes.io/name': 'mongodb-init'
          }
        }
      },
      // Create user Jobs - to track user initialization completion
      {
        apiVersion: 'batch/v1',
        resource: 'jobs',
        labelSelector: {
          matchLabels: {
            'ns.mdn.io/tenant': tenantId,
            'app.kubernetes.io/component': 'user-initialization'
          }
        }
      },
      // mongo-auth Secret - to get credentials for Job rendering
      {
        apiVersion: 'v1',
        resource: 'secrets',
        labelSelector: {
          matchLabels: {
            'ns.mdn.io/tenant': tenantId,
            'ns.mdn.io/composite': 'mongodb-auth'
          }
        }
      }
    ];
    
    console.log(`  Requesting ${relatedResources.length} related resource types`);
    
    res.send({ relatedResources });
    return next();
  };
}

module.exports = { createTenantInitializationDecoratorCustomize };
