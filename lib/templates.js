
const template_persistent_volume_claim = (data) => ({
  apiVersion: 'v1',
  kind: 'PersistentVolumeClaim',
  metadata: {
    name: `${data.WEB_NAME}-mongodb-data`,
    labels: {
      app: 'tenant',
      tenant: data.WEB_NAME
    }
  },
  spec: {
    accessModes: ['ReadWriteOnce'],
    resources: {
      requests: {
        storage: '1Gi'
      }
    }
  }
});

const template_nightscout_deployment = (data, opts = {}) => ({
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: {
    name: data.WEB_NAME,
    labels: {
      app: 'nightscout',
      instance: data.WEB_NAME
    }
  },
  spec: {
    replicas: 1,
    selector: {
      matchLabels: {
        app: 'nightscout'
      }
    },
    template: {
      metadata: {
        labels: {
          app: 'nightscout'
        }
      },
      spec: {
        containers: [{
          name: 'nightscout',
          image: 'nightscout/cgm-remote-monitor:latest',
          env: [{
            name: 'MONGODB_URI',
            value: `mongodb://${data.WEB_NAME}-mongodb:27017/${data.WEB_NAME}`
          }],
          resources: opts.resources || {
            requests: {
              cpu: '5m',
              memory: '120Mi'
            },
            limits: {
              cpu: '500m',
              memory: '500Mi'
            }
          }
        }]
      }
    }
  }
});

const template_mongodb_statefulset = (data) => ({
  apiVersion: 'apps/v1',
  kind: 'StatefulSet',
  metadata: {
    name: `${data.WEB_NAME}-mongodb`,
    labels: {
      app: 'mongodb',
      instance: data.WEB_NAME
    }
  },
  spec: {
    serviceName: 'mongodb',
    replicas: 1,
    selector: {
      matchLabels: {
        app: 'mongodb'
      }
    },
    template: {
      metadata: {
        labels: {
          app: 'mongodb'
        }
      },
      spec: {
        containers: [{
          name: 'mongodb',
          image: 'mongo:4.4',
          ports: [{ containerPort: 27017 }],
          volumeMounts: [{
            name: 'mongodb-data',
            mountPath: '/data/db'
          }],
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
        }],
        volumes: [{
          name: 'mongodb-data',
          persistentVolumeClaim: {
            claimName: `${data.WEB_NAME}-mongodb-data`
          }
        }]
      }
    }
  }
});

module.exports = {
  template_persistent_volume_claim,
  template_nightscout_deployment,
  template_mongodb_statefulset
};
