/**
 * Compute Composite Controller
 * 
 * Manages Nightscout Deployment + Service from ConfigMap parent
 * 
 * Parent: ConfigMap (labeled ns.mdn.io/composite=compute)
 * Children:
 *   - Nightscout Deployment
 *   - Nightscout Service
 *   - PodDisruptionBudget (optional)
 *   - KafkaTopic (if CDC_ENABLED)
 *   - KafkaConnector (if CDC_ENABLED)
 * Related (not owned):
 *   - Storage Secret (discovered via storage.nightscout.org/account label)
 *   - MongoDB StatefulSet (blast radius protection)
 * 
 * Note: Migration is a storage-layer concern handled by storage composite.
 *       This controller never renders migration Jobs.
 */

const { renderNightscout, renderKafkaTopics, renderKafkaConnector } = require('./resources');

async function computeCompositeSync(req, res, next) {
  const { parent, children, related } = req.body;
  
  const tenantId = parent.metadata.name;
  const storageAccountLabel = parent.metadata.labels?.['storage.nightscout.org/account'];
  
  console.log('Compute composite sync for tenant:', tenantId, 'storage account:', storageAccountLabel);
  
  try {
    const response = {
      status: {},
      children: [],
      relatedResourceRules: [
        {
          // Discover storage Secret (provides MongoDB credentials)
          apiVersion: 'v1',
          resource: 'secrets',
          labelSelector: {
            matchLabels: {
              'storage.nightscout.org/account': storageAccountLabel,
              'ns.mdn.io/composite': 'storage'
            }
          }
        },
        {
          // Discover MongoDB StatefulSet (blast radius protection)
          apiVersion: 'apps/v1',
          resource: 'statefulsets',
          labelSelector: {
            matchLabels: {
              'storage.nightscout.org/account': storageAccountLabel,
              'app.kubernetes.io/name': 'mongodb'
            }
          }
        }
      ]
    };

    // Find storage Secret from related resources
    const storageSecret = findStorageSecret(related, storageAccountLabel);
    
    if (!storageSecret) {
      console.warn(`Storage Secret not found for account: ${storageAccountLabel}`);
      response.status = {
        observedGeneration: parent.metadata?.generation,
        conditions: [{
          type: 'Ready',
          status: 'False',
          reason: 'StorageSecretNotFound',
          message: `Storage Secret with label storage.nightscout.org/account=${storageAccountLabel} not found`,
          lastTransitionTime: new Date().toISOString()
        }]
      };
      res.send(response);
      return next();
    }

    // Check MongoDB readiness from related StatefulSet
    const mongoReadiness = checkMongoReadinessFromRelated(related, storageAccountLabel);
    
    // Enhance parent with storage information
    const enrichedParent = enrichWithStorageInfo(parent, storageSecret, storageAccountLabel);
    
    // Render Nightscout resources
    response.children.push(...renderNightscout(enrichedParent));

    // Optional: CDC resources if enabled
    const cdcEnabled = parent.data?.CDC_ENABLED === 'true';
    if (cdcEnabled && mongoReadiness.ready) {
      response.children.push(...renderKafkaTopics(enrichedParent));
      response.children.push(renderKafkaConnector(enrichedParent));
    }

    // Build status
    response.status = buildStatus(parent, {
      mongoReadiness,
      cdcEnabled,
      storageAccount: storageAccountLabel,
      children
    });

    res.send(response);
    return next();
  } catch (error) {
    console.error('Error in compute composite sync:', error);
    res.send(500, { error: error.message });
    return next();
  }
}

/**
 * Find storage Secret from related resources
 */
function findStorageSecret(related, storageAccountLabel) {
  if (!related || !related['Secret.v1']) {
    return null;
  }
  
  const secrets = related['Secret.v1'];
  for (const [name, secret] of Object.entries(secrets)) {
    const accountLabel = secret.metadata?.labels?.['storage.nightscout.org/account'];
    const compositeLabel = secret.metadata?.labels?.['ns.mdn.io/composite'];
    
    if (accountLabel === storageAccountLabel && compositeLabel === 'storage') {
      console.log(`Found storage Secret: ${name} for account: ${storageAccountLabel}`);
      return secret;
    }
  }
  
  return null;
}

/**
 * Check MongoDB readiness from related StatefulSet
 * Note: Shared storage (no StatefulSet) is considered ready
 */
