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
const { ANNOTATIONS, LABELS } = require('./constants');

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
    req.mongoUsername = Buffer.from(existingAuth.data?.username || '', 'base64').toString('utf-8');
    req.mongoPassword = Buffer.from(existingAuth.data?.password || '', 'base64').toString('utf-8');
    
    console.log(`  Hydrated: database=${req.databaseName}, username=${req.mongoUsername}`);
    
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
   * Stage 3a: Set runtime-required annotation from spec.initialStorageType
   * Gen5: Enables Gen3/Gen4 migration compatibility
   */
  function setRuntimeRequiredAnnotation(req, res, next) {
    const spec = req.spec;
    const initialStorageType = spec.initialStorageType || 'shared';
    
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
    
    // No selector means no compute activation
    if (Object.keys(selector).length === 0) {
      console.log(`  No selector configured - compute disabled`);
      req.computeEnabled = false;
      req.computeConfigMap = null;
      res.status.phase = 'Provisioned';
      res.status.conditions.push({
        type: 'ComputeActivated',
        status: 'False',
        reason: 'NoSelector',
        message: 'No spec.selector configured (storage-only mode)'
      });
      return next();
    }
    
    // Look for ConfigMap matching selector in related resources
    const configMaps = req.related['configmaps.v1'];
    let matchingConfigMap = null;
    
    if (Array.isArray(configMaps) && configMaps.length > 0) {
      // Find first ConfigMap matching all selector labels
      matchingConfigMap = configMaps.find(cm => {
        const labels = cm.metadata?.labels || {};
        return Object.entries(selector).every(([key, value]) => labels[key] === value);
      });
    }
    
    if (matchingConfigMap) {
      console.log(`  Found compute ConfigMap: ${matchingConfigMap.metadata.name}`);
      req.computeEnabled = true;
      req.computeConfigMap = matchingConfigMap;
      // Status phase will be set later based on ReplicaSet readiness
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
      res.status.phase = 'Provisioned';
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
    
    // Check if secret already exists
    const existingSecret = findResource(req.children['secrets.v1'], nsSecretName, namespace);
    
    if (existingSecret) {
      console.log(`  Found existing Nightscout secret`);
      const cleaned = cleanResource(existingSecret);
      res.children.push(cleaned);
      req.nightscoutSecret = cleaned;
      return next();
    }
    
    // Generate new Nightscout secret
    console.log(`  Generating Nightscout Secret for ${tenantId}`);
    
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
    
    // Build MongoDB connection string (localhost since co-located)
    const mongoConnection = `mongodb://${mongoUsername}:${mongoPassword}@localhost:27017/${mongoDatabase}?authSource=${mongoDatabase}`;
    
    // Generate API_SECRET for Nightscout authentication
    const apiSecret = crypto.randomBytes(32).toString('hex');
    
    const nightscoutSecret = {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'Opaque',
      metadata: {
        name: nsSecretName,
        namespace: namespace,
        labels: {
          'app.kubernetes.io/name': 'nightscout',
          'app.kubernetes.io/component': 'application',
          'app.kubernetes.io/part-of': 'nightscout-tenant',
          'app.kubernetes.io/instance': tenantId,
          'app.kubernetes.io/managed-by': 'metacontroller',
          'ns.mdn.io/tenant': tenantId
        },
        annotations: {
          'ns.mdn.io/created-at': new Date().toISOString()
        }
      },
      stringData: {
        MONGO_CONNECTION: mongoConnection,
        API_SECRET: apiSecret,
        // Additional Nightscout configuration
        INSECURE_USE_HTTP: 'true', // Kubernetes handles TLS at ingress
        HOSTNAME: `${tenantId}.nightscout.svc.cluster.local`,
        BASE_URL: `https://${tenantId}.nightscout.example.com`, // Override via spec
        // Enable features by default
        ENABLE: 'careportal basal dbsize rawbg iob cob bwp cage iage sage boluscalc pushover treatmentnotify mmconnect loop pump profile food openaps bage alexa override cors',
        // Time format
        TIME_FORMAT: '24',
        THEME: 'colors'
      }
    };
    
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
   * Stage 5: Render children based on phase
   */
  function renderChildren(req, res, next) {
    const tenantId = req.tenantId;
    const spec = req.spec;
    
    // Persist durable state conditions as soon as observed
    // These survive resource garbage collection
    
    // Persist PVC bound state (write once, keep forever)
    if (req.pvcJustBound) {
      console.log(`  Persisting PVCBound condition (PVC just became bound)`);
      res.status.conditions.push({
        type: 'PVCBound',
        status: 'True',
        reason: 'PVCProvisioned',
        message: `PVC ${req.pvcName} is bound and ready`
      });
    } else if (req.pvcBound) {
      // Already persisted, re-write to maintain status
      res.status.conditions.push({
        type: 'PVCBound',
        status: 'True',
        reason: 'PVCProvisioned',
        message: `PVC ${req.pvcName} is bound and ready`
      });
    }
    
    // Persist replica set initialization (write once, keep forever)
    if (req.jobJustSucceeded) {
      console.log(`  Persisting ReplicaSetInitialized condition (Job just succeeded)`);
      res.status.conditions.push({
        type: 'ReplicaSetInitialized',
        status: 'True',
        reason: 'InitJobSucceeded',
        message: 'MongoDB replica set initialized successfully'
      });
    } else if (req.replicaSetInitialized) {
      // Already persisted, re-write to maintain status
      res.status.conditions.push({
        type: 'ReplicaSetInitialized',
        status: 'True',
        reason: 'InitJobSucceeded',
        message: 'MongoDB replica set initialized successfully'
      });
    }
    
    // Render children based on current phase
    if (req.targetPhase === 'Initializing') {
      // Initialization phase: render StatefulSet + Init Job
      console.log(`  Rendering StatefulSet for initialization`);
      
      const statefulSet = renderStatefulSet(tenantId, req.namespace, spec, req.authSecret, req.keyfileSecret, req.nightscoutSecret, config);
      res.children.push(statefulSet);
      
      // Only render init job if auth secret has credentials
      if (req.authSecret && req.databaseName) {
        const initJob = renderInitJob(tenantId, req.namespace, req.databaseName, req.authSecret, config);
        res.children.push(initJob);
      }
      
      res.status.phase = 'Initializing';
      res.status.conditions.push({
        type: 'Ready',
        status: 'False',
        reason: 'Initializing',
        message: 'StatefulSet and init Job created, waiting for replica set initialization'
      });
      
    } else {
      // Steady state: render direct Pod
      console.log(`  Rendering direct Pod for steady state`);
      
      const pod = renderPod(tenantId, req.namespace, spec, req.pvcName, req.authSecret, req.keyfileSecret, req.nightscoutSecret, config);
      res.children.push(pod);
      
      res.status.phase = 'Ready';
      res.status.conditions.push({
        type: 'Ready',
        status: 'True',
        reason: 'TenantReady',
        message: 'Tenant pod is running'
      });
      
      // Legacy condition for backward compatibility
      res.status.conditions.push({
        type: 'ReplicaSetReady',
        status: 'True',
        reason: 'ReplicaSetInitialized',
        message: 'MongoDB replica set initialized'
      });
    }
    
    // Add PVC status for easier observability
    if (req.pvcExists) {
      res.status.pvcName = req.pvcName;
    }
    
    res.status.databaseName = req.databaseName;
    res.status.connectionSecret = req.authSecret?.metadata?.name;
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
  
  // Return middleware pipeline
  return [
    initializeContext,
    ensureMongoKeyfile,
    ensureMongoAuthSecret,
    ensureNightscoutSecret,
    detectPhase,
    renderChildren,
    sendResponse
  ];
}

/**
 * Render StatefulSet for initialization phase
 * Co-located MongoDB + Nightscout containers
 */
function renderStatefulSet(tenantId, namespace, spec, authSecret, keyfileSecret, nightscoutSecret, config) {
  const mongoVersion = spec.mongodbVersion || '7.0';
  const mongoImage = spec.mongodbImage || `mongo:${mongoVersion}`;
  const nightscoutImage = spec.nightscoutImage || 'nightscout/cgm-remote-monitor:latest';
  
  const mongoResources = spec.mongoResources || {};
  const nsResources = spec.nightscoutResources || {};
  
  const storageSize = spec.storageSize || '10Gi';
  const storageClass = spec.storageClass || config.storage?.defaultStorageClass;
  
  const authSecretName = authSecret.metadata.name;
  const keyfileSecretName = keyfileSecret.metadata.name;
  const nightscoutSecretName = nightscoutSecret.metadata.name;
  
  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: {
      name: tenantId,
      namespace: namespace,
      labels: {
        'app.kubernetes.io/name': 'nightscout-tenant',
        'app.kubernetes.io/component': 'application',
        'app.kubernetes.io/part-of': 'nightscout-tenant',
        'app.kubernetes.io/instance': tenantId,
        'app.kubernetes.io/managed-by': 'metacontroller',
        'ns.mdn.io/tenant': tenantId
      }
    },
    spec: {
      serviceName: tenantId,
      replicas: 1,
      persistentVolumeClaimRetentionPolicy: {
        whenDeleted: 'Retain',
        whenScaled: 'Retain'
      },
      selector: {
        matchLabels: {
          'app.kubernetes.io/instance': tenantId
        }
      },
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'nightscout-tenant',
            'app.kubernetes.io/component': 'application',
            'app.kubernetes.io/part-of': 'nightscout-tenant',
            'app.kubernetes.io/instance': tenantId,
            'ns.mdn.io/tenant': tenantId
          }
        },
        spec: {
          initContainers: [
            {
              name: 'prepare-keyfile',
              image: config.images?.utility || 'busybox:latest',
              command: ['sh', '-c', 'cp /keyfile-secret/keyfile /keyfile-prep/keyfile && chmod 400 /keyfile-prep/keyfile && chown 999:999 /keyfile-prep/keyfile'],
              volumeMounts: [
                {
                  name: 'keyfile-secret',
                  mountPath: '/keyfile-secret',
                  readOnly: true
                },
                {
                  name: 'keyfile-prep',
                  mountPath: '/keyfile-prep'
                }
              ]
            }
          ],
          containers: [
            {
              name: 'mongodb',
              image: mongoImage,
              ports: [
                {
                  name: 'mongodb',
                  containerPort: 27017
                }
              ],
              env: [
                {
                  name: 'MONGO_INITDB_ROOT_USERNAME',
                  valueFrom: {
                    secretKeyRef: {
                      name: authSecretName,
                      key: 'MONGO_INITDB_ROOT_USERNAME'
                    }
                  }
                },
                {
                  name: 'MONGO_INITDB_ROOT_PASSWORD',
                  valueFrom: {
                    secretKeyRef: {
                      name: authSecretName,
                      key: 'MONGO_INITDB_ROOT_PASSWORD'
                    }
                  }
                },
                {
                  name: 'MONGO_INITDB_DATABASE',
                  valueFrom: {
                    secretKeyRef: {
                      name: authSecretName,
                      key: 'MONGO_INITDB_DATABASE'
                    }
                  }
                }
              ],
              args: [
                '--bind_ip_all',
                '--replSet', 'rs0',
                '--keyFile', '/keyfile/keyfile'
              ],
              volumeMounts: [
                {
                  name: 'data',
                  mountPath: '/data/db'
                },
                {
                  name: 'keyfile-prep',
                  mountPath: '/keyfile',
                  readOnly: true
                }
              ],
              resources: {
                requests: mongoResources.requests || {
                  cpu: '100m',
                  memory: '256Mi'
                },
                limits: mongoResources.limits || {
                  cpu: '500m',
                  memory: '512Mi'
                }
              }
            },
            {
              name: 'nightscout',
              image: nightscoutImage,
              ports: [
                {
                  name: 'http',
                  containerPort: 1337
                }
              ],
              envFrom: [
                {
                  secretRef: {
                    name: nightscoutSecretName
                  }
                }
              ],
              env: spec.env || [],
              resources: {
                requests: nsResources.requests || {
                  cpu: '100m',
                  memory: '256Mi'
                },
                limits: nsResources.limits || {
                  cpu: '1000m',
                  memory: '1Gi'
                }
              }
            }
          ],
          volumes: [
            {
              name: 'keyfile-secret',
              secret: {
                secretName: keyfileSecretName,
                defaultMode: 0o400
              }
            },
            {
              name: 'keyfile-prep',
              emptyDir: {}
            }
          ]
        }
      },
      volumeClaimTemplates: [
        {
          metadata: {
            name: 'data',
            labels: {
              'app.kubernetes.io/name': 'mongodb',
              'app.kubernetes.io/component': 'database',
              'app.kubernetes.io/part-of': 'nightscout-tenant',
              'app.kubernetes.io/instance': tenantId,
              'ns.mdn.io/tenant': tenantId
            },
            annotations: {
              'ns.mdn.io/backup-policy': spec.backup?.policy || 'snapshot',
              'ns.mdn.io/created-at': new Date().toISOString()
            }
          },
          spec: {
            accessModes: ['ReadWriteOnce'],
            storageClassName: storageClass,
            resources: {
              requests: {
                storage: storageSize
              }
            }
          }
        }
      ]
    }
  };
}

