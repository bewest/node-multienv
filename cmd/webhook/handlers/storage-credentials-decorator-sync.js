/**
 * Storage Credentials Decorator Controller
 * 
 * Manages per-tenant app credentials as attachments to ComputeInstance CRDs
 * 
 * Target: ComputeInstance CRD (nightscout.io/v1alpha1)
 * Attachments:
 *   - App Credentials Secret (MongoDB credentials for Nightscout pods)
 *   - Create User Job (initializes MongoDB user for new tenants)
 *   - Migration Job (optional - for shared → dedicated transitions)
 * 
 * Responsibilities:
 *   1. Dedicated Storage Mode:
 *      - Create unique app credentials Secret per ComputeInstance
 *      - Render create-user Job to initialize MongoDB user
 *      - Credentials isolated per tenant on same MongoDB instance
 *   
 *   2. Shared Storage Mode:
 *      - Skip credential creation (use existing ConfigMap-based credentials)
 *      - Allow legacy deployments to continue using shared MongoDB URI
 *   
 *   3. Migration Flow (Shared → Dedicated):
 *      - Detect migration annotation or ConfigMap + dedicated StorageAccount
 *      - Render migration Job with source (ConfigMap) and target (Secret) credentials
 *      - Preserve ConfigMap as backup during migration
 * 
 * Key Design Points:
 *   - Orthogonal to Storage/Compute composites (separation of concerns)
 *   - Uses DecoratorController pattern for attachment lifecycle
 *   - First-cycle-only credential generation (preserve existing Secrets)
 *   - Migration triggered by annotation: nightscout.io/migrate-to-dedicated: "true"
 */

const crypto = require('crypto');
const { ANNOTATIONS, LABELS, RESOURCE_TYPES } = require('./constants');

/**
 * Create storage credentials decorator sync handler with pipeline pattern
 */
