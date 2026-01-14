/**
 * Storage Composite Controller
 * 
 * Manages MongoDB StatefulSet + Service from StorageAccount CRD parent
 * 
 * Parent: StorageAccount CRD (nightscout.io/v1alpha1)
 * Children:
 *   - MongoDB StatefulSet
 *   - MongoDB Service (headless)
 *   - Init Replica Set Job (for replica set initialization)
 *   - MongoDB Auth Secret (root credentials for MongoDB admin)
 * Related (not owned):
 *   - PersistentVolumeClaim (created by StatefulSet, protected from deletion)
 *   - ComputeInstances (tenants using this storage)
 * 
 * Spec fields:
 *   - spec.mongodbVersion: MongoDB version (e.g., "7.0")
 *   - spec.replicas: Number of MongoDB replicas (default: 3)
 *   - spec.storageSize: Storage size per replica (default: "10Gi")
 *   - spec.tier: Service tier (free, basic, premium, enterprise)
 * 
 * Note: Per-tenant database migration is handled by Storage Credentials Decorator,
 * not this controller. See storage-credentials-decorator-sync.js for migration logic.
 */

const crypto = require('crypto');
const _ = require('lodash');
const { renderMongoDB, renderInitMongoClusterJob } = require('./resources');
const { ANNOTATIONS, LABELS } = require('./constants');

