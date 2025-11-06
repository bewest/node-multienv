/**
 * 
 * 
 * Gen 4 Two-Secret Architecture:
 * ===============================
 * Storage Composite creates TWO Secrets:
 * 1. Storage Secret (parent, ns.mdn.io/composite=storage):
 *    - Contains root/admin MongoDB credentials
 *    - Used only by webhook, init Jobs, and migration Jobs
 *    - Never projected into Nightscout containers
 * 
 * 2. App-Credentials Secret (<storage-account>-app-credentials):
 *    - Contains ONLY credentials needed by Nightscout app
 *    - Projected into Nightscout containers via envFrom
 *    - Includes: MONGODB_URI, MONGO_DATABASE, MONGO_HOST, MONGO_PORT, MONGO_USERNAME, MONGO_PASSWORD
 * 
 * Security Benefits:
 * - Principle of least privilege: Apps never see root credentials
 * - Separation of concerns: Storage orchestration vs application access
 * - RBAC flexibility: Different permissions for different Secret types
 * 
 * This renderMongoDB function creates a legacy Secret that is NOT used in Gen 4.
 * It remains for backward compatibility during migration from Gen 3.
 */
function renderMongoDB(parent, databaseName, config) {
  // Storage account ID from parent labels/annotation?
  const storageAccount = parent.metadata.labels?.['storage.nightscout.org/account'];
  const namespace = parent.metadata.namespace;
  
  // Storage configuration (tenant-specific overrides config defaults)
  const storageGi = parent.data.MONGO_STORAGE_GI || config.storage.defaultMongoStorageGi;
  const storageClass = parent.data.MONGO_SC || config.storage.defaultStorageClass;
  
  // MongoDB configuration
  const mongoImage = config.images.mongodb;
  const mongoImagePullPolicy = config.imagePullPolicies.mongodb;
  const mongoReplicas = parseInt(config.storage.defaultMongoReplicas);
  
  // Extract version from image
  const mongoVersion = mongoImage.split(':')[1] || 'latest';
  
  // Resource limits
  const mongoCpuRequest = parent.data.MONGO_CPU_REQUEST || config.resources.mongodb.requests.cpu;
  const mongoCpuLimit = parent.data.MONGO_CPU_LIMIT || config.resources.mongodb.limits.cpu;
  const mongoMemRequest = parent.data.MONGO_MEM_REQUEST || config.resources.mongodb.requests.memory;
  const mongoMemLimit = parent.data.MONGO_MEM_LIMIT || config.resources.mongodb.limits.memory;
  
  // PDB configuration
  const mongoPdbMinAvailable = parseInt(parent.data.MONGO_PDB_MIN_AVAILABLE || '1');
  
  // Resource names using databaseName for DNS-valid service naming
  const secretName = `${storageAccount}-mongo-auth`;
  const serviceName = `mongo-${databaseName}`;
  const statefulSetName = `${storageAccount}-mongo`;
  const pdbName = `${storageAccount}-mongo-pdb`;
  const pod0Hostname = `${storageAccount}-mongo-0.mongo-${databaseName}`;

  const resources = [];


  // Helper function for standard labels
  const standardLabels = (component, additionalLabels = {}) => ({
    'app.kubernetes.io/name': 'mongodb',
    'app.kubernetes.io/component': component,
    'app.kubernetes.io/part-of': 'nightscout-tenant',
    // 'app.kubernetes.io/instance': tenantId,
    'app.kubernetes.io/version': mongoVersion,
    'app.kubernetes.io/managed-by': 'metacontroller',
    'storage.nightscout.org/account': storageAccount,
    ...additionalLabels
  });

  const secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: secretName,
      namespace: namespace,
      labels: standardLabels('database'),
      annotations: {
        'ns.mdn.io/created-at': new Date().toISOString(),
        'ns.mdn.io/credential-type': 'mongodb-auth'
      }
    },
    type: 'Opaque',
    stringData: {
      // username should be generated randomly
      username: 'nsuser',
      password: generatePassword(),
      // database name should be generated randomly
      database: 'ns'
    }
  };

  const headlessService = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: serviceName,
      namespace: namespace,
      labels: standardLabels('database')
    },
    spec: {
      clusterIP: 'None',
      selector: {
        'app.kubernetes.io/name': 'mongodb',
        'app.kubernetes.io/instance': storageAccount
      },
      ports: [
        {
          name: 'mongodb',
          port: 27017,
          targetPort: 27017
        }
      ]
    }
  };

  const statefulSet = {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: {
      name: statefulSetName,
      namespace: namespace,
      labels: {
        ...standardLabels('database'),
        'ns.mdn.io/tier': parent.metadata.labels?.['ns.mdn.io/tier'] || 'basic'
      },
      annotations: {
        'ns.mdn.io/created-at': new Date().toISOString(),
        'ns.mdn.io/replicas': String(mongoReplicas),
        'ns.mdn.io/storage-gi': storageGi
      }
    },
    spec: {
      serviceName: serviceName,
      replicas: mongoReplicas,
      selector: {
        matchLabels: {
          'app.kubernetes.io/name': 'mongodb',
          'storage.nightscout.org/account': storageAccount,
          // 'app.kubernetes.io/instance': tenantId
        }
      },
      template: {
        metadata: {
          labels: standardLabels('database')
        },
        spec: {
          imagePullSecrets: parent.data.IMAGE_PULL_SECRET 
            ? [{ name: parent.data.IMAGE_PULL_SECRET }] 
            : undefined,
          initContainers: [
            {
              name: 'init-replica-set',
              image: parent.data.NS_UTILITY_IMAGE || config.images.nsUtility,
              imagePullPolicy: parent.data.NS_UTILITY_IMAGE_PULL_POLICY || config.imagePullPolicies.nsUtility,
              command: parent.data.INIT_REPLICA_SET_COMMAND ? parent.data.INIT_REPLICA_SET_COMMAND.split(',') : config.commands.initReplicaSet,
              env: [
                {
                  name: 'MONGO_HOST',
                  value: pod0Hostname
                },
                {
                  name: 'MONGO_PORT',
                  value: '27017'
                },
                {
                  name: 'MONGO_RS_NAME',
                  value: 'rs0'
                }
              ]
            }
          ],
          containers: [
            {
              name: 'mongodb',
              image: mongoImage,
              imagePullPolicy: mongoImagePullPolicy,
              command: parent.data.MONGODB_COMMAND ? parent.data.MONGODB_COMMAND.split(',') : config.commands.mongodb,
              ports: [
                {
                  containerPort: 27017,
                  name: 'mongodb'
                }
              ],
              env: [
                {
                  name: 'MONGO_INITDB_ROOT_USERNAME',
                  valueFrom: {
                    secretKeyRef: {
                      name: secretName,
                      key: 'username'
                    }
                  }
                },
                {
                  name: 'MONGO_INITDB_ROOT_PASSWORD',
                  valueFrom: {
                    secretKeyRef: {
                      name: secretName,
                      key: 'password'
                    }
                  }
                },
                {
                  name: 'MONGO_INITDB_DATABASE',
                  valueFrom: {
                    secretKeyRef: {
                      name: secretName,
                      key: 'database'
                    }
                  }
                }
              ],
              volumeMounts: [
                {
                  name: 'data',
                  mountPath: '/data/db'
                }
              ],
              resources: {
                requests: {
                  cpu: mongoCpuRequest,
                  memory: mongoMemRequest
                },
                limits: {
                  cpu: mongoCpuLimit,
                  memory: mongoMemLimit
                }
              }
            }
          ]
        }
      },
      persistentVolumeClaimRetentionPolicy: {
        whenDeleted: 'Retain',
        whenScaled: 'Retain',
      },
      volumeClaimTemplates: [
        {
          metadata: {
            name: 'data',
            labels: {
              ...standardLabels('database'),
              'ns.mdn.io/tier': parent.metadata.labels?.['ns.mdn.io/tier'] || 'basic',
              'ns.mdn.io/data-class': 'production',
              'ns.mdn.io/region': parent.data.REGION || 'default'
            },
            annotations: {
              'ns.mdn.io/created-at': new Date().toISOString(),
              'ns.mdn.io/parent-generation': String(parent.metadata.generation || 1),
              // 'ns.mdn.io/tenant-email': parent.data.TENANT_EMAIL || '',
              'ns.mdn.io/backup-schedule': parent.data.BACKUP_SCHEDULE || 'daily',
              'ns.mdn.io/storage-class': storageClass,
              'ns.mdn.io/size-gi': storageGi
            }
          },
          spec: {
            accessModes: ['ReadWriteOnce'],
            storageClassName: storageClass,
            resources: {
              requests: {
                storage: `${storageGi}Gi`
              }
            }
          }
        }
      ]
    }
  };

  const pdb = {
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: {
      name: pdbName,
      namespace: namespace,
      labels: standardLabels('database')
    },
    spec: {
      minAvailable: mongoPdbMinAvailable,
      selector: {
        matchLabels: {
          'app.kubernetes.io/name': 'mongodb',
          // 'app.kubernetes.io/instance': tenantId
          'storage.nightscout.org/account': storageAccount,
        }
      }
    }
  };

  resources.push(secret, headlessService, statefulSet, pdb);
  return resources;
}

