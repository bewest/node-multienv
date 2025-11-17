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
    req.migrationRequested = req.computeInstance.metadata?.annotations?.['nightscout.io/migrate-to-dedicated'] === 'true';
    
    // Extract storage account reference (supports both spec and label)
    req.storageAccountName = req.spec.storageAccountRef?.name;
    req.storageAccountLabel = computeInstance.metadata.labels?.['storage.nightscout.org/account'];
    
    // Initialize response
    res.attachments = [ ];
    res.labels = { };
    res.annotations = { };
    
    console.log('TENANT credentials decorator Storage credentials decorator sync for tenant:', req.tenantId);
    
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
    req.storageType = storageAccount.spec?.storageType;
    req.credentialsRequested = req.storageType == 'dedicated' || req.migrationRequested;
    req.storageAccountId = storageAccount.metadata.name; // TODO: look at annotation?
    // req.databaseName = generateDatabaseName(req.storageAccountId);
    req.databaseName = req.storageAccount.status.databaseName;
    
    console.log(`  Storage account: ${req.storageAccountId}, type: ${req.storageType}, database: ${req.databaseName}`);
    console.log(`  Storage account:`, req.storageAccount);
    req.mongoAuthName = req.storageAccount.status.connectionSecret;
    
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
    req.existingSecret = req.existingSecrets[req.appCredentialsSecretName] || req.related['Secret.v1'][req.appCredentialsSecretName];
    
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
    if (!req.credentialsRequested) {
      console.log(`  Shared storage mode - skipping credential creation`);
      req.credentials = null;
      return next();
    }
    console.log(`  Dedicated storage mode - managing app credentials`);

    if (req.existingSecret) {
      // Existing Secret found - preserve credentials and add protections
      console.log(`  compute credentials decorator Found existing app-credentials Secret: ${req.appCredentialsSecretName}`);
      res.attachments.push(req.existingSecret);
      // res.attachments.push(updatedSecret);

    } else {
      // First cycle - generate new credentials
      console.log(`  FIRST CYCLE - GENERATING NEW APP CREDENTIALS`);
      console.log(`MISSING APP SECRET`);
      console.log('MISSING FROM RELATED?', req.related);
      
      username = generateUsername(req.tenantId);
      password = generateSecurePassword(16);
      
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
      req.credentials = null;
      
      res.attachments.push(secret);
    }
    
    // Store credentials for Job rendering
    
    return next();
  }
  
  /**
   * Stage 5: Track user initialization Job completion
   * Sets ns.mdn.io/user-initialized annotation on Secret when Job succeeds
   * This ties Job lifecycle to Secret lifecycle
   */
  function trackUserInitialization(req, res, next) {
    // Skip if no app-credentials Secret exists yet
    if (!req.existingSecret) {
      console.log(`  No Secret exists yet - skipping user initialization tracking`);
      return next();
    }
    
    // Check if user already initialized via Secret annotation
    const userInitialized = req.existingSecret.metadata?.annotations?.['ns.mdn.io/user-initialized'];
    
    if (userInitialized) {
      console.log(`  User already initialized at ${userInitialized}`);
      return next();
    }
    
    // Find create-user Job in related resources
    const jobs = req.related['Job.batch/v1'] || {};
    const createUserJobName = `${req.storageAccountId}-${req.tenantId}-create-user`;
    const createUserJob = jobs[createUserJobName];
    
    if (!createUserJob) {
      console.log(`  Create-user Job not found - initialization not started`);
      return next();
    }
    
    // Check if Job succeeded
    const jobStatus = createUserJob.status || {};
    const succeeded = (jobStatus.succeeded || 0) > 0;
    
    if (succeeded) {
      console.log(`  Create-user Job succeeded - marking user initialized on Secret`);
      
      // Update annotation on the Secret object (req.existingSecret)
      // This works whether Secret came from attachments or related
      req.existingSecret.metadata.annotations = req.existingSecret.metadata.annotations || {};
      req.existingSecret.metadata.annotations['ns.mdn.io/user-initialized'] = new Date().toISOString();
      
      // Ensure the updated Secret is in res.attachments
      // Check if already attached (by planCredentialsSecret)
      const secretInAttachments = res.attachments.find(
        att => att.kind === 'Secret' && att.metadata.name === req.appCredentialsSecretName
      );
      
      if (!secretInAttachments) {
        // Not yet attached - add it now with the annotation
        console.log(`  Secret not in attachments - adding with user-initialized annotation`);
        res.attachments.push(req.existingSecret);
      } else {
        console.log(`  Updated Secret ${req.appCredentialsSecretName} with user-initialized annotation`);
      }
    } else {
      console.log(`  Create-user Job status: active=${jobStatus.active || 0}, failed=${jobStatus.failed || 0}`);
    }
    
    return next();
  }
  
  /**
   * Stage 6: Plan user initialization Job (create/skip)
   * Only renders Job if user not initialized (checked via Secret annotation)
   * Secret lifecycle controls Job lifecycle - if Secret deleted, Job reruns
   */
  function planUserInitJob(req, res, next) {
    // Skip if shared storage (no app-credentials Secret)
    if (!req.credentialsRequested) {
      console.log(`  Shared storage mode - skipping user init Job`);
      return next();
    }
    
    // Check if Secret exists and has user-initialized annotation
    // The annotation is set by trackUserInitialization when Job succeeds
    const userInitialized = req.existingSecret?.metadata?.annotations?.['ns.mdn.io/user-initialized'];
    
    if (userInitialized) {
      console.log(`  User already initialized at ${userInitialized} - skipping Job creation`);
      return next();
    }
    
    // User not initialized - render create-user Job
    // This handles both first-time creation and Secret recreation scenarios
    console.log(`  User not initialized - rendering create-user Job`);
    
    // Need to reference the Secret (either existing or newly created in this cycle)
    const secret = req.existingSecret || res.attachments.find(
      att => att.kind === 'Secret' && att.metadata.name === req.appCredentialsSecretName
    );
    
    if (!secret) {
      console.log(`  Warning: No Secret found to reference for create-user Job - skipping`);
      return next();
    }
    
    const createUserJob = renderCreateUserJob(
      req.mongoAuthName,
      secret,
      req.tenantId,
      req.namespace,
      req.storageAccountId,
      config
    );
    
    res.attachments.push(createUserJob);
    
    return next();
  }
  
  /**
   * Stage 6: Plan migration Job (shared → dedicated storage transition)
   * Detects migration annotation and renders migration Job
   * Only executes if migration annotation is present
   */
  function planMigrationJob(req, res, next) {
    // Check for migration annotation
    const migrationRequested = req.computeInstance.metadata?.annotations?.['nightscout.io/migrate-to-dedicated'] === 'true';
    
    if (!migrationRequested) {
      return next();
    }
    
    console.log(`  Migration annotation detected - planning shared → dedicated migration`);
    
    // Check if migration already completed
    const migrationCompleted = req.status.conditions?.find(
      c => c.type === 'MigrationCompleted' && c.status === 'True'
    );
    
    if (migrationCompleted) {
      console.log(`  Migration already completed - skipping Job creation`);
      return next();
    }
    
    // Verify we have target credentials (should exist from planCredentialsSecret stage)
    if (!req.credentials) {
      console.log(`  Warning: Migration requested but no target credentials available - skipping`);
      return next();
    }
    
    console.log(`  Rendering migration Job for tenant ${req.tenantId}`);
    
    const migrationJob = renderMigrationJob(
      req.tenantId,
      req.namespace,
      req.storageAccountId,
      req.databaseName,
      req.credentials.username,
      req.credentials.password,
      req.computeInstance.metadata.labels,
      config
    );
    
    res.attachments.push(migrationJob);
    
    return next();
  }
  
  /**
   * Stage 7: Assemble final response
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
    trackUserInitialization,
    planUserInitJob,
    planMigrationJob,
    assembleResponse
  ];


  function handle_customize (req, res, next) {
    const { parent: computeInstance } = req.body;
    
    // Extract storage account ID from Secret labels
    const storageAccountId = computeInstance.metadata.labels?.['storage.nightscout.org/account'];
    const tenantId = computeInstance.metadata.labels?.['nightscout.io/tenant'];
    
    console.log(`CREDENTIAL decorator customize for compute: ${computeInstance.metadata.name}`);
    console.log(`  Storage account: ${storageAccountId}`);
    
    if (!storageAccountId) {
      // No storage account label - return empty related resources
      res.send({ relatedResources: [] });
      return next();
    }
    
    // Define related resources to fetch
    const relatedResources = [
      // StorageAccount CRD - to check status conditions
      {
        apiVersion: 'nightscout.io/v1alpha1',
        resource: 'storageaccounts',
        labelSelector: {
          matchLabels: {
            'storage.nightscout.org/account': storageAccountId,
            // 'app.kubernetes.io/component': 'init-job',
          },
        },
      },
      {
        apiVersion: 'batch/v1',
        resource: 'jobs',
        labelSelector: {
          matchLabels: {
            'storage.nightscout.org/account': storageAccountId,
            'nightscout.io/tenant': tenantId,
            'ns.mdn.io/composite': 'storage-create-user',
          },
        },
      },
      // Detect per tenant secret connection.
      {
        apiVersion: 'v1',
        resource: 'secrets',
        // namespace: secret.metadata.namespace,
        labelSelector: {
          matchLabels: {
            'storage.nightscout.org/account': storageAccountId,
            'ns.mdn.io/decorator': 'storage-credentials',
            'nightscout.io/tenant': tenantId,
          },
        },
      },
      /*
      */
    ];
    
    console.log(`  Requesting ${relatedResources.length} related resource types`);
    
    res.send({ relatedResources });
    return next();
  }

  return { sync: pipeline, customize: handle_customize };

  
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
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~';
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
 * @param {object} existingAnnotations - Annotations to preserve from existing Secret
 */
