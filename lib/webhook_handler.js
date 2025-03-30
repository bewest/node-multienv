
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

    // Add MongoDB StatefulSet
    response.children.push(
      templates.template_mongodb_statefulset({ WEB_NAME: parent.metadata.name })
    );

    // Add Nightscout Deployment
    response.children.push(
      templates.template_nightscout_deployment({ WEB_NAME: parent.metadata.name })
    );

    return response;
  }
}

module.exports = WebhookHandler;
