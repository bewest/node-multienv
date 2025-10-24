const k8s = require('@kubernetes/client-node');
const { renderMongoDB, renderNightscout, renderKafkaTopics, renderKafkaConnector } = require('./resources');

async function compositeSync(req, res) {
  const { parent, children } = req.body;
  
  console.log('Composite sync for tenant:', parent.data?.TENANT_ID);
  
  try {
    const response = {
      status: {},
      children: []
    };

    const tenantId = parent.data?.TENANT_ID || 'unknown';
    const namespace = parent.metadata.namespace;
    const cdcEnabled = parent.data?.CDC_ENABLED === 'true';

    const mongoReady = isMongoReady(children);
    
    response.children.push(...renderMongoDB(parent));
    
    response.children.push(...renderNightscout(parent));

    if (cdcEnabled) {
      response.children.push(...renderKafkaTopics(parent));
      
      if (mongoReady) {
        response.children.push(renderKafkaConnector(parent));
      }
    }

    response.status = {
      mongo: {
        ready: mongoReady
      },
      connector: getConnectorStatus(children)
    };

    res.json(response);
  } catch (error) {
    console.error('Error in composite sync:', error);
    res.status(500).json({ error: error.message });
  }
}

function isMongoReady(children) {
  const statefulSets = children['StatefulSet.apps/v1'] || {};
  
  for (const [name, sts] of Object.entries(statefulSets)) {
    if (name.includes('ns-mongo')) {
      const ready = sts.status?.readyReplicas >= 1;
      console.log(`MongoDB StatefulSet ${name} ready:`, ready);
      return ready;
    }
  }
  
  return false;
}

function getConnectorStatus(children) {
  const connectors = children['KafkaConnector.kafka.strimzi.io/v1beta2'] || {};
  
  for (const [name, connector] of Object.entries(connectors)) {
    return {
      name: name,
      state: connector.status?.connectorStatus?.connector?.state || 'unknown'
    };
  }
  
  return null;
}

module.exports = compositeSync;
