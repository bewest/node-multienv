/**
 * Tenant Composite Customize Hook
 * 
 * Dynamically fetches ConfigMaps based on parent NightscoutTenant's spec.selector
 * ConfigMap presence signals compute activation (ReplicaSet rendering)
 * ConfigMap absence means storage-only mode (no compute layer)
 */

function createTenantCompositeCustomize(config) {
  return function tenantCompositeCustomize(req, res, next) {
    const parent = req.body.parent;
    const selector = parent.spec?.selector || {};
    
    console.log(`Tenant Composite Customize: ${parent.metadata.name}`);
    console.log(`  Namespace: ${parent.metadata.namespace}`);
    console.log(`  Selector: ${JSON.stringify(selector)}`);
    
    // Build related resources configuration
    const related = [];
    
    // Fetch ConfigMaps matching the selector (compute activation signal)
    if (Object.keys(selector).length > 0) {
      const matchLabels = {};
      Object.entries(selector).forEach(([key, value]) => {
        matchLabels[key] = value;
      });
      
      related.push({
        apiVersion: 'v1',
        resource: 'configmaps',
        namespace: parent.metadata.namespace,
        labelSelector: {
          matchLabels: matchLabels
        }
      });
      
      console.log(`  Will fetch ConfigMaps with labels: ${JSON.stringify(matchLabels)}`);
    } else {
      console.log(`  No selector configured, skipping ConfigMap fetch`);
    }
    
    // Send response
    res.send({
      relatedResources: related
    });
    
    return next();
  };
}

module.exports = createTenantCompositeCustomize;
