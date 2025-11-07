/**
 * Storage Composite Controller
 * 
 * Manages MongoDB StatefulSet + Service from StorageAccount CRD parent
 * 
 * Parent: StorageAccount CRD (nightscout.io/v1alpha1)
 * Children:
 *   - MongoDB StatefulSet
 *   - MongoDB Service (headless)
 *   - Migration Job (if spec.migration.enabled is true)
 *   - App Credentials Secret (MongoDB credentials for Nightscout)
 * Related (not owned):
 *   - PersistentVolumeClaim (created by StatefulSet, protected from deletion)
 *   - ComputeInstances (tenants using this storage)
 * 
 * Spec fields:
 *   - spec.mongodbVersion: MongoDB version (e.g., "7.0")
 *   - spec.replicas: Number of MongoDB replicas (default: 3)
 *   - spec.storageSize: Storage size per replica (default: "10Gi")
 *   - spec.tier: Service tier (free, basic, premium, enterprise)
 *   - spec.migration.enabled: Trigger migration from external MongoDB
 *   - spec.migration.sourceConnectionSecret: Secret containing source MongoDB URI
 */

const _ = require('lodash');
const { renderMongoDB } = require('./resources');
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

    // Count tenants using this storage account (from related ComputeInstances)
    const tenantUsage = countTenantUsage(req.related, req.storageAccount);
    console.log('Tenant Usage', tenantUsage);
    return next( );
  }
  function ensure_initialization (req, res, next) {


    const storageAccount = req.storageAccount;
    // Check if app-credentials Secret already exists (first-cycle-only pattern)
    const appCredentialsSecretName = `${storageAccount}-mongo-auth`;
    const existingAppSecret = req.children['Secret.v1']?.[appCredentialsSecretName];

    if (!existingAppSecret) {
      console.log(`  Generating mongo admin credentials for ${storageAccount}`);
      
      // Generate new credentials
      const root_username = generateUsername(storageAccount, 'admin');
      const root_password = generateSecurePassword(32);
      const databaseName = generateDatabaseName(storageAccount);
      const stringData = {
        STORAGE: storageAccount,
        MONGO_INITDB_ROOT_USERNAME: root_username,
        MONGO_INITDB_ROOT_PASSWORD: root_password,
        MONGO_INITDB_DATABASE: databaseName
      };
      var mongo_secret = template_initial_storage_secret(storageAccount, req.storageType, req.spec.tier, stringData);
      res.status.phase = 'Pending';
      res.children.push(mongo_secret);
      return next( );
    }

    res.status.phase = 'Pending';
    req.storageSecret = existingAppSecret;
    return next( );
  }

  function template_initial_storage_secret (accountId, storageType, tier, stringData) {
    const secretName = `${accountId}-mongo-auth`;
    
    // Create K8s secret with provisioning root MongoDB credentials
    // This Secret triggers the storage composite controller via ns.mdn.io/composite label
    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: secretName,
        labels: {
          'app.kubernetes.io/managed-by': 'metacontroller',
          'storage.nightscout.org/account': accountId,
          'ns.mdn.io/composite': 'storage'
        },
        annotations: {
          'ns.mdn.io/storage-type': storageType || config.storage.defaultStorageType,
          'ns.mdn.io/tier': tier || opts.DEFAULT_TIER || 'basic',
          'ns.mdn.io/created-at': new Date().toISOString(),
          [ANNOTATIONS.PROTECTED_RESOURCE]: 'true'
        },
        ownerReferences: null  // CRITICAL: Protected resource - survives parent deletion
      },
      stringData
    };
    return secret;
  }

  function resolveSelectorContext (req, res, next) {
    // Extract selector labels from parent.spec.selector
    // Handle legacy parents without selector
    const selector = req.parent.spec?.selector;
    
    if (!selector) {
      console.log('  No selector found in parent spec - using legacy behavior');
      req.selectorContext = null;
      return next();
    }
    
    // Build selector context with labels from parent.spec.selector
    req.selectorContext = {
      labels: {
        [LABELS.STORAGE_ACCOUNT]: req.storageAccount,
        ...selector
      }
    };
    
    console.log('  Resolved selector context:', req.selectorContext.labels);
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

  function planProtectedAssets (req, res, next) {
    // Only run if selector context is available (new behavior)
    if (!req.selectorContext) {
      console.log('  Skipping planProtectedAssets - no selector context');
      return next();
    }
    
    // Plan protected resources WITHOUT ownerReferences
    // These resources survive parent deletion for data safety
    
    // 1. Handle mongo-auth Secret (protected resource)
    const mongoAuthSecretName = `${req.storageAccount}-mongo-auth`;
    const existingMongoAuth = req.attachments.secrets[mongoAuthSecretName];
    
    if (existingMongoAuth) {
      console.log(`  Found existing mongo-auth Secret: ${mongoAuthSecretName} (${existingMongoAuth.source})`);
      
      // Clone and strip ownerReferences (like decorator does)
      const protectedSecret = {
        ...existingMongoAuth.resource,
        metadata: {
          ...existingMongoAuth.resource.metadata,
          labels: {
            ...existingMongoAuth.resource.metadata.labels,
            [LABELS.STORAGE_ACCOUNT]: req.storageAccount,
            ...req.selectorContext.labels
          },
          annotations: {
            ...existingMongoAuth.resource.metadata.annotations,
            [ANNOTATIONS.PROTECTED_RESOURCE]: 'true'
          },
          ownerReferences: null,  // CRITICAL: Remove garbage collection
          managedFields: null
        }
      };
      
      res.children.push(protectedSecret);
    } else if (req.storageSecret) {
      // Secret was created in ensure_initialization, ensure it has protected annotation
      console.log(`  Using mongo-auth Secret from ensure_initialization`);
      // The secret is already in res.children from ensure_initialization
      // Just verify it has the protected annotation (added in template_initial_storage_secret)
    }
    
    // 2. Handle PVCs (protected resources)
    // PVCs are typically created by StatefulSet volumeClaimTemplates
    // We check if they exist in attachments (from related resources)
    // If they exist, we ensure they have correct labels but NO ownerReferences
    const pvcPattern = new RegExp(`^data-${req.storageAccount}-mongodb-\\d+$`);
    
    for (const [pvcName, pvcAttachment] of Object.entries(req.attachments.pvcs)) {
      if (pvcPattern.test(pvcName)) {
        console.log(`  Found MongoDB PVC: ${pvcName} (${pvcAttachment.source})`);
        
        // Ensure PVC has correct labels (without ownerReferences)
        const pvc = pvcAttachment.resource;
        const protectedPVC = {
          ...pvc,
          metadata: {
            ...pvc.metadata,
            labels: {
              ...pvc.metadata.labels,
              [LABELS.STORAGE_ACCOUNT]: req.storageAccount,
              ...req.selectorContext.labels
            },
            annotations: {
              ...pvc.metadata.annotations,
              [ANNOTATIONS.PROTECTED_RESOURCE]: 'true'
            },
            ownerReferences: undefined  // Explicitly remove ownerReferences
          }
        };
        
        // Add to response children WITHOUT ownerReferences
        res.children.push(protectedPVC);
      }
    }
    
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
    if (req.spec.storageType != 'dedicated') {
      // if (!migrate-to-dedicated)
      return next( );
    }

    // Extract credentials from existing Secret for use in Jobs
    const secretData = req.storageSecret.data || {};
    var databaseName = Buffer.from(secretData.MONGO_INITDB_DATABASE || '', 'base64').toString('utf-8');

    if (req.storageSecret) {
        
      // Ensure app credentials
      // var updated_secret = ensureNSUserCredentials(req.storageSecret, storageAccount);
      // var nsuserUsername = Buffer.from(secretData.MONGO_USERNAME || '', 'base64').toString('utf-8');
      // var nsuserPassword = Buffer.from(secretData.MONGO_PASSWORD || '', 'base64').toString('utf-8');
      // res.children.push(updated_secret);

      const mongoResources = renderMongoDB(req.storageConfig, databaseName, config);
      res.children.push(...mongoResources);
      // Check if NS user creation is needed
      
      // const hasCredentials = nsuserUsername && nsuserPassword;
      // Check MongoDB readiness
      const mongoReadiness = checkMongoReadiness(children, storageAccount);
      if (mongoReadiness.condition) {
        res.status.conditions.push(mongoReadiness.condition);
      }
      if (mongoReadiness.ready) {
        const userInitialized = req.parent.status?.conditions?.find(c => c.type === 'UserInitialized' && c.status === 'True');
        if (!userInitialized) {
          console.log(`  NS user creation needed - rendering create-user Job`);
          const createUserJob = renderCreateUserJobFromCRD(req.parent, req.storageAccount, nsuserUsername, nsuserPassword, config);
          res.children.push(createUserJob);
        }
      }
    }

    next( );
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
        // ..._.omit(resource, 'status')
      }));
    }).reject((child) => {
        // child.metadata.name == name
        // child.metadata.kind == kind
        return _.some(response.children, (excluded) => {
          hasSameName = excluded.metadata.name == child.metadata.name && excluded;
          isSameKind = excluded.kind == child.kind;
          return hasSameName && isSameKind;
          
        });
    }).value( );
    console.log("ADDING REMAINING CHILDREN not active in current phase", remaining.length, remaining);
    response.children.push(...remaining);
    res.send(response);
    return next( );

  }

  // Compose/configure a list of handlers that operate in a chain or pipeline.
  return [
    pull_objects, 
    resolveSelectorContext,       // NEW - extract selector labels from parent.spec.selector
    collectAttachments,            // NEW - index children and related resources for easy lookup
    ensure_initialization,         // EXISTING - handle mongo-auth secret initialization
    planProtectedAssets,           // NEW - handle protected resources (PVCs, secrets) without ownerReferences
    render_shared_status,          // EXISTING - handle shared storage type
    render_specified_dedicated,    // EXISTING - handle dedicated storage type
    fmt_metacontroller_webhook     // EXISTING - format response
  ];

}

