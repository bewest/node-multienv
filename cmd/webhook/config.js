/**
 * Centralized configuration for Gen 4 Metacontroller webhooks
 * Follows the pattern from k8s-deployment-controller.js
 * All configuration is loaded from environment variables with sensible defaults
 */

// Helper to parse comma-separated values into array
function parseArray(value, defaultValue) {
  if (!value) return defaultValue;
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

// Helper to parse boolean values
function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return value !== 'false' && value !== '0';
}

const WEBHOOK_MANAGED_BY = process.env.WEBHOOK_MANAGED_BY || 'metacontroller';
const WEBHOOK_NAMESPACE = process.env.WEBHOOK_NAMESPACE || 'hosted-tenants';

const config = {
  // Server settings
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    namespace: WEBHOOK_NAMESPACE,
    name: process.env.WEBHOOK_SERVER_NAME || 'metacontroller-webhook',
  },

  // Container images
  multienv: {
    // imagePullSecrets: parseArray(process.env.MULTIENV_IMAGE_PULLSECRETS) || [],
    imagePullSecrets: (parseArray(process.env.MULTIENV_IMAGE_PULLSECRETS) || [])
      .map(function (el, v) { return { name: el }; }),
  },
  images: {
    mongodb: process.env.MONGODB_IMAGE || 'mongo:6',
    nightscout: process.env.NIGHTSCOUT_IMAGE || 'nightscout/cgm-remote-monitor:latest',
    nsUtility: process.env.NS_UTILITY_IMAGE || 'ns-utility:latest',
    podHealthcheck: process.env.POD_HEALTHCHECK_IMAGE || 'pod-healthcheck:latest',
    migrationJob: process.env.MIGRATION_JOB_IMAGE || 'ns-utility:latest',
  },
  // Image pull policies
  imagePullPolicies: {
    mongodb: process.env.MONGODB_IMAGE_PULL_POLICY || 'IfNotPresent',
    nightscout: process.env.NIGHTSCOUT_IMAGE_PULL_POLICY || 'IfNotPresent',
    nsUtility: process.env.NS_UTILITY_IMAGE_PULL_POLICY || 'Always',
    podHealthcheck: process.env.POD_HEALTHCHECK_IMAGE_PULL_POLICY || 'IfNotPresent',
    migrationJob: process.env.MIGRATION_JOB_IMAGE_PULL_POLICY || 'Always',
  },

  // Container commands
  commands: {
    podHealthcheck: process.env.POD_HEALTHCHECK_COMMAND || 'tenant-pod-healthcheck',
    // mongodb: parseArray(process.env.MONGODB_COMMAND, ['mongod', '--auth', /* '--replSet', 'rs0', */ '--bind_ip_all']),
    initReplicaSet: parseArray(process.env.MULTIENV_COMMANDS_INIT_REPLICA_SET, ['/app/multienvctl/entrypoints/init-replica-set.sh']),
    migration: parseArray(process.env.MULTIENV_COMMANDS_MIGRATION, ['/app/multienvctl/entrypoints/migrate-database.sh']),
    createUser: parseArray(process.env.MULTIENV_COMMANDS_CREATEUSER, ['/app/multienvctl/entrypoints/create-mongodb-user.sh']),
    prepareKeyfile: parseArray(process.env.MULTIENV_COMMANDS_PREPARE_KEYFILE, ['/app/multienvctl/entrypoints/prepare-keyfile.sh']),
  },

  // Resource requests and limits per container type
  resources: {
    // MongoDB StatefulSet
    mongodb: {
      requests: {
        cpu: process.env.MONGODB_REQUESTS_CPU || '100m',
        memory: process.env.MONGODB_REQUESTS_MEMORY || '256Mi',
      },
      limits: {
        cpu: process.env.MONGODB_LIMITS_CPU || '1000m',
        memory: process.env.MONGODB_LIMITS_MEMORY || '1Gi',
      },
    },
    
    // Nightscout Deployment
    nightscout: {
      requests: {
        cpu: process.env.NIGHTSCOUT_REQUESTS_CPU || '50m',
        memory: process.env.NIGHTSCOUT_REQUESTS_MEMORY || '128Mi',
      },
      limits: {
        cpu: process.env.NIGHTSCOUT_LIMITS_CPU || '500m',
        memory: process.env.NIGHTSCOUT_LIMITS_MEMORY || '512Mi',
      },
    },
    
    // Pod healthcheck sidecar
    podHealthcheck: {
      requests: {
        cpu: process.env.POD_HEALTHCHECK_REQUESTS_CPU || '10m',
        memory: process.env.POD_HEALTHCHECK_REQUESTS_MEMORY || '32Mi',
      },
      limits: {
        cpu: process.env.POD_HEALTHCHECK_LIMITS_CPU || '50m',
        memory: process.env.POD_HEALTHCHECK_LIMITS_MEMORY || '64Mi',
      },
    },
    // Utility container
    utility: {
      requests: {
        cpu: process.env.POD_HEALTHCHECK_REQUESTS_CPU || '10m',
        memory: process.env.POD_HEALTHCHECK_REQUESTS_MEMORY || '32Mi',
      },
      limits: {
        cpu: process.env.POD_HEALTHCHECK_LIMITS_CPU || '50m',
        memory: process.env.POD_HEALTHCHECK_LIMITS_MEMORY || '64Mi',
      },
    },
    
    // Init container for MongoDB replica set
    initReplicaSet: {
      requests: {
        cpu: process.env.INIT_REPLICA_SET_REQUESTS_CPU || '10m',
        memory: process.env.INIT_REPLICA_SET_REQUESTS_MEMORY || '32Mi',
      },
      limits: {
        cpu: process.env.INIT_REPLICA_SET_LIMITS_CPU || '100m',
        memory: process.env.INIT_REPLICA_SET_LIMITS_MEMORY || '64Mi',
      },
    },
    
    // Migration job
    migrationJob: {
      requests: {
        cpu: process.env.MIGRATION_JOB_REQUESTS_CPU || '50m',
        memory: process.env.MIGRATION_JOB_REQUESTS_MEMORY || '128Mi',
      },
      limits: {
        cpu: process.env.MIGRATION_JOB_LIMITS_CPU || '500m',
        memory: process.env.MIGRATION_JOB_LIMITS_MEMORY || '512Mi',
      },
    },
  },

  // Storage configuration
  storage: {
    defaultStorageType: process.env.DEFAULT_STORAGE_TYPE || 'shared',
    defaultStorageClass: process.env.STORAGE_CLASS || 'do-block-storage-xfs',
    defaultMongoStorageGi: process.env.MONGO_STORAGE_GI || '2',
    defaultMongoReplicas: process.env.MONGO_REPLICAS || '1',
  },

  // Pod healthcheck configuration
  podHealthcheck: {
    enabled: parseBoolean(process.env.POD_HEALTHCHECK_ENABLED, true),
    port: parseInt(process.env.POD_HEALTHCHECK_PORT || '3000', 10),
  },

  // PVC backup configuration
  backup: {
    defaultPolicy: process.env.BACKUP_POLICY || 'snapshot',
    defaultSnapshotClass: process.env.BACKUP_SNAPSHOT_CLASS || 'csi-snapclass',
    defaultTtl: process.env.BACKUP_TTL || '30d',
  },

  // Default labels and annotations
  defaults: {
    // Labels applied to all resources
    labels: {
      'app.kubernetes.io/managed-by': WEBHOOK_MANAGED_BY,
      'app.kubernetes.io/part-of': 'nightscout-tenant',
    },
    
    // Annotations applied to all resources
    annotations: {
      'ns.mdn.io/managed-by': WEBHOOK_MANAGED_BY,
    },
    
    // Storage composite specific
    storage: {
      labels: {
        'app.kubernetes.io/component': 'database',
        'app.kubernetes.io/name': 'mongodb',
      },
    },
    
    // Compute composite specific
    compute: {
      labels: {
        'app.kubernetes.io/component': 'application',
        'app.kubernetes.io/name': 'nightscout',
      },
    },
  },
  jobs: {
    ttlSecondsAfterFinished: parseInt(process.env.MULTIENV_JOBS_TTL || '3600'),
    backoffLimit: parseInt(process.env.MULTIENV_JOBS_BACKOFFLIMIT || '3'),
    imagePullSecrets: (parseArray(process.env.MULTIENV_IMAGE_PULLSECRETS) || [])
      .map(function (el, v) { return { name: el }; }),


  },
  mongodb: {
    keyfile: {
      uid: process.env.MULTIENV_MONGODB_KEYFILE_UID || '999',
      gid: process.env.MULTIENV_MONGODB_KEYFILE_GID || '999',
      // TODO: sourcePath, destPath?
    }
  },

  // CDC/Kafka configuration
  cdc: {
    kafkaCluster: process.env.KAFKA_CLUSTER || 'my-cluster',
    kafkaConnectCluster: process.env.KAFKA_CONNECT_CLUSTER || 'my-connect-cluster',
    topicPartitions: parseInt(process.env.KAFKA_TOPIC_PARTITIONS || '3', 10),
    topicReplicas: parseInt(process.env.KAFKA_TOPIC_REPLICAS || '3', 10),
  },

  // Migration configuration
  migration: {
    default_migration_policy: process.env.DEFAULT_MIGRATION_POLICY || 'auto',
    auto_migrate_role: process.env.AUTO_MIGRATE_ROLE || 'config-as-deploy',
    timeout: parseInt(process.env.MIGRATION_TIMEOUT || '3600', 10), // seconds
    backoffLimit: parseInt(process.env.MIGRATION_BACKOFF_LIMIT || '3', 10),
  },

  // Archive configuration for ConfigMap backups
  archive: {
    namespace: process.env.ARCHIVE_NAMESPACE || 'archived-configs',
  },

  // Node affinity configuration for tenant Pods and Jobs
  // When enabled, constrains Pods to specific node pools for isolation/performance
  nodeAffinity: {
    enabled: !!process.env.TENANT_NODEPOOL_KEY && !!process.env.TENANT_NODEPOOL_DEFAULT,
    // Label key to match (provider-specific, e.g., cloud.google.com/gke-nodepool)
    key: process.env.TENANT_NODEPOOL_KEY || 'cloud.google.com/gke-nodepool',
    // Default node pool when no tier-specific or per-tenant override
    defaultPool: process.env.TENANT_NODEPOOL_DEFAULT || 'tenant-runners',
  },
};

module.exports = config;
