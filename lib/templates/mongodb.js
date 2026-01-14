
const template_mongodb_service = (data) => ({
  apiVersion: 'v1',
  kind: 'Service',
  metadata: {
    name: `${data.WEB_NAME}-mongodb`,
    labels: {
      app: 'tenant',
      tenant: data.WEB_NAME
    }
  },
  spec: {
    selector: {
      app: `${data.WEB_NAME}-mongodb`
    },
    ports: [{
      port: 27017,
      targetPort: 27017
    }]
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
  template_mongodb_service,
  template_mongodb_statefulset
};
