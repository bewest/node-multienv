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

    const mongoReadiness = checkMongoReadiness(children);
    const migrationState = checkMigrationState(children);
    
    // Render core resources (always present)
    response.children.push(...renderMongoDB(parent));
    response.children.push(...renderNightscout(parent));

    // Render migration job if needed
    const migrationCompleteMarker = parent.metadata?.annotations?.['ns.mdn.io/migration-complete'];
    const migrationCompleteStatus = parent.status?.migration?.complete;
    
    if (migrationEnabled && mongoReadiness.ready && migrationState.phase !== 'Complete' && !migrationCompleteMarker && !migrationCompleteStatus) {
      console.log(`Rendering migration job for tenant ${tenantId}, phase: ${migrationState.phase}`);
      response.children.push(renderMigrationJob(parent));
    } else if ((migrationCompleteMarker || migrationCompleteStatus) && migrationState.phase !== 'NotStarted') {
      console.log(`Skipping migration job for tenant ${tenantId} - already complete`);
    }

    // Render CDC resources if enabled
    if (cdcEnabled) {
      response.children.push(...renderKafkaTopics(parent));
      
      if (mongoReadiness.ready) {
        response.children.push(renderKafkaConnector(parent));
      }
    }

    // Preserve unmanaged children (child preservation pattern)
    preserveUnmanagedChildren(children, response);

    // Build Kubernetes-idiomatic status with conditions
    response.status = buildStatus(parent, {
      mongoReadiness,
      migrationState,
      migrationEnabled,
      migrationCompleteMarker,
      migrationCompleteStatus,
      cdcEnabled,
      children,
      tenantId
    });

    res.json(response);
  } catch (error) {
    console.error('Error in composite sync:', error);
    res.status(500).json({ error: error.message });
  }
}

/**
 * Child preservation pattern - echoes back children not explicitly managed
 * This prevents deletion of resources created externally or in other reconciliation passes
 */
function preserveUnmanagedChildren(children, response) {
  const managedChildren = new Set();
  
  // Build set of managed children by kind+name
  response.children.forEach(child => {
    const key = `${child.kind}/${child.metadata.name}`;
    managedChildren.add(key);
  });
  
  // Echo back all unmanaged children
  let preservedCount = 0;
  Object.entries(children).forEach(([kindVersion, resourceMap]) => {
    Object.entries(resourceMap).forEach(([name, resource]) => {
      const key = `${resource.kind}/${name}`;
      if (!managedChildren.has(key)) {
        response.children.push(resource);
        preservedCount++;
      }
    });
  });
  
  if (preservedCount > 0) {
    console.log(`Preserved ${preservedCount} unmanaged children`);
  }
}

/**
 * Check MongoDB readiness and return condition
 */
function checkMongoReadiness(children) {
  const statefulSets = children['StatefulSet.apps/v1'] || {};
  
  for (const [name, sts] of Object.entries(statefulSets)) {
    if (name.endsWith('-mongo') || sts.metadata?.labels?.['app.kubernetes.io/name'] === 'mongodb') {
      const replicas = sts.spec?.replicas || 0;
      const readyReplicas = sts.status?.readyReplicas || 0;
      const ready = readyReplicas >= 1;
      
      console.log(`MongoDB StatefulSet ${name} ready: ${readyReplicas}/${replicas}`);
      
      return {
        ready,
        condition: {
          type: 'MongoDBReady',
          status: ready ? 'True' : 'False',
          reason: ready ? 'StatefulSetReady' : 'WaitingForPods',
          message: ready 
            ? `MongoDB StatefulSet is ready (${readyReplicas}/${replicas} replicas)`
            : `Waiting for MongoDB pods (${readyReplicas}/${replicas} replicas ready)`,
          lastTransitionTime: new Date().toISOString()
        }
      };
    }
  }
  
  return {
    ready: false,
    condition: {
      type: 'MongoDBReady',
      status: 'False',
      reason: 'StatefulSetNotFound',
      message: 'MongoDB StatefulSet not found',
      lastTransitionTime: new Date().toISOString()
    }
  };
}

/**
 * Check migration state and return detailed status
 */