/**
 * Render direct Pod for steady state
 * Mounts existing PVC created by StatefulSet
 */
function renderPod(tenantId, namespace, spec, pvcName, authSecret, keyfileSecret, nightscoutSecret, config) {
  const mongoVersion = spec.mongodbVersion || '7.0';
  const mongoImage = spec.mongodbImage || `mongo:${mongoVersion}`;
  const nightscoutImage = spec.nightscoutImage || 'nightscout/cgm-remote-monitor:latest';
  
  const mongoResources = spec.mongoResources || {};
  const nsResources = spec.nightscoutResources || {};
  
  const authSecretName = authSecret.metadata.name;
  const keyfileSecretName = keyfileSecret.metadata.name;
  const nightscoutSecretName = nightscoutSecret.metadata.name;
  
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `${tenantId}-0`,
      namespace: namespace,
      labels: {
        'app.kubernetes.io/name': 'nightscout-tenant',
        'app.kubernetes.io/component': 'application',
        'app.kubernetes.io/part-of': 'nightscout-tenant',
        'app.kubernetes.io/instance': tenantId,
        'app.kubernetes.io/managed-by': 'metacontroller',
        'ns.mdn.io/tenant': tenantId
      }
    },
    spec: {
      initContainers: [
        {
          name: 'prepare-keyfile',
          image: config.images?.utility || 'busybox:latest',
          command: ['sh', '-c', 'cp /keyfile-secret/keyfile /keyfile-prep/keyfile && chmod 400 /keyfile-prep/keyfile && chown 999:999 /keyfile-prep/keyfile'],
          volumeMounts: [
            {
              name: 'keyfile-secret',
              mountPath: '/keyfile-secret',
              readOnly: true
            },
            {
              name: 'keyfile-prep',
              mountPath: '/keyfile-prep'
            }
          ]
        }
      ],
      containers: [
        {
          name: 'mongodb',
          image: mongoImage,
          ports: [
            {
              name: 'mongodb',
              containerPort: 27017
            }
          ],
          env: [
            {
              name: 'MONGO_INITDB_ROOT_USERNAME',
              valueFrom: {
                secretKeyRef: {
                  name: authSecretName,
                  key: 'MONGO_INITDB_ROOT_USERNAME'
                }
              }
            },
            {
              name: 'MONGO_INITDB_ROOT_PASSWORD',
              valueFrom: {
                secretKeyRef: {
                  name: authSecretName,
                  key: 'MONGO_INITDB_ROOT_PASSWORD'
                }
              }
            }
          ],
          args: [
            '--bind_ip_all',
            '--replSet', 'rs0',
            '--keyFile', '/keyfile/keyfile'
          ],
          volumeMounts: [
            {
              name: 'data',
              mountPath: '/data/db'
            },
            {
              name: 'keyfile-prep',
              mountPath: '/keyfile',
              readOnly: true
            }
          ],
          resources: {
            requests: mongoResources.requests || {
              cpu: '100m',
              memory: '256Mi'
            },
            limits: mongoResources.limits || {
              cpu: '500m',
              memory: '512Mi'
            }
          }
        },
        {
          name: 'nightscout',
          image: nightscoutImage,
          ports: [
            {
              name: 'http',
              containerPort: 1337
            }
          ],
          envFrom: [
            {
              secretRef: {
                name: nightscoutSecretName
              }
            }
          ],
          env: spec.env || [],
          resources: {
            requests: nsResources.requests || {
              cpu: '100m',
              memory: '256Mi'
            },
            limits: nsResources.limits || {
              cpu: '1000m',
              memory: '1Gi'
            }
          }
        }
      ],
      volumes: [
        {
          name: 'data',
          persistentVolumeClaim: {
            claimName: pvcName
          }
        },
        {
          name: 'keyfile-secret',
          secret: {
            secretName: keyfileSecretName,
            defaultMode: 0o400
          }
        },
        {
          name: 'keyfile-prep',
          emptyDir: {}
        }
      ]
    }
  };
}

