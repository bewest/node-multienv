/**
 * Compute Composite Controller
 * 
 * Manages Nightscout Deployment + Service + Gen3 ConfigMap adoption from ComputeInstance CRD parent
 * 
 * Parent: ComputeInstance CRD (nightscout.io/v1alpha1)
 * Children:
 *   - Nightscout Deployment
 *   - Nightscout Service
 *   - Gen3 ConfigMap (adopted during userdata migration)
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
 * Migration responsibilities:
 *   - Adopt Gen3 ConfigMap as child when storage migration completes
 *   - Archive data.mongo URI to annotation before stripping from ConfigMap
 *   - Guard with nightscout.io/userdata-migration-completed annotation
 */

const { renderNightscout, renderKafkaTopics, renderKafkaConnector } = require('./resources');

function createComputeCompositeSync(config) {
  
  /**
   * Stage 1: Initialize context from webhook request
   */
  function initializeContext(req, res, next) {
    const { parent, children, related } = req.body;
    
    req.parent = parent;
    req.children = children;
    req.related = related;
    req.tenantId = parent.metadata.name;
    req.namespace = parent.metadata.namespace;
    req.spec = parent.spec || {};
    req.storageAccountName = req.spec.storageAccountRef?.name;
    req.storageAccountLabel = parent.metadata.labels?.['storage.nightscout.org/account'];
    
    // Initialize response
    res.childrenToRender = [];
    res.status = {};
    res.annotations = {};
    
    console.log('Compute composite sync for tenant:', req.tenantId, 'storage account:', req.storageAccountName);
    
    return next();
  }
  
  /**
   * Stage 2: Validate storage account reference
   */
  function validateStorageAccountRef(req, res, next) {
    if (!req.storageAccountName) {
      console.warn(`Storage account reference missing in ComputeInstance spec`);
      res.status = {
        phase: 'Failed',
        observedGeneration: req.parent.metadata?.generation,
        conditions: [{
          type: 'Ready',
          status: 'False',
          reason: 'StorageAccountRefMissing',
          message: `spec.storageAccountRef.name is required`
        }]
      };
      res.send({ status: res.status, children: [] });
      return;
    }
    return next();
  }
  
  /**
   * Stage 3: Discover StorageAccount CRD and app-credentials
   */
  function discoverStorageResources(req, res, next) {
    // Find StorageAccount CRD
    req.storageAccount = findStorageAccount(req.related, req.storageAccountName);
    
    if (!req.storageAccount) {
      console.warn(`StorageAccount CRD not found: ${req.storageAccountName}`);
      res.status = {
        phase: 'Pending',
        observedGeneration: req.parent.metadata?.generation,
        conditions: [{
          type: 'Ready',
          status: 'False',
          reason: 'StorageAccountNotFound',
          message: `StorageAccount ${req.storageAccountName} not found`
        }]
      };
      res.send({ status: res.status, children: [] });
      return;
    }
    
    req.storageType = req.storageAccount.spec?.storageType;
    
    // Find app-credentials Secret for dedicated storage
    req.appCredentialsSecret = findAppCredentialsSecret(req.related, req.storageAccountLabel);
    
    if (req.storageType == 'dedicated' && !req.appCredentialsSecret) {
      res.status = {
        phase: 'Pending',
        observedGeneration: req.parent.metadata?.generation,
        conditions: [{
          type: 'Ready',
          status: 'False',
          reason: 'AppCredentialsNotFound',
          message: `App credentials Secret not found for account ${req.storageAccountLabel}. Ensure StorageAccount is ready.`
        }]
      };
      res.send({ status: res.status, children: [] });
      return;
    }
    
    return next();
  }
  
  /**
   * Stage 4: Check MongoDB readiness
   */
  function checkMongoReadiness(req, res, next) {
    req.mongoReadiness = checkMongoReadinessFromRelated(
      req.related,
      req.storageAccountLabel,
      req.storageAccount
    );
    return next();
  }
  
  /**
   * Stage 5: Plan ConfigMap adoption (Gen3 → Gen4 migration)
   * Discovers Gen3 ConfigMap from related resources and prepares it for adoption
   */
  function planConfigMapAdoption(req, res, next) {
    // Look for Gen3 ConfigMap in related resources
    const configMaps = req.related['ConfigMap.v1'] || {};
    const gen3ConfigMapName = req.tenantId;
    const gen3ConfigMap = configMaps[gen3ConfigMapName];
    
    if (!gen3ConfigMap) {
      console.log(`  No Gen3 ConfigMap found for tenant ${req.tenantId} - skipping adoption`);
      return next();
    }
    
    console.log(`  Found Gen3 ConfigMap: ${gen3ConfigMapName}`);
    
    // Store for userdata migration stage
    req.gen3ConfigMap = gen3ConfigMap;
    
    return next();
  }
  
  /**
   * Stage 6: Plan userdata migration (archive data.mongo and strip from ConfigMap)
   * Only executes when storage migration completes
   */
  function planUserDataMigration(req, res, next) {
    if (!req.gen3ConfigMap) {
      return next();
    }
    
    // Check if userdata migration already completed
    const userDataMigrationCompleted = req.gen3ConfigMap.metadata?.annotations?.['nightscout.io/userdata-migration-completed'];
    if (userDataMigrationCompleted) {
      console.log(`  Userdata migration already completed at ${userDataMigrationCompleted} - rendering clean ConfigMap`);
      
      // Render clean ConfigMap without data.mongo
      const cleanConfigMap = renderCleanConfigMap(req.gen3ConfigMap, req.tenantId, req.namespace);
      res.childrenToRender.push(cleanConfigMap);
      return next();
    }
    
    // Check if storage migration completed (annotation on ComputeInstance)
    const storageMigrationCompleted = req.parent.metadata?.annotations?.['nightscout.io/migration-completed'];
    
    if (!storageMigrationCompleted) {
      console.log(`  Storage migration not yet completed - preserving Gen3 ConfigMap as-is`);
      
      // Preserve ConfigMap without modifications until storage migration completes
      const preservedConfigMap = renderPreservedConfigMap(req.gen3ConfigMap, req.tenantId, req.namespace);
      res.childrenToRender.push(preservedConfigMap);
      return next();
    }
    
    console.log(`  Storage migration completed at ${storageMigrationCompleted} - executing userdata migration`);
    
    // Extract data.mongo URI before stripping
    const mongoUri = extractMongoUri(req.gen3ConfigMap);
    
    if (mongoUri) {
      console.log(`  Archiving data.mongo URI to annotation (length: ${mongoUri.length})`);
      
      // Archive mongo URI to ConfigMap annotation
      const migratedConfigMap = renderMigratedConfigMap(
        req.gen3ConfigMap,
        req.tenantId,
        req.namespace,
        mongoUri
      );
      
      res.childrenToRender.push(migratedConfigMap);
    } else {
      console.log(`  WARNING: No data.mongo field found in Gen3 ConfigMap - marking migration complete anyway`);
      
      // No mongo URI to archive, just mark complete
      const cleanConfigMap = renderCleanConfigMap(req.gen3ConfigMap, req.tenantId, req.namespace);
      res.childrenToRender.push(cleanConfigMap);
    }
    
    return next();
  }
  
  /**
   * Stage 7: Render Nightscout resources (Deployment, Service, etc.)
   */
  function planNightscoutResources(req, res, next) {
    // Enhance parent with storage information
    const enrichedParent = enrichWithStorageInfo(
      req.parent,
      req.storageAccount,
      req.appCredentialsSecret,
      req.storageAccountLabel
    );
    
    // Render Nightscout Deployment and Service
    res.childrenToRender.push(...renderNightscout(enrichedParent, config));
    
    return next();
  }
  
  /**
   * Stage 8: Render CDC resources (KafkaTopic, KafkaConnector)
   */
  function planCDCResources(req, res, next) {
    const cdcConfig = req.spec.cdc || {};
    const cdcEnabled = cdcConfig.enabled === true;
    
    if (cdcEnabled && req.mongoReadiness.ready) {
      console.log(`  CDC enabled - rendering Kafka resources`);
      
      const enrichedParent = enrichWithStorageInfo(
        req.parent,
        req.storageAccount,
        req.appCredentialsSecret,
        req.storageAccountLabel
      );
      
      res.childrenToRender.push(...renderKafkaTopics(enrichedParent, config));
      res.childrenToRender.push(renderKafkaConnector(enrichedParent, config));
    }
    
    return next();
  }
  
  /**
   * Stage 9: Build status
   */
  function buildStatusConditions(req, res, next) {
    res.status = buildStatus(req.parent, {
      mongoReadiness: req.mongoReadiness,
      cdcEnabled: req.spec.cdc?.enabled === true,
      storageAccount: req.storageAccountLabel,
      children: req.children
    });
    
    return next();
  }
  
  /**
   * Stage 10: Assemble response
   */
  function assembleResponse(req, res, next) {
    const response = {
      status: res.status,
      children: res.childrenToRender
    };
    
    res.send(response);
  }
  
  // Define pipeline stages
  const pipeline = [
    initializeContext,
    validateStorageAccountRef,
    discoverStorageResources,
    checkMongoReadiness,
    planConfigMapAdoption,
    planUserDataMigration,
    planNightscoutResources,
    planCDCResources,
    buildStatusConditions,
    assembleResponse
  ];
  
  // Return handler that executes pipeline
  return async function computeCompositeSync(req, res) {
    try {
      // Execute pipeline
      let stageIndex = 0;
      
      const next = () => {
        stageIndex++;
        if (stageIndex < pipeline.length) {
          pipeline[stageIndex](req, res, next);
        }
      };
      
      pipeline[0](req, res, next);
    } catch (error) {
      console.error('Error in compute composite sync:', error);
      res.send(500, { error: error.message });
    }
  };
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

// ============================================================================
// ConfigMap Migration Helpers
// ============================================================================

/**
 * Extract data.mongo URI from Gen3 ConfigMap
 * Gen3 ConfigMaps store MongoDB URI in data.mongo field
 */
function extractMongoUri(configMap) {
  if (!configMap || !configMap.data) {
    return null;
  }
  
  return configMap.data.mongo || null;
}

/**
 * Render preserved ConfigMap (no modifications, just clean manifest)
 * Used before storage migration completes - preserves ConfigMap as-is
 */
function renderPreservedConfigMap(existingConfigMap, tenantId, namespace) {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: tenantId,
      namespace: namespace,
      labels: {
        ...(existingConfigMap.metadata?.labels || {}),
        'app.kubernetes.io/managed-by': 'metacontroller'
      },
      annotations: {
        ...(existingConfigMap.metadata?.annotations || {})
      }
    },
    data: existingConfigMap.data || {}
  };
}

