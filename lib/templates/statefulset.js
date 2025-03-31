
const template_mongodb_statefulset = (data) => {
  return {
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
          app: 'mongodb',
          instance: data.WEB_NAME
        }
      },
      template: {
        metadata: {
          labels: {
            app: 'mongodb',
            instance: data.WEB_NAME
          }
        },
        spec: {
          containers: [{
            name: 'mongodb',
            image: 'mongo:4.4',
            ports: [{
              containerPort: 27017
            }],
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
  };
};

module.exports = template_mongodb_statefulset;