/**
 * Render Init Job for MongoDB replica set initialization
 */
function renderInitJob(tenantId, namespace, databaseName, authSecret, config) {
  const authSecretName = authSecret.metadata.name;
  
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: `${tenantId}-init-rs`,
      namespace: namespace,
      labels: {
        'app.kubernetes.io/name': 'mongodb-init',
        'app.kubernetes.io/component': 'database',
        'app.kubernetes.io/part-of': 'nightscout-tenant',
        'app.kubernetes.io/instance': tenantId,
        'app.kubernetes.io/managed-by': 'metacontroller',
        'ns.mdn.io/tenant': tenantId
      }
    },
    spec: {
      ttlSecondsAfterFinished: 86400, // 24 hours
      backoffLimit: 3,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'mongodb-init',
            'app.kubernetes.io/component': 'database',
            'ns.mdn.io/tenant': tenantId
          }
        },
        spec: {
          restartPolicy: 'OnFailure',
          containers: [
            {
              name: 'init-replica-set',
              image: config.images?.mongoInit || 'mongo:7.0',
              env: [
                {
                  name: 'MONGO_INITDB_ROOT_USERNAME',
                  valueFrom: {
                    secretKeyRef: {
                      name: authSecretName,
                      key: 'MONGO_INITDB_ROOT_USERNAME'
                    }
                  }
                },
                {
                  name: 'MONGO_INITDB_ROOT_PASSWORD',
                  valueFrom: {
                    secretKeyRef: {
                      name: authSecretName,
                      key: 'MONGO_INITDB_ROOT_PASSWORD'
                    }
                  }
                },
                {
                  name: 'MONGO_INITDB_DATABASE',
                  value: databaseName
                },
                {
                  name: 'APP_USERNAME',
                  valueFrom: {
                    secretKeyRef: {
                      name: authSecretName,
                      key: 'username'
                    }
                  }
                },
                {
                  name: 'APP_PASSWORD',
                  valueFrom: {
                    secretKeyRef: {
                      name: authSecretName,
                      key: 'password'
                    }
                  }
                },
                {
                  name: 'APP_DATABASE',
                  valueFrom: {
                    secretKeyRef: {
                      name: authSecretName,
                      key: 'database'
                    }
                  }
                }
              ],
              command: ['bash', '-c'],
              args: [
                `
                set -e
                
                echo "Waiting for MongoDB to be ready..."
                until mongosh --host ${tenantId}-0.${tenantId} --eval "db.adminCommand('ping')" > /dev/null 2>&1; do
                  echo "MongoDB not ready, waiting..."
                  sleep 2
                done
                
                echo "Initializing replica set..."
                mongosh --host ${tenantId}-0.${tenantId} --eval "
                  rs.initiate({
                    _id: 'rs0',
                    members: [{ _id: 0, host: '${tenantId}-0.${tenantId}:27017' }]
                  })
                "
                
                echo "Waiting for replica set to be ready..."
                sleep 5
                
                echo "Creating application user..."
                mongosh "mongodb://\${MONGO_INITDB_ROOT_USERNAME}:\${MONGO_INITDB_ROOT_PASSWORD}@${tenantId}-0.${tenantId}:27017/admin?authSource=admin" --eval "
                  use \${APP_DATABASE};
                  db.createUser({
                    user: '\${APP_USERNAME}',
                    pwd: '\${APP_PASSWORD}',
                    roles: [
                      { role: 'readWrite', db: '\${APP_DATABASE}' },
                      { role: 'dbAdmin', db: '\${APP_DATABASE}' }
                    ]
                  });
                "
                
                echo "MongoDB initialization complete: replica set initialized and user created"
                `
              ]
            }
          ]
        }
      }
    }
  };
}

module.exports = createTenantCompositeSync;
