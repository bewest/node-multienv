/**
 * Template for StorageAccount CRD
 * Generates a StorageAccount custom resource from provisioner API request
 */

function createStorageAccountTemplate(accountId, cfg, requestBody = {}) {
  const {
    mongodbVersion = '7.0',
    replicas = 1,
    tier = 'basic',
    storageSize = '2Gi',
    storageClass,
    sharedConnection,
    resources = {},
    backup = {},
    migration = {}
  } = requestBody;

  var storageType = requestBody.storageType || cfg.default.provisioner.storageType;
  const storageAccount = {
    apiVersion: 'nightscout.io/v1alpha1',
    kind: 'StorageAccount',
    metadata: {
      name: accountId,
      labels: {
        'app.kubernetes.io/managed-by': 'multienv-provisioner-api',
        'storage.nightscout.org/account': accountId,
        'nightscout.io/tier': tier
      },
      annotations: {
        'nightscout.io/created-at': new Date().toISOString()
      }
    },
    spec: {
      selector: {
        matchLabels: {
          'storage.nightscout.org/account': accountId,
          'ns.mdn.io/composite': 'storage'
        }
      },
      mongodbVersion,
      replicas,
      tier,
      storageSize,
      sharedConnection,
      storageType,
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