function createStorageCompositeSync(config) {
  // TODO: set up as a pipeline of handlers
  function pull_objects (req, res, next) {
    // set up everything needed by our handlers.
    const { parent, children, related } = req.body;
    // Extract configuration from StorageAccount CRD spec
    const storageConfig = extractStorageConfig(parent);
    const spec = parent.spec || {};
    const storageType = spec.storageType;
    const storageAccount = parent.metadata.name;
    const storageAccountLabel = parent.metadata.labels?.['storage.nightscout.org/account'];
    req.parent = parent;
    req.children = children;
    req.related = related;
    req.storageConfig = storageConfig;
    req.spec = spec;
    req.storageAccount = storageAccount;
    req.databaseName = generateDatabaseName(storageAccount);
    
    res.children = [ ];
    res.status = { phase: 'Pending', conditions: [ ] };

    // Determine provisioning needs upfront (accommodates hybrid migration scenarios)
    // req.needsDedicatedInfra = (storageType === 'dedicated' || storageType === 'hybrid-migration');

    // Count tenants using this storage account (from related ComputeInstances)
    // const tenantUsage = countTenantUsage(req.related, req.storageAccount);
    // console.log('Tenant Usage', tenantUsage);
    return next( );
  }
  function ensure_initialization (req, res, next) {


    console.log('req.related', req.related);
    console.log('req.children', req.children);
    const storageAccount = req.storageAccount;
    // Check if app-credentials Secret already exists (first-cycle-only pattern)
    const appCredentialsSecretName = `${storageAccount}-mongo-auth`;
    const existingAppSecret = req.related['Secret.v1']?.[appCredentialsSecretName];

    if (!existingAppSecret) {
      console.log('storageAccount', storageAccount, 'MISSING SECRET KEY MUST CREATE OUT OF BAND');

      res.status.phase = 'Pending';
      return next( );
    }
    req.needsDedicatedInfra = (existingAppSecret.metadata?.annotations['ns.mdn.io/runtime-required'] == 'dedicated');

    res.status.phase = 'Pending';
    req.storageSecret = existingAppSecret;
    return next( );
  }

  function ensureMongoKeyfile(req, res, next) {
    // Only generate keyfile for dedicated infrastructure
    if (!req.needsDedicatedInfra) {
      return next();
    }

    const storageAccount = req.storageAccount;
    const keyfileSecretName = `${storageAccount}-mongo-keyfile`;
    
    // Check if keyfile Secret already exists (in children, or related)
    const existingKeyfile = req.children['Secret.v1']?.[keyfileSecretName] || req.related['Secret.v1']?.[keyfileSecretName];
    
    req.existingKeyfile = existingKeyfile;
    if (existingKeyfile) {
      console.log(`  Keyfile Secret ${keyfileSecretName} already exists`);
      // return next();
    }
    
    // Generate new keyfile Secret
    console.log(`  Generating keyfile Secret for ${storageAccount}`);
    
    // Generate 64 random bytes, base64 encoded
    const keyfileData = crypto.randomBytes(64).toString('base64');
    
    // const tier = req.spec.tier || 'basic';
    
    const keyfileSecret = {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'Opaque',
      metadata: {
        name: keyfileSecretName,
        labels: {
          'app.kubernetes.io/name': 'mongodb-keyfile',
          'app.kubernetes.io/component': 'database',
          'app.kubernetes.io/managed-by': 'metacontroller',
          'ns.mdn.io/composite': 'storage',
          'storage.nightscout.org/account': storageAccount
        },
        annotations: {
          // 'ns.mdn.io/tier': tier,
          'ns.mdn.io/created-at': existingKeyfile ? existingKeyfile.metadata.annotations['ns.mdn.io/created-at'] : new Date().toISOString(),
          'ns.mdn.io/description': 'MongoDB replica set keyfile for member authentication'
        }
      },
      /*
      stringData: {
        keyfile: keyfileData
      }
      */
    };
    if (existingKeyfile) {
      keyfileSecret.data = existingKeyfile.data;
    } else {
      keyfileSecret.stringData = { keyfile: keyfileData };
    }
    
    res.children.push(keyfileSecret);
    console.log(`  Added keyfile Secret to children`);
    
    return next();
  }


  function collectAttachments (req, res, next) {
    // Index req.children (owned) and req.related (label-selected) into req.attachments
    // This provides easy lookup for protected resources
    
    req.attachments = {
      pvcs: {},
      secrets: {},
      configMaps: {}
    };
    
    // Index owned children (PVCs may not be owned in selector mode)
    const childPVCs = req.children['PersistentVolumeClaim.v1'] || {};
    for (const [name, pvc] of Object.entries(childPVCs)) {
      req.attachments.pvcs[name] = { source: 'children', resource: pvc };
    }
    
    const childSecrets = req.children['Secret.v1'] || {};
    for (const [name, secret] of Object.entries(childSecrets)) {
      req.attachments.secrets[name] = { source: 'children', resource: secret };
    }
    
    const childConfigMaps = req.children['ConfigMap.v1'] || {};
    for (const [name, cm] of Object.entries(childConfigMaps)) {
      req.attachments.configMaps[name] = { source: 'children', resource: cm };
    }
    
    // Index related resources (label-selected, not owned)
    if (req.related) {
      const relatedPVCs = req.related['PersistentVolumeClaim.v1'] || {};
      for (const [name, pvc] of Object.entries(relatedPVCs)) {
        if (!req.attachments.pvcs[name]) {
          req.attachments.pvcs[name] = { source: 'related', resource: pvc };
        }
      }
      
      const relatedSecrets = req.related['Secret.v1'] || {};
      for (const [name, secret] of Object.entries(relatedSecrets)) {
        if (!req.attachments.secrets[name]) {
          req.attachments.secrets[name] = { source: 'related', resource: secret };
        }
      }
      
      const relatedConfigMaps = req.related['ConfigMap.v1'] || {};
      for (const [name, cm] of Object.entries(relatedConfigMaps)) {
        if (!req.attachments.configMaps[name]) {
          req.attachments.configMaps[name] = { source: 'related', resource: cm };
        }
      }
    }
    
    console.log(`  Collected attachments: ${Object.keys(req.attachments.pvcs).length} PVCs, ${Object.keys(req.attachments.secrets).length} Secrets, ${Object.keys(req.attachments.configMaps).length} ConfigMaps`);
    return next();
  }

  function render_shared_status (req, res, next) {
    if (req.spec.storageType != 'shared') {
      return next( );
    }
    var ready = req.storageSecret ? true : false;
    var sharedStatus = {
      condition: {
        type: 'Ready',
        status: ready ? 'True' : 'False',
        reason: ready ? 'SharedSecretReady' : 'WaitingForMongoSecret',
        message: ready
          ? 'Secret ready'
          : `SharedSecret not ready`,
        // lastTransitionTime: new Date().toISOString()
      }
    };
    res.status.phase = ready? 'Ready' : 'Pending';
    res.status.conditions.push(sharedStatus.condition);
    next( );

  }

  function render_specified_dedicated (req, res, next) {
    if (!req.needsDedicatedInfra) {
      return next( );
    }

    // Extract credentials from existing Secret for use in Jobs
    if (req.storageSecret) {
      const secretData = req.storageSecret?.data || {};
      var databaseName = Buffer.from(secretData.MONGO_INITDB_DATABASE || '', 'base64').toString('utf-8');

        
      const mongoResources = renderMongoDB(req.storageConfig, databaseName, config, req.parent);
      res.children.push(...mongoResources);

      // Check MongoDB readiness
      const mongoReadiness = checkMongoReadiness(req.children, req.storageAccount);
      if (mongoReadiness.condition) {
        res.status.phase = mongoReadiness.ready ? 'Ready' : res.status.phase;
        console.log("SETTING STATUS", mongoReadiness);
        res.status.conditions.push(mongoReadiness.condition);
      }

      if (mongoReadiness.ready) {
        const userInitialized = req.parent.status?.conditions?.find(c => c.type === 'UserInitialized' && c.status === 'True');
        if (!userInitialized) {
          console.log(`  NS user creation needed? - should render create-user Job`);
        }
      }
    }

    next( );
  }

  /**
   * Plan stable replica set initialization
   * Ensures MongoDB replica set is initialized before tenants can use it
   * 
   * Flow:
   * 1. Check if dedicated infrastructure is needed (skip for shared)
   * 2. Check durable marker (Secret annotation) for initialization status
   * 3. Render init-mongo-cluster Job if not initialized
   * 4. Watch Job status for completion
   * 5. Update Secret annotation when Job succeeds
   * 6. Set ReplicaSetReady status condition
   */
  function planStableReplicaset(req, res, next) {
    // Only for dedicated infrastructure (not shared)
    if (!req.needsDedicatedInfra) {
      return next();
    }

    // Check if we have a storage Secret
    if (!req.storageSecret) {
      console.log(`  Replica set init: No storage Secret yet, skipping`);
      return next();
    }
    if (!req.parent?.status?.databaseName) {
      return next();
    }

    const storageAccount = req.storageAccount;
    const jobName = `${storageAccount}-init-mongo-cluster`;
    
    // Check durable marker on Secret
    const rsInitialized = req.storageSecret.metadata?.annotations?.['ns.mdn.io/replica-set-initialized'];
    
    if (rsInitialized) {
      // Already initialized - just report status
      console.log(`  Replica set already initialized at ${rsInitialized}`);
      res.status.conditions.push({
        type: 'ReplicaSetReady',
        status: 'True',
        reason: 'ReplicaSetInitialized',
        message: `MongoDB replica set initialized at ${rsInitialized}`
      });
      return next();
    }

    // Not initialized yet - check if Job exists and render if needed
    console.log(`  Replica set not initialized - checking for init Job`);
    
    const existingJob = req.children['Job.batch/v1']?.[jobName];
    
    if (!existingJob) {
      // No Job exists - render it
      console.log(`  Rendering init-mongo-cluster Job for ${storageAccount}`);
      const initJob = renderInitMongoClusterJob(req.parent, storageAccount, config);
      res.children.push(initJob);
      
      // Set status condition: initialization in progress
      res.status.conditions.push({
        type: 'ReplicaSetReady',
        status: 'False',
        reason: 'InitializationPending',
        message: 'Replica set initialization Job created, waiting for execution'
      });
    } else {
      // Job exists - check its status
      const jobStatus = existingJob.status || {};
      const succeeded = jobStatus.succeeded || 0;
      const failed = jobStatus.failed || 0;
      const active = jobStatus.active || 0;
      
      console.log(`  Init Job status: active=${active}, succeeded=${succeeded}, failed=${failed}`);
      
      if (succeeded > 0) {
        // Job succeeded - Secret Decorator will update the annotation
        console.log(`  Init Job succeeded - Secret Decorator will mark initialization`);
        
        // Set status condition: ready
        res.status.conditions.push({
          type: 'ReplicaSetReady',
          status: 'True',
          reason: 'ReplicaSetInitialized',
          message: 'MongoDB replica set initialized successfully'
        });
        
        // Don't re-add Job - let ttlSecondsAfterFinished clean it up
        // Don't modify Secret - Secret Decorator owns annotation updates
      } else if (failed > 0) {
        // Job failed - keep rendering to allow retry (up to backoffLimit)
        // Will be re-added to children automatically below.
        console.log(`  Init Job failed (${failed} failures) - keeping Job for retry`);

        
        res.status.conditions.push({
          type: 'ReplicaSetReady',
          status: 'False',
          reason: 'InitializationFailed',
          message: `Replica set initialization failed (${failed} attempts). Check Job logs for details.`
        });
      } else {
        // Job still running - re-add to keep it alive
        console.log(`  Init Job in progress (active=${active}) - keeping Job alive`);

        res.status.conditions.push({
          type: 'ReplicaSetReady',
          status: 'False',
          reason: 'InitializationInProgress',
          message: 'Replica set initialization Job is running'
        });
      }
    }

    return next();
  }

  function fmt_metacontroller_webhook (req, res, next) {
    const response = {
      status: {
        phase: res.status.phase,
        observedGeneration: req.parent.metadata?.generation,
        conditions: res.status.conditions,
        connectionSecret: req.storageSecret?.metadata.name,
        databaseName: req.databaseName
      },
      children: res.children
    };
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
    console.log("FULL RESPONSE", response.children.length, JSON.stringify(response, null, 2));
    res.send(response);
    return next( );

  }

  // Compose/configure a list of handlers that operate in a chain or pipeline.
  return [
    pull_objects,                  // Gather K8s resources and classify provisioning needs
    // collectAttachments,         // NEW - index children and related resources for easy lookup
    ensure_initialization,         // Ensure mongo-auth Secret exists
    ensureMongoKeyfile,            // Ensure mongo-keyfile Secret exists for dedicated infrastructure
    render_shared_status,          // Handle shared storage type
    render_specified_dedicated,    // Render StatefulSet, Service, PDB for dedicated storage
    planStableReplicaset,          // NEW - Initialize MongoDB replica set via Job
    fmt_metacontroller_webhook     // Format response
  ];

}


