/**
 * Mongo-Auth Init Decorator (Shared Gen4/Gen5)
 * 
 * Watches mongo-auth Secrets and orchestrates MongoDB replica set initialization.
 * The Secret represents an allocated database resource that needs initialization.
 * 
 * Target: mongo-auth Secret (v1/secrets with ns.mdn.io/composite=mongodb-auth label)
 * Attachments: init-replica-set Job
 * Annotations on Secret:
 *   - ns.mdn.io/replica-set-initialized: ISO timestamp when init completed
 * 
 * Prerequisites for Job rendering:
 *   1. Pod with ns.mdn.io/storage label must be Ready (for Pod IP connectivity)
 *   2. Replica set init must not be already completed (check annotation)
 * 
 * This decorator stamps annotations on the mongo-auth Secret (not the parent CR),
 * which avoids drift issues with composite controllers using generateSelector=false.
 */

const { ANNOTATIONS, LABELS } = require('./constants');

function createMongoAuthInitDecoratorSync(config) {
  
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
    
    res.attachments = [];
    res.annotations = {};
    
    console.log(`Mongo-Auth Init Decorator: ${secret.metadata.name}`);
    console.log(`  Storage ID: ${req.storageId}`);
    
    if (!req.storageId) {
      console.log('  No storage ID label - skipping');
      res.send({ attachments: [] });
      return;
    }
    
    return next();
  }
  
  function checkAlreadyInitialized(req, res, next) {
    const replicaSetInitialized = req.secret.metadata?.annotations?.['ns.mdn.io/replica-set-initialized'];
    
    if (replicaSetInitialized) {
      console.log(`  Replica set already initialized at ${replicaSetInitialized}`);
      req.alreadyInitialized = true;
    } else {
      req.alreadyInitialized = false;
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
  
  function planInitJob(req, res, next) {
    if (req.alreadyInitialized) {
      console.log('  Already initialized - no Job needed');
      return next();
    }
    
    if (!req.podReady || !req.podIP) {
      console.log(`  Pod not ready (ready: ${req.podReady}, IP: ${req.podIP}) - waiting`);
      return next();
    }
    
    const initJobName = `${req.storageId}-init-rs`;
    const existingJobs = req.attachments['Job.batch/v1'] || {};
    const existingJob = existingJobs[initJobName] || 
                        findResource(req.related['Job.batch/v1'], j => j.metadata?.name === initJobName);
    
    if (existingJob && jobSucceeded(existingJob)) {
      console.log('  Init Job succeeded - marking replica set initialized');
      res.annotations['ns.mdn.io/replica-set-initialized'] = new Date().toISOString();
      res.attachments.push(cleanForAttachment(existingJob));
      return next();
    }
    
    if (existingJob) {
      console.log('  Init Job exists but not succeeded - preserving');
      res.attachments.push(cleanForAttachment(existingJob));
      return next();
    }
    
    console.log(`  Rendering init-replica-set Job → Pod IP: ${req.podIP}`);
    
    const authSecretName = req.secret.metadata.name;
    const databaseName = Buffer.from(req.secret.data?.MONGO_INITDB_DATABASE || '', 'base64').toString('utf-8') ||
                         Buffer.from(req.secret.data?.database || '', 'base64').toString('utf-8') ||
                         req.storageId;
    
    const mongoHost = `${req.podIP}:27017`;
    
    const initJob = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: initJobName,
        namespace: req.namespace,
        labels: {
          'app.kubernetes.io/name': 'mongodb-init',
          'app.kubernetes.io/component': 'database',
          'app.kubernetes.io/part-of': 'nightscout-tenant',
          'app.kubernetes.io/managed-by': 'metacontroller',
          'ns.mdn.io/decorator': 'mongo-auth-init',
          'ns.mdn.io/storage': req.storageId
        }
      },
      spec: {
        ttlSecondsAfterFinished: config.jobs?.ttlSecondsAfterFinished || 86400,
        backoffLimit: config.jobs?.backoffLimit || 3,
        template: {
          metadata: {
            labels: {
              'app.kubernetes.io/name': 'mongodb-init',
              'app.kubernetes.io/component': 'database',
              'ns.mdn.io/storage': req.storageId
            }
          },
          spec: {
            ...(config.multienv?.imagePullSecrets?.length > 0 
              ? { imagePullSecrets: config.multienv.imagePullSecrets } 
              : {}),
            restartPolicy: 'OnFailure',
            containers: [
              {
                name: 'init-replica-set',
                image: config.images?.nsUtility || 'nightscout/ns-utility:latest',
                imagePullPolicy: config.imagePullPolicies?.nsUtility || 'IfNotPresent',
                command: config.commands?.initReplicaSet || ['/app/multienvctl/entrypoints/init-replica-set.sh'],
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
                  }
                ],
                resources: config.resources?.initReplicaSet || {
                  requests: { cpu: '50m', memory: '64Mi' },
                  limits: { cpu: '200m', memory: '128Mi' }
                }
              }
            ]
          }
        }
      }
    };
    
    res.attachments.push(initJob);
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
    discoverPod,
    planInitJob,
    formatResponse
  ];
}

function createMongoAuthInitDecoratorCustomize(config) {
  return function(req, res, next) {
    const { parent: secret } = req.body;
    
    const storageId = secret.metadata.labels?.['ns.mdn.io/storage'] || 
                      secret.metadata.labels?.['storage.nightscout.org/account'];
    
    console.log(`Mongo-Auth Init customize for: ${secret.metadata.name}`);
    console.log(`  Storage ID: ${storageId}`);
    
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
        apiVersion: 'batch/v1',
        resource: 'jobs',
        labelSelector: {
          matchLabels: {
            'ns.mdn.io/storage': storageId,
            'ns.mdn.io/decorator': 'mongo-auth-init'
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
  createMongoAuthInitDecoratorSync, 
  createMongoAuthInitDecoratorCustomize 
};
