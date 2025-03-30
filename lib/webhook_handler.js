
const templates = require('./templates/index');

function createWebhookHandler(k8s, namespace) {
  return {
    handleSync: async function(parent, children = {}) {
      if (!parent.metadata || !parent.metadata.name) {
        throw new Error('Parent resource must have metadata.name');
      }

      const response = {
        status: {},
        children: []
      };

      const data = {
        WEB_NAME: parent.metadata.name
      };

      // Add PVC for MongoDB data
      response.children.push(
        templates.template_persistent_volume_claim(data)
      );

      // Add MongoDB StatefulSet
      response.children.push(
        templates.template_mongodb_statefulset(data)
      );

      // Add Nightscout Deployment with resource constraints  
      response.children.push(
        templates.template_nightscout_deployment(data, {
          resources: {
            requests: {
              cpu: '5m',
              memory: '120Mi'
            },
            limits: {
              cpu: '500m',
              memory: '500Mi'
            }
          }
        })
      );

      return response;
    }
  };
}

module.exports = createWebhookHandler;
