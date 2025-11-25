/**
 * Tenant Composite Customize Hook
 * 
 * Dynamically fetches related resources for NightscoutTenant:
 * 1. ConfigMaps via spec.configMapRef (by name) - compute activation signal
 * 2. Fallback to spec.selector.matchLabels for label-based discovery
 * 
 * ConfigMap presence signals compute activation (ReplicaSet rendering)
 * ConfigMap absence means storage-only mode (no compute layer)
 */

function createTenantCompositeCustomize(config) {
  return function tenantCompositeCustomize(req, res, next) {
    const parent = req.body.parent;
    const spec = parent.spec || {};
    const configMapRef = spec.configMapRef;
    const selector = spec.selector || {};
    
    console.log(`Tenant Composite Customize: ${parent.metadata.name}`);
    console.log(`  Namespace: ${parent.metadata.namespace}`);
    console.log(`  configMapRef: ${JSON.stringify(configMapRef)}`);
    console.log(`  selector: ${JSON.stringify(selector)}`);
    
    // Build related resources configuration
    const related = [];
    
    // Strategy 1: Fetch ConfigMap by name via spec.configMapRef (preferred)
    // Metacontroller requires nameSelector.matchNames for name-based discovery
    if (configMapRef && configMapRef.name) {
      const configMapNamespace = configMapRef.namespace || parent.metadata.namespace;
      
      related.push({
        apiVersion: 'v1',
        resource: 'configmaps',
        namespace: configMapNamespace,
        nameSelector: {
          matchNames: [configMapRef.name]
        }
      });
      
      console.log(`  Will fetch ConfigMap by name: ${configMapNamespace}/${configMapRef.name}`);
    }
    // Strategy 2: Fetch ConfigMaps by selector.matchLabels (fallback)
    else if (selector.matchLabels && Object.keys(selector.matchLabels).length > 0) {
      related.push({
        apiVersion: 'v1',
        resource: 'configmaps',
        namespace: parent.metadata.namespace,
        labelSelector: {
          matchLabels: selector.matchLabels
        }
      });
      
      console.log(`  Will fetch ConfigMaps with labels: ${JSON.stringify(selector.matchLabels)}`);
    } else {
      console.log(`  No configMapRef or selector - storage-only mode`);
    }
    
    // Also fetch PVCs by selector for storage layer discovery
    if (selector.matchLabels && Object.keys(selector.matchLabels).length > 0) {
      related.push({
        apiVersion: 'v1',
        resource: 'persistentvolumeclaims',
        namespace: parent.metadata.namespace,
        labelSelector: {
          matchLabels: selector.matchLabels
        }
      });
      
      console.log(`  Will fetch PVCs with labels: ${JSON.stringify(selector.matchLabels)}`);
    }
    
    // Send response
    res.send({
      relatedResources: related
    });
    
    return next();
  };
}

module.exports = createTenantCompositeCustomize;
