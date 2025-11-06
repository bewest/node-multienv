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
    nsUtility: process.env.NS_UTILITY_IMAGE_PULL_POLICY || 'IfNotPresent',
    podHealthcheck: process.env.POD_HEALTHCHECK_IMAGE_PULL_POLICY || 'IfNotPresent',
    migrationJob: process.env.MIGRATION_JOB_IMAGE_PULL_POLICY || 'IfNotPresent',
  },

  // Container commands
  commands: {
    podHealthcheck: process.env.POD_HEALTHCHECK_COMMAND || 'tenant-pod-healthcheck',
    mongodb: parseArray(process.env.MONGODB_COMMAND, ['mongod', '--replSet', 'rs0', '--bind_ip_all']),
    initReplicaSet: parseArray(process.env.INIT_REPLICA_SET_COMMAND, ['init-replica-set.sh']),
    migration: parseArray(process.env.MIGRATION_COMMAND, ['migrate-tenant-storage']),
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
    defaultStorageClass: process.env.STORAGE_CLASS || 'do-block-storage',
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

  // CDC/Kafka configuration
  cdc: {
    kafkaCluster: process.env.KAFKA_CLUSTER || 'my-cluster',
    kafkaConnectCluster: process.env.KAFKA_CONNECT_CLUSTER || 'my-connect-cluster',
    topicPartitions: parseInt(process.env.KAFKA_TOPIC_PARTITIONS || '3', 10),
    topicReplicas: parseInt(process.env.KAFKA_TOPIC_REPLICAS || '3', 10),
  },

  // Migration configuration
  migration: {
    timeout: parseInt(process.env.MIGRATION_TIMEOUT || '3600', 10), // seconds
    backoffLimit: parseInt(process.env.MIGRATION_BACKOFF_LIMIT || '3', 10),
  },
};

module.exports = config;
