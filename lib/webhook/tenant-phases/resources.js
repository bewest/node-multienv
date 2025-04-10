
const templates = require('../../templates');

function createResourcesPhaseHandler(opts) {
  function template_deployment (data) {
    var template = {
      apiVersion: 'apps/v1',
      kind: "Deployment"
    , metadata: {
      name: data.WEB_NAME,
      annotations: {
        ...opts.default.deployment.annotations
        // 'managed-by': 'multienv/k8s-deployment-controller'
      },
      labels: {
        ...opts.default.deployment.labels,
        // managed: 'multienv', app: 'tenant',
        internal_name: data.WEB_NAME
      }
    }
    , spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          internal_name: data.WEB_NAME

        }
      },
      template: {
        metadata: {
          name: data.WEB_NAME,
          annotations: {
            ...opts.default.deployment.annotations
            // 'managed-by': 'multienv/k8s-deployment-controller'
          },
          labels: {
            ...opts.default.deployment.labels,
            internal_name: data.WEB_NAME,
            tenant: data.WEB_NAME,
            // app: 'tenant'
          }

        },
        spec: {
          hostname: `${data.WEB_NAME}`,
          subdomain: "backends",
          volumes: [
            {
              name: "mongodb-data",
              persistentVolumeClaim: {
                claimName: `pvc-${data.account}-mongodb-data`
              }
            }
          ],
          containers: [
            {
              name: 'nightscout',
              image: 'nightscout/cgm-remote-monitor:latest',
              envFrom: [
                {
                  secretRef: {
                    name: `${data.WEB_NAME}-secrets`
                  , optional: true
                  },
                },
                {
                  configMapRef: {
                    name: data.WEB_NAME
                  , optional: true
                  }
                }
              ],
              env: [
                {
                  name: 'MONGODB_URI',
                  value: `mongodb://localhost:27017/${data.WEB_NAME}`
                },
                {
                  name: 'MONGO_INITDB_DATABASE',
                  value: `admin`
                }
              ],
              resources: {
                ...(opts.MULTIENV_TENANT_REQUESTS_ENABLE ? {
                  requests: opts.requests
                } : { }),
                ...(opts.MULTIENV_TENANT_LIMITS_ENABLE ? {
                  limits: opts.limits
                } : { }),
              }
            },
            {
              name: 'mongodb',
              image: 'mongo:4.4',
              volumeMounts: [
                {
                  name: "mongodb-data",
                  mountPath: "/data/db"
                }
              ],
              resources: {
                ...(opts.MULTIENV_TENANT_REQUESTS_ENABLE ? {
                  requests: opts.requests
                } : { }),
                ...(opts.MULTIENV_TENANT_LIMITS_ENABLE ? {
                  limits: opts.limits
                } : { }),
              }
            }
          ]
          /*
          // Add nodeSelector to target specific node pool
          nodeSelector: {
            'doks.digitalocean.com/node-pool': 'bigger-tenant-runners'
          }
          */

        }
      }
    }
    };

    if (opts.MULTIENV_TENANT_NODEPOOL_TARGET) {
      template.spec.template.spec.nodeSelector = {
        'doks.digitalocean.com/node-pool': opts.MULTIENV_TENANT_NODEPOOL_TARGET
      };
    }

    return template;
  }

  return function handleResourcesPhase(parent, children, response) {
    const data = { WEB_NAME: parent.metadata.name, account: parent.spec.storageAccount };
    
    response.children.push(
      // templates.template_persistent_volume_claim(data),
      // templates.template_mongodb_statefulset(data),
      template_deployment(data)
      /*
      templates.template_nightscout_deployment(data, {
        resources: opts.resources || {
          requests: { cpu: '5m', memory: '120Mi' },
          limits: { cpu: '500m', memory: '500Mi' }
        }
      })
      */
    );
    response.status.phase = 'Ready';
  };
}

module.exports = createResourcesPhaseHandler;
