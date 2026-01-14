
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
      persistentVolumeClaimRetentionPolicy: {
        whenDeleted: "Retain",
        whenScaled: "Retain",
      },
      volumeClaimTemplates: [
        {
          metadata: {
            name: `${data.WEB_NAME}-tenant-mongodb-data`,
            labels: {
              tenant: data.WEB_NAME,
              app: 'tenant',
            }
          },
          spec: {
            accessModes: [ "ReadWriteOnce" ],
            storageClassName: 'do-block-storage-xfs-retain',
            resources: {
              requests: {
                storage: '2Gi'
              }
            },
            //  'xfs',
            // volumeName: 'pvc-mongodb-data',
            // volumeName: `pvc-${data.WEB_NAME}-tenant-mongodb-data`,
          }
        }
      ],
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
              // name: 'mongodb-data',
              name: `${data.WEB_NAME}-tenant-mongodb-data`,
              mountPath: '/data/db'
            }],
            resources: {
              requests: {
                cpu: '5m',
                memory: '128Mi'
              },
              limits: {
                cpu: '500m',
                memory: '512Mi'
              }
            }
          }],
          /*
          volumes: [{
            name: 'mongodb-data',
            persistentVolumeClaim: {
              claimName: `${data.WEB_NAME}-tenant-mongodb-data`
            }
          }]
          */
        }
      }
    }
  };
};

module.exports = { template_mongodb_statefulset };
