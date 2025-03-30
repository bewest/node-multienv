
const templates = require('./templates');

class WebhookHandler {
  constructor(k8s, namespace) {
    this.k8s = k8s;
    this.namespace = namespace;
  }

  async handleSync(parent, children = {}) {
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

  validateParent(parent) {
    if (!parent.metadata || !parent.metadata.name) {
      throw new Error('Parent resource must have metadata.name');
    }
    return true;
  }
}

module.exports = WebhookHandler;