/**
 * Generate secure random password
 */
function generateSecurePassword(length = 32) {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*-_+=';
  const crypto = require('crypto');
  let password = '';
  const randomBytes = crypto.randomBytes(length);
  
  for (let i = 0; i < length; i++) {
    password += charset[randomBytes[i] % charset.length];
  }
  
  return password;
}

/**
 * Generate unique username with random suffix
 */
function generateUsername(storageAccount, prefix='nsuser') {
  const crypto = require('crypto');
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  return `${prefix}-${storageAccount}-${randomSuffix}`;
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
 * Ensure NS user credentials exist in Secret, generate if missing
 */
function ensureNSUserCredentials(secret, storageAccount) {
  // Decode existing Secret data
  const existingData = {};
  if (secret.data) {
    Object.keys(secret.data).forEach(key => {
      existingData[key] = Buffer.from(secret.data[key], 'base64').toString('utf-8');
    });
  }
  
  // Check if credentials already exist
  const hasUsername = existingData['nsuser-username'];
  const hasPassword = existingData['nsuser-password'];
  
  if (hasUsername && hasPassword) {
    // Credentials already exist, no update needed
    return null;
  }
  
  console.log(`  Generating NS user credentials for ${storageAccount}`);
  
  // Generate new credentials
  const nsuserUsername = hasUsername || generateUsername(storageAccount);
  const nsuserPassword = hasPassword || generateSecurePassword(32);
  
  // Build updated Secret data (merge with existing)
  const updatedData = {
    ...existingData,
    'nsuser-username': nsuserUsername,
    'nsuser-password': nsuserPassword
  };
  
  // Encode to base64 for Kubernetes Secret
  const encodedData = {};
  Object.keys(updatedData).forEach(key => {
    encodedData[key] = Buffer.from(updatedData[key]).toString('base64');
  });
  
  // Return updated Secret
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: secret.metadata.name,
      namespace: secret.metadata.namespace,
      labels: secret.metadata.labels,
      annotations: {
        ...secret.metadata.annotations,
        'ns.mdn.io/nsuser-credentials-generated': new Date().toISOString()
      }
    },
    type: 'Opaque',
    data: encodedData
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
          lastTransitionTime: new Date().toISOString()
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
      lastTransitionTime: new Date().toISOString()
    }
  };
}

