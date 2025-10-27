/**
 * Storage Composite Controller
 * 
 * Manages MongoDB StatefulSet + Service from Secret parent
 * 
 * Parent: Secret (labeled ns.mdn.io/composite=storage)
 * Children:
 *   - MongoDB StatefulSet
 *   - MongoDB Service (headless)
 * Related (not owned):
 *   - PersistentVolumeClaim (created by StatefulSet, protected from deletion)
 */

const { renderMongoDB } = require('./resources');

async function storageCompositeSync(req, res) {
  const { parent, children } = req.body;
  
  const storageAccount = parent.metadata.name;
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
              'storage.nightscout.org/account': parent.metadata.labels?.['storage.nightscout.org/account']
            }
          }
        }
      ]
    };

    // Extract configuration from Secret
    const config = extractStorageConfig(parent);
    
    // Render MongoDB resources (StatefulSet + Service)
    const mongoResources = renderMongoDB(config);
    response.children.push(...mongoResources);

    // Check MongoDB readiness
    const mongoReadiness = checkMongoReadiness(children, storageAccount);
    
    // Build status
    response.status = {
      observedGeneration: parent.metadata?.generation,
      conditions: [mongoReadiness.condition],
      mongodb: {
        host: `${storageAccount}-mongodb`,
        ready: mongoReadiness.ready,
        replicas: mongoReadiness.replicas
      }
    };

    res.json(response);
  } catch (error) {
    console.error('Error in storage composite sync:', error);
    res.status(500).json({ error: error.message });
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

module.exports = storageCompositeSync;
