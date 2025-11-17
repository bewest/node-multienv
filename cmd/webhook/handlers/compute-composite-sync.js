/**
 * Compute Composite Controller
 * 
 * Manages Nightscout Deployment + Service from ComputeInstance CRD parent
 * 
 * Parent: ComputeInstance CRD (nightscout.io/v1alpha1)
 * Children:
 *   - Nightscout Deployment
 *   - Nightscout Service
 *   - PodDisruptionBudget (optional)
 *   - KafkaTopic (if spec.cdc.enabled)
 *   - KafkaConnector (if spec.cdc.enabled)
 * Related (not owned):
 *   - StorageAccount CRD (referenced via spec.storageAccountRef.name)
 *   - MongoDB StatefulSet (blast radius protection)
 * 
 * Spec fields:
 *   - spec.storageAccountRef.name: Name of StorageAccount CRD providing MongoDB
 *   - spec.nightscoutImage: Nightscout container image
 *   - spec.replicas: Number of Nightscout replicas (default: 2)
 *   - spec.cdc.enabled: Enable CDC with Kafka
 * 
 * Note: Migration is a storage-layer concern handled by storage composite.
 *       This controller never renders migration Jobs.
 */

const { renderNightscout, renderKafkaTopics, renderKafkaConnector } = require('./resources');

