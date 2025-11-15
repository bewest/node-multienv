/**
 * Storage Initialization Decorator Controller
 * 
 * Manages durable state markers on mongo-auth Secrets for replica set initialization
 * 
 * Target: mongo-auth Secret (v1/secrets with storage.nightscout.org/account label)
 * Related Resources:
 *   - StorageAccount CRD (to read status conditions)
 *   - init-mongo-cluster Job (to detect completion)
 *   - ComputeInstance CRDs (to detect migration requests)
 * 
 * Responsibilities:
 *   1. Set ns.mdn.io/runtime-required (shared/dedicated) based on StorageAccount spec and migration requests
 *   2. Track replica set initialization state via ns.mdn.io/replica-set-initialized annotation
 *   3. Preserve protected Secret lifecycle (no ownership changes)
 * 
 * Response Format:
 *   - Changes needed: { labels?, annotations? } (patch format)
 *   - No changes: { attachments: [] } (no-op)
 */

const { ANNOTATIONS, LABELS } = require('./constants');

/**
 * Create storage initialization decorator sync handler with pipeline pattern
 */
function createStorageInitializationDecoratorSync(config) {
  
  /**
   * Initialize request context and response containers
   */
  function initialize(req, res, next) {
    const { object: secret, related } = req.body;
    
    req.secret = secret;
    req.related = related || {};
    req.storageAccountId = secret.metadata.labels?.['storage.nightscout.org/account'];
    
    // Response containers - only set if we need to patch
    res.labels = undefined;
    res.annotations = undefined;
    
    console.log(`Storage Init Decorator: ${secret.metadata.name}`);
    console.log(`  Account: ${req.storageAccountId}`);
    
    return next();
  }
  
  /**
   * Discover related StorageAccount CRD
   */
  function discoverStorageAccount(req, res, next) {
    if (!req.storageAccountId) {
      console.log('  No storage account label - skipping');
      return next();
    }
    
    const storageAccounts = req.related['StorageAccount.nightscout.io/v1alpha1'] || {};
    req.storageAccount = storageAccounts[req.storageAccountId];
    
    if (!req.storageAccount) {
      console.log('  StorageAccount not found in related resources');
    }
    
    return next();
  }
  
  /**
   * Determine infrastructure requirements (shared vs dedicated)
   * Sets ns.mdn.io/runtime-required annotation based on:
   * - StorageAccount spec.storageType
   * - Migration requests from ComputeInstances
   */
  function determineRuntimeRequirements(req, res, next) {
    const currentValue = req.secret.metadata.annotations?.['ns.mdn.io/runtime-required'];
    
    // Skip if already set to dedicated
    if (currentValue === 'dedicated') {
      console.log('  Runtime already dedicated');
      return next();
    }
    
    // Check StorageAccount spec
    const isDedicated = req.storageAccount?.spec?.storageType === 'dedicated';
    
    // Check for migration requests from ComputeInstances
    const computeInstances = req.related['ComputeInstance.nightscout.io/v1alpha1'] || {};
    let migrationRequested = false;
    
    for (const [name, instance] of Object.entries(computeInstances)) {
      if (instance.metadata?.annotations?.['nightscout.io/migrate-to-dedicated'] === 'true') {
        console.log(`  Migration requested by ComputeInstance: ${name}`);
        migrationRequested = true;
        break;
      }
    }
    
    // Determine required value
    const requiredValue = (isDedicated || migrationRequested) ? 'dedicated' : 'shared';
    
    // Only update if different from current
    if (requiredValue !== currentValue) {
      console.log(`  Setting runtime-required: ${currentValue} → ${requiredValue}`);
      res.annotations = res.annotations || {};
      res.annotations['ns.mdn.io/runtime-required'] = requiredValue;
    }
    
    return next();
  }
  
  /**
   * Track replica set initialization completion
   * Sets ns.mdn.io/replica-set-initialized when init Job succeeds
   */
  function trackReplicaSetInitialization(req, res, next) {
    const rsInitialized = req.secret.metadata.annotations?.['ns.mdn.io/replica-set-initialized'];
    const runtimeRequired = req.secret.metadata.annotations?.['ns.mdn.io/runtime-required'];
    
    // Skip if already initialized or not dedicated infrastructure
    if (rsInitialized) {
      console.log('  Replica set already initialized');
      return next();
    }
    
    if (runtimeRequired !== 'dedicated') {
      console.log('  Shared infrastructure - no replica set initialization needed');
      return next();
    }
    
    // Find init Job in related resources
    const jobs = req.related['Job.batch/v1'] || {};
    const initJobName = `${req.storageAccountId}-init-mongo-cluster`;
    const initJob = jobs[initJobName];
    
    if (!initJob) {
      console.log('  Init Job not found - initialization not started');
      return next();
    }
    
    // Check if Job succeeded
    const jobStatus = initJob.status || {};
    const succeeded = (jobStatus.succeeded || 0) > 0;
    
    if (succeeded) {
      console.log('  Init Job succeeded - marking replica set initialized');
      res.annotations = res.annotations || {};
      res.annotations['ns.mdn.io/replica-set-initialized'] = new Date().toISOString();
    } else {
      console.log(`  Init Job status: active=${jobStatus.active || 0}, failed=${jobStatus.failed || 0}`);
    }
    
    return next();
  }
  
  /**
   * Format decorator response
   * Returns patch (labels/annotations) or no-op (empty attachments)
   */
  function formatResponse(req, res, next) {
    const hasChanges = res.labels || res.annotations;
    
    if (hasChanges) {
      const response = {};
      if (res.labels) response.labels = res.labels;
      if (res.annotations) response.annotations = res.annotations;
      
      console.log('  Returning patch:', JSON.stringify(response, null, 2));
      res.send(response);
    } else {
      console.log('  No changes - returning no-op');
      res.send({ attachments: [] });
    }
  }
  
  // Pipeline: clean, sequential flow
  return [
    initialize,
    discoverStorageAccount,
    determineRuntimeRequirements,
    trackReplicaSetInitialization,
    formatResponse
  ];
}

module.exports = { createStorageInitializationDecoratorSync };
