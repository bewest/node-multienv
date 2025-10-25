function renderMongoDB(parent) {
  const tenantId = parent.data.TENANT_ID;
  const namespace = parent.metadata.namespace;
  
  // Storage configuration
  const storageGi = parent.data.MONGO_STORAGE_GI || '10';
  const storageClass = parent.data.MONGO_SC || 'standard';
  
  // MongoDB configuration
  const mongoImage = parent.data.MONGO_IMAGE || 'mongo:6';
  const mongoReplicas = parseInt(parent.data.MONGO_REPLICAS || '1');
  
  // Extract version from image
  const mongoVersion = mongoImage.split(':')[1] || 'latest';
  
  // Resource limits
  const mongoCpuRequest = parent.data.MONGO_CPU_REQUEST || '100m';
  const mongoCpuLimit = parent.data.MONGO_CPU_LIMIT || '500m';
  const mongoMemRequest = parent.data.MONGO_MEM_REQUEST || '256Mi';
  const mongoMemLimit = parent.data.MONGO_MEM_LIMIT || '512Mi';
  
  // PDB configuration
  const mongoPdbMinAvailable = parseInt(parent.data.MONGO_PDB_MIN_AVAILABLE || '1');
  
  // Resource names with tenant prefix
  const secretName = `${tenantId}-mongo-auth`;
  const serviceName = `${tenantId}-mongo`;
  const statefulSetName = `${tenantId}-mongo`;
  const pdbName = `${tenantId}-mongo-pdb`;
  const pod0Hostname = `${tenantId}-mongo-0.${tenantId}-mongo`;

  const resources = [];

  // Helper function for standard labels
  const standardLabels = (component, additionalLabels = {}) => ({
    'app.kubernetes.io/name': 'mongodb',
    'app.kubernetes.io/component': component,
    'app.kubernetes.io/part-of': 'nightscout-tenant',
    'app.kubernetes.io/instance': tenantId,
    'app.kubernetes.io/version': mongoVersion,
    'app.kubernetes.io/managed-by': 'metacontroller',
    'ns.mdn.io/tenant': tenantId,
    ...additionalLabels
  });

  const secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: secretName,
      namespace: namespace,
      labels: standardLabels('database')
    },
    type: 'Opaque',
    stringData: {
      username: 'nsuser',
      password: generatePassword(),
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
        'app.kubernetes.io/instance': tenantId
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
      labels: standardLabels('database')
    },
    spec: {
      serviceName: serviceName,
      replicas: mongoReplicas,
      selector: {
        matchLabels: {
          'app.kubernetes.io/name': 'mongodb',
          'app.kubernetes.io/instance': tenantId
        }
      },
      template: {
        metadata: {
          labels: standardLabels('database')
        },
        spec: {
          initContainers: [
            {
              name: 'init-replica-set',
              image: mongoImage,
              command: ['/bin/bash', '-c'],
              args: [
                `until mongosh --host ${pod0Hostname} --eval "rs.status()" > /dev/null 2>&1; do
                  echo "Waiting for MongoDB to start...";
                  sleep 2;
                done;
                mongosh --host ${pod0Hostname} --eval "
                  try {
                    rs.initiate({
                      _id: 'rs0',
                      members: [{ _id: 0, host: '${pod0Hostname}:27017' }]
                    });
                  } catch(e) {
                    print('RS already initialized or error:', e);
                  }
                " || true`
              ]
            }
          ],
          containers: [
            {
              name: 'mongodb',
              image: mongoImage,
              command: ['mongod', '--replSet', 'rs0', '--bind_ip_all'],
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
      volumeClaimTemplates: [
        {
          metadata: {
            name: 'data',
            labels: standardLabels('database')
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
          'app.kubernetes.io/instance': tenantId
        }
      }
    }
  };

  resources.push(secret, headlessService, statefulSet, pdb);
  return resources;
}

function renderNightscout(parent) {
  const tenantId = parent.data.TENANT_ID;
  const namespace = parent.metadata.namespace;
  
  // Nightscout configuration
  const nsImage = parent.data.NS_IMAGE || 'nightscout/cgm-remote-monitor:latest';
  const nsReplicas = parseInt(parent.data.NS_REPLICAS || '1');
  const nsServiceType = parent.data.NS_SERVICE_TYPE || 'ClusterIP';
  
  // Resource limits
  const nsCpuRequest = parent.data.NS_CPU_REQUEST || '100m';
  const nsCpuLimit = parent.data.NS_CPU_LIMIT || '500m';
  const nsMemRequest = parent.data.NS_MEM_REQUEST || '256Mi';
  const nsMemLimit = parent.data.NS_MEM_LIMIT || '512Mi';
  
  // PDB configuration
  const nsPdbMinAvailable = parseInt(parent.data.NS_PDB_MIN_AVAILABLE || '1');
  
  // Extract version from image
  const nsVersion = nsImage.split(':')[1] || 'latest';
  
  // Resource names with tenant prefix
  const deploymentName = `${tenantId}-nightscout`;
  const serviceName = `${tenantId}-nightscout`;
  const pdbName = `${tenantId}-nightscout-pdb`;
  const secretName = `${tenantId}-mongo-auth`;
  const mongoHost = `${tenantId}-mongo-0.${tenantId}-mongo`;

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
          containers: [
            {
              name: 'nightscout',
              image: nsImage,
              ports: [
                {
                  containerPort: 1337,
                  name: 'http'
                }
              ],
              env: [
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
          ]
        }
      }
    }
  };

  const service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: serviceName,
      namespace: namespace,
      labels: standardLabels('application')
    },
    spec: {
      type: nsServiceType,
      selector: {
        'app.kubernetes.io/name': 'nightscout',
        'app.kubernetes.io/instance': tenantId
      },
      ports: [
        {
          name: 'http',
          port: 80,
          targetPort: 1337
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

  resources.push(deployment, service, pdb);
  return resources;
}

function renderKafkaTopics(parent) {
  const tenantId = parent.data.TENANT_ID;
  const namespace = parent.metadata.namespace;
  const collections = (parent.data.CDC_COLLECTIONS || 'entries,treatments').split(',');
  
  // Kafka configuration
  const kafkaClusterName = parent.data.KAFKA_CLUSTER_NAME || 'kafka-cluster';
  const partitionsEntries = parseInt(parent.data.CDC_PARTITIONS_ENTRIES || '3');
  const partitionsTreatments = parseInt(parent.data.CDC_PARTITIONS_TREATMENTS || '1');
  const retentionMs = parent.data.CDC_RETENTION_MS || '604800000';
  const topicReplicas = parseInt(parent.data.KAFKA_TOPIC_REPLICAS || '3');
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

function renderKafkaConnector(parent) {
  const tenantId = parent.data.TENANT_ID;
  const namespace = parent.metadata.namespace;
  const collections = (parent.data.CDC_COLLECTIONS || 'entries,treatments').split(',');

  // Kafka configuration
  const kafkaConnectClusterName = parent.data.KAFKA_CONNECT_CLUSTER_NAME || 'connect-cluster';
  const cdcTasksMax = parseInt(parent.data.CDC_TASKS_MAX || '1');
  const cdcVersion = parent.data.CDC_VERSION || 'v1beta2';
  
  const uriKey = parent.data.CDC_URI_KEY;
  const useExternalConfig = !!uriKey;
  
  const secretName = `${tenantId}-mongo-auth`;
  const mongoHost = `${tenantId}-mongo-0.${tenantId}-mongo`;

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

  const config = {
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
    config['connection.uri'] = `\${file:/opt/kafka/external-configuration/mongo-credentials/${uriKey}}`;
  } else {
    // Note: In production, use externalConfiguration to mount credentials from a Secret
    config['connection.uri'] = `mongodb://nsuser:CHANGE_THIS_PASSWORD@${mongoHost}:27017/ns?replicaSet=rs0&authSource=admin`;
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
      config: config
    }
  };

  return connector;
}

function renderMigrationJob(parent) {
  const tenantId = parent.data.TENANT_ID;
  const namespace = parent.metadata.namespace;
  
  const migrationSourceUri = parent.data.MIGRATION_SOURCE_URI;
  const migrationSourceSecret = parent.data.MIGRATION_SOURCE_SECRET;
  const migrationMethod = parent.data.MIGRATION_METHOD || 'mongodump-restore';
  const migrationImage = parent.data.MIGRATION_IMAGE || 'mongo:6';
  
  if (!migrationSourceUri && !migrationSourceSecret) {
    console.error(`Migration enabled for tenant ${tenantId} but neither MIGRATION_SOURCE_URI nor MIGRATION_SOURCE_SECRET provided`);
    throw new Error('Migration enabled but no source configured. Provide either MIGRATION_SOURCE_URI or MIGRATION_SOURCE_SECRET.');
  }
  
  const targetSecretName = `${tenantId}-mongo-auth`;
  const targetHost = `${tenantId}-mongo-0.${tenantId}-mongo`;
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
  
  let command;
  let args;
  
  if (migrationMethod === 'mongodump-restore') {
    command = ['/bin/bash', '-c'];
    args = [
      `set -e
      echo "Starting migration for tenant: ${tenantId}"
      echo "Method: mongodump-restore"
      
      echo "Step 1: Dumping from source..."
      mongodump --uri="$SOURCE_URI" --out=/tmp/dump --gzip
      
      echo "Step 2: Restoring to target..."
      mongorestore --uri="$TARGET_URI" --nsFrom='*.*' --nsTo='ns.*' /tmp/dump --gzip --drop
      
      echo "Migration completed successfully"
      exit 0`
    ];
  } else if (migrationMethod === 'mongodump-restore-single-db') {
    const sourceDb = parent.data.MIGRATION_SOURCE_DB || 'nightscout';
    command = ['/bin/bash', '-c'];
    args = [
      `set -e
      echo "Starting single-database migration for tenant: ${tenantId}"
      echo "Method: mongodump-restore-single-db"
      echo "Source database: ${sourceDb}"
      mongodump --uri="$SOURCE_URI" --db=${sourceDb} --out=/tmp/dump --gzip
      mongorestore --uri="$TARGET_URI" --nsFrom='${sourceDb}.*' --nsTo='ns.*' /tmp/dump --gzip --drop
      echo "Migration completed successfully"`
    ];
  } else {
    command = ['/bin/bash', '-c'];
    args = ['echo "Unknown migration method: ' + migrationMethod + '"; exit 1'];
  }
  
  const env = [
    {
      name: 'TARGET_URI',
      value: targetUri
    },
    {
      name: 'MONGO_PASSWORD',
      valueFrom: {
        secretKeyRef: {
          name: targetSecretName,
          key: 'password'
        }
      }
    }
  ];
  
  if (migrationSourceSecret) {
    env.push({
      name: 'SOURCE_URI',
      valueFrom: {
        secretKeyRef: {
          name: migrationSourceSecret,
          key: 'uri'
        }
      }
    });
  } else {
    env.push({
      name: 'SOURCE_URI',
      value: migrationSourceUri
    });
  }
  
  const job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: `${tenantId}-migration`,
      namespace: namespace,
      labels: standardLabels(),
      annotations: {
        'ns.mdn.io/migration-started': new Date().toISOString(),
        'ns.mdn.io/migration-method': migrationMethod,
        'ns.mdn.io/migration-target': `${tenantId}-mongo`
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
          containers: [
            {
              name: 'migration',
              image: migrationImage,
              command: command,
              args: args,
              env: env,
              resources: {
                requests: {
                  cpu: '100m',
                  memory: '256Mi'
                },
                limits: {
                  cpu: '500m',
                  memory: '512Mi'
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
