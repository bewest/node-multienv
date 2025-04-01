
# Webhook Phase Management for Complex Resources

## Overview
When managing complex resources with multiple CRDs through MetaController, the webhook handlers need to implement phase-based logic to coordinate state transitions across resources.

## Phase Management Patterns

### 1. Status-Based Phase Transitions
```javascript
function handleSync(parent, children) {
  const response = {
    status: {
      phase: parent.status?.phase || 'Pending',
      conditions: []
    },
    children: []
  };

  switch(response.status.phase) {
    case 'Pending':
      // Initial phase - create TenantStorage
      response.children.push(createTenantStorageResource(parent));
      response.status.phase = 'StorageProvisioning';
      break;

    case 'StorageProvisioning':
      // Check if storage is ready
      const storage = children.TenantStorage?.[0];
      if (storage?.status?.ready) {
        response.status.phase = 'DatabaseInitializing';
        response.children.push(createDatabaseInitJob(parent, storage));
      }
      break;

    case 'DatabaseInitializing':
      // Check init job completion
      const initJob = children.Job?.find(j => j.metadata.labels['purpose'] === 'init');
      if (initJob?.status?.succeeded) {
        response.status.phase = 'Ready';
        response.children.push(createNightscoutDeployment(parent));
      }
      break;
  }

  return response;
}
```

### 2. Cross-CRD Dependencies
```javascript
function checkDependencies(parent, children) {
  const conditions = [];
  
  // Check TenantStorage dependency
  if (!children.TenantStorage?.[0]?.status?.ready) {
    conditions.push({
      type: 'StorageReady',
      status: 'False',
      reason: 'StorageNotProvisioned'
    });
    return false;
  }

  // Check Database initialization
  if (!children.Secret?.[0]?.data?.['database.ready']) {
    conditions.push({
      type: 'DatabaseReady',
      status: 'False',
      reason: 'DatabaseNotInitialized'
    });
    return false;
  }

  return true;
}
```

### 3. Rollback Handling
```javascript
function handleFailure(parent, children, phase) {
  const response = { status: {}, children: [] };
  
  switch(phase) {
    case 'DatabaseInitializing':
      // Cleanup failed init job
      response.children = children.Job
        .filter(j => j.status?.failed)
        .map(j => ({
          apiVersion: j.apiVersion,
          kind: j.kind,
          metadata: { name: j.metadata.name },
          deleteJob: true
        }));
      response.status.phase = 'StorageProvisioning';
      break;
  }
  
  return response;
}
```

## Best Practices

1. **Immutable Phase History**
   - Record phase transitions in status.conditions
   - Never skip phases
   - Include timestamps for transitions

2. **Dependency Management**
   - Check all dependencies before phase transition
   - Use condition arrays to track multiple dependencies
   - Implement timeouts for stuck phases

3. **Error Handling**
   - Define clear rollback paths
   - Preserve error context in status
   - Implement retry limits per phase

4. **Status Propagation**
   - Bubble up status from child resources
   - Aggregate health checks
   - Maintain detailed progress information