function checkMigrationState(children) {
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
        return {
          phase: 'Complete',
          condition: {
            type: 'MigrationComplete',
            status: 'True',
            reason: 'JobSucceeded',
            message: 'Database migration completed successfully',
            lastTransitionTime: completeCondition?.lastTransitionTime || new Date().toISOString()
          }
        };
      } else if (failedCondition) {
        return {
          phase: 'Failed',
          condition: {
            type: 'MigrationComplete',
            status: 'False',
            reason: 'JobFailed',
            message: `Migration job failed (${failed} failures). Check job logs and delete to retry.`,
            lastTransitionTime: failedCondition?.lastTransitionTime || new Date().toISOString()
          }
        };
      } else if (active > 0) {
        return {
          phase: 'Running',
          condition: {
            type: 'MigrationComplete',
            status: 'Unknown',
            reason: 'JobRunning',
            message: 'Database migration in progress',
            lastTransitionTime: new Date().toISOString()
          }
        };
      } else {
        return {
          phase: 'Pending',
          condition: {
            type: 'MigrationComplete',
            status: 'Unknown',
            reason: 'JobPending',
            message: 'Migration job created but not started',
            lastTransitionTime: new Date().toISOString()
          }
        };
      }
    }
  }
  
  return {
    phase: 'NotStarted',
    condition: null
  };
}

/**
 * Get CDC connector status
 */
function getCDCConnectorStatus(children) {
  const connectors = children['KafkaConnector.kafka.strimzi.io/v1beta2'] || {};
  
  for (const [name, connector] of Object.entries(connectors)) {
    const state = connector.status?.connectorStatus?.connector?.state || 'UNKNOWN';
    const tasksReady = connector.status?.tasksMax || 0;
    
    return {
      name,
      state,
      condition: {
        type: 'CDCReady',
        status: state === 'RUNNING' ? 'True' : 'False',
        reason: state === 'RUNNING' ? 'ConnectorRunning' : `Connector${state}`,
        message: state === 'RUNNING' 
          ? `Kafka connector is running (${tasksReady} tasks)`
          : `Kafka connector state: ${state}`,
        lastTransitionTime: new Date().toISOString()
      }
    };
  }
  
  return null;
}

/**
 * Build Kubernetes-idiomatic status with conditions
 */
function buildStatus(parent, state) {
  const { mongoReadiness, migrationState, migrationEnabled, migrationCompleteMarker, 
          migrationCompleteStatus, cdcEnabled, children, tenantId } = state;
  
  const conditions = [];
  
  // Always add MongoDB readiness condition
  conditions.push(mongoReadiness.condition);
  
  // Add migration condition if enabled
  if (migrationEnabled && migrationState.condition) {
    conditions.push(migrationState.condition);
  }
  
  // Add CDC condition if enabled and connector exists
  if (cdcEnabled) {
    const cdcStatus = getCDCConnectorStatus(children);
    if (cdcStatus?.condition) {
      conditions.push(cdcStatus.condition);
    }
  }
  
  // Add overall Ready condition based on all components
  const allReady = mongoReadiness.ready && 
                   (!migrationEnabled || migrationState.phase === 'Complete' || migrationState.phase === 'NotStarted');
  
  conditions.push({
    type: 'Ready',
    status: allReady ? 'True' : 'False',
    reason: allReady ? 'AllComponentsReady' : 'WaitingForComponents',
    message: allReady 
      ? 'Tenant is ready and operational'
      : 'Waiting for components to become ready',
    lastTransitionTime: new Date().toISOString()
  });
  
  // Build migration status object
  const migrationStatusObj = migrationEnabled ? {
    enabled: true,
    phase: migrationState.phase,
    job: migrationState.phase !== 'NotStarted' ? `${tenantId}-migration` : null,
    complete: (migrationCompleteMarker || migrationCompleteStatus || migrationState.phase === 'Complete') ? true : false,
    completedAt: migrationState.phase === 'Complete' && !parent.status?.migration?.completedAt 
      ? new Date().toISOString() 
      : parent.status?.migration?.completedAt || null
  } : {
    enabled: false
  };
  
  // Build CDC status object
  const cdcStatusObj = cdcEnabled ? getCDCConnectorStatus(children) : { enabled: false };
  
  return {
    observedGeneration: parent.metadata?.generation,
    conditions,
    mongodb: {
      ready: mongoReadiness.ready
    },
    migration: migrationStatusObj,
    cdc: cdcStatusObj
  };
}

module.exports = compositeSync;