/**
 * Generate short unique database name for storage account
 * Format: ns-<short-hash>
 */
function generateDatabaseName(storageAccount) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(storageAccount).digest('hex');
  return `ns-${hash.substring(0, 6)}`;
}

/**
 * Generate complete app credentials object
 * Returns all fields needed for Nightscout to connect to MongoDB
 */
function generateAppCredentials(storageAccount, mongoHost, mongoPort, databaseName, username, password) {
  const port = mongoPort || '27017';
  const mongodbUri = `mongodb://${username}:${password}@${mongoHost}:${port}/${databaseName}?authSource=${databaseName}`;
  
  return {
    'MONGODB_URI': mongodbUri,
    'MONGO_DATABASE': databaseName,
    'MONGO_HOST': mongoHost,
    'MONGO_PORT': port,
    'MONGO_USERNAME': username,
    'MONGO_PASSWORD': password,
    'MONGO_AUTH_SOURCE': databaseName
  };
}

/**
 * Extract storage configuration from StorageAccount CRD spec
 */
function extractStorageConfig(parent) {
  const storageAccount = parent.metadata.labels?.['storage.nightscout.org/account'] || parent.metadata.name;
  const namespace = parent.metadata.namespace;
  const spec = parent.spec || {};
  
  const mongodbVersion = spec.mongodbVersion || '7.0';
  const replicas = spec.replicas || 3;
  const storageSize = spec.storageSize || '10Gi';
  const tier = spec.tier || 'basic';
  const resources = spec.resources || {};
  
  const storageSizeGi = storageSize.replace('Gi', '');
  
  return {
    metadata: {
      namespace: namespace,
      labels: {
        'storage.nightscout.org/account': storageAccount,
        'ns.mdn.io/composite': 'storage',
        'ns.mdn.io/tier': tier
      }
    },
    data: {
      STORAGE: storageAccount,
      MONGO_REPLICAS: String(replicas),
      MONGO_STORAGE_GI: storageSizeGi,
      MONGO_IMAGE: `mongo:${mongodbVersion}`,
      MONGO_IMAGE_PULL_POLICY: 'IfNotPresent',
      MONGO_CPU_REQUEST: resources.requests?.cpu || '100m',
      MONGO_CPU_LIMIT: resources.limits?.cpu || '500m',
      MONGO_MEM_REQUEST: resources.requests?.memory || '256Mi',
      MONGO_MEM_LIMIT: resources.limits?.memory || '512Mi',
      MONGO_SC: spec.storageClass || undefined
    }
  };
}