/**
 * Render migrated ConfigMap (archives data.mongo to annotation and strips from data)
 * Executes userdata migration when storage migration completes
 */
function renderMigratedConfigMap(existingConfigMap, tenantId, namespace, mongoUri) {
  const data = { ...(existingConfigMap.data || {}) };
  
  // Strip data.mongo from ConfigMap data section
  delete data.mongo;
  
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: tenantId,
      namespace: namespace,
      labels: {
        ...(existingConfigMap.metadata?.labels || {}),
        'app.kubernetes.io/managed-by': 'metacontroller'
      },
      annotations: {
        ...(existingConfigMap.metadata?.annotations || {}),
        'nightscout.io/gen3-mongo-uri': mongoUri,
        'nightscout.io/userdata-migration-completed': new Date().toISOString()
      }
    },
    data: data
  };
}

/**
 * Render clean ConfigMap (no data.mongo, migration already completed)
 * Used when userdata migration already completed in previous reconciliation
 */
function renderCleanConfigMap(existingConfigMap, tenantId, namespace) {
  const data = { ...(existingConfigMap.data || {}) };
  
  // Ensure data.mongo is stripped (should already be gone)
  delete data.mongo;
  
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: tenantId,
      namespace: namespace,
      labels: {
        ...(existingConfigMap.metadata?.labels || {}),
        'app.kubernetes.io/managed-by': 'metacontroller'
      },
      annotations: {
        ...(existingConfigMap.metadata?.annotations || {})
      }
    },
    data: data
  };
}

module.exports = createComputeCompositeSync;