/**
 * Render app-credentials Secret for Nightscout containers
 * Contains only the credentials needed by application workloads (not root/admin credentials)
 */
function renderAppCredentialsSecret(storageAccount, namespace, appCredentials, storageLabels) {
  const secretName = `${storageAccount}-app-credentials`;
  
  // Encode all credential fields to base64
  const encodedData = {};
  Object.keys(appCredentials).forEach(key => {
    encodedData[key] = Buffer.from(appCredentials[key]).toString('base64');
  });
  
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: secretName,
      namespace: namespace,
      labels: {
        ...storageLabels,
        'app.kubernetes.io/component': 'app-credentials',
        'ns.mdn.io/composite': 'storage',
        'ns.mdn.io/credential-type': 'application'
      },
      annotations: {
        'ns.mdn.io/created-at': new Date().toISOString(),
        'ns.mdn.io/description': 'MongoDB credentials for Nightscout application containers'
      }
    },
    type: 'Opaque',
    data: encodedData
  };
}

/**
 * Render migration Job based on StorageAccount CRD spec
 * Uses ns-utility image and scripts for better status reporting
 */
function renderMigrationJobFromCRD(parent, storageAccount, sourceConnectionSecretName, config) {
  const namespace = parent.metadata.namespace;
  const jobName = `${storageAccount}-migration`;
  const spec = parent.spec || {};
  
  const targetDb = generateDatabaseName(storageAccount);
  const targetHost = `mongo-${targetDb}`;
  const migrationMethod = 'mongodump-restore';
  
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: namespace,
      labels: {
        'storage.nightscout.org/account': storageAccount,
        'app.kubernetes.io/component': 'migration',
        'ns.mdn.io/composite': 'storage'
      },
      annotations: {
        'ns.mdn.io/created-at': new Date().toISOString(),
        'ns.mdn.io/migration-method': migrationMethod,
        'ns.mdn.io/migration-target-db': targetDb,
        'ns.mdn.io/source-secret': sourceConnectionSecretName
      }
    },
    spec: {
      ttlSecondsAfterFinished: 86400,
      backoffLimit: 3,
      template: {
        metadata: {
          labels: {
            'storage.nightscout.org/account': storageAccount,
            'app.kubernetes.io/component': 'migration'
          }
        },
        spec: {
          restartPolicy: 'OnFailure',
          containers: [{
            name: 'migration',
            image: config.images.nsUtility,
            imagePullPolicy: config.images.nsUtilityPullPolicy,
            env: [
              {
                name: 'MIGRATION_SOURCE_URI',
                valueFrom: {
                  secretKeyRef: {
                    name: sourceConnectionSecretName,
                    key: 'uri'
                  }
                }
              },
              { name: 'MIGRATION_TARGET_HOST', value: targetHost },
              { name: 'MIGRATION_TARGET_DB', value: targetDb },
              { name: 'MIGRATION_METHOD', value: migrationMethod },
              { name: 'STORAGE_ACCOUNT', value: storageAccount }
            ],
            command: ['migrate-database.sh'],
            resources: {
              requests: {
                cpu: config.resources.nsUtility.cpuRequest,
                memory: config.resources.nsUtility.memRequest
              },
              limits: {
                cpu: config.resources.nsUtility.cpuLimit,
                memory: config.resources.nsUtility.memLimit
              }
            }
          }]
        }
      }
    }
  };
}