function createStorageCredentialsDecoratorSync(config) {
  
  /**
   * Stage 1: Initialize context from webhook request
   * Extracts ComputeInstance, related resources, and attachments
   * Sets up req/res objects for pipeline
   */
  function initializeContext(req, res, next) {
    const { object: computeInstance, related, attachments } = req.body;
    
    req.computeInstance = computeInstance;
    req.related = related;
    req.attachments = attachments;
    req.tenantId = computeInstance.metadata.name;
    req.namespace = computeInstance.metadata.namespace;
    req.spec = computeInstance.spec || {};
    req.status = computeInstance.status || {};
    
    // Extract storage account reference (supports both spec and label)
    req.storageAccountName = req.spec.storageAccountRef?.name;
    req.storageAccountLabel = computeInstance.metadata.labels?.['storage.nightscout.org/account'];
    
    // Initialize response
    res.attachments = [];
    
    console.log('Storage credentials decorator sync for tenant:', req.tenantId);
    
    return next();
  }
  
  /**
   * Stage 2: Discover StorageAccount from relatedResources
   * Supports both spec.storageAccountRef.name and label-based discovery
   * Handles transient API failures by preserving existing attachments
   */
  function discoverStorageAccount(req, res, next) {
    const storageAccount = findStorageAccount(
      req.related,
      req.storageAccountName,
      req.storageAccountLabel
    );
    
    if (!storageAccount) {
      console.log(`  StorageAccount not found (name: ${req.storageAccountName}, label: ${req.storageAccountLabel})`);
      console.log('  Preserving existing attachments to prevent deletion');
      
      // CRITICAL: Preserve existing attachments during transient API failures
      // This prevents Metacontroller from deleting Secrets and Jobs
      const preserved = collectExistingAttachments(req.attachments);
      res.attachments.push(...preserved);
      
      // Early exit - skip remaining pipeline stages
      res.send({ attachments: res.attachments });
      return;
    }
    
    req.storageAccount = storageAccount;
    req.storageType = storageAccount.spec?.storageType || 'dedicated';
    req.storageAccountId = storageAccount.metadata.name;
    req.databaseName = generateDatabaseName(req.storageAccountId);
    
    console.log(`  Storage account: ${req.storageAccountId}, type: ${req.storageType}, database: ${req.databaseName}`);
    
    return next();
  }
  
  /**
   * Stage 3: Collect and index existing attachments
   * Indexes Secrets and Jobs for efficient lookup
   */
  function collectAttachments(req, res, next) {
    req.existingSecrets = req.attachments['Secret.v1'] || {};
    req.existingJobs = req.attachments['Job.batch/v1'] || {};
    
    req.appCredentialsSecretName = `${req.tenantId}-app-credentials`;
    req.existingSecret = req.existingSecrets[req.appCredentialsSecretName];
    
    console.log(`  Existing app-credentials Secret: ${req.existingSecret ? 'found' : 'not found'}`);
    
    return next();
  }
  
  /**
   * Stage 4: Plan credentials Secret (create/update/skip)
   * Handles dedicated vs shared storage modes
   * Protects existing Secrets from garbage collection
   */
  function planCredentialsSecret(req, res, next) {
    // Skip for shared storage mode
    if (req.storageType !== 'dedicated') {
      console.log(`  Shared storage mode - skipping credential creation`);
      req.credentials = null;
      return next();
    }
    
    console.log(`  Dedicated storage mode - managing app credentials`);
    
    let username, password;
    
    if (req.existingSecret) {
      // Existing Secret found - preserve credentials and add protections
      console.log(`  Updating existing app-credentials Secret: ${req.appCredentialsSecretName}`);
      
      // Clone Secret and strip garbage collection metadata
      const updatedSecret = {
        ...req.existingSecret,
        metadata: {
          ...req.existingSecret.metadata,
          labels: {
            ...(req.existingSecret.metadata.labels || {}),
            [LABELS.RESOURCE_TYPE]: RESOURCE_TYPES.APP_CREDENTIALS_SECRET
          },
          annotations: {
            ...(req.existingSecret.metadata.annotations || {}),
            [ANNOTATIONS.PROTECTED_RESOURCE]: 'true'
          },
          // CRITICAL: Remove ownerReferences (use null for JSON serialization)
          ownerReferences: null,
          managedFields: null
        }
      };
      
      res.attachments.push(updatedSecret);
      
      // Extract credentials for Job rendering
      const secretData = req.existingSecret.data || {};
      username = Buffer.from(secretData.MONGO_USERNAME || '', 'base64').toString('utf-8');
      password = Buffer.from(secretData.MONGO_PASSWORD || '', 'base64').toString('utf-8');
      
    } else {
      // First cycle - generate new credentials
      console.log(`  First cycle - generating new app credentials`);
      
      username = generateUsername(req.tenantId);
      password = generateSecurePassword(32);
      
      const mongoHost = `mongo-${req.databaseName}`;
      const mongoPort = '27017';
      
      const appCredentials = generateAppCredentials(
        req.tenantId,
        mongoHost,
        mongoPort,
        req.databaseName,
        username,
        password
      );
      
      const secret = renderAppCredentialsSecret(
        req.tenantId,
        req.namespace,
        appCredentials,
        req.computeInstance.metadata.labels
      );
      
      res.attachments.push(secret);
    }
    
    // Store credentials for Job rendering
    req.credentials = username && password ? { username, password } : null;
    
    return next();
  }
  
  /**
   * Stage 5: Plan user initialization Job (create/skip)
   * Only renders Job if UserInitialized condition is not True
   * Preserves completed/running/failed Jobs
   */
  function planUserInitJob(req, res, next) {
    // Skip if no credentials (shared storage or missing data)
    if (!req.credentials) {
      return next();
    }
    
    // Check if user already initialized
    const userInitialized = req.status.conditions?.find(
      c => c.type === 'UserInitialized' && c.status === 'True'
    );
    
    if (userInitialized) {
      console.log(`  User already initialized - skipping Job creation`);
      return next();
    }
    
    console.log(`  User not initialized - rendering create-user Job`);
    
    const createUserJob = renderCreateUserJob(
      req.tenantId,
      req.namespace,
      req.storageAccountId,
      req.databaseName,
      req.credentials.username,
      req.credentials.password,
      req.computeInstance.metadata.labels,
      config
    );
    
    res.attachments.push(createUserJob);
    
    return next();
  }
  
  /**
   * Stage 6: Assemble final response
   * Sends attachments back to Metacontroller
   */
  function assembleResponse(req, res, next) {
    res.send({ attachments: res.attachments });
  }
  
  // Define pipeline stages
  const pipeline = [
    initializeContext,
    discoverStorageAccount,
    collectAttachments,
    planCredentialsSecret,
    planUserInitJob,
    assembleResponse
  ];
  
  // Return async handler that executes pipeline
  return async function storageCredentialsDecoratorSync(req, res) {
    let currentStage = 0;
    
    function next(err) {
      if (err) {
        console.error('Error in storage credentials decorator sync:', err);
        return res.send(500, { error: err.message });
      }
      
      if (currentStage >= pipeline.length) {
        return;
      }
      
      const handler = pipeline[currentStage++];
      
      try {
        handler(req, res, next);
      } catch (error) {
        console.error('Error in storage credentials decorator sync:', error);
        res.send(500, { error: error.message });
      }
    }
    
    next();
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Find StorageAccount CRD from related resources
 * Supports both spec.storageAccountRef.name and label-based discovery
 */
function findStorageAccount(related, storageAccountName, storageAccountLabel) {
  if (!related || !related['StorageAccount.nightscout.io/v1alpha1']) {
    return null;
  }
  
  const storageAccounts = related['StorageAccount.nightscout.io/v1alpha1'];
  
  // Try direct name lookup first (spec.storageAccountRef.name)
  if (storageAccountName && storageAccounts[storageAccountName]) {
    return storageAccounts[storageAccountName];
  }
  
  // Fallback: search by storage account label
  if (storageAccountLabel) {
    for (const [name, sa] of Object.entries(storageAccounts)) {
      const saLabel = sa.metadata?.labels?.['storage.nightscout.org/account'];
      if (saLabel === storageAccountLabel) {
        console.log(`  Found StorageAccount by label: ${storageAccountLabel} (name: ${name})`);
        return sa;
      }
    }
  }
  
  return null;
}

/**
 * Collect existing attachments to preserve during transient failures
 * Prevents Metacontroller from deleting Secrets and Jobs when StorageAccount lookup fails
 */
function collectExistingAttachments(attachments) {
  const preserved = [];
  
  if (!attachments) {
    return preserved;
  }
  
  // Preserve existing Secrets (app-credentials)
  if (attachments['Secret.v1']) {
    Object.values(attachments['Secret.v1']).forEach(secret => {
      preserved.push(secret);
    });
  }
  
  // Preserve existing Jobs (user initialization, migration)
  if (attachments['Job.batch/v1']) {
    Object.values(attachments['Job.batch/v1']).forEach(job => {
      preserved.push(job);
    });
  }
  
  return preserved;
}

/**
 * Generate secure random password
 */
function generateSecurePassword(length = 32) {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  const randomBytes = crypto.randomBytes(length);
  let password = '';
  
  for (let i = 0; i < length; i++) {
    password += charset[randomBytes[i] % charset.length];
  }
  
  return password;
}

/**
 * Generate deterministic username from tenant ID
 */
function generateUsername(tenantId, prefix = 'nsuser') {
  const hash = crypto.createHash('sha256').update(tenantId).digest('hex').substring(0, 8);
  return `${prefix}-${hash}`;
}

/**
 * Generate deterministic database name from storage account
 */
function generateDatabaseName(storageAccount) {
  const hash = crypto.createHash('sha256').update(storageAccount).digest('hex').substring(0, 6);
  return `ns-${hash}`;
}

/**
 * Generate app credentials object
 */
function generateAppCredentials(tenantId, mongoHost, mongoPort, databaseName, username, password) {
  const mongoUri = `mongodb://${username}:${password}@${mongoHost}:${mongoPort}/${databaseName}?authSource=${databaseName}`;
  
  return {
    MONGO_USERNAME: username,
    MONGO_PASSWORD: password,
    MONGO_HOST: mongoHost,
    MONGO_PORT: mongoPort,
    MONGO_DATABASE: databaseName,
    MONGODB_URI: mongoUri
  };
}

/**
 * Render app-credentials Secret
 */
function renderAppCredentialsSecret(tenantId, namespace, appCredentials, labels) {
  const secretName = `${tenantId}-app-credentials`;
  
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
        ...labels,
        'app.kubernetes.io/component': 'app-credentials',
        'app.kubernetes.io/managed-by': 'metacontroller',
        'ns.mdn.io/decorator': 'storage-credentials',
        'ns.mdn.io/credential-type': 'application',
        [LABELS.RESOURCE_TYPE]: RESOURCE_TYPES.APP_CREDENTIALS_SECRET
      },
      annotations: {
        'ns.mdn.io/created-at': new Date().toISOString(),
        'ns.mdn.io/tenant': tenantId,
        'ns.mdn.io/description': 'MongoDB credentials for Nightscout application pods',
        [ANNOTATIONS.PROTECTED_RESOURCE]: 'true'
      }
    },
    type: 'Opaque',
    data: encodedData
  };
}

