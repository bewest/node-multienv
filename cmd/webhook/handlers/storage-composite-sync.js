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

const { renderMongoDB, renderStorageSecret } = require('./resources');

function createStorageCompositeSync(config) {
  return async function storageCompositeSync(req, res) {
  const { parent, children, related } = req.body;
  
  const storageAccount = parent.metadata.name;
  const storageAccountLabel = parent.metadata.labels?.['storage.nightscout.org/account'];
  console.log('Storage composite sync for account:', storageAccount);
  
  try {
    const response = {
      status: {},
      children: []
    };

    // Extract configuration from StorageAccount CRD spec
    const storageConfig = extractStorageConfig(parent);
    const spec = parent.spec || {};
    const storageType = spec.storageType || 'dedicated';
    
    // Generate database name (used for both dedicated and shared)
    const databaseName = generateDatabaseName(storageAccount);
    
    // CHILD PRESERVATION: Collect existing children to preserve
    // We preserve: completed Jobs, PVCs (not owned), and existing Secrets (conditionally)
    const preservedChildren = collectPreservedChildren(children, parent);
    
    // Check if this is a "shared" storage account
    if (storageType === 'shared') {
      console.log(`  Storage type is 'shared' - skipping MongoDB resource creation`);
      
      // Validate that sharedConnection is provided
      const sharedConnection = spec.sharedConnection;
      if (!sharedConnection || !sharedConnection.host || !sharedConnection.secretRef?.name) {
        console.log(`  ERROR: Shared storage requires spec.sharedConnection with host and secretRef`);
        
        response.status = {
          phase: 'Failed',
          observedGeneration: parent.metadata?.generation,
          conditions: [
            {
              type: 'Ready',
              status: 'False',
              lastTransitionTime: new Date().toISOString(),
              reason: 'MissingSharedConnection',
              message: 'Shared storage requires spec.sharedConnection with host and secretRef fields'
            }
          ],
          databaseName: databaseName
        };
        
        res.send(response);
        return;
      }
      
      // CHILD PRESERVATION: Start with preserved children
      response.children.push(...preservedChildren);
      
      // Check if Storage Secret already exists (first-cycle-only pattern)
      const storageSecretName = `${storageAccount}-storage`;
      const existingStorageSecret = children['Secret.v1']?.[storageSecretName];
      
      let sourceMongoUri = '';
      
      if (existingStorageSecret) {
        // Existing Storage Secret found - preserve it unchanged
        console.log(`  Preserving existing Storage Secret: ${storageSecretName}`);
        response.children.push(existingStorageSecret);
        
        // Extract sourceMongoUri (staff may have populated it)
        sourceMongoUri = existingStorageSecret.data?.sourceMongoUri 
          ? Buffer.from(existingStorageSecret.data.sourceMongoUri, 'base64').toString('utf-8')
          : '';
      } else {
        // First cycle - render new Storage Secret as placeholder
        console.log(`  First cycle - rendering Storage Secret for shared storage`);
        const storageSecret = renderStorageSecret(
          storageAccount,
          parent.metadata.namespace,
          'shared',
          { databaseName },
          parent.metadata.labels
        );
        response.children.push(storageSecret);
      }
      
      if (!sourceMongoUri || sourceMongoUri === '') {
        // Staff has not yet populated sourceMongoUri
        console.log(`  Shared storage waiting for sourceMongoUri to be populated in Storage Secret`);
        
        response.status = {
          phase: 'Pending',
          observedGeneration: parent.metadata?.generation,
          conditions: [
            {
              type: 'Ready',
              status: 'False',
              lastTransitionTime: new Date().toISOString(),
              reason: 'AwaitingSourceURI',
              message: 'Waiting for staff to populate sourceMongoUri in Storage Secret'
            }
          ],
          databaseName: databaseName,
          storageSecret: storageSecretName
        };
        
        res.send(response);
        return;
      }
      
      // For shared storage, we need to read credentials from the referenced Secret
      // TODO: Implement actual Secret reading from Kubernetes API
      // For now, fail fast to avoid creating invalid credentials
      const mongoHost = sharedConnection.host;
      const mongoPort = sharedConnection.port || '27017';
      const credentialsSecretName = sharedConnection.secretRef.name;
      const credentialsSecretNamespace = sharedConnection.secretRef.namespace || parent.metadata.namespace;
      
      console.log(`  Shared storage has sourceMongoUri but Secret reading not yet implemented`);
      console.log(`  Would need to read Secret ${credentialsSecretNamespace}/${credentialsSecretName}`);
      
      response.status = {
        phase: 'Failed',
        observedGeneration: parent.metadata?.generation,
        conditions: [
          {
            type: 'Ready',
            status: 'False',
            lastTransitionTime: new Date().toISOString(),
            reason: 'NotImplemented',
            message: `Shared storage Secret reading not yet implemented. Would read ${credentialsSecretNamespace}/${credentialsSecretName} for credentials.`
          }
        ],
        databaseName: databaseName,
        storageSecret: storageSecretName
      };
      
      res.send(response);
      return;
    }
    
    // Dedicated storage: create MongoDB resources
    const mongoHost = `mongo-${databaseName}`;
    const mongoPort = '27017';
    
    // CHILD PRESERVATION: Start with preserved children
    response.children.push(...preservedChildren);
    
    // Check if Storage Secret already exists (first-cycle-only pattern)
    const storageSecretName = `${storageAccount}-storage`;
    const existingStorageSecret = children['Secret.v1']?.[storageSecretName];
    
    if (existingStorageSecret) {
      // Existing Storage Secret found - preserve it unchanged
      console.log(`  Preserving existing Storage Secret: ${storageSecretName}`);
      response.children.push(existingStorageSecret);
    } else {
      // First cycle - render new Storage Secret with connection details
      console.log(`  First cycle - rendering Storage Secret for dedicated storage`);
      const storageSecret = renderStorageSecret(
        storageAccount,
        parent.metadata.namespace,
        'dedicated',
        { databaseName, mongoHost, mongoPort },
        parent.metadata.labels
      );
      response.children.push(storageSecret);
    }
    
    // Check if app-credentials Secret already exists (first-cycle-only pattern)
    const appCredentialsSecretName = `${storageAccount}-app-credentials`;
    const existingAppSecret = children['Secret.v1']?.[appCredentialsSecretName];
    
    let nsuserUsername, nsuserPassword;
    
    if (existingAppSecret) {
      // Existing Secret found - preserve it unchanged and extract credentials
      console.log(`  Preserving existing app-credentials Secret: ${appCredentialsSecretName}`);
      response.children.push(existingAppSecret);
      
      // Extract credentials from existing Secret for use in Jobs
      const secretData = existingAppSecret.data || {};
      nsuserUsername = Buffer.from(secretData.MONGO_USERNAME || '', 'base64').toString('utf-8');
      nsuserPassword = Buffer.from(secretData.MONGO_PASSWORD || '', 'base64').toString('utf-8');
    } else {
      // First cycle - generate new credentials and render Secret
      console.log(`  First cycle - rendering new app-credentials Secret`);
      nsuserUsername = generateUsername(storageAccount);
      nsuserPassword = generateSecurePassword(32);
      
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
    
    // Render MongoDB resources with databaseName for service naming
    console.log(`  Creating MongoDB StatefulSet with service name: mongo-${databaseName}`);
    const mongoResources = renderMongoDB(storageConfig, databaseName, config);
    response.children.push(...mongoResources);
    
    // Check MongoDB readiness
    const mongoReadiness = checkMongoReadiness(children, storageAccount);
    
    // Check if migration is needed (spec-driven OR annotation-driven)
    const migrationConfig = spec.migration || {};
    const migrationEnabledBySpec = migrationConfig.enabled === true;
    const migrationEnabledByAnnotation = parent.metadata?.annotations?.['nightscout.io/migration-requested'] === 'true';
    const migrationEnabled = migrationEnabledBySpec || migrationEnabledByAnnotation;
    const migrationSourceSecret = migrationConfig.sourceConnectionSecret;
    
    if (migrationEnabled && migrationSourceSecret && mongoReadiness.ready) {
      const trigger = migrationEnabledByAnnotation ? 'annotation' : 'spec';
      console.log(`  Migration enabled via ${trigger} - rendering migration Job`);
      const migrationJob = renderMigrationJobFromCRD(parent, storageAccount, migrationSourceSecret, config);
      response.children.push(migrationJob);
    } else if (migrationEnabled && !migrationSourceSecret) {
      console.log(`  Migration requested but sourceConnectionSecret not provided`);
    }
    
    // Check if NS user creation is needed
    const hasCredentials = nsuserUsername && nsuserPassword;
    
    if (hasCredentials && mongoReadiness.ready) {
      const userInitialized = parent.status?.conditions?.find(c => c.type === 'UserInitialized' && c.status === 'True');
      if (!userInitialized) {
        console.log(`  NS user creation needed - rendering create-user Job`);
        const createUserJob = renderCreateUserJobFromCRD(parent, storageAccount, nsuserUsername, nsuserPassword, config);
        response.children.push(createUserJob);
      }
    }
    
    // Check migration state
    const migrationState = checkMigrationStateFromCRD(children, migrationEnabled);
    
    // Check user initialization state
    const userInitState = checkUserInitializationState(children, parent);
    
    // Count tenants using this storage account (from related ComputeInstances)
    const tenantUsage = countTenantUsage(related, storageAccountLabel);
    
    // Build status with phase
    const conditions = [mongoReadiness.condition];
    if (migrationState.condition) {
      conditions.push(migrationState.condition);
    }
    if (userInitState.condition) {
      conditions.push(userInitState.condition);
    }
    
    // Determine overall phase
    let phase = 'Pending';
    if (migrationEnabled && !migrationState.complete) {
      phase = 'Migrating';
    } else if (mongoReadiness.ready && (!migrationEnabled || migrationState.complete)) {
      phase = 'Ready';
    } else if (migrationState.failed) {
      phase = 'Failed';
    }
    
    response.status = {
      phase,
      observedGeneration: parent.metadata?.generation,
      conditions,
      connectionSecret: appCredentialsSecretName,
      databaseName: databaseName
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

}

module.exports = createStorageCompositeSync;
