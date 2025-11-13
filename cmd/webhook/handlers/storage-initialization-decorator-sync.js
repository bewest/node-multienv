/**
 * Storage Initialization Decorator Controller
 * 
 * Manages durable state markers on mongo-auth Secrets for replica set initialization
 * 
 * Target: mongo-auth Secret (v1/secrets with storage.nightscout.org/account label)
 * Related Resources:
 *   - StorageAccount CRD (to read status conditions)
 *   - init-mongo-cluster Job (to detect completion)
 * 
 * Responsibilities:
 *   1. Track replica set initialization state via Secret annotations
 *   2. Update ns.mdn.io/replica-set-initialized when init Job succeeds
 *   3. Coordinate migration intent via nightscout.io/migrate-to-dedicated annotation
 *   4. Preserve protected Secret lifecycle (no ownership changes)
 * 
 * Key Design Points:
 *   - Decorator pattern: only manages annotations/labels, doesn't own resources
 *   - Durable state: annotations survive CRD deletion/recreation
 *   - Separation of concerns: Storage Composite owns infrastructure, decorator owns metadata
 *   - Migration support: detects shared → dedicated transitions
 */

const { ANNOTATIONS, LABELS } = require('./constants');

/**
 * Create storage initialization decorator sync handler with pipeline pattern
 */