function checkMongoReadinessFromRelated(related, storageAccountLabel) {
  // Check if using shared storage (no StatefulSet expected)
  const storageSecrets = related?.['Secret.v1'] || {};
  for (const [name, secret] of Object.entries(storageSecrets)) {
    const accountLabel = secret.metadata?.labels?.['storage.nightscout.org/account'];
    const storageType = secret.metadata?.annotations?.['ns.mdn.io/storage-type'];
    
    if (accountLabel === storageAccountLabel && storageType === 'shared') {
      console.log(`  Shared storage detected - MongoDB assumed ready (no StatefulSet check)`);
      return {
        ready: true,
        condition: {
          type: 'MongoDBReady',
          status: 'True',
          reason: 'SharedMongoDB',
          message: 'Using shared MongoDB cluster (no dedicated StatefulSet)',
          lastTransitionTime: new Date().toISOString()
        }
      };
    }
  }
  
  // Dedicated storage - check StatefulSet readiness
  if (!related || !related['StatefulSet.apps/v1']) {
    return {
      ready: false,
      condition: {
        type: 'MongoDBReady',
        status: 'False',
        reason: 'StatefulSetNotFound',
        message: 'MongoDB StatefulSet not found in related resources (dedicated storage expected)',
        lastTransitionTime: new Date().toISOString()
      }
    };
  }
  
  const statefulSets = related['StatefulSet.apps/v1'];
  for (const [name, sts] of Object.entries(statefulSets)) {
    const accountLabel = sts.metadata?.labels?.['storage.nightscout.org/account'];
    
    if (accountLabel === storageAccountLabel) {
      const replicas = sts.spec?.replicas || 0;
      const readyReplicas = sts.status?.readyReplicas || 0;
      const ready = readyReplicas >= 1;
      
      console.log(`Found MongoDB StatefulSet ${name} for storage account ${storageAccountLabel}: ${readyReplicas}/${replicas} ready`);
      
      return {
        ready,
        condition: {
          type: 'MongoDBReady',
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
    condition: {
      type: 'MongoDBReady',
      status: 'False',
      reason: 'StatefulSetNotFound',
      message: `MongoDB StatefulSet for storage account ${storageAccountLabel} not found`,
      lastTransitionTime: new Date().toISOString()
    }
  };
}

/**
 * Enrich parent ConfigMap with storage information
 */
function enrichWithStorageInfo(parent, storageSecret, storageAccountLabel) {
  // Decode Secret data
  const secretData = {};
  if (storageSecret.data) {
    Object.keys(storageSecret.data).forEach(key => {
      secretData[key] = Buffer.from(storageSecret.data[key], 'base64').toString('utf-8');
    });
  }
  
  // Check if using shared MongoDB (no dedicated StatefulSet)
  const storageType = storageSecret.metadata?.annotations?.['ns.mdn.io/storage-type'] || 'dedicated';
  const mongoHost = storageType === 'shared' 
    ? secretData.mongoHost || 'shared-mongodb'
    : `${storageAccountLabel}-mongodb`;
  
  return {
    ...parent,
    data: {
      ...parent.data,
      TENANT_ID: parent.metadata.name,
      // Storage connection info (credentials come from Secret reference)
      MONGO_HOST: mongoHost,
      STORAGE_ACCOUNT: storageAccountLabel,
      STORAGE_SECRET: storageSecret.metadata.name,
      STORAGE_TYPE: storageType
    }
  };
}

/**
 * Build Kubernetes-idiomatic status
 */
function buildStatus(parent, state) {
  const { mongoReadiness, cdcEnabled, storageAccount } = state;
  
  const conditions = [];
  
  // MongoDB readiness (from related resources)
  conditions.push(mongoReadiness.condition);
  
  // Overall Ready condition
  const allReady = mongoReadiness.ready;
  
  conditions.push({
    type: 'Ready',
    status: allReady ? 'True' : 'False',
    reason: allReady ? 'AllComponentsReady' : 'WaitingForMongoDB',
    message: allReady 
      ? 'Tenant is ready and operational'
      : 'Waiting for MongoDB to become ready',
    lastTransitionTime: new Date().toISOString()
  });
  
  return {
    observedGeneration: parent.metadata?.generation,
    conditions,
    storage: {
      account: storageAccount,
      mongoReady: mongoReadiness.ready
    }
  };
}

module.exports = computeCompositeSync;
