/**
 * Tenant Initialization Decorator - Sync Hook (Gen 5)
 * 
 * Orchestrates MongoDB initialization Jobs for NightscoutTenant CRs
 * 
 * Target: NightscoutTenant CRD
 * Related Resources:
 *   - ConfigMap (to detect compute activation via spec.selector)
 *   - Jobs (init-replica-set, create-user) for tracking completion
 *   - mongo-auth Secret (for Job credential injection)
 * 
 * Responsibilities:
 *   1. Detect compute activation (ConfigMap presence)
 *   2. Render init-replica-set Job when compute activated and not yet initialized
 *   3. Track init Job completion → Set ns.mdn.io/replica-set-initialized annotation
 *   4. Render create-user Job when replica initialized and user not yet created
 *   5. Track user Job completion → Set ns.mdn.io/user-initialized annotation
 * 
 * Response Format:
 *   - Job attachments: [ init-replica-set Job, create-user Job ]
 *   - Annotations: { ns.mdn.io/replica-set-initialized, ns.mdn.io/user-initialized }
 */

const crypto = require('crypto');

function createTenantInitializationDecoratorSync(config) {
  
  /**
   * Helper: Find resource in related collection (handles both array and object formats)
   */
  function findResource(collection, predicate) {
    if (!collection) return null;
    
    if (Array.isArray(collection)) {
      return collection.find(predicate);
    }
    
    const values = Object.values(collection);
    return values.find(predicate);
  }
  
  /**
   * Helper: Find Job by name across all related Job collections
   * Metacontroller delivers multiple label selectors as distinct keys (Job.batch/v1@0, Job.batch/v1@1)
   */
  function findJobByName(related, jobName, namespace) {
    if (!related) return null;
    
    // Iterate over all keys in related and find Job collections
    for (const [key, collection] of Object.entries(related)) {
      // Match keys like "Job.batch/v1", "Job.batch/v1@0", "Job.batch/v1@1", etc.
      if (!key.startsWith('Job.batch/v1')) continue;
      
      if (Array.isArray(collection)) {
        const job = collection.find(j => 
          j.metadata?.name === jobName && 
          j.metadata?.namespace === namespace
        );
        if (job) return job;
      } else if (collection && typeof collection === 'object') {
        // Object format - iterate values
        const jobValues = Object.values(collection);
        const job = jobValues.find(j => 
          j.metadata?.name === jobName && 
          j.metadata?.namespace === namespace
        );
        if (job) return job;
      }
    }
    
    return null;
  }
  
  /**
   * Stage 1: Initialize context and response containers
   */
  function initialize(req, res, next) {
    const { object: tenant, related } = req.body;
    
    req.tenant = tenant;
    req.related = related || {};
    req.tenantId = tenant.metadata.name;
    req.namespace = tenant.metadata.namespace;
    req.spec = tenant.spec || {};
    req.selector = req.spec.selector || {};
    
    // Response containers
    res.attachments = [];
    res.annotations = {};
    
    console.log(`Tenant Init Decorator: ${req.tenantId}`);
    console.log(`  Namespace: ${req.namespace}`);
    console.log(`  Selector: ${JSON.stringify(req.selector)}`);
    
    return next();
  }
  
  /**
   * Stage 2: Discover ConfigMap (compute activation signal)
   * Sets req.computeActivated flag based on ConfigMap presence
   */
  function discoverConfigMap(req, res, next) {
    const selector = req.selector;
    
    // No selector means no compute activation
    if (Object.keys(selector).length === 0) {
      console.log('  No selector - compute not activated');
      req.computeActivated = false;
      return next();
    }
    
    // Look for ConfigMap matching selector
    const configMaps = req.related['ConfigMap.v1'] || {};
    const matchingConfigMap = findResource(configMaps, cm => {
      const labels = cm.metadata?.labels || {};
      return Object.entries(selector).every(([key, value]) => labels[key] === value);
    });
    
    if (matchingConfigMap) {
      console.log(`  ConfigMap found: ${matchingConfigMap.metadata.name} - compute activated`);
      req.computeActivated = true;
      req.configMap = matchingConfigMap;
    } else {
      console.log('  No matching ConfigMap - compute not activated');
      req.computeActivated = false;
    }
    
    return next();
  }
  
  /**
   * Stage 3: Discover mongo-auth Secret (for Job credentials)
   */
  function discoverMongoAuthSecret(req, res, next) {
    const mongoAuthSecretRef = req.spec.mongoAuthSecretRef;
    
    if (!mongoAuthSecretRef || !mongoAuthSecretRef.name) {
      console.log('  No mongoAuthSecretRef in spec');
      req.mongoAuthSecret = null;
      return next();
    }
    
    const authSecretName = mongoAuthSecretRef.name;
    const secrets = req.related['Secret.v1'] || {};
    
    const authSecret = findResource(secrets, s => 
      s.metadata.name === authSecretName && 
      s.metadata.namespace === req.namespace
    );
    
    if (authSecret) {
      console.log(`  Found mongo-auth Secret: ${authSecretName}`);
      req.mongoAuthSecret = authSecret;
      
      // Extract database name for Job rendering
      req.databaseName = Buffer.from(authSecret.data?.MONGO_INITDB_DATABASE || '', 'base64').toString('utf-8') ||
                        Buffer.from(authSecret.data?.database || '', 'base64').toString('utf-8');
    } else {
      console.log(`  mongo-auth Secret ${authSecretName} not found in related resources`);
      req.mongoAuthSecret = null;
    }
    
    return next();
  }
  
  /**
   * Stage 4: Render init-replica-set Job and track completion
   * Only if: compute activated, not already initialized, auth secret exists
   */
  function renderInitReplicaSetJob(req, res, next) {
    // Skip if compute not activated
    if (!req.computeActivated) {
      console.log('  Compute not activated - skipping init Job');
      req.replicaSetInitialized = false;
      return next();
    }
    
    // Check if already initialized (annotation on tenant)
    const replicaSetInitialized = req.tenant.metadata?.annotations?.['ns.mdn.io/replica-set-initialized'];
    if (replicaSetInitialized) {
      console.log(`  Replica set already initialized at ${replicaSetInitialized}`);
      req.replicaSetInitialized = true;
      return next();
    }
    
    // Skip if auth secret missing
    if (!req.mongoAuthSecret) {
      console.log('  mongo-auth Secret missing - cannot render init Job');
      req.replicaSetInitialized = false;
      return next();
    }
    
    // Check if init Job already exists and succeeded
    // Use helper to find Job across all related Job collections (Job.batch/v1@0, Job.batch/v1@1, etc.)
    const initJobName = `${req.tenantId}-init-rs`;
    const initJob = findJobByName(req.related, initJobName, req.namespace);
    
    if (initJob) {
      const jobStatus = initJob.status || {};
      const succeeded = (jobStatus.succeeded || 0) > 0;
      
      if (succeeded) {
        console.log('  Init Job succeeded - marking replica set initialized');
        res.annotations['ns.mdn.io/replica-set-initialized'] = new Date().toISOString();
        req.replicaSetInitialized = true;
        return next();
      }
      
      console.log(`  Init Job exists but not yet succeeded (active: ${jobStatus.active || 0}, failed: ${jobStatus.failed || 0})`);
      req.replicaSetInitialized = false;
      return next();
    }
    
    // No Job exists yet - render it as attachment
    console.log('  Rendering init-replica-set Job');
    const initJobResource = renderInitReplicaSetJob_(
      req.tenantId,
      req.namespace,
      req.databaseName,
      req.mongoAuthSecret,
      config
    );
    
    res.attachments.push(initJobResource);
    req.replicaSetInitialized = false;
    
    // Request explicit requeue to ensure decorator re-runs when Job completes
    res.resyncAfterSeconds = 15;
    
    return next();
  }
  
  /**
   * Stage 5: Render create-user Job and track completion
   * Only if: replica set initialized, user not yet initialized, auth secret exists
   */
  function renderCreateUserJob(req, res, next) {
    // Skip if replica set not initialized
    if (!req.replicaSetInitialized) {
      console.log('  Replica set not initialized - skipping create-user Job');
      return next();
    }
    
    // Check if user already initialized (annotation on tenant)
    const userInitialized = req.tenant.metadata?.annotations?.['ns.mdn.io/user-initialized'];
    if (userInitialized) {
      console.log(`  User already initialized at ${userInitialized}`);
      return next();
    }
    
    // Skip if auth secret missing
    if (!req.mongoAuthSecret) {
      console.log('  mongo-auth Secret missing - cannot render create-user Job');
      return next();
    }
    
    // Check if create-user Job already exists and succeeded
    // Use helper to find Job across all related Job collections (Job.batch/v1@0, Job.batch/v1@1, etc.)
    const createUserJobName = `${req.tenantId}-create-user`;
    const createUserJob = findJobByName(req.related, createUserJobName, req.namespace);
    
    if (createUserJob) {
      const jobStatus = createUserJob.status || {};
      const succeeded = (jobStatus.succeeded || 0) > 0;
      
      if (succeeded) {
        console.log('  Create-user Job succeeded - marking user initialized');
        res.annotations['ns.mdn.io/user-initialized'] = new Date().toISOString();
        return next();
      }
      
      console.log(`  Create-user Job exists but not yet succeeded (active: ${jobStatus.active || 0}, failed: ${jobStatus.failed || 0})`);
      return next();
    }
    
    // No Job exists yet - render it as attachment
    console.log('  Rendering create-user Job');
    const createUserJobResource = renderCreateUserJob_(
      req.tenantId,
      req.namespace,
      req.databaseName,
      req.mongoAuthSecret,
      config
    );
    
    res.attachments.push(createUserJobResource);
    
    // Request explicit requeue to ensure decorator re-runs when Job completes
    res.resyncAfterSeconds = 15;
    
    return next();
  }
  
  /**
   * Stage 6: Format response
   */
  function formatResponse(req, res, next) {
    const hasAttachments = res.attachments.length > 0;
    const hasAnnotations = Object.keys(res.annotations).length > 0;
    const hasResync = res.resyncAfterSeconds !== undefined;
    
    const response = {};
    
    if (hasAttachments) {
      response.attachments = res.attachments;
      console.log(`  Returning ${res.attachments.length} attachments`);
    }
    
    if (hasAnnotations) {
      response.annotations = res.annotations;
      console.log(`  Setting annotations: ${Object.keys(res.annotations).join(', ')}`);
    }
    
    if (hasResync) {
      response.resyncAfterSeconds = res.resyncAfterSeconds;
      console.log(`  Requesting requeue after ${res.resyncAfterSeconds} seconds`);
    }
    
    // Always return response (may be empty object for no-op)
    res.send(response);
    
    // Call next() to maintain Restify middleware chain
    return next();
  }
  
  // Pipeline
  return [
    initialize,
    discoverConfigMap,
    discoverMongoAuthSecret,
    renderInitReplicaSetJob,
    renderCreateUserJob,
    formatResponse
  ];
}

