/**
 * Tenant Composite Controller (Gen 5 Architecture)
 * 
 * Two-phase provisioning model with ConfigMap-based compute activation
 * 
 * Parent: NightscoutTenant CRD (nightscout.io/v1alpha1)
 * 
 * Phase 1 (Provisioner creates):
 *   - PVC (referenced by spec.pvcName)
 *   - mongo-auth Secret (referenced by spec.mongoAuthSecretRef)
 *   - NightscoutTenant CR (minimal spec with refs)
 * 
 * Phase 2 (ConfigMap signals compute):
 *   - Provisioner creates ConfigMap matching spec.selector
 *   - Controller detects ConfigMap and renders compute layer
 * 
 * Children (Storage Only - No ConfigMap):
 *   - MongoDB Keyfile Secret
 *   - Init Replica Set Job (if needed)
 * 
 * Children (Storage + Compute - ConfigMap Present):
 *   - ReplicaSet (replicas: 1, co-located MongoDB + Nightscout)
 *   - MongoDB Keyfile Secret
 *   - Nightscout Secret (generated from mongo-auth)
 *   - Init Replica Set Job (if needed)
 * 
 * Related (not owned):
 *   - PVC (created by provisioner, referenced in spec)
 *   - mongo-auth Secret (created by provisioner, referenced in spec)
 *   - ConfigMap (created by provisioner, fetched via customize hook)
 */

const crypto = require('crypto');
const { ANNOTATIONS, LABELS, RESOURCE_TYPES } = require('./constants');
const { 
  generateSecurePassword, 
  generateUsername,
  generateAppCredentials,
  renderAppCredentialsSecret,
  renderNightscoutSecret
} = require('./resources');

