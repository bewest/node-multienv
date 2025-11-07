/**
 * Template for ComputeInstance CRD
 * Generates a ComputeInstance custom resource from provisioner API request
 */

function createComputeInstanceTemplate(tenantId, storageAccountId, requestBody = {}) {
  const {
    nightscoutImage = 'nightscout/cgm-remote-monitor:latest',
    replicas = 2,
    tier = 'basic',
    resources = {},
    cdc = {},
    healthcheck = {},
    env = []
  } = requestBody;

  const computeInstance = {
    apiVersion: 'nightscout.io/v1alpha1',
    kind: 'ComputeInstance',
    metadata: {
      name: tenantId,
      labels: {
        'app.kubernetes.io/managed-by': 'provisioner-api',
        'storage.nightscout.org/account': storageAccountId,
        'nightscout.io/tenant': tenantId,
        'nightscout.io/tier': tier
      },
      annotations: {
        'nightscout.io/created-at': new Date().toISOString()
      }
    },
    spec: {
      storageAccountRef: {
        name: storageAccountId
      },
      selector: {
        matchLabels: {
          tenant: tenantId,
        }
      },
      nightscoutImage,
      replicas,
      tier,
      resources: {
        requests: resources.requests || {
          cpu: tier === 'premium' ? '200m' : '100m',
          memory: tier === 'premium' ? '256Mi' : '128Mi'
        },
        limits: resources.limits || {
          cpu: tier === 'premium' ? '1000m' : '500m',
          memory: tier === 'premium' ? '1Gi' : '512Mi'
        }
      }
    }
  };

  // Optional environment variables
  if (env && env.length > 0) {
    computeInstance.spec.env = env;
  }

  // Optional CDC configuration
  if (cdc && cdc.enabled !== undefined) {
    computeInstance.spec.cdc = {
      enabled: cdc.enabled,
      kafkaCluster: cdc.kafkaCluster || 'main-kafka',
      kafkaConnectCluster: cdc.kafkaConnectCluster || 'connect-cluster'
    };
  }

  // Optional healthcheck configuration
  if (healthcheck && healthcheck.enabled !== undefined) {
    computeInstance.spec.healthcheck = {
      enabled: healthcheck.enabled,
      image: healthcheck.image
    };
  }

  return computeInstance;
}

module.exports = createComputeInstanceTemplate;