function renderAppCredentialsSecret(tenantId, namespace, appCredentials, labels, existingAnnotations = {}) {
  const secretName = `${tenantId}-app-credentials`;
  
  // Encode all credential fields to base64
  const encodedData = {};
  Object.keys(appCredentials).forEach(key => {
    encodedData[key] = Buffer.from(appCredentials[key]).toString('base64');
  });
  
  // Standard annotations that are always set
  const standardAnnotations = {
    'ns.mdn.io/created-at': new Date().toISOString(),
    'ns.mdn.io/tenant': tenantId,
    'ns.mdn.io/description': 'MongoDB credentials for Nightscout application pods',
    [ANNOTATIONS.PROTECTED_RESOURCE]: 'true'
  };
  
  // Merge existing annotations (lifecycle tracking) with standard annotations
  // Existing annotations take precedence to preserve user-initialized state
  const mergedAnnotations = {
    ...standardAnnotations,
    ...existingAnnotations
  };
  
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
      annotations: mergedAnnotations
    },
    type: 'Opaque',
    data: encodedData
  };
}

/**
 * Render migration Job (shared → dedicated storage transition)
 * Migrates data from shared MongoDB (ConfigMap-based) to dedicated storage
 */
function renderMigrationJob(tenantId, namespace, storageAccount, databaseName, username, password, labels, config) {
  const jobName = `${tenantId}-migrate-to-dedicated`;
  const targetHost = `mongo-${databaseName}`;
  const migrationMethod = 'mongodump-restore';
  
  // TODO: Discover source ConfigMap credentials for shared storage
  // For now, assume source ConfigMap name follows convention
  const sourceConfigMapName = `${tenantId}-shared-storage-config`;
  
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: namespace,
      labels: {
        ...labels,
        'app.kubernetes.io/component': 'migration',
        'app.kubernetes.io/managed-by': 'metacontroller',
        'ns.mdn.io/decorator': 'storage-credentials',
        'ns.mdn.io/migration-type': 'shared-to-dedicated',
        'storage.nightscout.org/account': storageAccount
      },
      annotations: {
        // 'ns.mdn.io/created-at': new Date().toISOString(),
        'ns.mdn.io/tenant': tenantId,
        'ns.mdn.io/migration-method': migrationMethod,
        'ns.mdn.io/migration-target-db': databaseName,
        'ns.mdn.io/source-config': sourceConfigMapName
      }
    },
    spec: {
      ttlSecondsAfterFinished: config.jobs.ttlSecondsAfterFinished,
      backoffLimit: config.jobs.backoffLimit,
      template: {
        metadata: {
          labels: {
            ...labels,
            'app.kubernetes.io/component': 'migration',
            'ns.mdn.io/decorator': 'storage-credentials'
          }
        },
        spec: {
          imagePullSecrets: config.jobs.imagePullSecrets,
          restartPolicy: 'OnFailure',
          serviceAccountName: 'migration-job',
          containers: [{
            name: 'migration',
            image: config.images.nsUtility,
            imagePullPolicy: config.imagePullPolicies.nsUtility || 'IfNotPresent',
            env: [
              // TODO: Source MongoDB URI from ConfigMap
              // This should reference the shared storage ConfigMap
              // For now, use placeholder that will need to be populated
              {
                name: 'MIGRATION_SOURCE_URI',
                valueFrom: {
                  configMapKeyRef: {
                    name: sourceConfigMapName,
                    key: 'MONGODB_URI',
                    optional: true
                  }
                }
              },
              // Target MongoDB connection (dedicated storage)
              { name: 'MIGRATION_TARGET_HOST', value: targetHost },
              { name: 'MIGRATION_TARGET_PORT', value: '27017' },
              { name: 'MIGRATION_TARGET_DB', value: databaseName },
              { name: 'MIGRATION_TARGET_USER', value: username },
              { name: 'MIGRATION_TARGET_PASSWORD', value: password },
              // Migration configuration
              { name: 'MIGRATION_METHOD', value: migrationMethod },
              { name: 'MIGRATION_SOURCE_DB', value: 'nightscout' }, // Default shared DB name
              { name: 'STORAGE_ACCOUNT', value: storageAccount },
              { name: 'TENANT_ID', value: tenantId }
            ],
            command: config.commands.migration, //  ['migrate-database.sh'],
            // args: [], // TODO: Add specific migration args if needed
            resources: {
              requests: {
                cpu: config.resources?.nsUtility?.cpuRequest || '100m',
                memory: config.resources?.nsUtility?.memRequest || '256Mi'
              },
              limits: {
                cpu: config.resources?.nsUtility?.cpuLimit || '500m',
                memory: config.resources?.nsUtility?.memLimit || '512Mi'
              }
            }
          }]
        }
      }
    }
  };
}

