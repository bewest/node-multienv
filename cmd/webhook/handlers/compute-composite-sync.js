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

function createComputeCompositeSync(config) {
  return async function computeCompositeSync(req, res) {
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
          // Discover storage Secret (for storage type metadata)
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
          // Discover app-credentials Secret (provides MongoDB credentials for Nightscout)
          apiVersion: 'v1',
          resource: 'secrets',
          labelSelector: {
            matchLabels: {
              'storage.nightscout.org/account': storageAccountLabel,
              'ns.mdn.io/credential-type': 'application'
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

    // Find storage Secret from related resources (for metadata)
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
      return;
    }

    // Find app-credentials Secret from related resources (for Nightscout credentials)
    const appCredentialsSecret = findAppCredentialsSecret(related, storageAccountLabel);
    
    if (!appCredentialsSecret) {
      console.warn(`App credentials Secret not found for account: ${storageAccountLabel}`);
      response.status = {
        observedGeneration: parent.metadata?.generation,
        conditions: [{
          type: 'Ready',
          status: 'False',
          reason: 'AppCredentialsNotFound',
          message: `App credentials Secret not found for account ${storageAccountLabel}. Ensure storage Secret is initialized.`,
          lastTransitionTime: new Date().toISOString()
        }]
      };
      res.send(response);
      return;
    }

    // Check MongoDB readiness from related StatefulSet
    const mongoReadiness = checkMongoReadinessFromRelated(related, storageAccountLabel);
    
    // Enhance parent with storage information
    const enrichedParent = enrichWithStorageInfo(parent, storageSecret, appCredentialsSecret, storageAccountLabel);
    
    // Render Nightscout resources
    response.children.push(...renderNightscout(enrichedParent, config));

    // Optional: CDC resources if enabled
    const cdcEnabled = parent.data?.CDC_ENABLED === 'true';
    if (cdcEnabled && mongoReadiness.ready) {
      response.children.push(...renderKafkaTopics(enrichedParent, config));
      response.children.push(renderKafkaConnector(enrichedParent, config));
    }

    // Build status
    response.status = buildStatus(parent, {
      mongoReadiness,
      cdcEnabled,
      storageAccount: storageAccountLabel,
      children
    });

    res.send(response);
  } catch (error) {
    console.error('Error in compute composite sync:', error);
    res.send(500, { error: error.message });
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
 * Find app-credentials Secret from related resources
 */
function findAppCredentialsSecret(related, storageAccountLabel) {
  if (!related || !related['Secret.v1']) {
    return null;
  }
  
  const secrets = related['Secret.v1'];
  for (const [name, secret] of Object.entries(secrets)) {
    const accountLabel = secret.metadata?.labels?.['storage.nightscout.org/account'];
    const credentialType = secret.metadata?.labels?.['ns.mdn.io/credential-type'];
    
    if (accountLabel === storageAccountLabel && credentialType === 'application') {
      console.log(`Found app-credentials Secret: ${name} for account: ${storageAccountLabel}`);
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
 * Uses app-credentials Secret for MongoDB connection (not storage Secret)
 */
function enrichWithStorageInfo(parent, storageSecret, appCredentialsSecret, storageAccountLabel) {
  // Get storage type from storage Secret metadata
  const storageType = storageSecret.metadata?.annotations?.['ns.mdn.io/storage-type'] || 'dedicated';
  
  // Decode app credentials to get MONGO_HOST (for reference)
  const appCredentials = {};
  if (appCredentialsSecret.data) {
    Object.keys(appCredentialsSecret.data).forEach(key => {
      appCredentials[key] = Buffer.from(appCredentialsSecret.data[key], 'base64').toString('utf-8');
    });
  }
  
  return {
    ...parent,
    data: {
      ...parent.data,
      TENANT_ID: parent.metadata.name,
      // App credentials Secret will be projected into Nightscout containers
      APP_CREDENTIALS_SECRET: appCredentialsSecret.metadata.name,
      MONGO_HOST: appCredentials.MONGO_HOST || `${storageAccountLabel}-mongodb`,
      STORAGE_ACCOUNT: storageAccountLabel,
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

}

module.exports = createComputeCompositeSync;
