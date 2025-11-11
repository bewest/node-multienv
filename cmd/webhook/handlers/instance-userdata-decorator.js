/**
 * Instance Userdata Decorator Controller
 * 
 * Orchestrates Gen 3 → Gen 4 migration cutover by managing ConfigMap labels
 * 
 * Target: ConfigMap with role=config-as-deploy label (Gen 3 user config)
 * Related Resources:
 *   - Deployments (Gen 3 + Gen 4) - both have internal_name label
 *   - ComputeInstance - migration status tracking
 * 
 * Responsibilities:
 *   1. Watch Gen 3 ConfigMaps (role=config-as-deploy)
 *   2. Verify migration readiness:
 *      - Migration completed (ComputeInstance status)
 *      - Gen 3 deployment healthy (readyReplicas > 0)
 *      - Gen 4 deployment healthy (readyReplicas > 0)
 *   3. When ready:
 *      - Archive ConfigMap to different namespace (backup for rollback)
 *      - Remove role=config-as-deploy label (retires Gen 3 from resolver)
 * 
 * Key Design Points:
 *   - ConfigMap is parent resource (modify its own labels without ownership changes)
 *   - Zero-downtime cutover (both generations running before label removal)
 *   - Archive enables instant rollback if Gen 4 has issues
 *   - Idempotent (safe to reconcile multiple times)
 */

const { ANNOTATIONS, LABELS } = require('./constants');

/**
 * Create instance userdata decorator with pipeline pattern
 */