/**
 * Check MongoDB readiness
 */
function checkMongoReadiness(children, storageAccount) {
  const statefulSets = children['StatefulSet.apps/v1'] || {};
  
  for (const [name, sts] of Object.entries(statefulSets)) {
    if (name === `${storageAccount}-mongodb` || name.startsWith(`${storageAccount}-mongo`)) {
      const replicas = sts.spec?.replicas || 0;
      const readyReplicas = sts.status?.readyReplicas || 0;
      const ready = readyReplicas >= 1;
      
      console.log(`MongoDB StatefulSet ${name} ready: ${readyReplicas}/${replicas}`);
      
      return {
        ready,
        replicas: `${readyReplicas}/${replicas}`,
        condition: {
          type: 'Ready',
          status: ready ? 'True' : 'False',
          reason: ready ? 'StatefulSetReady' : 'WaitingForPods',
          message: ready 
            ? `MongoDB StatefulSet is ready (${readyReplicas}/${replicas} replicas)`
            : `Waiting for MongoDB pods (${readyReplicas}/${replicas} replicas ready)`,
          // lastTransitionTime: new Date().toISOString()
        }
      };
    }
  }
  
  return {
    ready: false,
    replicas: '0/0',
    condition: {
      type: 'Ready',
      status: 'False',
      reason: 'StatefulSetNotFound',
      message: 'MongoDB StatefulSet not found or not yet created',
      // lastTransitionTime: new Date().toISOString()
    }
  };
}

