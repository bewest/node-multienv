const k8s = require('@kubernetes/client-node');

async function compositeFinalize(req, res) {
  const { parent, children } = req.body;
  
  console.log('Composite finalize for tenant:', parent.data?.TENANT_ID);
  
  try {
    const response = {
      status: {},
      children: []
    };

    const connectors = children['KafkaConnector.kafka.strimzi.io/v1beta2'] || {};
    const deployments = children['Deployment.apps/v1'] || {};

    for (const [name, connector] of Object.entries(connectors)) {
      if (!connector.spec?.pause) {
        console.log(`Pausing connector ${name}`);
        const pausedConnector = {
          ...connector,
          spec: {
            ...connector.spec,
            pause: true
          }
        };
        response.children.push(pausedConnector);
      } else {
        const taskState = connector.status?.connectorStatus?.tasks?.[0]?.state;
        if (taskState !== 'RUNNING') {
          console.log(`Connector ${name} tasks idle, can delete`);
        } else {
          console.log(`Waiting for connector ${name} to pause...`);
          response.children.push(connector);
        }
      }
    }

    for (const [name, deployment] of Object.entries(deployments)) {
      if (name.includes('nightscout')) {
        console.log(`Scaling down Nightscout deployment ${name}`);
        const scaledDeployment = {
          ...deployment,
          spec: {
            ...deployment.spec,
            replicas: 0
          }
        };
        response.children.push(scaledDeployment);
      }
    }

    response.status = {
      finalized: true
    };

    res.json(response);
  } catch (error) {
    console.error('Error in composite finalize:', error);
    res.status(500).json({ error: error.message });
  }
}

module.exports = compositeFinalize;