function createDecoratorSync(config) {
  const ARCHIVE_NAMESPACE = config.archive?.namespace || 'archived-configs';
  const GEN3_ROLE_LABEL = 'config-as-deploy';
  
  /**
   * Stage 1: Initialize context from webhook request
   * Extracts ConfigMap parent, related resources, and tenant ID
   */
  function initializeContext(req, res, next) {
    const { object: configMap, related, attachments } = req.body;
    
    req.configMap = configMap;
    req.related = related || {};
    req.attachments = attachments || {};
    req.tenantId = configMap.metadata.labels?.tenant;
    req.namespace = configMap.metadata.namespace;
    
    // Initialize response
    res.attachments = [];
    res.labels = null;  // Will be set if label modification needed
    
    console.log('Instance userdata decorator sync for ConfigMap:', configMap.metadata.name);
    console.log('  Tenant ID:', req.tenantId);
    
    if (!req.tenantId) {
      console.log('  WARNING: No internal_name label - cannot discover related resources');
      // Skip pipeline - return empty response
      res.send({ attachments: [], labels: {} });
      return;
    }
    
    return next();
  }
  
  /**
   * Stage 2: Parse related resources
   * Find Gen 3 deployment, Gen 4 deployment, and ComputeInstance
   */
  function parseRelatedResources(req, res, next) {
    // Extract deployments
    const deployments = req.related['Deployment.apps/v1'] || {};
    const deploymentList = Object.values(deployments);
    
    // Distinguish Gen 3 vs Gen 4 by presence of role=config-as-deploy label
    req.gen3Deployment = deploymentList.find(d => 
      d.metadata?.labels?.role === GEN3_ROLE_LABEL
    );
    
    req.gen4Deployment = deploymentList.find(d => 
      d.metadata?.labels?.role !== GEN3_ROLE_LABEL &&
      d.metadata?.labels?.internal_name === req.tenantId
    );
    
    // Extract ComputeInstance
    const computeInstances = req.related['ComputeInstance.nightscout.io/v1alpha1'] || {};
    req.computeInstance = Object.values(computeInstances).find(ci =>
      ci.metadata?.labels?.['compute.nightscout.org/instance'] === req.tenantId ||
      ci.metadata?.name === req.tenantId
    );
    
    console.log('  Gen 3 deployment:', req.gen3Deployment?.metadata?.name || 'not found');
    console.log('  Gen 4 deployment:', req.gen4Deployment?.metadata?.name || 'not found');
    console.log('  ComputeInstance:', req.computeInstance?.metadata?.name || 'not found');
    
    return next();
  }
  
  /**
   * Stage 3: Evaluate migration readiness
   * Check if all conditions met for Gen 3 → Gen 4 cutover
   */
  function evaluateReadiness(req, res, next) {
    req.ready = false;
    
    // Check migration completed
    const migrationCompleted = hasCondition(req.computeInstance, 'MigrationCompleted');
    
    // Check Gen 3 deployment health
    const gen3Healthy = req.gen3Deployment?.status?.readyReplicas > 0;
    
    // Check Gen 4 deployment health
    const gen4Healthy = req.gen4Deployment?.status?.readyReplicas > 0;
    
    console.log('  Readiness checks:');
    console.log('    Migration completed:', migrationCompleted);
    console.log('    Gen 3 healthy:', gen3Healthy, `(${req.gen3Deployment?.status?.readyReplicas || 0} replicas)`);
    console.log('    Gen 4 healthy:', gen4Healthy, `(${req.gen4Deployment?.status?.readyReplicas || 0} replicas)`);
    
    // All conditions must be true
    req.ready = migrationCompleted && gen3Healthy && gen4Healthy;
    
    console.log('  Ready for cutover:', req.ready);
    
    return next();
  }
  
  /**
   * Stage 4: Plan ConfigMap archive (if ready)
   * Create backup copy in archive namespace for rollback capability
   */
  function planArchiveConfigMap(req, res, next) {
    if (!req.ready) {
      console.log('  Skipping archive - not ready');
      return next();
    }
    
    // Check if already archived
    const archiveAttachments = req.attachments['ConfigMap.v1'] || {};
    const archiveName = `${req.configMap.metadata.name}-backup`;
    const alreadyArchived = Object.values(archiveAttachments).some(cm =>
      cm.metadata?.namespace === ARCHIVE_NAMESPACE &&
      cm.metadata?.name === archiveName
    );
    
    if (alreadyArchived) {
      console.log('  Archive already exists - skipping');
      return next();
    }
    
    // Create archive copy with full original data
    const archiveConfigMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: archiveName,
        namespace: ARCHIVE_NAMESPACE,
        labels: {
          ...req.configMap.metadata.labels,
          'nightscout.io/archived': 'true'
        },
        annotations: {
          ...req.configMap.metadata.annotations,
          'nightscout.io/archived-at': new Date().toISOString(),
          'nightscout.io/source-namespace': req.namespace,
          'nightscout.io/original-name': req.configMap.metadata.name
        }
      },
      data: req.configMap.data  // Preserve all user preferences + MONGODB_URI
    };
    
    res.attachments.push(archiveConfigMap);
    console.log(`  Planned archive: ${archiveName} → ${ARCHIVE_NAMESPACE}`);
    
    return next();
  }
  
  /**
   * Stage 5: Plan label adjustment (if ready)
   * Remove role=config-as-deploy label to retire Gen 3
   */
  function planLabelAdjustment(req, res, next) {
    if (!req.ready) {
      console.log('  Skipping label adjustment - not ready');
      return next();
    }
    
    // Check if already migrated (label already removed)
    const currentRole = req.configMap.metadata.labels?.role;
    if (currentRole !== GEN3_ROLE_LABEL) {
      console.log(`  Already migrated - role label is "${currentRole}"`);
      return next();
    }
    
    // Plan label removal
    res.labels = {
      role: 'dedicated',  // Remove config-as-deploy label
      'nightscout.io/migrated-at': new Date().toISOString()
    };
    
    console.log('  Planned label removal: role=config-as-deploy → null');
    
    return next();
  }
  
  /**
   * Stage 6: Assemble final response
   * Return attachments and label modifications to Metacontroller
   */
  function assembleResponse(req, res, next) {
    const response = {
      attachments: res.attachments
    };
    
    // Only include labels if modifications planned
    if (res.labels) {
      response.labels = res.labels;
    }
    
    console.log('  Response:', {
      attachments: response.attachments.length,
      labelModifications: res.labels ? Object.keys(res.labels).length : 0
    });
    
    res.json(response);
  }
  
  // Define sync pipeline
  const sync = [
    initializeContext,
    parseRelatedResources,
    evaluateReadiness,
    planArchiveConfigMap,
    planLabelAdjustment,
    assembleResponse
  ];
  
  /**
   * Customize hook: Discover related resources dynamically
   * Returns label selectors for Deployments and ComputeInstance
   */
  function customize_userdata_related(req, res, next) {
    const { parent } = req.body;
    const tenantId = parent.metadata?.labels?.tenant;
    
    console.log('Instance userdata decorator customize for ConfigMap:', parent.metadata?.name);
    console.log('  Tenant ID:', tenantId);
    
    if (!tenantId) {
      // No tenant ID - cannot discover related resources
      console.log('  WARNING: No internal_name label - returning empty relatedResources');
      return res.json({ relatedResources: [] });
    }
    
    const relatedResources = [
      // Both Gen 3 and Gen 4 deployments (distinguished by role label in sync)
      {
        apiVersion: 'apps/v1',
        resource: 'deployments',
        labelSelector: {
          matchLabels: {
            internal_name: tenantId,
            app: 'deployment'
          }
        }
      },
      
      // ComputeInstance for migration status
      {
        apiVersion: 'nightscout.io/v1alpha1',
        resource: 'computeinstances',
        labelSelector: {
          matchExpressions: [
            {
              key: 'nightscout.io/tenant',
              operator: 'In',
              values: [tenantId]
            }
          ]
        }
      }
    ];
    
    console.log('  Related resources:', relatedResources.length);
    
    res.json({ relatedResources });
  }
  
  const customize = [customize_userdata_related];
  
  return { sync, customize };
}

/**
 * Helper: Check if CRD status has specific condition set to True
 */
function hasCondition(resource, conditionType) {
  if (!resource?.status?.conditions) {
    return false;
  }
  
  const condition = resource.status.conditions.find(c => c.type === conditionType);
  return condition?.status === 'True';
}

module.exports = createDecoratorSync;