function renderNightscout(parent, config) {
  const tenantId = parent.data.TENANT_ID;
  const storageAccount = parent.metadata.labels?.['storage.nightscout.org/account'];
  const namespace = parent.metadata.namespace;
  
  // Nightscout configuration (tenant-specific overrides config defaults)
  const nsImage = parent.data.NS_IMAGE || config.images.nightscout;
  const nsImagePullPolicy = parent.data.NS_IMAGE_PULL_POLICY || config.imagePullPolicies.nightscout;
  const nsReplicas = parseInt(parent.data.NS_REPLICAS || '1');
  
  // Resource limits (tenant-specific overrides config defaults)
  const nsCpuRequest = parent.data.NS_CPU_REQUEST || config.resources.nightscout.requests.cpu;
  const nsCpuLimit = parent.data.NS_CPU_LIMIT || config.resources.nightscout.limits.cpu;
  const nsMemRequest = parent.data.NS_MEM_REQUEST || config.resources.nightscout.requests.memory;
  const nsMemLimit = parent.data.NS_MEM_LIMIT || config.resources.nightscout.limits.memory;
  
  // PDB configuration
  const nsPdbMinAvailable = parseInt(parent.data.NS_PDB_MIN_AVAILABLE || '1');
  
  // Health check sidecar configuration (tenant-specific overrides config defaults)
  const healthCheckEnabled = parent.data.POD_HEALTHCHECK_ENABLED !== undefined 
    ? parent.data.POD_HEALTHCHECK_ENABLED !== 'false'
    : config.podHealthcheck.enabled;
  const healthCheckImage = parent.data.POD_HEALTHCHECK_IMAGE || config.images.podHealthcheck;
  const healthCheckCommand = parent.data.POD_HEALTHCHECK_COMMAND || config.commands.podHealthcheck;
  const healthCheckImagePullPolicy = parent.data.POD_HEALTHCHECK_IMAGE_PULL_POLICY || config.imagePullPolicies.podHealthcheck;
  const healthCheckPort = parseInt(parent.data.POD_HEALTHCHECK_PORT || String(config.podHealthcheck.port));
  const healthCheckCpuRequest = parent.data.POD_HEALTHCHECK_CPU_REQUEST || config.resources.podHealthcheck.requests.cpu;
  const healthCheckCpuLimit = parent.data.POD_HEALTHCHECK_CPU_LIMIT || config.resources.podHealthcheck.limits.cpu;
  const healthCheckMemRequest = parent.data.POD_HEALTHCHECK_MEM_REQUEST || config.resources.podHealthcheck.requests.memory;
  const healthCheckMemLimit = parent.data.POD_HEALTHCHECK_MEM_LIMIT || config.resources.podHealthcheck.limits.memory;
  
  // Extract version from image
  const nsVersion = nsImage.split(':')[1] || 'latest';
  
  // Resource names with tenant prefix
  const deploymentName = `${tenantId}-nightscout`;
  const serviceName = `${tenantId}-nightscout`;
  const pdbName = `${tenantId}-nightscout-pdb`;
  // Resourcces with storageAccount prefix
  const secretName = `${storageAccount}-mongo-auth`;
  const mongoHost = `${storageAccount}-mongo-0.${storageAccount}-mongo`;

  const resources = [];

  // Helper function for standard labels
  const standardLabels = (component, additionalLabels = {}) => ({
    'app.kubernetes.io/name': 'nightscout',
    'app.kubernetes.io/component': component,
    'app.kubernetes.io/part-of': 'nightscout-tenant',
    'app.kubernetes.io/instance': tenantId,
    'app.kubernetes.io/version': nsVersion,
    'app.kubernetes.io/managed-by': 'metacontroller',
    'ns.mdn.io/tenant': tenantId,
    'storage.nightscout.org/account': storageAccount,
    ...additionalLabels
  });

  const deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: deploymentName,
      namespace: namespace,
      labels: standardLabels('application')
    },
    spec: {
      replicas: nsReplicas,
      selector: {
        matchLabels: {
          'app.kubernetes.io/name': 'nightscout',
          'app.kubernetes.io/instance': tenantId
        }
      },
      template: {
        metadata: {
          labels: standardLabels('application')
        },
        spec: {
          imagePullSecrets: parent.data.IMAGE_PULL_SECRET 
            ? [{ name: parent.data.IMAGE_PULL_SECRET }] 
            : undefined,
          containers: buildContainers()
        }
      }
    }
  };

  function buildContainers() {
    const containers = [
      {
        name: 'nightscout',
        image: nsImage,
        imagePullPolicy: nsImagePullPolicy,
        ports: [
          {
            containerPort: 1337,
            name: 'http'
          }
        ],
        // Gen 4 Two-Secret Architecture: Use envFrom to project app-credentials Secret
        // The app-credentials Secret contains MONGODB_URI and all MongoDB connection details
        // This follows the principle of least privilege - Nightscout never sees root credentials
        envFrom: (parent.data.APP_CREDENTIALS_SECRET ? [
          {
            secretRef: {
              name: parent.data.APP_CREDENTIALS_SECRET
            }
          }
        ] : []).concat([
          {
            secretRef: {
              name: `${tenantId}-secrets`
            , optional: true
            },
          },
          {
            configMapRef: {
              name: tenantId
            , optional: true
            }
          }
        ]),
        // Legacy Gen 3 fallback: Individual env vars with secretKeyRef
        // Kept for backward compatibility during migration
        env: !parent.data.APP_CREDENTIALS_SECRET ? [ ] : [
          {
            name: 'MONGO_CONNECTION',
            value: `mongodb://$(MONGO_USER):$(MONGO_PASS)@${mongoHost}:27017/$(MONGO_DB)?replicaSet=rs0`
          },
          {
            name: 'MONGO_USER',
            valueFrom: {
              secretKeyRef: {
                name: secretName,
                key: 'username'
              }
            }
          },
          {
            name: 'MONGO_PASS',
            valueFrom: {
              secretKeyRef: {
                name: secretName,
                key: 'password'
              }
            }
          },
          {
            name: 'MONGO_DB',
            valueFrom: {
              secretKeyRef: {
                name: secretName,
                key: 'database'
              }
            }
          }
        ],
        resources: {
          requests: {
            cpu: nsCpuRequest,
            memory: nsMemRequest
          },
          limits: {
            cpu: nsCpuLimit,
            memory: nsMemLimit
          }
        }
      }
    ];

    if (healthCheckEnabled) {
      containers.push({
        name: 'pod-healthcheck',
        image: healthCheckImage,
        args: [healthCheckCommand],
        imagePullPolicy: healthCheckImagePullPolicy,
        ports: [
          {
            containerPort: healthCheckPort,
            name: 'healthcheck'
          }
        ],
        env: [
          {
            name: 'PORT',
            value: String(healthCheckPort)
          },
          {
            name: 'POD_UID',
            valueFrom: {
              fieldRef: {
                fieldPath: 'metadata.uid'
              }
            }
          },
          {
            name: 'POD_IP',
            valueFrom: {
              fieldRef: {
                fieldPath: 'status.podIP'
              }
            }
          },
          {
            name: 'POD_NAME',
            valueFrom: {
              fieldRef: {
                fieldPath: 'metadata.name'
              }
            }
          },
          {
            name: 'POD_NAMESPACE',
            valueFrom: {
              fieldRef: {
                fieldPath: 'metadata.namespace'
              }
            }
          },
          {
            name: 'NODE_NAME',
            valueFrom: {
              fieldRef: {
                fieldPath: 'spec.nodeName'
              }
            }
          }
        ],
        resources: {
          requests: {
            cpu: healthCheckCpuRequest,
            memory: healthCheckMemRequest
          },
          limits: {
            cpu: healthCheckCpuLimit,
            memory: healthCheckMemLimit
          }
        }
      });
    }

    return containers;
  }

  const pdb = {
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: {
      name: pdbName,
      namespace: namespace,
      labels: standardLabels('application')
    },
    spec: {
      minAvailable: nsPdbMinAvailable,
      selector: {
        matchLabels: {
          'app.kubernetes.io/name': 'nightscout',
          'app.kubernetes.io/instance': tenantId
        }
      }
    }
  };

  resources.push(deployment, pdb);
  return resources;
}