/**
 * Check user initialization state from create-user Job
 */
function checkUserInitializationState(children, parent) {
  const nsuserInitialized = parent.metadata.annotations?.['ns.mdn.io/nsuser-initialized'] === 'true';
  const jobs = children['Job.batch/v1'] || {};
  
  for (const [name, job] of Object.entries(jobs)) {
    if (name.endsWith('-create-user')) {
      const conditions = job.status?.conditions || [];
      const succeeded = job.status?.succeeded || 0;
      const failed = job.status?.failed || 0;
      const active = job.status?.active || 0;
      
      const completeCondition = conditions.find(c => c.type === 'Complete' && c.status === 'True');
      const failedCondition = conditions.find(c => c.type === 'Failed' && c.status === 'True');
      
      if (completeCondition || succeeded > 0) {
        return {
          completed: true,
          alreadyMarked: nsuserInitialized,
          condition: {
            type: 'UserInitialized',
            status: 'True',
            reason: 'JobSucceeded',
            message: 'MongoDB user created successfully',
            lastTransitionTime: completeCondition?.lastTransitionTime || new Date().toISOString()
          }
        };
      } else if (failedCondition) {
        return {
          completed: false,
          alreadyMarked: nsuserInitialized,
          condition: {
            type: 'UserInitialized',
            status: 'False',
            reason: 'JobFailed',
            message: `User creation Job failed (${failed} failures)`,
            lastTransitionTime: failedCondition?.lastTransitionTime || new Date().toISOString()
          }
        };
      } else if (active > 0) {
        return {
          completed: false,
          alreadyMarked: nsuserInitialized,
          condition: {
            type: 'UserInitialized',
            status: 'False',
            reason: 'JobRunning',
            message: 'User creation Job is running',
            lastTransitionTime: new Date().toISOString()
          }
        };
      }
    }
  }
  
  // No create-user Job found
  if (nsuserInitialized) {
    return {
      completed: true,
      alreadyMarked: true,
      condition: {
        type: 'UserInitialized',
        status: 'True',
        reason: 'PreviouslyInitialized',
        message: 'MongoDB user previously initialized',
        lastTransitionTime: parent.metadata.annotations?.['ns.mdn.io/nsuser-initialized-at'] || new Date().toISOString()
      }
    };
  }
  
  return {
    completed: false,
    alreadyMarked: false,
    condition: null
  };
}


