/**
 * App-Credentials Init Decorator (Shared Gen4/Gen5)
 * 
 * Watches app-credentials Secrets and orchestrates MongoDB user creation.
 * The Secret represents an allocated tenant credential that needs a database user.
 * 
 * Target: app-credentials Secret (v1/secrets with ns.mdn.io/credential-type=application label)
 * Attachments: create-user Job
 * Annotations on Secret:
 *   - ns.mdn.io/user-initialized: ISO timestamp when user creation completed
 * 
 * Prerequisites for Job rendering:
 *   1. Pod with ns.mdn.io/storage label must be Ready (for Pod IP connectivity)
 *   2. mongo-auth Secret must have ns.mdn.io/replica-set-initialized annotation
 *   3. User must not be already created (check annotation on app-credentials Secret)
 *   4. mongo-auth Secret must be discoverable (for admin credentials)
 * 
 * This decorator stamps annotations on the app-credentials Secret (not the parent CR),
 * which avoids drift issues with composite controllers using generateSelector=false.
 */

const { ANNOTATIONS, LABELS, RESOURCE_TYPES } = require('./constants');
const { renderCreateUserJob } = require('./resources');

function createAppCredentialsInitDecoratorSync(config) {
  
  function findResource(collection, predicate) {
    if (!collection) return null;
    if (Array.isArray(collection)) {
      return collection.find(predicate);
    }
    return Object.values(collection).find(predicate);
  }
  
  function jobSucceeded(job) {
    if (!job) return false;
    const status = job.status || {};
    return (status.succeeded || 0) > 0;
  }
  
  function cleanForAttachment(resource) {
    if (!resource) return null;
    const cleaned = JSON.parse(JSON.stringify(resource));
    if (cleaned.metadata) {
      delete cleaned.metadata.resourceVersion;
      delete cleaned.metadata.uid;
      delete cleaned.metadata.creationTimestamp;
      delete cleaned.metadata.generation;
      delete cleaned.metadata.managedFields;
      delete cleaned.metadata.selfLink;
    }
    delete cleaned.status;
    return cleaned;
  }
  
  function initialize(req, res, next) {
    const { object: secret, related, attachments } = req.body;
    
    req.secret = secret;
    req.related = related || {};
    req.attachments = attachments || {};
    req.namespace = secret.metadata.namespace;
    
    req.storageId = secret.metadata.labels?.['ns.mdn.io/storage'] || 
                    secret.metadata.labels?.['storage.nightscout.org/account'];
    req.tenantId = secret.metadata.labels?.['ns.mdn.io/tenant'] ||
                   secret.metadata.labels?.['nightscout.io/tenant'];
    
    const secretName = secret.metadata.name;
    req.resourceName = secretName.replace(/-app-credentials$/, '');
    
    res.attachments = [];
    res.annotations = {};
    
    console.log(`App-Credentials Init Decorator: ${secretName}`);
    console.log(`  Storage ID: ${req.storageId}`);
    console.log(`  Tenant ID: ${req.tenantId || '(not set)'}`);
    console.log(`  Resource Name: ${req.resourceName}`);
    
    if (!req.storageId) {
      console.log('  No storage ID label - skipping');
      res.send({ attachments: [] });
      return;
    }
    
    return next();
  }
  
  function checkAlreadyInitialized(req, res, next) {
    const userInitialized = req.secret.metadata?.annotations?.['ns.mdn.io/user-initialized'];
    
    if (userInitialized) {
      console.log(`  User already initialized at ${userInitialized}`);
      req.alreadyInitialized = true;
    } else {
      req.alreadyInitialized = false;
    }
    
    return next();
  }
  
  function discoverMongoAuthSecret(req, res, next) {
    if (req.alreadyInitialized) {
      return next();
    }
    
    const secrets = req.related['Secret.v1'] || {};
    
    const mongoAuthSecret = findResource(secrets, s => 
      (s.metadata?.labels?.['ns.mdn.io/storage'] === req.storageId ||
       s.metadata?.labels?.['storage.nightscout.org/account'] === req.storageId) &&
      (s.metadata?.labels?.['ns.mdn.io/composite'] === 'mongodb-auth' ||
       s.metadata?.name?.endsWith('-mongo-auth'))
    );
    
    if (mongoAuthSecret) {
      console.log(`  Found mongo-auth Secret: ${mongoAuthSecret.metadata.name}`);
      req.mongoAuthSecret = mongoAuthSecret;
      
      // Check replica set initialization status
      const replicaSetInitialized = mongoAuthSecret.metadata?.annotations?.['ns.mdn.io/replica-set-initialized'];
      
      // Check if replica set is required (default true for backwards compatibility)
      const replicasetRequired = mongoAuthSecret.metadata?.annotations?.['ns.mdn.io/replicaset-required'];
      req.replicasetRequired = replicasetRequired !== 'false';
      
      if (replicaSetInitialized) {
        console.log(`    Replica set initialized at: ${replicaSetInitialized}`);
        req.replicaSetInitialized = true;
      } else if (!req.replicasetRequired) {
        // If replicaset is not required, treat as initialized
        console.log('    Replica set NOT required - treating as initialized');
        req.replicaSetInitialized = true;
      } else {
        console.log('    Replica set NOT initialized yet (required)');
        req.replicaSetInitialized = false;
      }
      
      req.databaseName = Buffer.from(mongoAuthSecret.data?.MONGO_INITDB_DATABASE || '', 'base64').toString('utf-8') ||
                         Buffer.from(mongoAuthSecret.data?.database || '', 'base64').toString('utf-8') ||
                         req.storageId;
    } else {
      console.log('  mongo-auth Secret not found');
      req.mongoAuthSecret = null;
      req.replicaSetInitialized = false;
      req.replicasetRequired = true;  // Assume required if we can't find the secret
    }
    
    return next();
  }
  
  function discoverPod(req, res, next) {
    if (req.alreadyInitialized) {
      return next();
    }
    
    const pods = req.related['Pod.v1'] || {};
    
    const tenantPod = findResource(pods, p => 
      (p.metadata?.labels?.['ns.mdn.io/storage'] === req.storageId ||
       p.metadata?.labels?.['storage.nightscout.org/account'] === req.storageId) &&
      (p.metadata?.labels?.['app.kubernetes.io/component'] === 'tenant-pod' ||
       p.metadata?.labels?.['app.kubernetes.io/component'] === 'database')
    );
    
    if (tenantPod) {
      const podIP = tenantPod.status?.podIP;
      const podPhase = tenantPod.status?.phase;
      const containerReady = tenantPod.status?.containerStatuses?.find(c => 
        c.name === 'mongodb' && c.ready
      );
      
      console.log(`  Pod found: ${tenantPod.metadata.name}`);
      console.log(`    Phase: ${podPhase}, IP: ${podIP || '(pending)'}`);
      console.log(`    MongoDB ready: ${!!containerReady}`);
      
      req.tenantPod = tenantPod;
      req.podIP = podIP;
      req.podReady = podPhase === 'Running' && !!containerReady;
    } else {
      console.log('  No tenant Pod found');
      req.tenantPod = null;
      req.podIP = null;
      req.podReady = false;
    }
    
    return next();
  }
  
  function planCreateUserJob(req, res, next) {
    if (req.alreadyInitialized) {
      console.log('  Already initialized - no Job needed');
      return next();
    }
    
    if (!req.mongoAuthSecret) {
      console.log('  mongo-auth Secret not found - cannot create user');
      return next();
    }
    
    const tenantIdForJob = req.tenantId || req.resourceName;
    const createUserJobName = `${req.storageId}-${tenantIdForJob}-create-user`;
    
    // First, check for existing Job in attachments OR related (preserve existing Jobs)
    const existingJobsAttachments = req.attachments['Job.batch/v1'] || {};
    const existingJob = existingJobsAttachments[createUserJobName] || 
                        findResource(req.related['Job.batch/v1'], j => j.metadata?.name === createUserJobName);
    
    if (existingJob && jobSucceeded(existingJob)) {
      console.log('  Create-user Job succeeded - marking user initialized');
      res.annotations['ns.mdn.io/user-initialized'] = new Date().toISOString();
      // Preserve the completed Job (K8s TTL controller will clean it up)
      res.attachments.push(cleanForAttachment(existingJob));
      return next();
    }
    
    if (existingJob) {
      console.log('  Create-user Job exists but not succeeded - preserving');
      res.attachments.push(cleanForAttachment(existingJob));
      return next();
    }
    
    // Gate on replica set initialized (either actually initialized, or not required)
    if (!req.replicaSetInitialized) {
      console.log('  Replica set not initialized yet - waiting before creating user');
      return next();
    }
    
    // Only create new Job if Pod is ready
    if (!req.podReady || !req.podIP) {
      console.log(`  Pod not ready (ready: ${req.podReady}, IP: ${req.podIP}) - waiting`);
      return next();
    }
    
    console.log(`  Rendering create-user Job → Pod IP: ${req.podIP}`);
    
    const mongoHostname = req.podIP;
    
    const createUserJob = renderCreateUserJob(
      req.mongoAuthSecret.metadata.name,
      req.secret.metadata.name,
      tenantIdForJob,
      req.namespace,
      req.storageId,
      mongoHostname,
      config
    );
    
    createUserJob.metadata.labels = {
      ...createUserJob.metadata.labels,
      'ns.mdn.io/decorator': 'app-credentials-init',
      'ns.mdn.io/storage': req.storageId,
      ...(req.tenantId ? { 'ns.mdn.io/tenant': req.tenantId } : {})
    };
    
    res.attachments.push(createUserJob);
    return next();
  }
  
  function formatResponse(req, res, next) {
    const hasAttachments = res.attachments.length > 0;
    const hasAnnotations = Object.keys(res.annotations).length > 0;
    
    const response = { attachments: res.attachments };
    
    if (hasAnnotations) {
      response.annotations = res.annotations;
      console.log(`  Setting annotations: ${Object.keys(res.annotations).join(', ')}`);
    }
    
    console.log(`  Returning ${res.attachments.length} attachments`);
    res.send(response);
    return next();
  }
  
  return [
    initialize,
    checkAlreadyInitialized,
    discoverMongoAuthSecret,
    discoverPod,
    planCreateUserJob,
    formatResponse
  ];
}

