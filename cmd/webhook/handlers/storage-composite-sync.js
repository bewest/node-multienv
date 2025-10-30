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
        const migrationJob = renderMigrationJob(parent, storageAccount, migrationSourceUri);
        response.children.push(migrationJob);
      }
    }
    
    // Check migration state
    const migrationState = checkMigrationState(children, parent);
    
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
      TENANT_ID: storageAccount,
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
 * Render migration Job based on Secret annotations
 */
function renderMigrationJob(secret, storageAccount, sourceUri) {
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
  
  const migrationImage = secret.metadata.annotations?.['ns.mdn.io/migration-image'] || 'mongo:6';
  const migrationMethod = secret.metadata.annotations?.['ns.mdn.io/migration-method'] || 'mongodump-restore';
  
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
        'ns.mdn.io/created-at': new Date().toISOString()
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
            command: ['/bin/sh', '-c'],
            args: [
              `
              echo "Starting migration from shared MongoDB to dedicated instance..."
              echo "Source: ${sourceUri.replace(/\/\/.*@/, '//*****@')}"
              echo "Target: ${targetUri.replace(/\/\/.*@/, '//*****@')}"
              echo "Method: ${migrationMethod}"
              
              mongodump --uri="${sourceUri}" --archive | mongorestore --uri="${targetUri}" --archive
              
              if [ $? -eq 0 ]; then
                echo "Migration completed successfully"
                exit 0
              else
                echo "Migration failed"
                exit 1
              fi
              `
            ],
            resources: {
              requests: {
                cpu: '100m',
                memory: '256Mi'
              },
              limits: {
                cpu: '500m',
                memory: '512Mi'
              }
            }
          }]
        }
      }
    }
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