function createStorageInitializationDecoratorSync(config) {
  
  /**
   * Stage 1: Initialize context from webhook request
   * Extracts Secret (parent), related resources
   */
  function initializeContext(req, res, next) {
    const { object: secret, attachments, related } = req.body;
    
    req.secret = secret;
    req.related = related || {};
    req.secretName = secret.metadata.name;
    req.namespace = secret.metadata.namespace;
    
    // Extract storage account ID from labels
    req.storageAccountId = secret.metadata.labels?.['storage.nightscout.org/account'];
    
    // Check if replica set is already initialized
    req.rsInitialized = secret.metadata?.annotations?.['ns.mdn.io/replica-set-initialized'];
    req.runtimeRequired = req.secret.metadata.annotations['ns.mdn.io/runtime-required'];
    
    console.log(`Storage initialization decorator sync for Secret: ${req.secretName}`);
    console.log(`  Storage account: ${req.storageAccountId}`);
    console.log(`  Infrastructure required: ${secret.metadata.annotations['ns.mdn.io/runtime-required']}`);
    console.log(`  Replica set initialized: ${req.rsInitialized ? 'yes' : 'no'}`);
    
    return next();
  }
  
  /**
   * Stage 2: Discover StorageAccount from related resources
   * Needed to check migration intent and status conditions
   */
  function discoverStorageAccount(req, res, next) {
    if (!req.storageAccountId) {
      console.log('  WARNING: Secret missing storage.nightscout.org/account label');
      // Return current labels/annotations unchanged
      res.send({
        labels: req.secret.metadata?.labels || {},
        annotations: req.secret.metadata?.annotations || {}
      });
      return;
    }
    
    // Find StorageAccount in related resources
    const storageAccounts = req.related['StorageAccount.nightscout.io/v1alpha1'] || {};
    req.storageAccount = storageAccounts[req.storageAccountId];
    
    if (!req.storageAccount) {
      console.log(`  StorageAccount ${req.storageAccountId} not found in related resources`);
      // Return current labels/annotations unchanged - StorageAccount may not exist yet
      res.send({
        labels: req.secret.metadata?.labels || {},
        annotations: req.secret.metadata?.annotations || {}
      });
      return;
    }
    
    console.log(`  StorageAccount found: ${req.storageAccountId}`);
    
    return next();
  }
  
  /**
   * Stage 3: Check init-mongo-cluster Job status
   * Detects when replica set initialization has completed
   */
  function checkInitJob(req, res, next) {
    // If already initialized, skip Job checking
    if (req.rsInitialized) {
      console.log('  Replica set already initialized - skipping Job check');
      return next();
    }
    if (req.runtimeRequired != 'dedicated') {
      console.log('  No provisioning job required');
      return next();
    }
    
    // Find init Job in related resources
    const jobs = req.related['Job.batch/v1'] || {};
    const initJobName = `${req.storageAccountId}-init-mongo-cluster`;
    req.initJob = jobs[initJobName];
    
    if (!req.initJob) {
      console.log(`  Init Job ${initJobName} not found - initialization not started yet`);
      // renderInitMongoClusterJob
      // const initJob = renderInitMongoClusterJob(req.parent, storageAccount, config);
      return next();
    }
    
    // Check Job status
    const jobStatus = req.initJob.status || {};
    req.jobSucceeded = (jobStatus.succeeded || 0) > 0;
    req.jobFailed = (jobStatus.failed || 0) > 0;
    req.jobActive = (jobStatus.active || 0) > 0;
    
    console.log(`  Init Job status: succeeded=${req.jobSucceeded}, failed=${req.jobFailed}, active=${req.jobActive}`);
    
    return next();
  }
  
  /**
   * Stage 4: Update Secret annotations based on Job status
   * Sets replica-set-initialized marker when Job succeeds
   */
  function updateAnnotations(req, res, next) {
    let modified = false;
    const annotations = { ...(req.secret.metadata.annotations || {}) };
    
    // Update replica set initialization marker
    if (!req.rsInitialized && req.jobSucceeded) {
      console.log('  Init Job succeeded - marking Secret as initialized');
      annotations['ns.mdn.io/replica-set-initialized'] = new Date().toISOString();
      modified = true;
    }
    
    // Store whether we modified anything
    req.annotationsModified = modified;
    req.updatedAnnotations = annotations;
    
    return next();
  }
  
  /**
   * Stage 5: Handle migration intent detection
   * Detects and tracks migration requests for shared → dedicated transitions
   * 
   * Migration annotation originates from ComputeInstance:
   *   nightscout.io/migrate-to-dedicated=true
   * 
   * When detected, the Storage Composite provisions dedicated infrastructure
   * This decorator tracks the migration state on the Secret
   */
  function handleMigrationIntent(req, res, next) {
    if (req.secret.metadata.annotations['ns.mdn.io/runtime-required'] == 'dedicated') {
      return next( );
    }

    // Check for migration annotation on ComputeInstance (origin)
    const computeInstances = req.related['ComputeInstance.nightscout.io/v1alpha1'] || {};
    let migrationRequested = false;
    
    // Check all ComputeInstances associated with this storage account
    for (const [name, instance] of Object.entries(computeInstances)) {
      if (instance.metadata?.annotations?.['nightscout.io/migrate-to-dedicated'] === 'true') {
        console.log(`  Migration annotation found on ComputeInstance: ${name}`);
        migrationRequested = true;
        break;
      }
    }


    const isDedicated = req.storageAccount?.spec?.storageType === 'dedicated';
    const isHybrid = req.storageAccount?.spec?.storageType === 'shared' && migrationRequested;
    req.updatedAnnotations = req.updatedAnnotations || { ...(req.secret.metadata.annotations || {}) };
    req.updatedAnnotations['ns.mdn.io/runtime-required'] = isDedicated || isHybrid ? 'dedicated' : 'shared';
    req.annotationsModified = true;
    
    console.log("SETTING runtime-required", req.updatedAnnotations);
    
    return next();
  }
  
  /**
   * Stage 6: Format response
   * Returns only labels and annotations (decorator response format)
   */
  function formatResponse(req, res, next) {
    if (req.annotationsModified) {
      // Return only the annotations that changed (decorator format)
      console.log('  Returning updated annotations');
      res.send({
        labels: req.secret.metadata?.labels || {},
        annotations: req.updatedAnnotations
      });
    } else {
      // No changes needed - return current labels/annotations
      console.log('  No changes needed');
      res.send({
        // labels: req.secret.metadata?.labels || {},
        // annotations: req.secret.metadata?.annotations || {}
        attachments: [ ]
      });
    }
  }
  
  // Pipeline: chain all stages together
  return [
    initializeContext,
    discoverStorageAccount,
    checkInitJob,
    handleMigrationIntent,
    // updateAnnotations,
    formatResponse,
  ];
}

module.exports = { createStorageInitializationDecoratorSync };
