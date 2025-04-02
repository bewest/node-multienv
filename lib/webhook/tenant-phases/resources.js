
const templates = require('../../templates');

function handleResourcesPhase(parent, children, response) {
  const data = { WEB_NAME: parent.metadata.name };
  
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
  response.status.phase = 'Ready';
}

module.exports = handleResourcesPhase;
