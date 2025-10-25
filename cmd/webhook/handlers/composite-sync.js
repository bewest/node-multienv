const k8s = require('@kubernetes/client-node');
const { renderMongoDB, renderNightscout, renderKafkaTopics, renderKafkaConnector, renderMigrationJob } = require('./resources');

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
    const migrationEnabled = parent.data?.MIGRATION_ENABLED === 'true';

    const mongoReady = isMongoReady(children);
    const migrationStatus = getMigrationStatus(children);
    
    response.children.push(...renderMongoDB(parent));
    
    response.children.push(...renderNightscout(parent));

    const migrationCompleteMarker = parent.metadata?.annotations?.['ns.mdn.io/migration-complete'];
    const migrationCompleteStatus = parent.status?.migration?.complete;
    
    if (migrationEnabled && mongoReady && migrationStatus !== 'Complete' && !migrationCompleteMarker && !migrationCompleteStatus) {
      console.log(`Rendering migration job for tenant ${tenantId}, status: ${migrationStatus}`);
      response.children.push(renderMigrationJob(parent));
    } else if ((migrationCompleteMarker || migrationCompleteStatus) && migrationStatus !== 'Not Started') {
      console.log(`Skipping migration job for tenant ${tenantId} - already complete (marker: ${!!migrationCompleteMarker}, status: ${!!migrationCompleteStatus})`);
    }

    if (cdcEnabled) {
      response.children.push(...renderKafkaTopics(parent));
      
      if (mongoReady) {
        response.children.push(renderKafkaConnector(parent));
      }
    }

    const migrationStatusObj = migrationEnabled ? {
      enabled: true,
      status: migrationStatus,
      job: migrationStatus !== 'Not Started' ? `${tenantId}-migration` : null,
      complete: (migrationCompleteMarker || migrationCompleteStatus || migrationStatus === 'Complete') ? true : false,
      completedAt: migrationStatus === 'Complete' && !parent.status?.migration?.completedAt 
        ? new Date().toISOString() 
        : parent.status?.migration?.completedAt || null,
      instructions: migrationStatus === 'Complete' && !migrationCompleteStatus && !migrationCompleteMarker
        ? 'Migration complete and will not re-run (automatically tracked).'
        : migrationStatus === 'Failed'
        ? 'Migration failed. Check job logs. Delete job to retry.'
        : null
    } : {
      enabled: false
    };

    response.status = {
      mongo: {
        ready: mongoReady
      },
      migration: migrationStatusObj,
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
    // Look for MongoDB StatefulSets by label or name pattern
    if (name.endsWith('-mongo') || sts.metadata?.labels?.['app.kubernetes.io/name'] === 'mongodb') {
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

function getMigrationStatus(children) {
  const jobs = children['Job.batch/v1'] || {};
  
  for (const [name, job] of Object.entries(jobs)) {
    if (name.endsWith('-migration') || job.metadata?.labels?.['app.kubernetes.io/component'] === 'migration') {
      const conditions = job.status?.conditions || [];
      const succeeded = job.status?.succeeded || 0;
      const failed = job.status?.failed || 0;
      const active = job.status?.active || 0;
      
      const completeCondition = conditions.find(c => c.type === 'Complete' && c.status === 'True');
      const failedCondition = conditions.find(c => c.type === 'Failed' && c.status === 'True');
      
      if (completeCondition || succeeded > 0) {
        return 'Complete';
      } else if (failedCondition) {
        return 'Failed';
      } else if (active > 0) {
        return 'Running';
      } else {
        return 'Pending';
      }
    }
  }
  
  return 'Not Started';
}

module.exports = compositeSync;
