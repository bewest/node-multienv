function renderMongoDB(parent) {
  const tenantId = parent.data.TENANT_ID;
  const namespace = parent.metadata.namespace;
  const storageGi = parent.data.MONGO_STORAGE_GI || '10';
  const storageClass = parent.data.MONGO_SC || 'standard';

  const resources = [];

  const secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: 'ns-mongo-auth',
      namespace: namespace,
      labels: {
        'app.kubernetes.io/name': 'ns-mongo',
        'app.kubernetes.io/part-of': 'nightscout-tenant',
        'ns.mdn.io/tenant': tenantId
      }
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
      name: 'ns-mongo',
      namespace: namespace,
      labels: {
        'app.kubernetes.io/name': 'ns-mongo',
        'app.kubernetes.io/part-of': 'nightscout-tenant',
        'ns.mdn.io/tenant': tenantId
      }
    },
    spec: {
      clusterIP: 'None',
      selector: {
        'app.kubernetes.io/name': 'ns-mongo'
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
      name: 'ns-mongo',
      namespace: namespace,
      labels: {
        'app.kubernetes.io/name': 'ns-mongo',
        'app.kubernetes.io/part-of': 'nightscout-tenant',
        'ns.mdn.io/tenant': tenantId
      }
    },
    spec: {
      serviceName: 'ns-mongo',
      replicas: 1,
      selector: {
        matchLabels: {
          'app.kubernetes.io/name': 'ns-mongo'
        }
      },
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'ns-mongo',
            'app.kubernetes.io/part-of': 'nightscout-tenant',
            'ns.mdn.io/tenant': tenantId
          }
        },
        spec: {
          initContainers: [
            {
              name: 'init-replica-set',
              image: 'mongo:6',
              command: ['/bin/bash', '-c'],
              args: [
                `until mongosh --host ns-mongo-0.ns-mongo --eval "rs.status()" > /dev/null 2>&1; do
                  echo "Waiting for MongoDB to start...";
                  sleep 2;
                done;
                mongosh --host ns-mongo-0.ns-mongo --eval "
                  try {
                    rs.initiate({
                      _id: 'rs0',
                      members: [{ _id: 0, host: 'ns-mongo-0.ns-mongo:27017' }]
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
              image: 'mongo:6',
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
                      name: 'ns-mongo-auth',
                      key: 'username'
                    }
                  }
                },
                {
                  name: 'MONGO_INITDB_ROOT_PASSWORD',
                  valueFrom: {
                    secretKeyRef: {
                      name: 'ns-mongo-auth',
                      key: 'password'
                    }
                  }
                },
                {
                  name: 'MONGO_INITDB_DATABASE',
                  valueFrom: {
                    secretKeyRef: {
                      name: 'ns-mongo-auth',
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
      },
      volumeClaimTemplates: [
        {
          metadata: {
            name: 'data',
            labels: {
              'app.kubernetes.io/name': 'ns-mongo',
              'app.kubernetes.io/part-of': 'nightscout-tenant',
              'ns.mdn.io/tenant': tenantId
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
      name: 'ns-mongo-pdb',
      namespace: namespace,
      labels: {
        'app.kubernetes.io/name': 'ns-mongo',
        'ns.mdn.io/tenant': tenantId
      }
    },
    spec: {
      minAvailable: 1,
      selector: {
        matchLabels: {
          'app.kubernetes.io/name': 'ns-mongo'
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
  const nsImage = parent.data.NS_IMAGE || 'nightscout/cgm-remote-monitor:latest';

  const resources = [];

  const deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: 'nightscout',
      namespace: namespace,
      labels: {
        'app.kubernetes.io/name': 'nightscout',
        'app.kubernetes.io/part-of': 'nightscout-tenant',
        'ns.mdn.io/tenant': tenantId
      }
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          'app.kubernetes.io/name': 'nightscout'
        }
      },
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'nightscout',
            'ns.mdn.io/tenant': tenantId
          }
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
                  value: 'mongodb://$(MONGO_USER):$(MONGO_PASS)@ns-mongo-0.ns-mongo:27017/$(MONGO_DB)?replicaSet=rs0'
                },
                {
                  name: 'MONGO_USER',
                  valueFrom: {
                    secretKeyRef: {
                      name: 'ns-mongo-auth',
                      key: 'username'
                    }
                  }
                },
                {
                  name: 'MONGO_PASS',
                  valueFrom: {
                    secretKeyRef: {
                      name: 'ns-mongo-auth',
                      key: 'password'
                    }
                  }
                },
                {
                  name: 'MONGO_DB',
                  valueFrom: {
                    secretKeyRef: {
                      name: 'ns-mongo-auth',
                      key: 'database'
                    }
                  }
                }
              ],
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

  const service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: 'nightscout',
      namespace: namespace,
      labels: {
        'app.kubernetes.io/name': 'nightscout',
        'ns.mdn.io/tenant': tenantId
      }
    },
    spec: {
      type: 'ClusterIP',
      selector: {
        'app.kubernetes.io/name': 'nightscout'
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
      name: 'nightscout-pdb',
      namespace: namespace,
      labels: {
        'app.kubernetes.io/name': 'nightscout',
        'ns.mdn.io/tenant': tenantId
      }
    },
    spec: {
      minAvailable: 1,
      selector: {
        matchLabels: {
          'app.kubernetes.io/name': 'nightscout'
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
  
  const partitionsEntries = parseInt(parent.data.CDC_PARTITIONS_ENTRIES || '3');
  const partitionsTreatments = parseInt(parent.data.CDC_PARTITIONS_TREATMENTS || '1');
  const retentionMs = parent.data.CDC_RETENTION_MS || '604800000';

  const topics = [];

  collections.forEach(collection => {
    const partitions = collection === 'entries' ? partitionsEntries : partitionsTreatments;
    
    topics.push({
      apiVersion: 'kafka.strimzi.io/v1beta2',
      kind: 'KafkaTopic',
      metadata: {
        name: `ns.${tenantId}.${collection}`,
        namespace: namespace,
        labels: {
          'strimzi.io/cluster': 'kafka-cluster',
          'ns.mdn.io/tenant': tenantId
        }
      },
      spec: {
        partitions: partitions,
        replicas: 3,
        config: {
          'retention.ms': retentionMs,
          'compression.type': 'producer'
        }
      }
    });
  });

  topics.push({
    apiVersion: 'kafka.strimzi.io/v1beta2',
    kind: 'KafkaTopic',
    metadata: {
      name: `dlq.ns.${tenantId}`,
      namespace: namespace,
      labels: {
        'strimzi.io/cluster': 'kafka-cluster',
        'ns.mdn.io/tenant': tenantId
      }
    },
    spec: {
      partitions: 1,
      replicas: 3,
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

  const uriKey = parent.data.CDC_URI_KEY;
  const useExternalConfig = !!uriKey;

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
    config['connection.uri'] = 'mongodb://nsuser:CHANGE_THIS_PASSWORD@ns-mongo-0.ns-mongo:27017/ns?replicaSet=rs0&authSource=admin';
  }

  const connector = {
    apiVersion: 'kafka.strimzi.io/v1beta2',
    kind: 'KafkaConnector',
    metadata: {
      name: `ns-${tenantId}-source`,
      namespace: namespace,
      labels: {
        'strimzi.io/cluster': 'connect-cluster',
        'ns.mdn.io/tenant': tenantId
      }
    },
    spec: {
      class: 'com.mongodb.kafka.connect.MongoSourceConnector',
      tasksMax: 1,
      config: config
    }
  };

  return connector;
}

function generatePassword() {
  return Math.random().toString(36).slice(-16) + Math.random().toString(36).slice(-16);
}

module.exports = {
  renderMongoDB,
  renderNightscout,
  renderKafkaTopics,
  renderKafkaConnector
};