/**
 * Render init-replica-set Job (Gen5)
 * Uses ns-utility container with bundled scripts
 */
function renderInitReplicaSetJob_(tenantId, namespace, databaseName, authSecret, config) {
  const authSecretName = authSecret.metadata.name;
  const mongoHost = 'localhost:27017';  // Pod-local MongoDB
  
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
        'ns.mdn.io/tenant': tenantId,
        'ns.mdn.io/decorator': 'tenant-initialization'
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
              image: config.images?.nsUtility || 'nightscout/ns-utility:latest',
              command: ['/bin/bash', '-c'],
              args: ['/scripts/init-replica-set.sh'],
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
                  name: 'MONGO_HOST',
                  value: mongoHost
                },
                {
                  name: 'REPLICA_SET_NAME',
                  value: 'rs0'
                },
                {
                  name: 'POD_NAME',
                  value: `${tenantId}-rs-`  // ReplicaSet pod name prefix
                }
              ]
            }
          ]
        }
      }
    }
  };
}

/**
 * Render create-user Job (Gen5)
 * Uses ns-utility container with create-mongodb-user.sh script
 */
function renderCreateUserJob_(tenantId, namespace, databaseName, authSecret, config) {
  const authSecretName = authSecret.metadata.name;
  const mongoHost = 'localhost:27017';  // Pod-local MongoDB
  
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: `${tenantId}-create-user`,
      namespace: namespace,
      labels: {
        'app.kubernetes.io/name': 'mongodb-user',
        'app.kubernetes.io/component': 'user-initialization',
        'app.kubernetes.io/part-of': 'nightscout-tenant',
        'app.kubernetes.io/instance': tenantId,
        'app.kubernetes.io/managed-by': 'metacontroller',
        'ns.mdn.io/tenant': tenantId,
        'ns.mdn.io/decorator': 'tenant-initialization'
      }
    },
    spec: {
      ttlSecondsAfterFinished: 86400, // 24 hours
      backoffLimit: 3,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'mongodb-user',
            'app.kubernetes.io/component': 'user-initialization',
            'ns.mdn.io/tenant': tenantId
          }
        },
        spec: {
          restartPolicy: 'OnFailure',
          containers: [
            {
              name: 'create-user',
              image: config.images?.nsUtility || 'nightscout/ns-utility:latest',
              command: ['/bin/bash', '-c'],
              args: ['/scripts/create-mongodb-user.sh'],
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
                },
                {
                  name: 'MONGO_HOST',
                  value: mongoHost
                },
                {
                  name: 'MONGO_PORT',
                  value: '27017'
                },
                {
                  name: 'MONGO_RS_NAME',
                  value: 'rs0'
                },
                {
                  name: 'FORCE_USER_CREATE',
                  value: 'true'
                }
              ]
            }
          ]
        }
      }
    }
  };
}

module.exports = { createTenantInitializationDecoratorSync };