function createAppCredentialsInitDecoratorCustomize(config) {
  return function(req, res, next) {
    const { parent: secret } = req.body;
    
    const storageId = secret.metadata.labels?.['ns.mdn.io/storage'] || 
                      secret.metadata.labels?.['storage.nightscout.org/account'];
    const tenantId = secret.metadata.labels?.['ns.mdn.io/tenant'] ||
                     secret.metadata.labels?.['nightscout.io/tenant'];
    
    console.log(`App-Credentials Init customize for: ${secret.metadata.name}`);
    console.log(`  Storage ID: ${storageId}`);
    console.log(`  Tenant ID: ${tenantId || '(not set)'}`);
    
    if (!storageId) {
      res.send({ relatedResources: [] });
      return next();
    }
    
    const relatedResources = [
      {
        apiVersion: 'v1',
        resource: 'pods',
        labelSelector: {
          matchLabels: {
            'ns.mdn.io/storage': storageId
          }
        }
      },
      {
        apiVersion: 'v1',
        resource: 'secrets',
        labelSelector: {
          matchLabels: {
            'ns.mdn.io/storage': storageId,
            'ns.mdn.io/composite': 'mongodb-auth'
          }
        }
      },
      {
        apiVersion: 'batch/v1',
        resource: 'jobs',
        labelSelector: {
          matchLabels: {
            'ns.mdn.io/storage': storageId,
            'ns.mdn.io/decorator': 'app-credentials-init'
          }
        }
      }
    ];
    
    console.log(`  Requesting ${relatedResources.length} related resource types`);
    res.send({ relatedResources });
    return next();
  };
}

module.exports = { 
  createAppCredentialsInitDecoratorSync, 
  createAppCredentialsInitDecoratorCustomize 
};