/**
 * Render create-user Job
 */
function renderCreateUserJob(tenantId, namespace, storageAccount, databaseName, username, password, labels, config) {
  const jobName = `${tenantId}-create-user`;
  const targetHost = `mongo-${databaseName}`;
  
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: namespace,
      labels: {
        ...labels,
        'app.kubernetes.io/component': 'user-initialization',
        'app.kubernetes.io/managed-by': 'metacontroller',
        'ns.mdn.io/decorator': 'storage-credentials',
        'storage.nightscout.org/account': storageAccount
      },
      annotations: {
        'ns.mdn.io/created-at': new Date().toISOString(),
        'ns.mdn.io/tenant': tenantId,
        'ns.mdn.io/target-user': username,
        'ns.mdn.io/target-db': databaseName
      }
    },
    spec: {
      ttlSecondsAfterFinished: 3600,
      backoffLimit: 3,
      template: {
        metadata: {
          labels: {
            ...labels,
            'app.kubernetes.io/component': 'user-initialization',
            'ns.mdn.io/decorator': 'storage-credentials'
          }
        },
        spec: {
          restartPolicy: 'OnFailure',
          serviceAccountName: 'migration-job',
          containers: [{
            name: 'create-user',
            image: config.images.nsUtility,
            imagePullPolicy: config.imagePullPolicies.nsUtility || 'IfNotPresent',
            env: [
              { name: 'MONGO_HOST', value: targetHost },
              { name: 'MONGO_PORT', value: '27017' },
              { 
                name: 'MONGO_ADMIN_USERNAME',
                valueFrom: {
                  secretKeyRef: {
                    name: `${storageAccount}-mongo-auth`,
                    key: 'MONGO_INITDB_ROOT_USERNAME'
                  }
                }
              },
              {
                name: 'MONGO_ADMIN_PASSWORD',
                valueFrom: {
                  secretKeyRef: {
                    name: `${storageAccount}-mongo-auth`,
                    key: 'MONGO_INITDB_ROOT_PASSWORD'
                  }
                }
              },
              { name: 'NSUSER_USERNAME', value: username },
              { name: 'NSUSER_PASSWORD', value: password },
              { name: 'NSUSER_DATABASE', value: databaseName },
              { name: 'STORAGE_ACCOUNT', value: storageAccount }
            ],
            command: ['sh', '-c'],
            args: [`
              echo "Creating MongoDB user ${username} for database ${databaseName}..."
              
              MONGO_ADMIN_URI="mongodb://\${MONGO_ADMIN_USERNAME}:\${MONGO_ADMIN_PASSWORD}@\${MONGO_HOST}:\${MONGO_PORT}/admin"
              
              mongosh "\${MONGO_ADMIN_URI}" --eval "
                use ${databaseName};
                db.createUser({
                  user: '${username}',
                  pwd: '${password}',
                  roles: [
                    { role: 'readWrite', db: '${databaseName}' },
                    { role: 'dbAdmin', db: '${databaseName}' }
                  ]
                });
              "
              
              echo "User creation completed"
            `],
            resources: {
              requests: {
                cpu: config.resources?.nsUtility?.cpuRequest || '100m',
                memory: config.resources?.nsUtility?.memRequest || '128Mi'
              },
              limits: {
                cpu: config.resources?.nsUtility?.cpuLimit || '200m',
                memory: config.resources?.nsUtility?.memLimit || '256Mi'
              }
            }
          }]
        }
      }
    }
  };
}

module.exports = { createStorageCredentialsDecoratorSync };