function createTenantCompositeSync(config) {
  
  /**
   * Helper: Find resource by name and namespace in children or related collections
   * Handles both object (keyed by name) and array formats from Metacontroller
   */
  function findResource(collection, resourceName, namespace) {
    if (!collection) return null;
    
    // Helper to match both name and namespace
    function matchesResource(resource) {
      return resource.metadata?.name === resourceName &&
             resource.metadata?.namespace === namespace;
    }
    
    // Direct object lookup (common for children indexed by name)
    if (collection[resourceName]) {
      const resource = collection[resourceName];
      // Verify namespace matches to avoid cross-namespace pollution
      if (resource.metadata?.namespace === namespace) {
        return resource;
      }
    }
    
    // Array format (common for related resources with label selectors)
    if (Array.isArray(collection)) {
      return collection.find(matchesResource);
    }
    
    // Object with resource values (iterate to find by name AND namespace)
    const values = Object.values(collection);
    if (values.length > 0 && values[0]?.metadata) {
      return values.find(matchesResource);
    }
    
    return null;
  }
  
  /**
   * Helper: Clean resource by removing server-populated fields
   * Returns a new object suitable for desired state in res.children
   */
  function cleanResource(resource) {
    const cleaned = JSON.parse(JSON.stringify(resource));
    
    // Remove server-populated metadata fields
    if (cleaned.metadata) {
      delete cleaned.metadata.resourceVersion;
      delete cleaned.metadata.uid;
      delete cleaned.metadata.generation;
      delete cleaned.metadata.creationTimestamp;
      delete cleaned.metadata.deletionTimestamp;
      delete cleaned.metadata.deletionGracePeriodSeconds;
      delete cleaned.metadata.managedFields;
      delete cleaned.metadata.selfLink;
      delete cleaned.metadata.ownerReferences; // Metacontroller sets this
    }
    
    // Remove status (not part of desired state)
    delete cleaned.status;
    
    return cleaned;
  }
  
  /**
   * Stage 1: Initialize context from webhook request
   */
  function initializeContext(req, res, next) {
    const { parent, children, related } = req.body;
    
    req.parent = parent;
    req.children = children;
    req.related = related;
    req.tenantId = parent.metadata.name;
    req.namespace = parent.metadata.namespace;
    req.spec = parent.spec || {};
    
    // Initialize response
    res.children = [];
    res.status = { phase: 'Pending', conditions: [] };
    
    console.log('Tenant composite sync for tenant:', req.tenantId);
    
    return next();
  }
  
  /**
   * Stage 2: Ensure MongoDB keyfile Secret exists
   */
  function ensureMongoKeyfile(req, res, next) {
    const tenantId = req.tenantId;
    const namespace = req.namespace;
    const keyfileSecretName = `${tenantId}-mongo-keyfile`;
    
    // Check if keyfile Secret already exists (robust lookup with namespace)
    const existingKeyfile = findResource(req.children['secrets.v1'], keyfileSecretName, namespace) || 
                           findResource(req.related['secrets.v1'], keyfileSecretName, namespace);
    
    if (existingKeyfile) {
      console.log(`  Keyfile Secret ${keyfileSecretName} exists`);
      req.keyfileSecret = existingKeyfile;
      // CRITICAL: Clean and add to res.children to keep it in desired state
      res.children.push(cleanResource(existingKeyfile));
      return next();
    }
    
    // Generate new keyfile Secret
    console.log(`  Generating keyfile Secret for ${tenantId}`);
    const keyfileData = crypto.randomBytes(64).toString('base64');
    
    const keyfileSecret = {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'Opaque',
      metadata: {
        name: keyfileSecretName,
        namespace: namespace,
        labels: {
          'app.kubernetes.io/name': 'mongodb-keyfile',
          'app.kubernetes.io/component': 'database',
          'app.kubernetes.io/part-of': 'nightscout-tenant',
          'app.kubernetes.io/instance': tenantId,
          'app.kubernetes.io/managed-by': 'metacontroller',
          'ns.mdn.io/tenant': tenantId
        },
        annotations: {
          'ns.mdn.io/created-at': new Date().toISOString(),
          'ns.mdn.io/description': 'MongoDB replica set keyfile for member authentication'
        }
      },
      stringData: {
        keyfile: keyfileData
      }
    };
    
    res.children.push(keyfileSecret);
    req.keyfileSecret = keyfileSecret;
    console.log(`  Added keyfile Secret to children`);
    
    return next();
  }
  
  /**
   * Stage 3: Read MongoDB auth Secret from spec.mongoAuthSecretRef
   * Gen5: Provisioner owns mongo-auth Secret (not controller)
   */
  function ensureMongoAuthSecret(req, res, next) {
    const tenantId = req.tenantId;
    const namespace = req.namespace;
    const spec = req.spec;
    
    // Resolve mongo-auth Secret from spec reference
    const mongoAuthSecretRef = spec.mongoAuthSecretRef;
    if (!mongoAuthSecretRef || !mongoAuthSecretRef.name) {
      console.error(`  ERROR: spec.mongoAuthSecretRef.name not provided for ${tenantId}`);
      res.status.phase = 'Error';
      res.status.conditions.push({
        type: 'MongoAuthSecretResolved',
        status: 'False',
        reason: 'MissingReference',
        message: 'spec.mongoAuthSecretRef.name is required but not provided'
      });
      req.authSecret = null;
      return next();
    }
    
    const authSecretName = mongoAuthSecretRef.name;
    console.log(`  Looking up mongo-auth Secret: ${authSecretName}`);
    
    // Find Secret in related resources (provisioner-owned, not a child)
    const existingAuth = findResource(req.related['secrets.v1'], authSecretName, namespace);
    
    if (!existingAuth) {
      console.error(`  ERROR: mongo-auth Secret ${authSecretName} not found in related resources`);
      res.status.phase = 'Pending';
      res.status.conditions.push({
        type: 'MongoAuthSecretResolved',
        status: 'False',
        reason: 'SecretNotFound',
        message: `mongo-auth Secret ${authSecretName} not found (provisioner must create it)`
      });
      req.authSecret = null;
      return next();
    }
    
    console.log(`  Found mongo-auth Secret ${authSecretName}`);
    
    // Hydrate derived values from Secret data (base64-encoded)
    req.authSecret = existingAuth;
    req.databaseName = Buffer.from(existingAuth.data?.MONGO_INITDB_DATABASE || '', 'base64').toString('utf-8') ||
                      Buffer.from(existingAuth.data?.database || '', 'base64').toString('utf-8');
    // req.mongoUsername = Buffer.from(existingAuth.data?.username || '', 'base64').toString('utf-8');
    // req.mongoPassword = Buffer.from(existingAuth.data?.password || '', 'base64').toString('utf-8');
    
    console.log(`  Hydrated: database=${req.databaseName}`);
    
    // DO NOT add to res.children (provisioner owns it, not Metacontroller)
    
    res.status.conditions.push({
      type: 'MongoAuthSecretResolved',
      status: 'True',
      reason: 'SecretFound',
      message: `mongo-auth Secret ${authSecretName} resolved successfully`
    });
    
    return next();
  }
  
  /**
   * Stage 3a: Set runtime-required annotation and detect credential requirements
   * Gen5: Standardized credential detection logic (shared with Gen4)
   * 
   * Credentials required when:
   * 1. Storage type is 'dedicated' (from mongo-auth Secret annotation or spec)
   * 2. Migration requested (nightscout.io/migrate-to-dedicated annotation)
   */
  function setRuntimeRequiredAnnotation(req, res, next) {
    const spec = req.spec;
    const initialStorageType = spec?.initialStorageType;
    
    // Check migration annotation on parent CR
    req.migrationRequested = req.parent.metadata?.annotations?.['nightscout.io/migrate-to-dedicated'] === 'true';
    
    // Read runtime-required from mongo-auth Secret (set by provisioner or decorator)
    const runtimeRequired = req.authSecret?.metadata?.annotations?.['ns.mdn.io/runtime-required'];
    req.storageType = runtimeRequired || initialStorageType;
    
    // Standardized credential detection (matches Gen4 storage-credentials decorator)
    req.credentialsRequested = req.storageType === 'dedicated' || req.migrationRequested;
    
    console.log(`  Migration requested: ${req.migrationRequested}`);
    console.log(`  Storage type: ${req.storageType}`);
    console.log(`  Credentials requested: ${req.credentialsRequested}`);
    
    // Stamp annotation on parent CR for Gen3/Gen4 decorator compatibility
    if (!res.annotations) {
      res.annotations = {};
    }
    res.annotations['ns.mdn.io/runtime-required'] = initialStorageType;
    
    console.log(`  Set runtime-required annotation: ${initialStorageType}`);
    
    return next();
  }
  
  /**
   * Stage 3b: Detect compute activation via ConfigMap presence
   * Gen5: ConfigMap signals compute layer should be rendered
   */
  function detectComputeActivation(req, res, next) {
    const tenantId = req.tenantId;
    const spec = req.spec;
    const selector = spec.selector || {};
    
    console.log(`Stage 3b: Detecting compute activation for ${tenantId}`);
    console.log(`  Selector: ${JSON.stringify(selector)}`);
    
    // Preserve existing Error phase (don't override)
    const currentPhase = res.status.phase;
    const inErrorState = currentPhase === 'Error';
    
    // No selector means no compute activation
    if (Object.keys(selector).length === 0) {
      console.log(`  No selector configured - compute disabled`);
      req.computeEnabled = false;
      req.computeConfigMap = null;
      
      // Only set phase if not already in Error state
      if (!inErrorState) {
        res.status.phase = 'Provisioned';
      }
      
      res.status.conditions.push({
        type: 'ComputeActivated',
        status: 'False',
        reason: 'NoSelector',
        message: 'No spec.selector configured (storage-only mode)'
      });
      return next();
    }
    
    // Look for ConfigMap matching selector in related resources
    // Handle both array and object map formats
    const configMaps = req.related['configmaps.v1'];
    let matchingConfigMap = null;
    
    if (Array.isArray(configMaps)) {
      // Array format
      matchingConfigMap = configMaps.find(cm => {
        const labels = cm.metadata?.labels || {};
        return Object.entries(selector).every(([key, value]) => labels[key] === value);
      });
    } else if (configMaps && typeof configMaps === 'object') {
      // Object map format
      const configMapArray = Object.values(configMaps);
      matchingConfigMap = configMapArray.find(cm => {
        const labels = cm.metadata?.labels || {};
        return Object.entries(selector).every(([key, value]) => labels[key] === value);
      });
    }
    
    if (matchingConfigMap) {
      console.log(`  Found compute ConfigMap: ${matchingConfigMap.metadata.name}`);
      req.computeEnabled = true;
      req.computeConfigMap = matchingConfigMap;
      // Status phase will be set later based on ReplicaSet readiness
      // Don't override Error phase
      res.status.conditions.push({
        type: 'ComputeActivated',
        status: 'True',
        reason: 'ConfigMapFound',
        message: `ConfigMap ${matchingConfigMap.metadata.name} found (compute enabled)`
      });
    } else {
      console.log(`  No matching ConfigMap found - compute disabled`);
      req.computeEnabled = false;
      req.computeConfigMap = null;
      
      // Only set phase if not already in Error state
      if (!inErrorState) {
        res.status.phase = 'Provisioned';
      }
      
      res.status.conditions.push({
        type: 'ComputeActivated',
        status: 'False',
        reason: 'ConfigMapNotFound',
        message: 'No ConfigMap matching spec.selector found (storage-only mode)'
      });
    }
    
    return next();
  }
  
  /**
   * Stage 3c: Ensure Nightscout application secret exists
   * Generates API_SECRET and MONGO_CONNECTION from MongoDB credentials
   * Gen5: Only renders when compute is activated (ConfigMap present)
   */
  function ensureNightscoutSecret(req, res, next) {
    const tenantId = req.tenantId;
    const namespace = req.namespace;
    const nsSecretName = `${tenantId}-nightscout`;
    
    console.log(`Stage 3c: Ensuring Nightscout secret ${nsSecretName}`);
    
    // Skip if compute not activated
    if (!req.computeEnabled) {
      console.log(`  Compute not activated - skipping Nightscout secret`);
      return next();
    }
    
    // Guard: Skip if authSecret is missing (Error state from ensureMongoAuthSecret)
    if (!req.authSecret) {
      console.log(`  Auth secret missing - skipping Nightscout secret (Error state)`);
      return next();
    }
    
    // Check if secret already exists
    const existingSecret = findResource(req.children['secrets.v1'], nsSecretName, namespace);
    
    if (existingSecret) {
      console.log(`  Found existing Nightscout secret`);
      const cleaned = cleanResource(existingSecret);
      res.children.push(cleaned);
      req.nightscoutSecret = cleaned;
      return next();
    }
    
    // Generate new Nightscout secret using shared helper
    console.log(`  Generating Nightscout Secret`);
    
    // Extract MongoDB credentials from auth secret
    // Handle both stringData (newly created) and data (existing, base64-encoded)
    let mongoUsername, mongoPassword, mongoDatabase;
    
    if (req.authSecret.stringData) {
      // New secret with stringData
      mongoUsername = req.authSecret.stringData.username;
      mongoPassword = req.authSecret.stringData.password;
      mongoDatabase = req.authSecret.stringData.database;
    } else if (req.authSecret.data) {
      // Existing secret with base64-encoded data
      mongoUsername = Buffer.from(req.authSecret.data.username || '', 'base64').toString('utf8');
      mongoPassword = Buffer.from(req.authSecret.data.password || '', 'base64').toString('utf8');
      mongoDatabase = Buffer.from(req.authSecret.data.database || '', 'base64').toString('utf8');
    } else {
      // Fallback defaults
      mongoUsername = 'nsuser';
      mongoPassword = '';
      mongoDatabase = req.databaseName || `ns_${tenantId.replace(/-/g, '_')}`;
    }
    
    // Use shared helper to render Nightscout Secret
    const nightscoutSecret = renderNightscoutSecret(
      tenantId,
      namespace,
      {
        username: mongoUsername,
        password: mongoPassword,
        database: mongoDatabase
      },
      existingSecret,  // null for first cycle, existing Secret to preserve
      req.parent.metadata.labels || {}
    );
    
    res.children.push(nightscoutSecret);
    req.nightscoutSecret = nightscoutSecret;
    console.log(`  Added Nightscout Secret to children`);
    
    return next();
  }
  
  /**
   * Stage 4: Check initialization status and determine phase
   * Uses durable parent status for replica set initialization state
   */
  function detectPhase(req, res, next) {
    const tenantId = req.tenantId;
    const pvcName = `data-${tenantId}-0`;
    const initJobName = `${tenantId}-init-rs`;
    
    // Helper: Find PVC in children or related (with namespace matching)
    function findPVC() {
      return findResource(req.children['persistentvolumeclaims.v1'], pvcName, req.namespace) ||
             findResource(req.related['persistentvolumeclaims.v1'], pvcName, req.namespace);
    }
    
    // Helper: Find init Job in children (with namespace matching)
    function findInitJob() {
      return findResource(req.children['jobs.batch/v1'], initJobName, req.namespace);
    }
    
    // Check for existing PVC
    const existingPVC = findPVC();
    const pvcBound = existingPVC?.status?.phase === 'Bound';
    
    // Check for durable PVC bound marker (persisted once observed)
    const pvcBoundCondition = req.parent.status?.conditions?.find(
      c => c.type === 'PVCBound' && c.status === 'True'
    );
    const pvcBoundDurable = !!pvcBoundCondition || pvcBound;
    
    // Check for durable replica set initialization marker
    const replicaSetInitCondition = req.parent.status?.conditions?.find(
      c => c.type === 'ReplicaSetInitialized' && c.status === 'True'
    );
    
    // Check if init Job just completed (if not already marked)
    const initJob = findInitJob();
    const jobJustSucceeded = initJob?.status?.succeeded > 0;
    const replicaSetInitialized = !!replicaSetInitCondition || jobJustSucceeded;
    
    // Store state for use in other middleware
    req.pvcExists = !!existingPVC;
    req.pvcBound = pvcBoundDurable;
    req.pvcName = pvcName;
    req.replicaSetInitialized = replicaSetInitialized;
    req.jobJustSucceeded = jobJustSucceeded;
    req.pvcJustBound = pvcBound && !pvcBoundCondition;
    
    // Log current state for debugging
    console.log(`  Resource state:`);
    console.log(`    - PVC: ${existingPVC ? 'exists' : 'missing'}, bound: ${pvcBound} (durable: ${pvcBoundDurable})`);
    console.log(`    - Job: ${initJob ? 'exists' : 'missing'}, succeeded: ${jobJustSucceeded} (durable: ${!!replicaSetInitCondition})`);
    
    // Transition to Ready phase when BOTH conditions are durably true
    if (pvcBoundDurable && replicaSetInitialized) {
      console.log(`  Phase: Ready (all prerequisites met)`);
      req.targetPhase = 'Ready';
    } else {
      console.log(`  Phase: Initializing (waiting for: ${!pvcBoundDurable ? 'PVC' : ''} ${!replicaSetInitialized ? 'Job' : ''})`);
      req.targetPhase = 'Initializing';
    }
    
    return next();
  }
  
  /**
   * Stage 4: Assert PVC exists before rendering compute layer
   * Gen5: PVC is provisioner-owned (not a child)
   */
  function assertPVCExists(req, res, next) {
    const spec = req.spec;
    const pvcName = spec.pvcName;
    
    if (!pvcName) {
      console.error(`  ERROR: spec.pvcName not provided`);
      res.status.conditions.push({
        type: 'PVCResolved',
        status: 'False',
        reason: 'MissingPVCReference',
        message: 'spec.pvcName is required but not provided'
      });
      req.pvcExists = false;
      return next();
    }
    
    console.log(`  Checking PVC existence: ${pvcName}`);
    
    // Look for PVC in related resources
    const pvc = findResource(req.related['persistentvolumeclaims.v1'], pvcName, req.namespace);
    
    if (!pvc) {
      console.warn(`  WARNING: PVC ${pvcName} not found (provisioner must create it)`);
      res.status.conditions.push({
        type: 'PVCResolved',
        status: 'False',
        reason: 'PVCNotFound',
        message: `PVC ${pvcName} not found (provisioner must create it)`
      });
      req.pvcExists = false;
      req.pvcBound = false;
    } else {
      const pvcPhase = pvc.status?.phase;
      const pvcBound = pvcPhase === 'Bound';
      
      console.log(`  PVC ${pvcName} found, phase: ${pvcPhase}`);
      req.pvcExists = true;
      req.pvcBound = pvcBound;
      req.pvcName = pvcName;
      
      res.status.conditions.push({
        type: 'PVCResolved',
        status: 'True',
        reason: 'PVCFound',
        message: `PVC ${pvcName} found, phase: ${pvcPhase}`
      });
    }
    
    return next();
  }
  
  /**
   * Stage 5: Render children based on compute activation and initialization annotations
   * Gen5 Decorator-Driven: Read annotations set by tenant-initialization-decorator
   *   - ns.mdn.io/replica-set-initialized: Job orchestration complete
   *   - ns.mdn.io/user-initialized: User creation complete
   */
  function renderChildren(req, res, next) {
    const tenantId = req.tenantId;
    const spec = req.spec;
    
    console.log(`Stage 5: Rendering children for ${tenantId}`);
    console.log(`  Compute enabled: ${req.computeEnabled}`);
    console.log(`  PVC exists: ${req.pvcExists}`);
    console.log(`  Auth secret exists: ${!!req.authSecret}`);
    
    // Storage-only mode (no ConfigMap or compute disabled)
    if (!req.computeEnabled) {
      console.log(`  Storage-only mode - no compute layer`);
      
      // Status already set to 'Provisioned' by detectComputeActivation
      // or 'Error' by ensureMongoAuthSecret
      
      res.status.conditions.push({
        type: 'Ready',
        status: 'False',
        reason: 'ComputeNotActivated',
        message: 'Storage provisioned but compute not activated (ConfigMap missing)'
      });
      
      // Add status fields
      res.status.databaseName = req.databaseName;
      res.status.connectionSecret = req.authSecret?.metadata?.name;
      res.status.observedGeneration = req.parent.metadata.generation;
      
      return next();
    }
    
    // Compute enabled but missing prerequisites (PVC or auth secret)
    if (!req.pvcExists || !req.authSecret) {
      console.log(`  Compute enabled but missing prerequisites`);
      console.log(`    PVC exists: ${req.pvcExists}, Auth secret: ${!!req.authSecret}`);
      
      res.status.phase = 'Pending';
      res.status.conditions.push({
        type: 'Ready',
        status: 'False',
        reason: 'MissingPrerequisites',
        message: `Waiting for: ${!req.pvcExists ? 'PVC ' : ''}${!req.authSecret ? 'mongo-auth secret' : ''}`
      });
      
      res.status.databaseName = req.databaseName;
      res.status.connectionSecret = req.authSecret?.metadata?.name;
      res.status.observedGeneration = req.parent.metadata.generation;
      
      return next();
    }
    
    // Read initialization annotations from parent (set by decorator)
    const annotations = req.parent.metadata?.annotations || {};
    const replicaSetInitialized = annotations['ns.mdn.io/replica-set-initialized'];
    const userInitialized = annotations['ns.mdn.io/user-initialized'];
    
    console.log(`  Replica set initialized: ${replicaSetInitialized || 'no'}`);
    console.log(`  User initialized: ${userInitialized || 'no'}`);
    
    // Compute enabled but initialization not complete (decorator Jobs still running)
    if (!replicaSetInitialized || !userInitialized) {
      console.log(`  Waiting for initialization Jobs (managed by decorator)`);
      
      res.status.phase = 'Initializing';
      res.status.conditions.push({
        type: 'Ready',
        status: 'False',
        reason: 'WaitingForInitialization',
        message: `Waiting for: ${!replicaSetInitialized ? 'replica set init ' : ''}${!userInitialized ? 'user creation' : ''}`
      });
      
      if (replicaSetInitialized) {
        res.status.conditions.push({
          type: 'ReplicaSetInitialized',
          status: 'True',
          reason: 'InitJobSucceeded',
          message: `MongoDB replica set initialized at ${replicaSetInitialized}`
        });
      }
      
      if (userInitialized) {
        res.status.conditions.push({
          type: 'UserInitialized',
          status: 'True',
          reason: 'CreateUserJobSucceeded',
          message: `MongoDB user created at ${userInitialized}`
        });
      }
      
      res.status.databaseName = req.databaseName;
      res.status.connectionSecret = req.authSecret?.metadata?.name;
      res.status.observedGeneration = req.parent.metadata.generation;
      
      return next();
    }
    
    // Prerequisites satisfied and initialization complete - render ReplicaSet
    console.log(`  All prerequisites satisfied - rendering ReplicaSet`);
    
    const replicaSetResource = renderReplicaSet(
      tenantId, 
      req.namespace, 
      spec, 
      req.authSecret, 
      req.keyfileSecret, 
      req.nightscoutSecret, 
      config
    );
    res.children.push(replicaSetResource);
    
    // Check if ReplicaSet is ready
    const replicaSet = findResource(req.children['replicasets.v1.apps'], `${tenantId}-rs`, req.namespace);
    const replicaSetReady = replicaSet?.status?.readyReplicas > 0;
    
    console.log(`  ReplicaSet ready: ${replicaSetReady}`);
    
    // Set phase and conditions based on ReplicaSet readiness
    if (replicaSetReady) {
      res.status.phase = 'Running';
      res.status.conditions.push({
        type: 'Ready',
        status: 'True',
        reason: 'ReplicaSetReady',
        message: 'Tenant is running with compute layer active'
      });
    } else {
      res.status.phase = 'Initializing';
      res.status.conditions.push({
        type: 'Ready',
        status: 'False',
        reason: 'WaitingForPods',
        message: 'ReplicaSet created, waiting for pod to be ready'
      });
    }
    
    // Add initialization completion conditions
    res.status.conditions.push({
      type: 'ReplicaSetInitialized',
      status: 'True',
      reason: 'InitJobSucceeded',
      message: `MongoDB replica set initialized at ${replicaSetInitialized}`
    });
    
    res.status.conditions.push({
      type: 'UserInitialized',
      status: 'True',
      reason: 'CreateUserJobSucceeded',
      message: `MongoDB user created at ${userInitialized}`
    });
    
    // Add status fields
    res.status.databaseName = req.databaseName;
    res.status.connectionSecret = req.authSecret?.metadata?.name;
    res.status.pvcName = req.pvcName;
    res.status.observedGeneration = req.parent.metadata.generation;
    
    return next();
  }
  
  /**
   * Final handler: send response
   */
  function sendResponse(req, res, next) {
    res.send({
      status: res.status,
      children: res.children
    });
  }
  
  /**
   * Stage 6a: ConfigMap adoption and userdata migration
   * Adopts ConfigMap as child whenever compute is enabled
   * Handles Gen3→Gen5 migration when requested
   * 
   * Adoption modes:
   * 1. No migration: Adopt ConfigMap as-is (preserve all data)
   * 2. Migration pending: Preserve ConfigMap until storage migration completes
   * 3. Migration ready: Archive data.mongo to annotation and strip from data
   * 4. Migration complete: Render clean ConfigMap without data.mongo
   */
  function planUserDataMigration(req, res, next) {
    if (!req.computeConfigMap) {
      return next();
    }
    
    const tenantId = req.tenantId;
    const namespace = req.namespace;
    const configMap = req.computeConfigMap;
    
    // Non-migration case: Adopt ConfigMap as-is (normal operation)
    if (!req.migrationRequested) {
      console.log(`  Adopting ConfigMap as child (no migration)`);
      const preservedConfigMap = renderPreservedConfigMap(configMap, tenantId, namespace);
      res.children.push(preservedConfigMap);
      return next();
    }
    
    // Migration case: Handle Gen3→Gen5 userdata migration
    console.log(`  Migration mode: handling ConfigMap adoption with userdata migration`);
    
    // Check if userdata migration already completed
    const userDataMigrationCompleted = configMap.metadata?.annotations?.['nightscout.io/userdata-migration-completed'];
    if (userDataMigrationCompleted) {
      console.log(`  Userdata migration already completed at ${userDataMigrationCompleted} - rendering clean ConfigMap`);
      
      // Render clean ConfigMap without data.mongo (child of composite)
      const cleanConfigMap = renderCleanConfigMap(configMap, tenantId, namespace);
      res.children.push(cleanConfigMap);
      return next();
    }
    
    // Check if storage migration completed (annotation on mongo-auth Secret, not parent CR)
    const storageMigrationCompleted = req.authSecret?.metadata?.annotations?.['nightscout.io/migration-completed'];
    
    if (!storageMigrationCompleted) {
      console.log(`  Storage migration not yet completed - preserving Gen3 ConfigMap as-is`);
      
      // Preserve ConfigMap without modifications until storage migration completes (child of composite)
      const preservedConfigMap = renderPreservedConfigMap(configMap, tenantId, namespace);
      res.children.push(preservedConfigMap);
      return next();
    }
    
    console.log(`  Storage migration completed at ${storageMigrationCompleted} - executing userdata migration`);
    
    // Extract data.mongo URI before stripping
    const mongoUri = extractMongoUri(configMap);
    
    if (mongoUri) {
      console.log(`  Archiving data.mongo URI to annotation (length: ${mongoUri.length})`);
      
      // Archive mongo URI to ConfigMap annotation (child of composite)
      const migratedConfigMap = renderMigratedConfigMap(
        configMap,
        tenantId,
        namespace,
        mongoUri
      );
      
      res.children.push(migratedConfigMap);
    } else {
      console.log(`  WARNING: No data.mongo field found in Gen3 ConfigMap - marking migration complete anyway`);
      
      // No mongo URI to archive, just mark complete (child of composite)
      const cleanConfigMap = renderCleanConfigMap(configMap, tenantId, namespace);
      res.children.push(cleanConfigMap);
    }
    
    return next();
  }
  
  // Return middleware pipeline (Gen5: two-phase provisioning)
  // 1. Initialize context from webhook request
  // 2. Ensure MongoDB keyfile Secret (child resource)
  // 3. Read mongo-auth Secret from spec reference (provisioner-owned)
  // 4. Set runtime-required annotation for Gen3/Gen4 compatibility
  // 5. Detect compute activation via ConfigMap presence
  // 6. Ensure Nightscout Secret (conditional on compute)
  // 6a. Plan userdata migration (Gen3 ConfigMap adoption, optional)
  // 7. Assert PVC exists from spec reference
  // 8. Render children (conditional compute layer)
  // 9. Send response
  return [
    initializeContext,
    ensureMongoKeyfile,
    ensureMongoAuthSecret,
    setRuntimeRequiredAnnotation,
    detectComputeActivation,
    ensureNightscoutSecret,
    planUserDataMigration,
    assertPVCExists,
    renderChildren,
    sendResponse
  ];
}