function renderKafkaTopics(parent, config) {
  const tenantId = parent.data.TENANT_ID;
  const namespace = parent.metadata.namespace;
  const collections = (parent.data.CDC_COLLECTIONS || 'entries,treatments').split(',');
  
  // Kafka configuration (tenant-specific overrides config defaults)
  const kafkaClusterName = parent.data.KAFKA_CLUSTER_NAME || config.cdc.kafkaCluster;
  const partitionsEntries = parseInt(parent.data.CDC_PARTITIONS_ENTRIES || String(config.cdc.topicPartitions));
  const partitionsTreatments = parseInt(parent.data.CDC_PARTITIONS_TREATMENTS || '1');
  const retentionMs = parent.data.CDC_RETENTION_MS || '604800000';
  const topicReplicas = parseInt(parent.data.KAFKA_TOPIC_REPLICAS || String(config.cdc.topicReplicas));
  const cdcVersion = parent.data.CDC_VERSION || 'v1beta2';

  const topics = [];

  // Helper function for standard labels
  const standardLabels = (additionalLabels = {}) => ({
    'app.kubernetes.io/name': 'kafka-topic',
    'app.kubernetes.io/component': 'messaging',
    'app.kubernetes.io/part-of': 'nightscout-tenant',
    'app.kubernetes.io/instance': tenantId,
    'app.kubernetes.io/version': cdcVersion,
    'app.kubernetes.io/managed-by': 'metacontroller',
    'strimzi.io/cluster': kafkaClusterName,
    'ns.mdn.io/tenant': tenantId,
    ...additionalLabels
  });

  collections.forEach(collection => {
    const partitions = collection === 'entries' ? partitionsEntries : partitionsTreatments;
    
    topics.push({
      apiVersion: 'kafka.strimzi.io/v1beta2',
      kind: 'KafkaTopic',
      metadata: {
        name: `ns.${tenantId}.${collection}`,
        namespace: namespace,
        labels: standardLabels({ 'ns.mdn.io/collection': collection })
      },
      spec: {
        partitions: partitions,
        replicas: topicReplicas,
        config: {
          'retention.ms': retentionMs,
          'compression.type': 'producer'
        }
      }
    });
  });

  // DLQ topic
  topics.push({
    apiVersion: 'kafka.strimzi.io/v1beta2',
    kind: 'KafkaTopic',
    metadata: {
      name: `dlq.ns.${tenantId}`,
      namespace: namespace,
      labels: standardLabels({ 'ns.mdn.io/topic-type': 'dlq' })
    },
    spec: {
      partitions: 1,
      replicas: topicReplicas,
      config: {
        'retention.ms': retentionMs
      }
    }
  });

  return topics;
}

