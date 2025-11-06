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

function createStorageCredentialsDecoratorSync(config) {
  return async function storageCredentialsDecoratorSync(req, res) {
    const { object: computeInstance, related, attachments } = req.body;
    
    const tenantId = computeInstance.metadata.name;
    const namespace = computeInstance.metadata.namespace;
    const spec = computeInstance.spec || {};
    const storageAccountName = spec.storageAccountRef?.name;
    const storageAccountLabel = computeInstance.metadata.labels?.['storage.nightscout.org/account'];
    
    console.log('Storage credentials decorator sync for tenant:', tenantId);
    
    try {
      const response = {
        attachments: []
      };
      
      // Find StorageAccount from related resources
      // Supports both spec.storageAccountRef.name and label-based discovery
      const storageAccount = findStorageAccount(related, storageAccountName, storageAccountLabel);
      
      if (!storageAccount) {
        console.log(`  StorageAccount not found (name: ${storageAccountName}, label: ${storageAccountLabel}) - preserving existing attachments`);
        
        // CRITICAL: Preserve existing attachments to prevent Metacontroller from deleting them
        // This handles transient API issues, related resource discovery delays, or legacy configs
        const existingAttachments = collectExistingAttachments(attachments);
        response.attachments.push(...existingAttachments);
        
        res.send(response);
        return;
      }
      
      const storageType = storageAccount.spec?.storageType || 'dedicated';
      // CRITICAL: Use storageAccount.metadata.name for database name generation
      // This must match the storage composite's naming to connect to correct MongoDB Service
      const storageAccountId = storageAccount.metadata.name;
      const databaseName = generateDatabaseName(storageAccountId);
      
      console.log(`  Storage account: ${storageAccountId}, type: ${storageType}, database: ${databaseName}`);
      
      // Check for existing app-credentials Secret (first-cycle-only pattern)
      const appCredentialsSecretName = `${tenantId}-app-credentials`;
      const existingSecret = attachments['Secret.v1']?.[appCredentialsSecretName];
      
      // DEDICATED STORAGE MODE: Create per-tenant credentials
      if (storageType === 'dedicated') {
        console.log(`  Dedicated storage mode - managing app credentials`);
        
        let username, password;
        
        if (existingSecret) {
          // Preserve existing credentials but ensure protected-resource annotation and labels
          console.log(`  Updating existing app-credentials Secret: ${appCredentialsSecretName}`);
          
          // Clone existing Secret and add protections
          // CRITICAL: Remove ownerReferences to prevent garbage collection
          const updatedSecret = {
            ...existingSecret,
            metadata: {
              ...existingSecret.metadata,
              labels: {
                ...(existingSecret.metadata.labels || {}),
                [LABELS.RESOURCE_TYPE]: RESOURCE_TYPES.APP_CREDENTIALS_SECRET
              },
              annotations: {
                ...(existingSecret.metadata.annotations || {}),
                [ANNOTATIONS.PROTECTED_RESOURCE]: 'true'
              },
              // Remove fields that enable garbage collection (use null for JSON serialization)
              ownerReferences: null,
              managedFields: null
            }
          };
          
          response.attachments.push(updatedSecret);
          
          // Extract credentials for Job rendering
          const secretData = existingSecret.data || {};
          username = Buffer.from(secretData.MONGO_USERNAME || '', 'base64').toString('utf-8');
          password = Buffer.from(secretData.MONGO_PASSWORD || '', 'base64').toString('utf-8');
        } else {
          // First cycle - generate new credentials
          console.log(`  First cycle - generating new app credentials for tenant ${tenantId}`);
          username = generateUsername(tenantId);
          password = generateSecurePassword(32);
          
          const mongoHost = `mongo-${databaseName}`;
          const mongoPort = '27017';
          
          const appCredentials = generateAppCredentials(
            tenantId,
            mongoHost,
            mongoPort,
            databaseName,
            username,
            password
          );
          
          const secret = renderAppCredentialsSecret(
            tenantId,
            namespace,
            appCredentials,
            computeInstance.metadata.labels
          );
          
          response.attachments.push(secret);
        }
        
        // Check if user initialization is needed
        if (username && password) {
          const userInitialized = computeInstance.status?.conditions?.find(
            c => c.type === 'UserInitialized' && c.status === 'True'
          );
          
          if (!userInitialized) {
            console.log(`  User not initialized - rendering create-user Job`);
            const createUserJob = renderCreateUserJob(
              tenantId,
              namespace,
              storageAccountId,
              databaseName,
              username,
              password,
              computeInstance.metadata.labels,
              config
            );
            response.attachments.push(createUserJob);
          }
        }
      }
      
      // SHARED STORAGE MODE: Skip credential creation
      else if (storageType === 'shared') {
        console.log(`  Shared storage mode - skipping credential creation (use ConfigMap)`);
        
        // Check for migration annotation
        const migrationRequested = computeInstance.metadata?.annotations?.['nightscout.io/migrate-to-dedicated'] === 'true';
        
        if (migrationRequested) {
          console.log(`  Migration annotation detected - this would trigger shared → dedicated migration`);
          // TODO: Implement migration Job rendering
          // Would read ConfigMap for source URI, create new credentials, render migration Job
        }
      }
      
      res.send(response);
    } catch (error) {
      console.error('Error in storage credentials decorator sync:', error);
      res.send(500, { error: error.message });
    }
  };
}

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
  // This handles legacy ComputeInstances that only have the label
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
 * This prevents Metacontroller from deleting Secrets and Jobs when StorageAccount lookup fails
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