/**
 * Render migration Job based on Secret annotations (LEGACY)
 * Uses ns-utility image and scripts for better status reporting
 */
function renderMigrationJob(secret, storageAccount, sourceUri, config) {
  const namespace = secret.metadata.namespace;
  const jobName = `${storageAccount}-migration`;
  
  // Decode Secret data for target credentials
  const secretData = {};
  if (secret.data) {
    Object.keys(secret.data).forEach(key => {
      secretData[key] = Buffer.from(secret.data[key], 'base64').toString('utf-8');
    });
  }
  
  const targetDb = generateDatabaseName(storageAccount);
  const targetHost = `mongo-${targetDb}`;
  const targetUser = secretData.username || 'admin';
  const targetPassword = secretData.password || secretData['root-password'];
  const targetUri = `mongodb://${targetUser}:${targetPassword}@${targetHost}:27017/${targetDb}?replicaSet=rs0`;
  
  // Use ns-utility image from config
  const migrationImage = config.images.nsUtility;
  const migrationMethod = secret.metadata.annotations?.['ns.mdn.io/migration-method'] || 'mongodump-restore';
  
  // Get source database name from annotation or default
  const sourceDb = secret.metadata.annotations?.['ns.mdn.io/migration-source-db'] || 'nightscout';
  
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: namespace,
      labels: {
        'storage.nightscout.org/account': storageAccount,
        'app.kubernetes.io/component': 'migration',
        'ns.mdn.io/composite': 'storage'
      },
      annotations: {
        'ns.mdn.io/created-at': new Date().toISOString(),
        'ns.mdn.io/migration-method': migrationMethod,
        'ns.mdn.io/migration-source-db': sourceDb,
        'ns.mdn.io/migration-target-db': targetDb
      }
    },
    spec: {
      ttlSecondsAfterFinished: 86400, // 24 hours
      backoffLimit: 3,
      template: {
        metadata: {
          labels: {
            'storage.nightscout.org/account': storageAccount,
            'app.kubernetes.io/component': 'migration'
          }
        },
        spec: {
          restartPolicy: 'OnFailure',
          containers: [{
            name: 'migration',
            image: migrationImage,
            imagePullPolicy: config.images.nsUtilityPullPolicy,
            env: [
              { name: 'MIGRATION_SOURCE_URI', value: sourceUri },
              { name: 'MIGRATION_TARGET_URI', value: targetUri },
              { name: 'MIGRATION_SOURCE_DB', value: sourceDb },
              { name: 'MIGRATION_TARGET_DB', value: targetDb },
              { name: 'MIGRATION_METHOD', value: migrationMethod },
              { name: 'STORAGE_ACCOUNT', value: storageAccount }
            ],
            command: ['migrate-database.sh'],
            resources: {
              requests: {
                cpu: config.resources.nsUtility.cpuRequest,
                memory: config.resources.nsUtility.memRequest
              },
              limits: {
                cpu: config.resources.nsUtility.cpuLimit,
                memory: config.resources.nsUtility.memLimit
              }
            }
          }]
        }
      }
    }
  };
}