function renderKafkaConnector(parent, config) {
  const storageAccount = parent.metadata.labels?.['storage.nightscout.org/account'];
  const tenantId = parent.data.TENANT_ID;
  const namespace = parent.metadata.namespace;
  const collections = (parent.data.CDC_COLLECTIONS || 'entries,treatments').split(',');

  // Kafka configuration (tenant-specific overrides config defaults)
  const kafkaConnectClusterName = parent.data.KAFKA_CONNECT_CLUSTER_NAME || config.cdc.kafkaConnectCluster;
  const cdcTasksMax = parseInt(parent.data.CDC_TASKS_MAX || '1');
  const cdcVersion = parent.data.CDC_VERSION || 'v1beta2';
  
  const uriKey = parent.data.CDC_URI_KEY;
  const useExternalConfig = !!uriKey;
  
  const secretName = `${storageAccount}-mongo-auth`;
  const mongoHost = `${storageAccount}-mongo-0.${storageAccount}-mongo`;

  // Helper function for standard labels
  const standardLabels = () => ({
    'app.kubernetes.io/name': 'kafka-connector',
    'app.kubernetes.io/component': 'messaging',
    'app.kubernetes.io/part-of': 'nightscout-tenant',
    'app.kubernetes.io/instance': tenantId,
    'app.kubernetes.io/version': cdcVersion,
    'app.kubernetes.io/managed-by': 'metacontroller',
    'strimzi.io/cluster': kafkaConnectClusterName,
    'ns.mdn.io/tenant': tenantId
  });

  const connectorConfig = {
    'database': 'ns',
    'collection': collections.join(','),
    'pipeline': JSON.stringify([
      { $match: { 'ns.coll': { $in: collections } } }
    ]),
    'output.format.value': 'json',
    'output.format.key': 'json',
    'publish.full.document.only': 'true',
    'topic.namespace.map': JSON.stringify(
      collections.reduce((acc, col) => {
        acc[`ns.${col}`] = `ns.${tenantId}.${col}`;
        return acc;
      }, {})
    ),
    'errors.tolerance': 'all',
    'errors.deadletterqueue.topic.name': `dlq.ns.${tenantId}`,
    'errors.deadletterqueue.context.headers.enable': 'true'
  };

  if (useExternalConfig) {
    connectorConfig['connection.uri'] = `\${file:/opt/kafka/external-configuration/mongo-credentials/${uriKey}}`;
  } else {
    // Note: In production, use externalConfiguration to mount credentials from a Secret
    connectorConfig['connection.uri'] = `mongodb://nsuser:CHANGE_THIS_PASSWORD@${mongoHost}:27017/ns?replicaSet=rs0&authSource=admin`;
  }

  const connector = {
    apiVersion: 'kafka.strimzi.io/v1beta2',
    kind: 'KafkaConnector',
    metadata: {
      name: `${tenantId}-cdc-source`,
      namespace: namespace,
      labels: standardLabels()
    },
    spec: {
      class: 'com.mongodb.kafka.connect.MongoSourceConnector',
      tasksMax: cdcTasksMax,
      config: connectorConfig
    }
  };

  return connector;
}