function createComputeCompositeSync(config) {
  return async function computeCompositeSync(req, res) {
  const { parent, children, related } = req.body;
  
  const tenantId = parent.metadata.name;
  const spec = parent.spec || {};
  const storageAccountName = spec.storageAccountRef?.name;
  const storageAccountLabel = parent.metadata.labels?.['storage.nightscout.org/account'];
  
  console.log('Compute composite sync for tenant:', tenantId, 'storage account:', storageAccountName);
  
  try {
    const response = {
      status: {},
      children: []
    };

    if (!storageAccountName) {
      console.warn(`Storage account reference missing in ComputeInstance spec`);
      response.status = {
        phase: 'Failed',
        observedGeneration: parent.metadata?.generation,
        conditions: [{
          type: 'Ready',
          status: 'False',
          reason: 'StorageAccountRefMissing',
          message: `spec.storageAccountRef.name is required`,
          // lastTransitionTime: new Date().toISOString()
        }]
      };
      res.send(response);
      return;
    }

    // Find StorageAccount CRD from related resources
    const storageAccount = findStorageAccount(related, storageAccountName);
    
    if (!storageAccount) {
      console.warn(`StorageAccount CRD not found: ${storageAccountName}`);
      response.status = {
        phase: 'Pending',
        observedGeneration: parent.metadata?.generation,
        conditions: [{
          type: 'Ready',
          status: 'False',
          reason: 'StorageAccountNotFound',
          message: `StorageAccount ${storageAccountName} not found`,
          // lastTransitionTime: new Date().toISOString()
        }]
      };
      res.send(response);
      return;
    }

    // Find app-credentials Secret from related resources (for Nightscout credentials)
    const appCredentialsSecret = findAppCredentialsSecret(related, storageAccountLabel);
    
    if (storageAccount.spec.storageType == 'dedicated' && !appCredentialsSecret) {

      response.status = {
        phase: 'Pending',
        observedGeneration: parent.metadata?.generation,
        conditions: [{
          type: 'Ready',
          status: 'False',
          reason: 'AppCredentialsNotFound',
          message: `App credentials Secret not found for account ${storageAccountLabel}. Ensure StorageAccount is ready.`,
          // lastTransitionTime: new Date().toISOString()
        }]
      };
      res.send(response);
      return;
    }

    // Check MongoDB readiness from related StatefulSet or StorageAccount status
    const mongoReadiness = checkMongoReadinessFromRelated(related, storageAccountLabel, storageAccount);
    
    // Enhance parent with storage information
    const enrichedParent = enrichWithStorageInfo(parent, storageAccount, appCredentialsSecret, storageAccountLabel);
    
    // Render Nightscout resources
    response.children.push(...renderNightscout(enrichedParent, config));

    // Optional: CDC resources if enabled
    const cdcConfig = spec.cdc || {};
    const cdcEnabled = cdcConfig.enabled === true;
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
 * Find StorageAccount CRD from related resources
 */
function findStorageAccount(related, storageAccountName) {
  if (!related || !related['StorageAccount.nightscout.io/v1alpha1']) {
    return null;
  }
  
  const storageAccounts = related['StorageAccount.nightscout.io/v1alpha1'];
  for (const [name, sa] of Object.entries(storageAccounts)) {
    if (name === storageAccountName) {
      console.log(`Found StorageAccount CRD: ${name}`);
      return sa;
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
 * Check MongoDB readiness from StorageAccount status or related StatefulSet
 */
function checkMongoReadinessFromRelated(related, storageAccountLabel, storageAccount) {
  // Check StorageAccount status first
  if (storageAccount?.status) {
    const phase = storageAccount.status.phase;
    const ready = phase === 'Ready';
    
    console.log(`  StorageAccount phase: ${phase}`);
    
    return {
      ready,
      condition: {
        type: 'MongoDBReady',
        status: ready ? 'True' : 'False',
        reason: ready ? 'StorageAccountReady' : `StorageAccountPhase${phase}`,
        message: ready 
          ? `StorageAccount is ready`
          : `Waiting for StorageAccount to become ready (current phase: ${phase})`,
        // lastTransitionTime: new Date().toISOString()
      }
    };
  }
  
  // Fallback: check StatefulSet readiness directly
  if (!related || !related['StatefulSet.apps/v1']) {
    return {
      ready: false,
      condition: {
        type: 'MongoDBReady',
        status: 'False',
        reason: 'StatefulSetNotFound',
        message: 'MongoDB StatefulSet not found in related resources',
        // lastTransitionTime: new Date().toISOString()
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
          // lastTransitionTime: new Date().toISOString()
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
      // lastTransitionTime: new Date().toISOString()
    }
  };
}

/**
 * Enrich parent ComputeInstance with storage information
 * Uses app-credentials Secret for MongoDB connection
 */
function enrichWithStorageInfo(parent, storageAccount, appCredentialsSecret, storageAccountLabel) {
  const spec = parent.spec || {};
  
  // Decode app credentials to get MONGO_HOST (for reference)
  const appCredentials = {};
  if (appCredentialsSecret && appCredentialsSecret.data) {
    Object.keys(appCredentialsSecret.data).forEach(key => {
      appCredentials[key] = Buffer.from(appCredentialsSecret.data[key], 'base64').toString('utf-8');
    });
  }
  
  return {
    ...parent,
    data: {
      TENANT_ID: parent.metadata.name,
      NS_IMAGE: spec.nightscoutImage || 'nightscout/cgm-remote-monitor:latest',
      NS_REPLICAS: String(spec.replicas || 1),
      // APP_CREDENTIALS_SECRET: appCredentialsSecret.metadata.name,
      MONGO_HOST: appCredentials.MONGO_HOST || `${storageAccountLabel}-mongo`,
      STORAGE_ACCOUNT: storageAccountLabel,
      CDC_ENABLED: spec.cdc?.enabled ? 'true' : 'false',
      CDC_COLLECTIONS: spec.cdc?.collections?.join(',') || 'entries,treatments'
    }
  };
}

/**
 * Build Kubernetes-idiomatic status with phase
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
    // lastTransitionTime: new Date().toISOString()
  });
  
  // Determine phase
  const phase = allReady ? 'Ready' : 'Pending';
  
  return {
    phase,
    observedGeneration: parent.metadata?.generation,
    conditions,
    /*
    storage: {
      account: storageAccount,
      mongoReady: mongoReadiness.ready
    }
    */
  };
}

}

module.exports = createComputeCompositeSync;