/**
 * Render create-user Job for StorageAccount CRD
 * Creates MongoDB user with NS app credentials
 */
function renderCreateUserJobFromCRD(parent, storageAccount, nsuserUsername, nsuserPassword, config) {
  const namespace = parent.metadata.namespace;
  const jobName = `${storageAccount}-create-user`;
  
  const targetDb = generateDatabaseName(storageAccount);
  const targetHost = `mongo-${targetDb}`;
  
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: namespace,
      labels: {
        'storage.nightscout.org/account': storageAccount,
        'app.kubernetes.io/component': 'user-initialization',
        'ns.mdn.io/composite': 'storage'
      },
      annotations: {
        'ns.mdn.io/created-at': new Date().toISOString(),
        'ns.mdn.io/target-user': nsuserUsername,
        'ns.mdn.io/target-db': targetDb
      }
    },
    spec: {
      ttlSecondsAfterFinished: 3600,
      backoffLimit: 3,
      template: {
        metadata: {
          labels: {
            'storage.nightscout.org/account': storageAccount,
            'app.kubernetes.io/component': 'user-initialization'
          }
        },
        spec: {
          restartPolicy: 'OnFailure',
          containers: [{
            name: 'create-user',
            image: config.images.nsUtility,
            imagePullPolicy: config.images.nsUtilityPullPolicy,
            env: [
              { name: 'MONGO_HOST', value: targetHost },
              // TODO: MONGO_ADMIN_URI is required by the create-users script.
              // The create-user Job needs to be rendered in response when a
              // new compute tenant is linked to the our storage resource by
              { name: 'MONGO_ADMIN_URI', value: targetHost },
              { name: 'MONGO_PORT', value: '27017' },
              { name: 'NSUSER_USERNAME', value: nsuserUsername },
              { name: 'NSUSER_PASSWORD', value: nsuserPassword },
              { name: 'NSUSER_DATABASE', value: targetDb },
              { name: 'STORAGE_ACCOUNT', value: storageAccount }
            ],
            command: ['create-mongodb-user.sh'],
            resources: {
              requests: {
                cpu: config.resources.nsUtility.cpuRequest,
                memory: config.resources.nsUtility.memRequest
              },
              limits: {
                cpu: config.resources.nsUtility.cpuLimit,
                memory: config.resources.nsUtility.memLimit
              }
            }
          }]
        }
      }
    }
  };
}

/**
 * Render create-user Job to create MongoDB user with NS app credentials (LEGACY)
 */