/**
 * Check migration state from Job children (LEGACY - for annotation-based migrations)
 */
function checkMigrationState(children, parent) {
  const migrationNeeded = parent.metadata.annotations?.['ns.mdn.io/migration-needed'] === 'true';
  const migrationComplete = parent.metadata.annotations?.['ns.mdn.io/migration-complete'] === 'true';
  
  if (!migrationNeeded) {
    return { enabled: false };
  }
  
  const jobs = children['Job.batch/v1'] || {};
  
  for (const [name, job] of Object.entries(jobs)) {
    if (name.endsWith('-migration')) {
      const conditions = job.status?.conditions || [];
      const succeeded = job.status?.succeeded || 0;
      const failed = job.status?.failed || 0;
      const active = job.status?.active || 0;
      
      const completeCondition = conditions.find(c => c.type === 'Complete' && c.status === 'True');
      const failedCondition = conditions.find(c => c.type === 'Failed' && c.status === 'True');
      
      if (completeCondition || succeeded > 0 || migrationComplete) {
        return {
          enabled: true,
          phase: 'Complete',
          complete: true,
          condition: {
            type: 'MigrationComplete',
            status: 'True',
            reason: 'JobSucceeded',
            message: 'Database migration completed successfully',
            lastTransitionTime: completeCondition?.lastTransitionTime || new Date().toISOString()
          }
        };
      } else if (failedCondition) {
        return {
          enabled: true,
          phase: 'Failed',
          complete: false,
          condition: {
            type: 'MigrationComplete',
            status: 'False',
            reason: 'JobFailed',
            message: `Migration job failed (${failed} failures). Check logs and delete job to retry.`,
            lastTransitionTime: failedCondition?.lastTransitionTime || new Date().toISOString()
          }
        };
      } else if (active > 0) {
        return {
          enabled: true,
          phase: 'Running',
          complete: false,
          condition: {
            type: 'MigrationComplete',
            status: 'Unknown',
            reason: 'JobRunning',
            message: 'Database migration in progress',
            lastTransitionTime: new Date().toISOString()
          }
        };
      } else {
        return {
          enabled: true,
          phase: 'Pending',
          complete: false,
          condition: {
            type: 'MigrationComplete',
            status: 'Unknown',
            reason: 'JobPending',
            message: 'Migration job created but not yet started',
            lastTransitionTime: new Date().toISOString()
          }
        };
      }
    }
  }
  
  return {
    enabled: true,
    phase: 'NotStarted',
    complete: false,
    condition: null
  };
}

/**
 * Count tenant usage from related ComputeInstances
 * Reports how many tenants are using this storage account
 */
function countTenantUsage(related, storageAccountLabel) {
  if (!related || !related['ComputeInstance.nightscout.io/v1alpha1']) {
    return {
      count: 0,
      tenantIds: []
    };
  }
  
  const computeInstances = related['ComputeInstance.nightscout.io/v1alpha1'];
  const tenants = [];
  
  for (const [name, ci] of Object.entries(computeInstances)) {
    const ciStorageAccount = ci.metadata?.labels?.['storage.nightscout.org/account'];
    const tenantId = name;
    
    // Only count ComputeInstances that match this storage account
    if (ciStorageAccount === storageAccountLabel) {
      tenants.push(tenantId);
    }
  }
  
  console.log(`  Tenant usage: ${tenants.length} tenant(s) using storage account ${storageAccountLabel}`);
  
  return {
    count: tenants.length,
    tenantIds: tenants
  };
}

module.exports = createStorageCompositeSync;
