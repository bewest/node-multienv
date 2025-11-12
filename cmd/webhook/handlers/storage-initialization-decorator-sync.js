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
    const { object: secret, related } = req.body;
    
    req.secret = secret;
    req.related = related || {};
    req.secretName = secret.metadata.name;
    req.namespace = secret.metadata.namespace;
    
    // Extract storage account ID from labels
    req.storageAccountId = secret.metadata.labels?.['storage.nightscout.org/account'];
    
    // Check if replica set is already initialized
    req.rsInitialized = secret.metadata?.annotations?.['ns.mdn.io/replica-set-initialized'];
    
    console.log(`Storage initialization decorator sync for Secret: ${req.secretName}`);
    console.log(`  Storage account: ${req.storageAccountId}`);
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
      // Return unmodified Secret
      res.send({ object: req.secret });
      return;
    }
    
    // Find StorageAccount in related resources
    const storageAccounts = req.related['StorageAccount.nightscout.io/v1alpha1'] || {};
    req.storageAccount = storageAccounts[req.storageAccountId];
    
    if (!req.storageAccount) {
      console.log(`  StorageAccount ${req.storageAccountId} not found in related resources`);
      // Return unmodified Secret - StorageAccount may not exist yet
      res.send({ object: req.secret });
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
    
    // Find init Job in related resources
    const jobs = req.related['Job.batch/v1'] || {};
    const initJobName = `${req.storageAccountId}-init-mongo-cluster`;
    req.initJob = jobs[initJobName];
    
    if (!req.initJob) {
      console.log(`  Init Job ${initJobName} not found - initialization not started yet`);
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
   * Migration can be triggered by:
   * 1. ComputeInstance annotation: nightscout.io/migrate-to-dedicated=true
   * 2. Secret annotation: nightscout.io/migrate-to-dedicated=true
   * 
   * When detected, the Storage Composite will provision dedicated infrastructure
   * This decorator tracks the migration state on the Secret
   */
  function handleMigrationIntent(req, res, next) {
    const migrationRequested = req.secret.metadata?.annotations?.['nightscout.io/migrate-to-dedicated'];
    const migrationInProgress = req.secret.metadata?.annotations?.['ns.mdn.io/migration-status'];
    
    if (migrationRequested === 'true') {
      console.log('  Migration to dedicated storage requested');
      
      // Check if StorageAccount is now dedicated (migration infrastructure provisioned)
      const isDedicated = req.storageAccount?.spec?.storageType === 'dedicated';
      const isHybrid = req.storageAccount?.spec?.storageType === 'hybrid-migration';
      
      if (isDedicated || isHybrid) {
        console.log(`  Storage is now ${req.storageAccount.spec.storageType} - migration infrastructure available`);
        
        // Update migration status if not already set
        if (migrationInProgress !== 'infrastructure-ready') {
          console.log('  Marking migration infrastructure as ready');
          req.updatedAnnotations = req.updatedAnnotations || { ...(req.secret.metadata.annotations || {}) };
          req.updatedAnnotations['ns.mdn.io/migration-status'] = 'infrastructure-ready';
          req.updatedAnnotations['ns.mdn.io/migration-infrastructure-timestamp'] = new Date().toISOString();
          req.annotationsModified = true;
        }
      } else {
        // Migration requested but infrastructure not provisioned yet
        console.log('  Migration requested but infrastructure not yet provisioned');
        if (migrationInProgress !== 'pending') {
          req.updatedAnnotations = req.updatedAnnotations || { ...(req.secret.metadata.annotations || {}) };
          req.updatedAnnotations['ns.mdn.io/migration-status'] = 'pending';
          req.annotationsModified = true;
        }
      }
    }
    
    return next();
  }
  
  /**
   * Stage 6: Format response
   * Returns modified Secret or original if no changes
   */
  function formatResponse(req, res, next) {
    if (req.annotationsModified) {
      console.log('  Returning modified Secret with updated annotations');
      
      const updatedSecret = {
        ...req.secret,
        metadata: {
          ...req.secret.metadata,
          annotations: req.updatedAnnotations
        }
      };
      
      res.send({ object: updatedSecret });
    } else {
      console.log('  No changes needed - returning original Secret');
      res.send({ object: req.secret });
    }
    
    return next();
  }
  
  // Pipeline: chain all stages together
  return [
    initializeContext,
    discoverStorageAccount,
    checkInitJob,
    updateAnnotations,
    handleMigrationIntent,
    formatResponse,
  ];
}

module.exports = { createStorageInitializationDecoratorSync };