/**
 * Helper: Extract data.mongo URI from Gen3 ConfigMap
 * Gen3 ConfigMaps store MongoDB URI in data.mongo field
 */
function extractMongoUri(configMap) {
  if (!configMap || !configMap.data) {
    return null;
  }
  
  return configMap.data.mongo || null;
}

/**
 * Helper: Render preserved ConfigMap (no modifications, just clean manifest)
 * Used before storage migration completes - preserves ConfigMap as-is
 * CRITICAL: Preserves original name/namespace to avoid creating duplicate ConfigMaps
 */
function renderPreservedConfigMap(existingConfigMap, tenantId, namespace) {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: existingConfigMap.metadata.name,
      namespace: existingConfigMap.metadata.namespace,
      labels: {
        ...(existingConfigMap.metadata?.labels || {}),
        'app.kubernetes.io/managed-by': 'metacontroller'
      },
      annotations: {
        ...(existingConfigMap.metadata?.annotations || {})
      }
    },
    data: existingConfigMap.data || {}
  };
}

/**
 * Helper: Render migrated ConfigMap (archives data.mongo to annotation and strips from data)
 * Executes userdata migration when storage migration completes
 * CRITICAL: Preserves original name/namespace to avoid creating duplicate ConfigMaps
 */
function renderMigratedConfigMap(existingConfigMap, tenantId, namespace, mongoUri) {
  const data = { ...(existingConfigMap.data || {}) };
  
  // Strip data.mongo from ConfigMap data section
  delete data.mongo;
  
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: existingConfigMap.metadata.name,
      namespace: existingConfigMap.metadata.namespace,
      labels: {
        ...(existingConfigMap.metadata?.labels || {}),
        'app.kubernetes.io/managed-by': 'metacontroller'
      },
      annotations: {
        ...(existingConfigMap.metadata?.annotations || {}),
        'nightscout.io/gen3-mongo-uri': mongoUri,
        'nightscout.io/userdata-migration-completed': new Date().toISOString()
      }
    },
    data: data
  };
}

