/**
 * Tenant Composite Controller (Gen 5 Architecture)
 * 
 * Two-phase provisioning model with ConfigMap-based compute activation
 * and two-phase Pod container gating for safe initialization
 * 
 * Parent: NightscoutTenant CRD (nightscout.io/v1alpha1)
 * 
 * Phase 1 (Provisioner creates storage resources):
 *   - PVC (referenced by spec.pvcName)
 *   - mongo-auth Secret (referenced by spec.mongoAuthSecretRef)
 *   - NightscoutTenant CR (minimal spec with refs)
 * 
 * Phase 2 (ConfigMap activates compute):
 *   - Provisioner creates ConfigMap and sets spec.configMapRef
 *   - Controller adopts existing ConfigMap (preserves name/namespace)
 *   - ConfigMap presence enables compute (Pod rendered)
 *   - No ConfigMap OR deleted ConfigMap = storage-only mode (no pods)
 * 
 * Two-Phase Pod Container Gating:
 *   Phase 2a: Pod with MongoDB-only container (ns.mdn.io/user-initialized absent)
 *     - Allows initialization Jobs to connect via Pod IP
 *     - Decorator orchestrates init-replica-set and create-user Jobs
 *   Phase 2b: Pod with MongoDB + Nightscout containers (ns.mdn.io/user-initialized set)
 *     - Full tenant with application layer
 *     - Nightscout connects to MongoDB via localhost
 * 
 * Children (Storage Only - No ConfigMap):
 *   - MongoDB Keyfile Secret
 * 
 * Children (Storage + Compute - ConfigMap Present):
 *   - ConfigMap (adopted from provisioner with preserved identity)
 *   - Pod (co-located MongoDB + Nightscout, gated by initialization)
 *   - MongoDB Keyfile Secret
 *   - App-Credentials Secret (THE Nightscout app Secret with MongoDB credentials + runtime config)
 * 
 * Related (not owned):
 *   - PVC (created by provisioner, referenced in spec)
 *   - mongo-auth Secret (created by provisioner, referenced in spec)
 *   - ConfigMap (created by provisioner, referenced in spec.configMapRef, enables compute)
 * 
 * Decorator Interaction:
 *   - tenant-initialization-decorator discovers Pod via related resources
 *   - Decorator extracts Pod IP from status.podIP for Job connectivity
 *   - Jobs use Pod IP to connect to MongoDB (not localhost or Service)
 *   - Decorator sets annotations on CR when Jobs succeed
 *   - Composite reads annotations to gate Nightscout container inclusion
 */

const crypto = require('crypto');
const _ = require('lodash');
const { ANNOTATIONS, LABELS, RESOURCE_TYPES } = require('./constants');
const { 
  generateSecurePassword, 
  generateUsername,
  generateAppCredentials,
  renderAppCredentialsSecret,
  renderTenantPod,
  renderTenantReplicaSet,
  hashPodInputs
} = require('./resources');

