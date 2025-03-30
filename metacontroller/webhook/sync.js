
// Webhook sync handler
function handleSync(req, res) {
  const parent = req.body.parent;
  const children = req.body.children || {};

  const response = {
    status: {},
    children: []
  };

  // Single StatefulSet for both Nightscout and MongoDB
  response.children.push({
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: {
      name: parent.metadata.name,
      labels: {
        app: parent.metadata.name
      }
    },
    spec: {
      serviceName: parent.metadata.name,
      replicas: 1,
      selector: {
        matchLabels: {
          app: parent.metadata.name
        }
      },
      template: {
        metadata: {
          labels: {
            app: parent.metadata.name
          }
        },
        spec: {
          containers: [
            {
              name: 'nightscout',
              image: 'nightscout/cgm-remote-monitor:latest',
              env: [
                {
                  name: 'MONGODB_URI',
                  value: 'mongodb://localhost:27017/' + parent.metadata.name
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
            },
            {
              name: 'mongodb',
              image: 'mongo:4.4',
              volumeMounts: [
                {
                  name: 'mongodb-data',
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
          ],
          volumes: [
            {
              name: 'mongodb-data',
              persistentVolumeClaim: {
                claimName: parent.metadata.name + '-mongodb-data',
                spec: {
                  accessModes: ["ReadWriteOnce"],
                  resources: {
                    requests: {
                      storage: "2Gi"
                    }
                  },
                  storageClassName: "do-block-storage",
                  volumeMode: "Filesystem",
                  fsType: "xfs"
                }
              }
            }
          ]
        }
      }
    }
  });

  res.json(response);
}
