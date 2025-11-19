/**
 * Instance Userdata Decorator Controller
 * 
 * Orchestrates Gen 3 → Gen 4 userdata migration (Phase 2 of two-phase migration)
 * 
 * Target: ConfigMap with role=config-as-deploy label (Gen 3 user config)
 * Related Resources:
 *   - Deployments (Gen 4) - verify Gen 4 deployment health
 *   - ComputeInstance - storage migration status tracking
 * 
 * Two-Phase Migration Architecture:
 *   Phase 1 (Storage): Storage-Credentials decorator migrates MongoDB data
 *                      Sets nightscout.io/migration-completed on ComputeInstance
 *   Phase 2 (Userdata): Instance-Userdata decorator (this controller)
 *                       - Discovers ComputeInstance via customize hook
 *                       - Waits for storage migration completion annotation
 *                       - Archives ConfigMap (WITH MONGODB_URI for rollback)
 *                       - Strips MONGODB_URI from active ConfigMap
 *                       - Sets nightscout.io/userdata-migration-completed
 * 
 * Responsibilities:
 *   1. Watch Gen 3 ConfigMaps (role=config-as-deploy)
 *   2. Discover related ComputeInstance via customize hook
 *   3. Check storage migration completion (nightscout.io/migration-completed annotation)
 *   4. Guard against duplicate migrations (nightscout.io/userdata-migration-completed)
 *   5. Verify Gen 4 deployment health (readyReplicas > 0)
 *   6. When ready:
 *      - Archive complete ConfigMap to archive namespace (rollback capability)
 *      - Strip MONGODB_URI from active ConfigMap (Gen4 uses Secret)
 *      - Set completion annotation on ConfigMap
 * 
 * Key Design Points:
 *   - ConfigMap is parent resource (modify annotations without ownership changes)
 *   - Archive preserves MONGODB_URI for rollback scenarios
 *   - Active ConfigMap becomes Compute Composite child (lifecycle-managed)
 *   - Idempotent (safe to reconcile multiple times)
 *   - Loosely coupled from Storage-Credentials via annotation signaling
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
    req.tenantId = configMap.metadata.labels?.internal_name;
    req.namespace = configMap.metadata.namespace;
    
    // Initialize response
    res.attachments = [];
    res.labels = null;  // Will be set if label modification needed
    res.annotations = null;  // Will be set if annotation modification needed
    
    console.log('Instance userdata decorator sync for ConfigMap:', configMap.metadata.name);
    console.log('  Tenant ID:', req.tenantId);
    
    if (!req.tenantId) {
      console.log('  WARNING: No internal_name label - cannot discover related resources');
      // Skip pipeline - return empty response
      res.send({ attachments: [] });
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
   * Check if storage migration completed and userdata migration not yet done
   */
  function evaluateReadiness(req, res, next) {
    req.ready = false;
    
    // Guard: Check if userdata migration already completed
    const userdataMigrationCompleted = req.configMap?.metadata?.annotations?.['nightscout.io/userdata-migration-completed'];
    
    if (userdataMigrationCompleted) {
      console.log('  Userdata migration already completed at:', userdataMigrationCompleted);
      console.log('  Skipping pipeline');
      res.send({ attachments: [] });
      return;
    }
    
    // Check storage migration completed via annotation
    const storageMigrationCompleted = req.computeInstance?.metadata?.annotations?.['nightscout.io/migration-completed'];
    
    if (!storageMigrationCompleted) {
      console.log('  Storage migration not completed - skipping userdata migration');
      console.log('  ComputeInstance annotations:', req.computeInstance?.metadata?.annotations || 'none');
      return next();
    }
    
    // Check Gen 4 deployment health (must be healthy before proceeding)
    const gen4Healthy = req.gen4Deployment?.status?.readyReplicas > 0;
    
    console.log('  Readiness checks:');
    console.log('    Storage migration completed:', storageMigrationCompleted);
    console.log('    Userdata migration completed:', userdataMigrationCompleted);
    console.log('    Gen 4 healthy:', gen4Healthy, `(${req.gen4Deployment?.status?.readyReplicas || 0} replicas)`);
    
    // Ready if storage migration done and Gen 4 is healthy
    req.ready = storageMigrationCompleted && gen4Healthy;
    
    console.log('  Ready for userdata migration:', req.ready);
    
    return next();
  }
  
  /**
   * Stage 4: Plan ConfigMap archive and MONGODB_URI cleanup (if ready)
   * Creates archived copy (WITH MONGODB_URI for rollback) and strips MONGODB_URI from active ConfigMap
   */
  function planArchiveConfigMap(req, res, next) {
    if (!req.ready) {
      console.log('  Skipping archive - not ready');
      return next();
    }
    
    console.log('  Planning ConfigMap archival and MONGODB_URI cleanup');
    
    // Guard against missing data field
    const sourceData = req.configMap.data || {};
    
    // Create archived copy in archive namespace (preserves MONGODB_URI for rollback)
    const archiveName = `${req.tenantId}-gen3-backup`;
    const archivedConfigMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: archiveName,
        namespace: ARCHIVE_NAMESPACE,
        labels: {
          'nightscout.io/tenant': req.tenantId,
          'ns.mdn.io/archived': 'true',
          'ns.mdn.io/archived-from': 'gen3'
        },
        annotations: {
          'ns.mdn.io/archived-at': new Date().toISOString(),
          'ns.mdn.io/original-namespace': req.namespace,
          'ns.mdn.io/original-name': req.configMap.metadata.name
        }
      },
      data: { ...sourceData }  // Full copy including MONGODB_URI
    };
    
    res.attachments.push(archivedConfigMap);
    console.log(`  Created archived ConfigMap: ${ARCHIVE_NAMESPACE}/${archiveName}`);
    
    // Return modified ConfigMap with MONGODB_URI stripped (Gen4 uses Secret for credentials)
    const strippedConfigMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: req.configMap.metadata.name,
        namespace: req.namespace,
        labels: { ...(req.configMap.metadata.labels || {}) },
        annotations: { ...(req.configMap.metadata.annotations || {}) }
      },
      data: { ...sourceData }
    };
    
    // Remove sensitive MongoDB URI (Gen4 uses app-credentials Secret instead)
    delete strippedConfigMap.data.MONGODB_URI;
    
    res.attachments.push(strippedConfigMap);
    console.log('  Stripped MONGODB_URI from active ConfigMap');
    
    // Set completion annotation on ConfigMap (signals userdata migration done)
    res.annotations = res.annotations || {};
    res.annotations['nightscout.io/userdata-migration-completed'] = new Date().toISOString();
    console.log('  Set userdata-migration-completed annotation');
    
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
   * Return attachments, annotations, and label modifications to Metacontroller
   */
  function assembleResponse(req, res, next) {
    const response = {
      attachments: res.attachments
    };
    
    // Only include labels if modifications planned
    if (res.labels) {
      response.labels = res.labels;
    }
    
    // Only include annotations if modifications planned
    if (res.annotations) {
      response.annotations = res.annotations;
    }
    
    console.log('  Response:', {
      attachments: response.attachments.length,
      labelModifications: res.labels ? Object.keys(res.labels).length : 0,
      annotationModifications: res.annotations ? Object.keys(res.annotations).length : 0
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
    const tenantId = parent.metadata?.labels?.internal_name;
    
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