// Feature flag: Toggle between ReplicaSet and direct Pod management
// - USE_REPLICASET=true: ReplicaSet buffer layer, InPlace updates, K8s manages Pod lifecycle
// - USE_REPLICASET=false: Direct Pod, generateSelector=false, spec-hash triggers RollingRecreate
// Direct Pod mode has lower resource overhead (no ReplicaSet object per tenant)
const USE_REPLICASET = true;

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
   * 
   * Identity fields from spec:
   *   - spec.storage (required): Storage account ID from provisioner facade
   *   - spec.tenant (optional): Tenant ID set on site creation
   * 
   * Naming conventions:
   *   - resourceName: CR name (used for child resource naming prefixes)
   *   - storageId: spec.storage (used for storage grouping labels)
   *   - tenantId: spec.tenant when set, else CR name (used for tenant identification labels)
   */
  function initializeContext(req, res, next) {
    const { parent, children, related } = req.body;
    
    req.parent = parent;
    req.children = children;
    req.related = related;
    req.spec = parent.spec || {};
    req.namespace = parent.metadata.namespace;
    
    // Resource naming (CR name, used for child resource prefixes)
    req.resourceName = parent.metadata.name;
    
    // Identity fields from spec (set by provisioner facade)
    req.storageId = req.spec.storage;
    req.tenantId = req.spec.tenant || parent.metadata.name; // Fallback to CR name if tenant not yet set
    req.tenantSet = !!req.spec.tenant; // Track if tenant ID was explicitly set
    
    // Initialize response
    res.children = [];
    res.status = { phase: 'Pending', conditions: [] };
    
    console.log("INCOMING CONTEXT", JSON.stringify(req.body, null, 2));
    console.log(`Tenant composite sync for resource: ${req.resourceName}`);
    console.log(`  Storage ID: ${req.storageId}`);
    console.log(`  Tenant ID: ${req.tenantId} (explicit: ${req.tenantSet})`);
    
    // Validate required spec.storage field
    if (!req.storageId) {
      console.error(`  ERROR: spec.storage is required but not provided`);
      res.status.phase = 'Error';
      res.status.conditions.push({
        type: 'StorageIdentityValidated',
        status: 'False',
        reason: 'MissingStorageId',
        message: 'spec.storage is required but not provided (must be set by provisioner facade)'
      });
      // Continue to sendResponse - early termination
      res.send({ status: res.status, children: [] });
      return; // Skip remaining middleware
    }
    
    res.status.conditions.push({
      type: 'StorageIdentityValidated',
      status: 'True',
      reason: 'StorageIdPresent',
      message: `Storage account ID: ${req.storageId}`
    });
    
    return next();
  }
  
  /**
   * Helper: Build standard labels for child resources
   * Uses spec.storage and spec.tenant for identity labels
   */
  function buildStandardLabels(req, component, additionalLabels = {}) {
    const labels = {
      'app.kubernetes.io/name': 'nightscout',
      'app.kubernetes.io/component': component,
      'app.kubernetes.io/part-of': 'nightscout-tenant',
      'app.kubernetes.io/instance': req.resourceName,
      'app.kubernetes.io/managed-by': 'metacontroller',
      'ns.mdn.io/storage': req.storageId,
      'ns.mdn.io/composite': 'tenant', 
      ...additionalLabels
    };
    
    // Only add tenant label if explicitly set
    if (req.tenantSet) {
      labels['ns.mdn.io/tenant'] = req.tenantId;
    }
    
    return labels;
  }
  
  /**
   * Stage 2: Ensure MongoDB keyfile Secret exists
   */
  function ensureMongoKeyfile(req, res, next) {
    const resourceName = req.resourceName;
    const namespace = req.namespace;
    const keyfileSecretName = `${resourceName}-mongo-keyfile`;
    
    // Check if keyfile Secret already exists (robust lookup with namespace)
    const existingKeyfile = findResource(req.children['Secret.v1'], keyfileSecretName, namespace) || 
                           findResource(req.related['Secret.v1'], keyfileSecretName, namespace);
    
    if (existingKeyfile) {
      console.log(`  Keyfile Secret ${keyfileSecretName} exists`);
      req.keyfileSecret = existingKeyfile;
      // CRITICAL: Clean and add to res.children to keep it in desired state
      res.children.push(cleanResource(existingKeyfile));
      return next();
    }
    
    // Generate new keyfile Secret
    console.log(`  Generating keyfile Secret for ${resourceName}`);
    const keyfileData = crypto.randomBytes(64).toString('base64');
    
    const keyfileSecret = {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'Opaque',
      metadata: {
        name: keyfileSecretName,
        namespace: namespace,
        labels: buildStandardLabels(req, 'database', {
          'app.kubernetes.io/name': 'mongodb-keyfile'
        }),
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
    const resourceName = req.resourceName;
    const namespace = req.namespace;
    const spec = req.spec;
    
    // Resolve mongo-auth Secret from spec reference
    const mongoAuthSecretRef = spec.mongoAuthSecretRef;
    if (!mongoAuthSecretRef) {
      console.error(`  ERROR: spec.mongoAuthSecretRef not provided for ${resourceName}`);
      res.status.phase = 'Error';
      res.status.conditions.push({
        type: 'MongoAuthSecretResolved',
        status: 'False',
        reason: 'MissingReference',
        message: 'spec.mongoAuthSecretRef is required but not provided'
      });
      req.authSecret = null;
      return next();
    }
    
    const authSecretName = mongoAuthSecretRef;
    console.log(`  Looking up mongo-auth Secret: ${authSecretName}`);
    
    // Find Secret in related resources (provisioner-owned, not a child)
    const existingAuth = findResource(req.related['Secret.v1'], authSecretName, namespace);
    
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
    
    // Read runtime-required from self (set by provisioner or decorator)
    const runtimeRequired = req.parent?.metadata?.annotations?.['ns.mdn.io/runtime-required'];
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
    // Only set if not already set.
    if (!runtimeRequired) {
      res.annotations['ns.mdn.io/runtime-required'] = initialStorageType;
    }
    // 
    if (!req.credentialsRequested) {
      res.annotations['ns.mdn.io/runtime-required'] = 'dedicated';
    }
    
    console.log(`  Set runtime-required annotation: ${initialStorageType}`);
    
    return next();
  }
  
  /**
   * Stage 3b: Ensure ConfigMap exists (adopt from provisioner if referenced)
   * Gen5: ConfigMap activates compute layer
   * 
   * spec.configMapRef provided:
   *   - Controller adopts existing ConfigMap (preserves name/namespace)
   *   - ConfigMap presence enables compute (ReplicaSet rendered)
   * 
   * No spec.configMapRef OR ConfigMap deleted:
   *   - Storage-only mode (no compute, no pods)
   *   - Deleting ConfigMap via environs API stops tenant execution
   */
  function ensureConfigMap(req, res, next) {
    const resourceName = req.resourceName;
    const namespace = req.namespace;
    const spec = req.spec;
    const configMapRef = spec.configMapRef;
    
    console.log(`Stage 3b: Ensuring ConfigMap for ${resourceName}`);
    console.log(`  configMapRef: ${configMapRef}`);
    
    // Preserve existing Error phase (don't override)
    const currentPhase = res.status.phase;
    const inErrorState = currentPhase === 'Error';
    
    // No configMapRef means storage-only mode (no compute activation)
    if (!configMapRef || !configMapRef.name) {
      console.log(`  No configMapRef - storage-only mode (no compute)`);
      req.computeEnabled = false;
      req.computeConfigMap = null;
      
      // Only set phase if not already in Error state
      if (!inErrorState) { }
      res.status.phase = 'Pending';
      
      res.status.conditions.push({
        type: 'ComputeActivated',
        status: 'False',
        reason: 'NoConfigMapRef',
        message: 'No spec.configMapRef configured (storage-only mode)'
      });
      return next();
    }
    
    // Explicit configMapRef - adopt provisioner-managed ConfigMap
    const configMapName = configMapRef.name;
    const configMapNamespace = configMapRef.namespace || namespace;
    
    console.log(`  Looking for referenced ConfigMap: ${configMapNamespace}/${configMapName}`);
    
    // Look for referenced ConfigMap in children (owned) or related (actual cluster state)
    // After first reconcile, adopted ConfigMap moves from related to children
    let existingConfigMap = findResource(
      req.related['ConfigMap.v1'],
      configMapName,
      configMapNamespace
    );
    
    /*
    // If not in children, check related resources (first reconcile)
    if (!existingConfigMap) {
      existingConfigMap = findResource(
        req.related['ConfigMap.v1'],
        configMapName,
        configMapNamespace
      );
    }
    */
    
    if (existingConfigMap) {
      console.log(`  Found existing ConfigMap`);
      /*
      console.log(`  Found existing ConfigMap - adopting for compute activation`);
      
      // Adopt existing ConfigMap (preserves name/namespace, adds management labels)
      const adoptedConfigMap = cleanResource(existingConfigMap);
      
      // Add management and identity labels
      if (!adoptedConfigMap.metadata.labels) {
        adoptedConfigMap.metadata.labels = {};
      }
      Object.assign(adoptedConfigMap.metadata.labels, buildStandardLabels(req, 'userdata'));
      
      res.children.push(adoptedConfigMap);
      */
      req.computeEnabled = true;
      req.computeConfigMap = existingConfigMap;
      
      res.status.conditions.push({
        type: 'ComputeActivated',
        status: 'True',
        reason: 'ConfigMapAdopted',
        message: `ConfigMap ${configMapNamespace}/${configMapName} found (compute enabled)`
      });
      
      return next();
    }
    
    // ConfigMap referenced but not found - storage-only mode (compute disabled)
    // This happens when ConfigMap deleted via environs API to stop tenant
    console.log(`  ConfigMap ${configMapNamespace}/${configMapName} not found - storage-only mode`);
    req.computeEnabled = false;
    req.computeConfigMap = null;
    
    // Only set phase if not already in Error state
    if (!inErrorState) {
      res.status.phase = 'Pending';
    }
    
    res.status.conditions.push({
      type: 'ComputeActivated',
      status: 'False',
      reason: 'ConfigMapNotFound',
      message: `ConfigMap ${configMapNamespace}/${configMapName} not found (storage-only mode)`
    });
    
    return next();
  }
  
  /**
   * Stage 3c: Ensure app-credentials Secret exists (THE Nightscout app Secret)
   * Contains MongoDB credentials + Nightscout runtime configuration
   * Gen5: Only renders when compute is activated (ConfigMap present)
   */
  function ensureAppCredentialsSecret(req, res, next) {
    const resourceName = req.resourceName;
    const namespace = req.namespace;
    const secretName = `${resourceName}-app-credentials`;
    
    console.log(`Stage 3c: Ensuring app-credentials Secret ${secretName}`);
    
    // Skip if compute not activated
    if (!req.computeEnabled) {
      console.log(`  Compute not activated - skipping app-credentials Secret`);
      return next();
    }
    
    // Guard: Skip if authSecret is missing (Error state from ensureMongoAuthSecret)
    if (!req.authSecret) {
      console.log(`  ${resourceName} Auth secret missing - skipping app-credentials Secret (Error state)`);
      return next();
    }
    
    // Check if secret already exists
    const existingSecret = findResource(req.children['Secret.v1'], secretName, namespace);

    // Generate new app-credentials Secret using shared helper
    console.log(`  Ensuring app-credentials Secret`, existingSecret);
    
    // Build identity labels for the secret
    const identityLabels = buildStandardLabels(req, 'application');
    var overrides = {
      mongoHost: 'localhost',
    };
    
    const appCredentialsSecret = renderAppCredentialsSecret(
      resourceName,
      namespace,
      req.databaseName,
      existingSecret,  // null for first cycle, existing Secret to preserve
      identityLabels,
      overrides
    );

    res.children.push(appCredentialsSecret);
    req.appCredentialsSecret = existingSecret;

    return next();
  }
  
  /**
   * Stage 4: Check initialization status and determine phase
   * Uses durable parent status for replica set initialization state
   */
  function detectPhase(req, res, next) {
    const resourceName = req.resourceName;
    const pvcName = `data-${resourceName}-0`;
    const initJobName = `${resourceName}-init-rs`;
    
    // Helper: Find PVC in children or related (with namespace matching)
    function findPVC() {
      return findResource(req.children['PersistentVolumeClaim.v1'], pvcName, req.namespace) ||
             findResource(req.related['PersistentVolumeClaim.v1'], pvcName, req.namespace);
    }
    
    // Helper: Find init Job in children (with namespace matching)
    function findInitJob() {
      return findResource(req.children['Job.batch/v1'], initJobName, req.namespace);
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
    const pvc = findResource(req.related['PersistentVolumeClaim.v1'], pvcName, req.namespace);
    
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
    const resourceName = req.resourceName;
    const spec = req.spec;
    
    console.log(`Stage 5: Rendering children for ${resourceName}`);
    console.log(`  Compute enabled: ${req.computeEnabled}`);
    console.log(`  PVC exists: ${req.pvcExists}`);
    console.log(`  Auth secret exists: ${!!req.authSecret}`);
    
    // Storage-only mode (no ConfigMap or compute disabled)
    if (!req.computeEnabled) {
      console.log(`  Storage-only mode - no compute layer`);
      
      // Status already set to 'Provisioned' by ensureConfigMap
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
    
    // Read initialization state from Secrets (set by decorators)
    // - mongo-auth Secret: ns.mdn.io/replica-set-initialized annotation
    // - app-credentials Secret: ns.mdn.io/user-initialized annotation
    // This is more reliable than CR annotations because decorators can stamp Secrets
    // without causing drift on the parent CR managed by the composite controller
    
    // Check mongo-auth Secret for replica set initialization
    const mongoAuthAnnotations = req.authSecret?.metadata?.annotations || {};
    const replicaSetInitialized = mongoAuthAnnotations['ns.mdn.io/replica-set-initialized'];
    
    // Check app-credentials Secret for user initialization
    // First check existing children, then related (for first sync cycle)
    const appCredentialsSecretNameLocal = `${resourceName}-app-credentials`;
    const existingAppCreds = findResource(req.children['Secret.v1'], appCredentialsSecretNameLocal, req.namespace) ||
                             findResource(req.related['Secret.v1'], appCredentialsSecretNameLocal, req.namespace);
    const appCredsAnnotations = existingAppCreds?.metadata?.annotations || {};
    const userInitialized = appCredsAnnotations['ns.mdn.io/user-initialized'];
    
    // Fallback: Also check parent CR annotations for backwards compatibility
    const parentAnnotations = req.parent.metadata?.annotations || {};
    const replicaSetInitializedFallback = replicaSetInitialized || parentAnnotations['ns.mdn.io/replica-set-initialized'];
    const userInitializedFallback = userInitialized || parentAnnotations['ns.mdn.io/user-initialized'];
    
    console.log(`  Replica set initialized: ${replicaSetInitializedFallback || 'no'} (from Secret: ${!!replicaSetInitialized})`);
    console.log(`  User initialized: ${userInitializedFallback || 'no'} (from Secret: ${!!userInitialized})`);
    
    // Build identity labels for Pod
    const identityLabels = {
      'ns.mdn.io/storage': req.storageId
    };
    if (req.tenantSet) {
      identityLabels['ns.mdn.io/tenant'] = req.tenantId;
      identityLabels['tenant'] = req.tenantId;
    }
    
    // Two-phase container rendering:
    // Phase 1: MongoDB-only (userInitialized = false) - allows Jobs to run
    // Phase 2: MongoDB + Nightscout (userInitialized = true) - full tenant
    const userInitializedBool = !!userInitializedFallback;
    
    // Check for existing resources and determine readiness state
    let existingPod = null;
    let podReady = false;
    let mongoReady = false;
    // Compute spec hash for Pod inputs - embedded in Pod annotation to trigger recreation
    const authSecretName = req.authSecret?.metadata?.name || `${resourceName}-mongo-auth`;
    const keyfileSecretName = req.keyfileSecret?.metadata?.name || `${resourceName}-mongo-keyfile`;
    const appCredentialsSecretName = req.appCredentialsSecret?.metadata?.name || `${resourceName}-app-credentials`;
      
    const specHash = hashPodInputs({
      resourceName,
      spec,
      authSecretName,
      keyfileSecretName,
      appCredentialsSecretName,
      userInitialized: userInitializedBool,
      identityLabels,
      config
    });
    res.status.specHash = specHash;
    
    if (USE_REPLICASET) {
      // ReplicaSet mode: Render ReplicaSet, let K8s manage Pod lifecycle
      // This provides a buffer layer that isolates Metacontroller from Pod-level drift
      console.log(`  Rendering ReplicaSet with userInitialized=${userInitializedBool}`);
      
      const replicaSet = renderTenantReplicaSet(
        resourceName,
        req.namespace,
        spec,
        req.authSecret,
        req.keyfileSecret,
        req.appCredentialsSecret,
        userInitializedBool,
        identityLabels,
        config
      );
      res.children.push(replicaSet);
      
      // Check existing ReplicaSet for status
      const existingRS = findResource(req.children['ReplicaSet.apps/v1'], `${resourceName}-rs`, req.namespace);
      
      // Find Pod managed by this ReplicaSet (via owner reference or label selector)
      // Pods owned by ReplicaSet will have matching labels
      const pods = req.children['Pod.v1'] || {};
      const podList = Array.isArray(pods) ? pods : Object.values(pods);
      existingPod = podList.find(p => 
        p.metadata?.labels?.['app.kubernetes.io/instance'] === resourceName &&
        p.metadata?.namespace === req.namespace
      );
      
      console.log("DIFF REPLICASET", existingRS, replicaSet);
      if (existingPod) {
        podReady = existingPod.status?.conditions?.find(c => c.type === 'Ready' && c.status === 'True');
        mongoReady = existingPod.status?.containerStatuses?.find(c => c.name === 'mongodb' && c.ready);
      }
      
      console.log(`  Existing ReplicaSet: ${!!existingRS}, Pod: ${!!existingPod}, Pod ready: ${!!podReady}, MongoDB ready: ${!!mongoReady}`);
      
    } else {
      // Direct Pod mode with generateSelector=false
      // With generateSelector=false, Metacontroller doesn't inject controller-uid into labels,
      // so we can render a clean Pod without preservation logic. The spec-hash annotation
      // in the Pod spec triggers Pod recreation when inputs change (RollingRecreate strategy).
      console.log(`  Rendering Pod with userInitialized=${userInitializedBool}`);
      
      
      // Always render fresh Pod - generateSelector=false ensures no drift from controller-uid
      // The spec-hash annotation changes when inputs change, triggering RollingRecreate
      console.log(`  Rendering Pod with spec-hash: ${specHash}`);
      const pod = renderTenantPod(
        resourceName,
        req.namespace,
        spec,
        req.authSecret,
        req.keyfileSecret,
        req.appCredentialsSecret,
        userInitializedBool,
        identityLabels,
        config,
        specHash
      );
      res.children.push(pod);
      
      // Check existing Pod for status
      existingPod = findResource(req.children['Pod.v1'], `${resourceName}-pod`, req.namespace);
      podReady = existingPod?.status?.conditions?.find(c => c.type === 'Ready' && c.status === 'True');
      mongoReady = existingPod?.status?.containerStatuses?.find(c => c.name === 'mongodb' && c.ready);
      
      console.log("DIFF POD", existingPod, pod);
      console.log(`  Existing Pod: ${!!existingPod}, Pod ready: ${!!podReady}, MongoDB ready: ${!!mongoReady}`);
    }
    
    console.log(`  Pod exists: ${!!existingPod}, Pod ready: ${!!podReady}, MongoDB ready: ${!!mongoReady}`);
    
    
    // Determine phase based on initialization and Pod state
    if (userInitializedBool && podReady) {
      // Fully initialized with all containers running
      res.status.phase = 'Running';
      res.status.conditions.push({
        type: 'Ready',
        status: 'True',
        reason: 'PodReady',
        message: 'Tenant Pod is running with MongoDB and Nightscout containers'
      });
    } else if (userInitializedBool && !podReady) {
      // User initialized, waiting for Pod to restart with Nightscout container
      res.status.phase = 'Pending';
      res.status.conditions.push({
        type: 'Ready',
        status: 'False',
        reason: 'WaitingForPodRestart',
        message: 'User credentials created, waiting for Pod to restart with Nightscout container'
      });
    } else if (mongoReady && !replicaSetInitializedFallback) {
      // MongoDB running, waiting for replica set init Job
      res.status.phase = 'Initializing';
      res.status.conditions.push({
        type: 'Ready',
        status: 'False',
        reason: 'WaitingForReplicaSetInit',
        message: 'MongoDB running, waiting for replica set initialization Job'
      });
    } else if (replicaSetInitializedFallback && !userInitializedFallback) {
      // Replica set ready, waiting for user creation Job
      res.status.phase = 'Initializing';
      res.status.conditions.push({
        type: 'Ready',
        status: 'False',
        reason: 'WaitingForUserCreation',
        message: 'Replica set initialized, waiting for user creation Job'
      });
    } else {
      // Starting up - MongoDB container initializing
      res.status.phase = 'Pending';
      res.status.conditions.push({
        type: 'Ready',
        status: 'False',
        reason: 'WaitingForMongoDB',
        message: 'Waiting for MongoDB container to become ready'
      });
    }
    
    // Request requeue if not fully Ready (ensures continuous progress through initialization)
    // Metacontroller will resync after this interval to check for annotation updates
    if (!userInitializedBool || !podReady) {
      res.resyncAfterSeconds = 15;
      console.log(`  Requesting requeue in 15 seconds (waiting for initialization)`);
    }
    
    // Add initialization completion conditions (when set)
    if (replicaSetInitializedFallback) {
      res.status.conditions.push({
        type: 'ReplicaSetInitialized',
        status: 'True',
        reason: 'InitJobSucceeded',
        message: `MongoDB replica set initialized at ${replicaSetInitializedFallback}`
      });
    }
    
    if (userInitializedFallback) {
      res.status.conditions.push({
        type: 'UserInitialized',
        status: 'True',
        reason: 'CreateUserJobSucceeded',
        message: `MongoDB user created at ${userInitializedFallback}`
      });
    }
    
    // Add status fields
    res.status.databaseName = req.databaseName;
    res.status.connectionSecret = req.authSecret?.metadata?.name;
    res.status.pvcName = req.pvcName;
    res.status.podName = `${resourceName}-pod`;
    res.status.podIP = existingPod?.status?.podIP;
    res.status.observedGeneration = req.parent.metadata.generation;
    
    return next();
  }
  
  /**
   * Final handler: send response
   */
  function sendResponse(req, res, next) {
    const response = {
      status: res.status,
      children: res.children
    };
    
    // Include resyncAfterSeconds if set (for initialization progress)
    if (res.resyncAfterSeconds) {
      // response.resyncAfterSeconds = res.resyncAfterSeconds;
    }

    var remaining = _(req.children).flatMap(function (resources, kind) {
      return _.map(resources, (resource, name) => ({
        ...resource
      }));
    }).reject((child) => {
        return _.some(response.children, (excluded) => {
          hasSameName = excluded.metadata.name == child.metadata.name && excluded;
          isSameKind = excluded.kind == child.kind;
          return hasSameName && isSameKind;
          
        });
    }).value( );
    console.log("ADDING REMAINING CHILDREN not active in current phase", remaining.length, remaining);
    response.children.push(...remaining);
    // console.log("RESPONSE", JSON.stringify(response, null, 2));
    res.send(response);
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
    // No adoption at all.
    return next();
    
    const resourceName = req.resourceName;
    const namespace = req.namespace;
    const configMap = req.computeConfigMap;
    
    // Non-migration case: Adopt ConfigMap as-is (normal operation)
    if (!req.migrationRequested) {
      console.log(`  Adopting ConfigMap as child (no migration)`);
      const preservedConfigMap = renderPreservedConfigMap(configMap, resourceName, namespace);
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
      const cleanConfigMap = renderCleanConfigMap(configMap, resourceName, namespace);
      res.children.push(cleanConfigMap);
      return next();
    }
    
    // Check if storage migration completed (annotation on mongo-auth Secret, not parent CR)
    const storageMigrationCompleted = req.authSecret?.metadata?.annotations?.['nightscout.io/migration-completed'];
    
    if (!storageMigrationCompleted) {
      console.log(`  Storage migration not yet completed - preserving Gen3 ConfigMap as-is`);
      
      // Preserve ConfigMap without modifications until storage migration completes (child of composite)
      const preservedConfigMap = renderPreservedConfigMap(configMap, resourceName, namespace);
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
        resourceName,
        namespace,
        mongoUri
      );
      
      res.children.push(migratedConfigMap);
    } else {
      console.log(`  WARNING: No data.mongo field found in Gen3 ConfigMap - marking migration complete anyway`);
      
      // No mongo URI to archive, just mark complete (child of composite)
      const cleanConfigMap = renderCleanConfigMap(configMap, resourceName, namespace);
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
  // 6. Ensure app-credentials Secret (THE Nightscout app Secret, conditional on compute)
  // 6a. Plan userdata migration (Gen3 ConfigMap adoption, optional)
  // 7. Assert PVC exists from spec reference
  // 8. Render children (conditional compute layer)
  // 9. Send response
  return [
    initializeContext,
    ensureMongoKeyfile,
    ensureMongoAuthSecret,
    setRuntimeRequiredAnnotation,
    ensureConfigMap,
    ensureAppCredentialsSecret,
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
