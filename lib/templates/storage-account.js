/**
 * Template for StorageAccount CRD
 * Generates a StorageAccount custom resource from provisioner API request
 */

function createStorageAccountTemplate(accountId, requestBody = {}) {
  const {
    mongodbVersion = '7.0',
    replicas = 3,
    tier = 'basic',
    storageSize = '10Gi',
    storageClass,
    resources = {},
    backup = {},
    migration = {}
  } = requestBody;

  const storageAccount = {
    apiVersion: 'nightscout.io/v1alpha1',
    kind: 'StorageAccount',
    metadata: {
      name: accountId,
      labels: {
        'app.kubernetes.io/managed-by': 'provisioner-api',
        'storage.nightscout.org/account': accountId,
        'nightscout.io/tier': tier
      },
      annotations: {
        'nightscout.io/created-at': new Date().toISOString()
      }
    },
    spec: {
      mongodbVersion,
      replicas,
      tier,
      storageSize,
      resources: {
        requests: resources.requests || {
          cpu: tier === 'premium' ? '500m' : '250m',
          memory: tier === 'premium' ? '512Mi' : '256Mi'
        },
        limits: resources.limits || {
          cpu: tier === 'premium' ? '2000m' : '1000m',
          memory: tier === 'premium' ? '2Gi' : '1Gi'
        }
      }
    }
  };

  // Optional fields
  if (storageClass) {
    storageAccount.spec.storageClass = storageClass;
  }

  if (backup && backup.enabled !== undefined) {
    storageAccount.spec.backup = {
      enabled: backup.enabled,
      schedule: backup.schedule || '0 2 * * *',
      retention: backup.retention || 7
    };
  }

  if (migration && migration.enabled !== undefined) {
    storageAccount.spec.migration = {
      enabled: migration.enabled,
      sourceStorageAccount: migration.sourceStorageAccount,
      sourceConnectionSecret: migration.sourceConnectionSecret
    };
  }

  return storageAccount;
}

module.exports = createStorageAccountTemplate;
