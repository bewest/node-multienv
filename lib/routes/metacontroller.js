
const templates = require('lib/templates');

function createWebhookHandler(k8s, namespace) {
  return {
    handleSync: function (parent, children = {}) {
      if (!parent.metadata || !parent.metadata.name) {
        throw new Error('Parent resource must have metadata.name');
      }

      const response = {
        status: {
          observedGeneration: parent.metadata.generation || 0,
          ready: false
        },
        children: []
      };

      const data = {
        WEB_NAME: parent.metadata.name
      };

      // Add core resources for Nightscout instance
      response.children.push(
        templates.template_persistent_volume_claim(data),
        templates.template_mongodb_statefulset(data),
        templates.template_nightscout_deployment(data, {
          resources: {
            requests: { cpu: '5m', memory: '120Mi' },
            limits: { cpu: '500m', memory: '500Mi' }
          }
        })
      );

      response.status.ready = true;
      return response;
    }
  };
}

module.exports = createWebhookHandler;