/**
 * Helper: Render clean ConfigMap (no data.mongo, migration already completed)
 * Used when userdata migration already completed in previous reconciliation
 * CRITICAL: Preserves original name/namespace and migration annotations for rollback
 */
function renderCleanConfigMap(existingConfigMap, tenantId, namespace) {
  const data = { ...(existingConfigMap.data || {}) };
  
  // Ensure data.mongo is stripped (should already be gone)
  delete data.mongo;
  
  // Preserve migration annotations for rollback capability
  const existingAnnotations = existingConfigMap.metadata?.annotations || {};
  const annotations = {
    ...existingAnnotations,
    'app.kubernetes.io/managed-by': 'metacontroller'
  };
  
  // Ensure migration markers are preserved (if present in existing ConfigMap)
  // These are critical for rollback and audit trail
  if (existingAnnotations['nightscout.io/gen3-mongo-uri']) {
    annotations['nightscout.io/gen3-mongo-uri'] = existingAnnotations['nightscout.io/gen3-mongo-uri'];
  }
  if (existingAnnotations['nightscout.io/userdata-migration-completed']) {
    annotations['nightscout.io/userdata-migration-completed'] = existingAnnotations['nightscout.io/userdata-migration-completed'];
  }
  
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: existingConfigMap.metadata.name,
      namespace: existingConfigMap.metadata.namespace,
      labels: {
        ...(existingConfigMap.metadata?.labels || {}),
        'app.kubernetes.io/managed-by': 'metacontroller'
      },
      annotations: annotations
    },
    data: data
  };
}

module.exports = createTenantCompositeSync;