function renderMigrationJob(parent, config) {
  // const tenantId = parent.data.TENANT_ID;
  const storageAccount = parent.metadata.labels?.['storage.nightscout.org/account'];
  const namespace = parent.metadata.namespace;
  
  const migrationSourceUri = parent.data.MIGRATION_SOURCE_URI;
  const migrationSourceSecret = parent.data.MIGRATION_SOURCE_SECRET;
  const migrationMethod = parent.data.MIGRATION_METHOD || config.resources.migrationMethod;
  const utilityImage = config.images.migrationJob;
  const utilityImagePullPolicy = config.imagePullPolicies.migrationJob;
  const utilityImagePullSecret = config.imagePullSecrets;
  const utilityCpuRequest = config.resources.migrationJob.requests.cpu;
  const utilityCpuLimit = config.resources.migrationJob.limits.cpu;
  const utilityMemRequest = config.resources.migrationJob.requests.memory;
  const utilityMemLimit = config.resources.migrationJob.limits.memory;
  
  if (!migrationSourceUri && !migrationSourceSecret) {
    console.error(`Migration enabled for tenant ${storageAccount} but neither MIGRATION_SOURCE_URI nor MIGRATION_SOURCE_SECRET provided`);
    throw new Error('Migration enabled but no source configured. Provide either MIGRATION_SOURCE_URI or MIGRATION_SOURCE_SECRET.');
  }
  
  const targetSecretName = `${storageAccount}-mongo-auth`;
  const targetHost = `${storageAccount}-mongo-0.${storageAccount}-mongo`;
  // targetUri should use the username and password and database from the parent secret.
  const targetUri = `mongodb://nsuser:\${MONGO_PASSWORD}@${targetHost}:27017/ns?replicaSet=rs0&authSource=admin`;
  
  const standardLabels = () => ({
    'app.kubernetes.io/name': 'migration-job',
    'app.kubernetes.io/component': 'migration',
    'app.kubernetes.io/part-of': 'nightscout-tenant',
    'app.kubernetes.io/instance': tenantId,
    'app.kubernetes.io/version': migrationImage.split(':')[1] || 'latest',
    'app.kubernetes.io/managed-by': 'metacontroller',
    'ns.mdn.io/tenant': tenantId,
    'ns.mdn.io/migration-method': migrationMethod
  });
  
  const command = ['migrate-database.sh'];
  const args = [];
  
  const sourceDb = parent.data.MIGRATION_SOURCE_DB || 'nightscout';
  
  const env = [
    {
      name: 'TARGET_MONGO_HOST',
      value: targetHost
    },
    {
      name: 'TARGET_MONGO_PORT',
      value: '27017'
    },
    {
      name: 'MIGRATION_METHOD',
      value: migrationMethod
    },
    {
      name: 'MIGRATION_SOURCE_DB',
      value: sourceDb
    },
    {
      name: 'MIGRATION_TARGET_DB',
      valueFrom: {
        secretKeyRef: {
          name: targetSecretName,
          key: 'MONGO_INITDB_DATABASE'
        }
      }
    },
    {
      name: 'MIGRATION_TARGET_USERNAME',
      valueFrom: {
        secretKeyRef: {
          name: targetSecretName,
          key: 'MONGO_INITDB_ROOT_USERNAME'
        }
      }
    },
    {
      name: 'MONGO_TARGET_PASSWORD',
      valueFrom: {
        secretKeyRef: {
          name: targetSecretName,
          key: 'MONGO_INITDB_ROOT_PASSWORD'
        }
      }
    }
  ];
  
  if (migrationSourceSecret) {
    env.push({
      name: 'SOURCE_MONGO_URI',
      valueFrom: {
        secretKeyRef: {
          name: migrationSourceSecret,
          key: 'uri'
        }
      }
    });
  } else {
    env.push({
      name: 'SOURCE_MONGO_URI',
      value: migrationSourceUri
    });
  }
  
  const job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: `${storageAccount}-migration`,
      namespace: namespace,
      labels: standardLabels(),
      annotations: {
        'ns.mdn.io/migration-started': new Date().toISOString(),
        'ns.mdn.io/migration-method': migrationMethod,
        'ns.mdn.io/migration-target': `${tenantId}-mongo`,
        'ns.mdn.io/migration-source-db': sourceDb,
        'ns.mdn.io/migrated-from': migrationSourceSecret ? `secret:${migrationSourceSecret}` : 'uri-provided',
        'ns.mdn.io/parent-generation': String(parent.metadata.generation || 1)
      }
    },
    spec: {
      backoffLimit: 3,
      activeDeadlineSeconds: 3600,
      ttlSecondsAfterFinished: 86400,
      template: {
        metadata: {
          labels: standardLabels()
        },
        spec: {
          restartPolicy: 'OnFailure',
          imagePullSecrets: utilityImagePullSecret 
            ? [{ name: utilityImagePullSecret }] 
            : undefined,
          containers: [
            {
              name: 'migration',
              image: utilityImage,
              imagePullPolicy: utilityImagePullPolicy,
              command: command,
              args: args,
              env: env,
              resources: {
                requests: {
                  cpu: utilityCpuRequest,
                  memory: utilityMemRequest
                },
                limits: {
                  cpu: utilityCpuLimit,
                  memory: utilityMemLimit
                }
              }
            }
          ]
        }
      }
    }
  };
  
  return job;
}

function generatePassword() {
  return Math.random().toString(36).slice(-16) + Math.random().toString(36).slice(-16);
}

module.exports = {
  renderMongoDB,
  renderNightscout,
  renderKafkaTopics,
  renderKafkaConnector,
  renderMigrationJob
};