function renderCreateUserJob(secret, storageAccount, forceCreate, config) {
  const namespace = secret.metadata.namespace;
  const jobName = `${storageAccount}-create-user`;
  
  // Decode Secret data for credentials
  const secretData = {};
  if (secret.data) {
    Object.keys(secret.data).forEach(key => {
      secretData[key] = Buffer.from(secret.data[key], 'base64').toString('utf-8');
    });
  }
  
  const nsuserUsername = secretData['nsuser-username'];
  const nsuserPassword = secretData['nsuser-password'];
  const rootUser = secretData.username || secretData['root-user'] || 'admin';
  const rootPassword = secretData.password || secretData['root-password'];
  const targetDb = generateDatabaseName(storageAccount);
  const targetHost = `mongo-${targetDb}`;
  
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: namespace,
      labels: {
        'storage.nightscout.org/account': storageAccount,
        'app.kubernetes.io/component': 'user-initialization',
        'ns.mdn.io/composite': 'storage'
      },
      annotations: {
        'ns.mdn.io/created-at': new Date().toISOString(),
        'ns.mdn.io/force-create': forceCreate.toString(),
        'ns.mdn.io/target-user': nsuserUsername,
        'ns.mdn.io/target-db': targetDb
      }
    },
    spec: {
      ttlSecondsAfterFinished: 3600, // 1 hour
      backoffLimit: 3,
      template: {
        metadata: {
          labels: {
            'storage.nightscout.org/account': storageAccount,
            'app.kubernetes.io/component': 'user-initialization'
          }
        },
        spec: {
          restartPolicy: 'OnFailure',
          containers: [{
            name: 'create-user',
            image: config.images.nsUtility,
            imagePullPolicy: config.images.nsUtilityPullPolicy,
            env: [
              { name: 'MONGO_HOST', value: targetHost },
              { name: 'MONGO_PORT', value: '27017' },
              { name: 'MONGO_ROOT_PASSWORD', value: rootPassword },
              { name: 'NSUSER_USERNAME', value: nsuserUsername },
              { name: 'NSUSER_PASSWORD', value: nsuserPassword },
              { name: 'NSUSER_DATABASE', value: targetDb },
              { name: 'FORCE_USER_CREATE', value: forceCreate ? 'true' : 'false' },
              { name: 'STORAGE_ACCOUNT', value: storageAccount }
            ],
            command: ['create-mongodb-user.sh'],
            resources: {
              requests: {
                cpu: config.resources.nsUtility.cpuRequest,
                memory: config.resources.nsUtility.memRequest
              },
              limits: {
                cpu: config.resources.nsUtility.cpuLimit,
                memory: config.resources.nsUtility.memLimit
              }
            }
          }]
        }
      }
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
 * Check migration state from Job children (for CRD-based migrations)
 */
function checkMigrationStateFromCRD(children, migrationEnabled) {
  if (!migrationEnabled) {
    return { enabled: false, complete: true, failed: false };
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
      
      if (completeCondition || succeeded > 0) {
        return {
          enabled: true,
          complete: true,
          failed: false,
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
          complete: false,
          failed: true,
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
          complete: false,
          failed: false,
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
          complete: false,
          failed: false,
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
    complete: false,
    failed: false,
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

/**
 * Collect children that should be preserved unchanged
 * This prevents accidental deletion when we don't return a child
 * 
 * We preserve:
 * - Completed Jobs (Success status) - keep them for audit/history
 * - Failed Jobs - keep for debugging
 * - Running Jobs - keep them running
 * Only exclude Pending/incomplete Jobs that we might want to recreate
 * 
 * @param {Object} children - Existing children from request
 * @param {Object} parent - Parent StorageAccount CRD
 * @returns {Array} - Array of children resources to preserve
 */
function collectPreservedChildren(children, parent) {
  const preserved = [];
  
  // Preserve completed/running Jobs (don't recreate them)
  const jobs = children['Job.batch/v1'] || {};
  for (const [name, job] of Object.entries(jobs)) {
    const succeeded = job.status?.succeeded || 0;
    const failed = job.status?.failed || 0;
    const active = job.status?.active || 0;
    
    // Preserve if completed (succeeded or failed) or still running
    if (succeeded > 0 || failed > 0 || active > 0) {
      console.log(`  Preserving Job: ${name} (succeeded=${succeeded}, failed=${failed}, active=${active})`);
      preserved.push(job);
    }
  }
  
  return preserved;
}


module.exports = createStorageCompositeSync;