/**
 * Render create-user Job to create MongoDB user with NS app credentials
 */
function renderCreateUserJob(adminRefName, secret, tenantId, namespace, storageAccount, config) {
  // const namespace = secret.metadata.namespace;
  const secretName = secret.metadata.name;
  const jobName = `${storageAccount}-${tenantId}-create-user`;
  const forceCreate = true;
  const utilityImagePullSecret = config.imagePullSecrets;
  
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: namespace,
      labels: {
        'storage.nightscout.org/account': storageAccount,
        'nightscout.io/tenant': tenantId,
        'app.kubernetes.io/component': 'user-initialization',
        'ns.mdn.io/composite': 'storage-create-user'
      },
      annotations: {

      }
    },
    spec: {
      ttlSecondsAfterFinished: config.jobs.ttlSecondsAfterFinished,
      backoffLimit: config.jobs.backoffLimit,
      template: {
        metadata: {
          labels: {
            'storage.nightscout.org/account': storageAccount,
            'nightscout.io/tenant': tenantId,
            'app.kubernetes.io/component': 'user-initialization'
          }
        },
        spec: {
          imagePullSecrets: config.jobs.imagePullSecrets,
          restartPolicy: 'OnFailure',
          backoffLimit: 4,
          containers: [{
            name: 'create-user',
            image: config.images.nsUtility,
            imagePullPolicy: config.images.nsUtilityPullPolicy,
            command: config.commands.createUser, // ['/app/multienvctl/entrypoints/create-mongodb-user.sh'],
            env: [
              { name: 'MONGO_PORT', value: '27017' },
              { name: 'FORCE_USER_CREATE', value: forceCreate ? 'true' : 'false' },
              {
                name: 'MONGO_PORT',
                value: '27017'
              },
              {
                name: 'MONGO_RS_NAME',
                value: 'rs0'
              },
              {
                name: 'NSUSER_USERNAME',
                valueFrom: {
                  secretKeyRef: {
                    name: secretName,
                    key: 'MONGO_USERNAME'
                  }
                }
              },
              {
                name: 'NSUSER_PASSWORD',
                valueFrom: {
                  secretKeyRef: {
                    name: secretName,
                    key: 'MONGO_PASSWORD'
                  }
                }
              },
              {
                name: 'MONGO_ADMIN_USERNAME',
                valueFrom: {
                  secretKeyRef: {
                    name: adminRefName,
                    key: 'MONGO_INITDB_ROOT_USERNAME'
                  }
                }
              },
              {
                name: 'MONGO_ADMIN_PASSWORD',
                valueFrom: {
                  secretKeyRef: {
                    name: adminRefName,
                    key: 'MONGO_INITDB_ROOT_PASSWORD'
                  }
                }
              },
              {
                name: 'NSUSER_DATABASE',
                valueFrom: {
                  secretKeyRef: {
                    name: adminRefName,
                    key: 'MONGO_INITDB_DATABASE'
                  }
                }
              },
              {
                name: 'MONGO_HOST',
                value: 'mongo-$(NSUSER_DATABASE)',
              },
              {
                name: 'MONGO_ADMIN_URI',
                value: 'mongodb://$(MONGO_ADMIN_USERNAME):$(MONGO_ADMIN_PASSWORD)@$(MONGO_HOST):27017/?authSource=admin'
              },
              { name: 'STORAGE_ACCOUNT', value: storageAccount }
            ],
            resources: {
              requests: {
                cpu: config.resources.utility.cpuRequest,
                memory: config.resources.utility.memRequest
              },
              limits: {
                cpu: config.resources.utility.cpuLimit,
                memory: config.resources.utility.memLimit
              }
            }
          }]
        }
      }
    }
  };
}

module.exports = { createStorageCredentialsDecoratorSync };
