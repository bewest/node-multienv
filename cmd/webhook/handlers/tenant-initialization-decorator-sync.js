/**
 * Tenant Initialization Decorator - Sync Hook (Gen 5)
 * 
 * Orchestrates MongoDB initialization Jobs for NightscoutTenant CRs
 * 
 * Identity Field Pattern:
 * - resourceName (CR name): Used for Job naming prefixes (DNS-safe)
 * - spec.storage: Required, used for ns.mdn.io/storage label on all Jobs
 * - spec.tenant: Optional, used for ns.mdn.io/tenant label when set
 * 
 * Target: NightscoutTenant CRD
 * Related Resources:
 *   - ConfigMap (to detect compute activation via spec.configMapRef)
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
 * 
 * Render Pattern:
 *   - Render functions accept optional existing Job to clean/preserve
 *   - If existing Job provided, strip runtime metadata and return (preserves attachment)
 *   - If no existing Job, create fresh resource
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
   * Helper: Check if Job has succeeded
   */
  function jobSucceeded(job) {
    if (!job) return false;
    const status = job.status || {};
    return (status.succeeded || 0) > 0;
  }
  
  /**
   * Helper: Build identity labels for child resources
   * - ns.mdn.io/storage: Always included (from spec.storage)
   * - ns.mdn.io/tenant: Only included when spec.tenant is explicitly set
   */
  function buildIdentityLabels(req) {
    const labels = {
      'ns.mdn.io/storage': req.storageId
    };
    
    if (req.tenantSet && req.tenantId) {
      labels['ns.mdn.io/tenant'] = req.tenantId;
    }
    
    return labels;
  }
  
  /**
   * Helper: Clean existing resource for re-attachment
   * Strips runtime metadata (status, resourceVersion, uid, etc.) that shouldn't be in desired state
   */
  function cleanForAttachment(resource) {
    if (!resource) return null;
    
    // Deep clone to avoid mutating original
    const cleaned = JSON.parse(JSON.stringify(resource));
    
    // Remove runtime-only fields from metadata
    if (cleaned.metadata) {
      delete cleaned.metadata.resourceVersion;
      delete cleaned.metadata.uid;
      delete cleaned.metadata.creationTimestamp;
      delete cleaned.metadata.generation;
      delete cleaned.metadata.managedFields;
      delete cleaned.metadata.selfLink;
    }
    
    // Remove status (runtime-only)
    delete cleaned.status;
    
    return cleaned;
  }
  
  /**
   * Stage 1: Initialize context and response containers
   */
  function initialize(req, res, next) {
    const { object: tenant, related } = req.body;
    
    req.tenant = tenant;
    req.related = related || {};
    req.namespace = tenant.metadata.namespace;
    req.spec = tenant.spec || {};
    
    // Identity field extraction (matching composite controller pattern)
    req.resourceName = tenant.metadata.name;  // Used for resource naming
    req.storageId = req.spec.storage;          // Used for ns.mdn.io/storage label
    req.tenantId = req.spec.tenant;            // Used for ns.mdn.io/tenant label (when set)
    req.tenantSet = !!req.spec.tenant;         // Track if tenant ID was explicitly set
    
    // ConfigMap ref for compute activation
    req.configMapRef = req.spec.configMapRef;
    
    // Response containers
    res.attachments = [];
    res.annotations = {};
    
    console.log(`Tenant Init Decorator: ${req.resourceName}`);
    console.log(`  Namespace: ${req.namespace}`);
    console.log(`  Storage ID: ${req.storageId}`);
    console.log(`  Tenant ID: ${req.tenantId || '(not set)'} (explicit: ${req.tenantSet})`);
    
    // Validate required spec.storage field
    if (!req.storageId) {
      console.error(`  ERROR: spec.storage is required but not provided`);
      res.send({ attachments: [] });
      return; // Skip remaining middleware
    }
    
    return next();
  }
  
  /**
   * Stage 2: Discover ConfigMap (compute activation signal)
   * Sets req.computeActivated flag based on ConfigMap presence via spec.configMapRef
   */
  function discoverConfigMap(req, res, next) {
    const configMapRef = req.configMapRef;
    
    // No configMapRef means no compute activation
    if (!configMapRef || !configMapRef.name) {
      console.log('  No configMapRef - compute not activated');
      req.computeActivated = false;
      return next();
    }
    
    // Look for ConfigMap by name
    const configMaps = req.related['ConfigMap.v1'] || {};
    const refNamespace = configMapRef.namespace || req.namespace;
    
    const matchingConfigMap = findResource(configMaps, cm => 
      cm.metadata?.name === configMapRef.name &&
      cm.metadata?.namespace === refNamespace
    );
    
    if (matchingConfigMap) {
      console.log(`  ConfigMap found: ${matchingConfigMap.metadata.name} - compute activated`);
      req.computeActivated = true;
      req.configMap = matchingConfigMap;
    } else {
      console.log(`  ConfigMap ${configMapRef.name} not found - compute not activated`);
      req.computeActivated = false;
    }
    
    return next();
  }
  
  /**
   * Stage 3: Discover mongo-auth Secret (for Job credentials)
   */
  function discoverMongoAuthSecret(req, res, next) {
    const mongoAuthSecretRef = req.spec.mongoAuthSecretRef;
    
    if (!mongoAuthSecretRef) {
      console.log('  No mongoAuthSecretRef in spec');
      req.mongoAuthSecret = null;
      return next();
    }
    
    const authSecretName = mongoAuthSecretRef;
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
   * Stage 4: Plan init-replica-set Job
   * Gates on annotation - only renders if not already initialized
   * Render function handles both new and existing Job cases
   */
  function planInitReplicaSetJob(req, res, next) {
    // Skip if compute not activated
    if (!req.computeActivated) {
      console.log('  Compute not activated - skipping init Job');
      req.replicaSetInitialized = false;
      return next();
    }
    
    // Skip if auth secret missing
    if (!req.mongoAuthSecret) {
      console.log('  mongo-auth Secret missing - cannot render init Job');
      req.replicaSetInitialized = false;
      return next();
    }
    
    // skip replicaset stuff for now
    const replicaSetRequired = req.tenant.metadata?.annotation?.['ns.mdn.io/replica-set-required'] == 'true';
    req.replicaSetRequired = replicaSetRequired;
    if (!replicaSetRequired) {
      return next();
    }

    // Check if already initialized (annotation on tenant)
    const replicaSetInitialized = req.tenant.metadata?.annotations?.['ns.mdn.io/replica-set-initialized'];
    if (replicaSetInitialized) {
      console.log(`  Replica set already initialized at ${replicaSetInitialized} - skipping Job`);
      req.replicaSetInitialized = true;
      return next();
    }
    
    // Find existing Job (if any)
    const initJobName = `${req.resourceName}-init-rs`;
    const existingJob = findJobByName(req.related, initJobName, req.namespace);
    
    // Check if existing Job succeeded - set annotation
    if (existingJob && jobSucceeded(existingJob)) {
      console.log('  Init Job succeeded - marking replica set initialized');
      res.annotations['ns.mdn.io/replica-set-initialized'] = new Date().toISOString();
      req.replicaSetInitialized = true;
      // Keep completed Job in attachments for TTL cleanup
      res.attachments.push(cleanForAttachment(existingJob));
      return next();
    }
    
    // Not initialized - render Job (handles both new and existing cases)
    console.log(`  Rendering init-replica-set Job${existingJob ? ' (preserving existing)' : ' (new)'}`);
    
    const identityLabels = buildIdentityLabels(req);
    const initJob = renderInitReplicaSetJob(
      req.resourceName,
      req.namespace,
      req.databaseName,
      req.mongoAuthSecret,
      identityLabels,
      config,
      existingJob  // Pass existing for preservation
    );
    
    res.attachments.push(initJob);
    req.replicaSetInitialized = false;
    
    // Request requeue to check Job status
    res.resyncAfterSeconds = 15;
    
    return next();
  }
  
  /**
   * Stage 5: Plan create-user Job
   * Gates on annotation - only renders if not already initialized
   * Render function handles both new and existing Job cases
   */
  function planCreateUserJob(req, res, next) {
    // Skip if replica set not initialized
    if (req.replicaSetRequired && !req.replicaSetInitialized) {
      console.log('  Replica set not initialized - skipping create-user Job');
      return next();
    }
    
    // Skip if auth secret missing
    if (!req.mongoAuthSecret) {
      console.log('  mongo-auth Secret missing - cannot render create-user Job');
      return next();
    }
    
    // Check if user already initialized (annotation on tenant)
    const userInitialized = req.tenant.metadata?.annotations?.['ns.mdn.io/user-initialized'];
    if (userInitialized) {
      console.log(`  User already initialized at ${userInitialized} - skipping Job`);
      return next();
    }
    
    // Find existing Job (if any)
    const createUserJobName = `${req.resourceName}-create-user`;
    const existingJob = findJobByName(req.related, createUserJobName, req.namespace);
    
    // Check if existing Job succeeded - set annotation
    if (existingJob && jobSucceeded(existingJob)) {
      console.log('  Create-user Job succeeded - marking user initialized');
      res.annotations['ns.mdn.io/user-initialized'] = new Date().toISOString();
      // Keep completed Job in attachments for TTL cleanup
      res.attachments.push(cleanForAttachment(existingJob));
      return next();
    }
    
    // Not initialized - render Job (handles both new and existing cases)
    console.log(`  Rendering create-user Job${existingJob ? ' (preserving existing)' : ' (new)'}`);
    
    const identityLabels = buildIdentityLabels(req);
    const createUserJob = renderCreateUserJob(
      req.resourceName,
      req.namespace,
      req.databaseName,
      req.mongoAuthSecret,
      identityLabels,
      config,
      existingJob  // Pass existing for preservation
    );
    
    res.attachments.push(createUserJob);
    
    // Request requeue to check Job status
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
  
  /**
   * Render init-replica-set Job
   * 
   * If existing Job provided, cleans and returns it (preserves attachment)
   * If no existing Job, creates fresh resource
   * 
   * @param resourceName - CR name, used for Job naming prefix
   * @param namespace - Target namespace
   * @param databaseName - MongoDB database name
   * @param authSecret - mongo-auth Secret for credentials
   * @param identityLabels - Pre-built identity labels (ns.mdn.io/storage, ns.mdn.io/tenant)
   * @param config - Controller configuration
   * @param existing - Optional existing Job to preserve (cleans runtime metadata)
   */
  function renderInitReplicaSetJob(resourceName, namespace, databaseName, authSecret, identityLabels, cfg, existing) {
    // If existing Job provided, clean and return it to preserve attachment
    if (existing) {
      return cleanForAttachment(existing);
    }
    
    // Create fresh Job
    const authSecretName = authSecret.metadata.name;
    const mongoHost = 'localhost:27017';  // Pod-local MongoDB
    
    return {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: `${resourceName}-init-rs`,
        namespace: namespace,
        labels: {
          'app.kubernetes.io/name': 'mongodb-init',
          'app.kubernetes.io/component': 'database',
          'app.kubernetes.io/part-of': 'nightscout-tenant',
          'app.kubernetes.io/instance': resourceName,
          'app.kubernetes.io/managed-by': 'metacontroller',
          'ns.mdn.io/decorator': 'tenant-initialization',
          ...identityLabels
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
              ...identityLabels
            }
          },
          spec: {
            restartPolicy: 'OnFailure',
            containers: [
              {
                name: 'init-replica-set',
                image: cfg.images?.nsUtility || 'nightscout/ns-utility:latest',
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
                    value: `${resourceName}-rs-`  // ReplicaSet pod name prefix
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
   * Render create-user Job
   * 
   * If existing Job provided, cleans and returns it (preserves attachment)
   * If no existing Job, creates fresh resource
   * 
   * @param resourceName - CR name, used for Job naming prefix
   * @param namespace - Target namespace
   * @param databaseName - MongoDB database name
   * @param authSecret - mongo-auth Secret for credentials
   * @param identityLabels - Pre-built identity labels (ns.mdn.io/storage, ns.mdn.io/tenant)
   * @param config - Controller configuration
   * @param existing - Optional existing Job to preserve (cleans runtime metadata)
   */
  function renderCreateUserJob(resourceName, namespace, databaseName, authSecret, identityLabels, cfg, existing) {
    // If existing Job provided, clean and return it to preserve attachment
    if (existing) {
      return cleanForAttachment(existing);
    }
    
    // Create fresh Job
    const authSecretName = authSecret.metadata.name;
    const mongoHost = 'localhost:27017';  // Pod-local MongoDB
    
    return {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: `${resourceName}-create-user`,
        namespace: namespace,
        labels: {
          'app.kubernetes.io/name': 'mongodb-user',
          'app.kubernetes.io/component': 'user-initialization',
          'app.kubernetes.io/part-of': 'nightscout-tenant',
          'app.kubernetes.io/instance': resourceName,
          'app.kubernetes.io/managed-by': 'metacontroller',
          'ns.mdn.io/decorator': 'tenant-initialization',
          ...identityLabels
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
              ...identityLabels
            }
          },
          spec: {
            restartPolicy: 'OnFailure',
            containers: [
              {
                name: 'create-user',
                image: cfg.images?.nsUtility || 'nightscout/ns-utility:latest',
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
  
  // Pipeline
  return [
    initialize,
    discoverConfigMap,
    discoverMongoAuthSecret,
    planInitReplicaSetJob,
    planCreateUserJob,
    formatResponse
  ];
}

module.exports = { createTenantInitializationDecoratorSync };
