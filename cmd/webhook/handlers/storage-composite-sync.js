/**
 * Storage Composite Controller
 * 
 * Manages MongoDB StatefulSet + Service from Secret parent
 * 
 * Parent: Secret (labeled ns.mdn.io/composite=storage)
 * Children:
 *   - MongoDB StatefulSet (if storage-type=dedicated)
 *   - MongoDB Service (headless)
 *   - Migration Job (if ns.mdn.io/migration-needed annotation present)
 * Related (not owned):
 *   - PersistentVolumeClaim (created by StatefulSet, protected from deletion)
 * 
 * Annotations:
 *   - ns.mdn.io/storage-type: "shared" | "dedicated" (controls StatefulSet creation)
 *   - ns.mdn.io/migration-needed: "true" (triggers migration Job)
 *   - ns.mdn.io/migration-source-uri: mongodb://... (source for migration)
 *   - ns.mdn.io/migration-complete: "true" (prevents re-running migration)
 */

const { renderMongoDB } = require('./resources');

function createStorageCompositeSync(config) {
  return async function storageCompositeSync(req, res) {
  const { parent, children, related } = req.body;
  
  const storageAccount = parent.metadata.name;
  const storageAccountLabel = parent.metadata.labels?.['storage.nightscout.org/account'];
  console.log('Storage composite sync for account:', storageAccount);
  
  try {
    const response = {
      status: {},
      children: [],
      relatedResourceRules: [
        {
          // Discover PVCs created by StatefulSet (blast radius protection)
          apiVersion: 'v1',
          resource: 'persistentvolumeclaims',
          labelSelector: {
            matchLabels: {
              'storage.nightscout.org/account': storageAccountLabel
            }
          }
        },
        {
          // Discover tenant ConfigMaps using this storage (for auditing)
          apiVersion: 'v1',
          resource: 'configmaps',
          labelSelector: {
            matchExpressions: [
              {
                key: 'storage.nightscout.org/account',
                operator: 'Exists'
              },
              {
                key: 'ns.mdn.io/composite',
                operator: 'In',
                values: ['compute']
              }
            ]
          }
        }
      ]
    };

    // Extract configuration from Secret
    const storageConfig = extractStorageConfig(parent);
    const storageType = parent.metadata.annotations?.['ns.mdn.io/storage-type'] || 'dedicated';
    
    // Generate NS user credentials if missing
    const updatedSecret = ensureNSUserCredentials(parent, storageAccount);
    if (updatedSecret) {
      response.children.push(updatedSecret);
    }
    
    // Decode Secret data for app credentials generation
    const secretData = {};
    if (parent.data) {
      Object.keys(parent.data).forEach(key => {
        secretData[key] = Buffer.from(parent.data[key], 'base64').toString('utf-8');
      });
    }
    
    // Generate app-credentials Secret if nsuser credentials exist
    const nsuserUsername = secretData['nsuser-username'];
    const nsuserPassword = secretData['nsuser-password'];
    
    if (nsuserUsername && nsuserPassword) {
      const mongoHost = storageType === 'shared'
        ? (secretData.mongoHost || 'shared-mongodb')
        : `${storageAccount}-mongodb`;
      const mongoPort = secretData.mongoPort || '27017';
      const databaseName = generateDatabaseName(storageAccount);
      
      const appCredentials = generateAppCredentials(
        storageAccount,
        mongoHost,
        mongoPort,
        databaseName,
        nsuserUsername,
        nsuserPassword
      );
      
      const appCredentialsSecret = renderAppCredentialsSecret(
        storageAccount,
        parent.metadata.namespace,
        appCredentials,
        parent.metadata.labels
      );
      
      response.children.push(appCredentialsSecret);
    }
    
    // Render MongoDB resources ONLY for dedicated storage
    // Shared storage uses external MongoDB cluster (no StatefulSet created)
    let mongoReadiness;
    if (storageType === 'shared') {
      console.log(`  Storage type: shared - skipping MongoDB StatefulSet creation`);
      mongoReadiness = {
        ready: true, // Shared MongoDB assumed ready (external cluster)
        replicas: 'N/A (shared)',
        condition: {
          type: 'Ready',
          status: 'True',
          reason: 'SharedMongoDB',
          message: 'Using shared MongoDB cluster (no dedicated StatefulSet)',
          lastTransitionTime: new Date().toISOString()
        }
      };
    } else {
      console.log(`  Storage type: dedicated - creating MongoDB StatefulSet`);
      const mongoResources = renderMongoDB(storageConfig, config);
      response.children.push(...mongoResources);
      
      // Check MongoDB readiness
      mongoReadiness = checkMongoReadiness(children, storageAccount);
      
      // Check if migration is needed (annotation-driven)
      const migrationNeeded = parent.metadata.annotations?.['ns.mdn.io/migration-needed'] === 'true';
      const migrationSourceUri = parent.metadata.annotations?.['ns.mdn.io/migration-source-uri'];
      const migrationComplete = parent.metadata.annotations?.['ns.mdn.io/migration-complete'] === 'true';
      
      if (migrationNeeded && migrationSourceUri && !migrationComplete && mongoReadiness.ready) {
        console.log(`  Migration needed - rendering migration Job`);
        const migrationJob = renderMigrationJob(parent, storageAccount, migrationSourceUri, config);
        response.children.push(migrationJob);
      }
      
      // Check if NS user creation is needed
      const nsuserInitialized = parent.metadata.annotations?.['ns.mdn.io/nsuser-initialized'] === 'true';
      const rotateCredentials = parent.metadata.annotations?.['ns.mdn.io/rotate-credentials'] === 'true';
      const hasCredentials = parent.data?.['nsuser-username'] && parent.data?.['nsuser-password'];
      
      if (hasCredentials && (!nsuserInitialized || rotateCredentials) && mongoReadiness.ready) {
        console.log(`  NS user creation needed - rendering create-user Job`);
        const createUserJob = renderCreateUserJob(parent, storageAccount, rotateCredentials, config);
        response.children.push(createUserJob);
      }
    }
    
    // Check migration state
    const migrationState = checkMigrationState(children, parent);
    
    // Check user initialization state
    const userInitState = checkUserInitializationState(children, parent);
    
    // Update Secret annotations if user initialization completed
    if (userInitState.completed && !userInitState.alreadyMarked) {
      console.log(`  User initialization completed - updating Secret annotations`);
      const updatedSecretAnnotations = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: parent.metadata.name,
          namespace: parent.metadata.namespace,
          labels: parent.metadata.labels,
          annotations: {
            ...parent.metadata.annotations,
            'ns.mdn.io/nsuser-initialized': 'true',
            'ns.mdn.io/nsuser-initialized-at': new Date().toISOString()
          }
        },
        type: parent.type,
        data: parent.data
      };
      
      // Remove rotation annotation if present
      if (updatedSecretAnnotations.metadata.annotations['ns.mdn.io/rotate-credentials']) {
        delete updatedSecretAnnotations.metadata.annotations['ns.mdn.io/rotate-credentials'];
      }
      
      response.children.push(updatedSecretAnnotations);
    }
    
    // Count tenants using this storage account (from related ConfigMaps)
    const tenantUsage = countTenantUsage(related, storageAccountLabel);
    
    // Build status
    const mongoHost = storageType === 'shared' 
      ? (Buffer.from(parent.data?.mongoHost || '', 'base64').toString('utf-8') || 'shared-mongodb')
      : `${storageAccount}-mongodb`;
    
    const conditions = [mongoReadiness.condition];
    if (migrationState.condition) {
      conditions.push(migrationState.condition);
    }
    if (userInitState.condition) {
      conditions.push(userInitState.condition);
    }
    
    response.status = {
      observedGeneration: parent.metadata?.generation,
      conditions,
      storage: {
        type: storageType,
        host: mongoHost,
        ready: mongoReadiness.ready,
        replicas: mongoReadiness.replicas
      },
      tenantUsage: {
        count: tenantUsage.count,
        tenants: tenantUsage.tenantIds
      },
      migration: migrationState.enabled ? {
        enabled: true,
        phase: migrationState.phase,
        complete: migrationState.complete
      } : {
        enabled: false
      }
    };

    res.send(response);
  } catch (error) {
    console.error('Error in storage composite sync:', error);
    res.send(500, { error: error.message });
  }
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
function generateUsername(storageAccount) {
  const crypto = require('crypto');
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  return `nsuser-${storageAccount}-${randomSuffix}`;
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
 * Extract storage configuration from Secret
 */
function extractStorageConfig(secret) {
  const storageAccount = secret.metadata.labels?.['storage.nightscout.org/account'] || secret.metadata.name;
  const namespace = secret.metadata.namespace;
  
  // Decode Secret data
  const data = {};
  if (secret.data) {
    Object.keys(secret.data).forEach(key => {
      data[key] = Buffer.from(secret.data[key], 'base64').toString('utf-8');
    });
  }
  
  // Map to format expected by renderMongoDB
  return {
    metadata: {
      namespace: namespace,
      labels: {
        'storage.nightscout.org/account': storageAccount,
        'ns.mdn.io/composite': 'storage'
      }
    },
    data: {
      STORAGE: storageAccount,
      MONGO_REPLICAS: data.replicas || '1',
      MONGO_STORAGE_GI: data.storageGi || '2',
      MONGO_IMAGE: data.mongoImage || 'mongo:6',
      MONGO_IMAGE_PULL_POLICY: data.imagePullPolicy || 'IfNotPresent',
      MONGO_CPU_REQUEST: data.cpuRequest || '100m',
      MONGO_CPU_LIMIT: data.cpuLimit || '500m',
      MONGO_MEM_REQUEST: data.memRequest || '256Mi',
      MONGO_MEM_LIMIT: data.memLimit || '512Mi',
      IMAGE_PULL_SECRET: data.imagePullSecret || undefined
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
 * Render migration Job based on Secret annotations
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
  
  const targetHost = `${storageAccount}-mongodb`;
  const targetUser = secretData.username || 'nsuser';
  const targetPassword = secretData.password;
  const targetDb = secretData.database || 'nightscout';
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
 * Render create-user Job to create MongoDB user with NS app credentials
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
  const rootUser = secretData.username || secretData['root-user'];
  const rootPassword = secretData.password || secretData['root-password'];
  const targetHost = `${storageAccount}-mongodb`;
  const targetDb = secretData.database || 'nightscout';
  const adminUri = `mongodb://${targetUser}:${targetPassword}@${targetHost}:27017/${targetDb}?replicaSet=rs0`;
  
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
              { name: 'MONGO_ADMIN_URI', value: rootPassword },
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
 * Check migration state from Job children
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
 * Count tenant usage from related ConfigMaps
 * Reports how many tenants are using this storage account
 */
function countTenantUsage(related, storageAccountLabel) {
  if (!related || !related['ConfigMap.v1']) {
    return {
      count: 0,
      tenantIds: []
    };
  }
  
  const configMaps = related['ConfigMap.v1'];
  const tenants = [];
  
  for (const [name, cm] of Object.entries(configMaps)) {
    const cmStorageAccount = cm.metadata?.labels?.['storage.nightscout.org/account'];
    const tenantId = cm.metadata?.labels?.['ns.mdn.io/tenant'] || name;
    
    // Only count ConfigMaps that match this storage account
    if (cmStorageAccount === storageAccountLabel) {
      tenants.push(tenantId);
    }
  }
  
  console.log(`  Tenant usage: ${tenants.length} tenant(s) using storage account ${storageAccountLabel}`);
  
  return {
    count: tenants.length,
    tenantIds: tenants
  };
}

}

module.exports = createStorageCompositeSync;
