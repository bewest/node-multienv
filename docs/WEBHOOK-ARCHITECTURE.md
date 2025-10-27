# Webhook Architecture and Best Practices

## Overview

This document explains the architectural patterns used in our **two-composite Metacontroller webhook handlers** (Gen 4) and how they align with Kubernetes best practices.

**Applies to**:
- Storage Composite: `storage-composite-sync.js` (Secret → MongoDB + Migration)
- Compute Composite: `compute-composite-sync.js` (ConfigMap → Nightscout + CDC)

**See also**: `docs/TWO-COMPOSITE-ARCHITECTURE.md` for the overall Gen 4 architecture.

## Core Patterns

### 1. Kubernetes-Idiomatic Status with Conditions

Following the Kubernetes pattern used by Deployments, DaemonSets, and other controllers, we report status using standardized conditions.

#### Status Structure

```json
{
  "observedGeneration": 5,
  "conditions": [
    {
      "type": "MongoDBReady",
      "status": "True",
      "reason": "StatefulSetReady",
      "message": "MongoDB StatefulSet is ready (1/1 replicas)",
      "lastTransitionTime": "2025-10-25T12:00:00Z"
    },
    {
      "type": "MigrationComplete",
      "status": "True",
      "reason": "JobSucceeded",
      "message": "Database migration completed successfully",
      "lastTransitionTime": "2025-10-25T12:05:00Z"
    },
    {
      "type": "CDCReady",
      "status": "True",
      "reason": "ConnectorRunning",
      "message": "Kafka connector is running (1 tasks)",
      "lastTransitionTime": "2025-10-25T12:10:00Z"
    },
    {
      "type": "Ready",
      "status": "True",
      "reason": "AllComponentsReady",
      "message": "Tenant is ready and operational",
      "lastTransitionTime": "2025-10-25T12:10:00Z"
    }
  ],
  "mongodb": {
    "ready": true
  },
  "migration": {
    "enabled": true,
    "phase": "Complete",
    "complete": true,
    "completedAt": "2025-10-25T12:05:00Z"
  },
  "cdc": {
    "name": "demo-cdc-source",
    "state": "RUNNING"
  }
}
```

#### Condition Types

| Type | Purpose | Status Values |
|------|---------|---------------|
| **MongoDBReady** | MongoDB StatefulSet health | True, False |
| **MigrationComplete** | Database migration status | True (complete), False (failed), Unknown (running) |
| **CDCReady** | Kafka connector status | True (running), False (not running) |
| **Ready** | Overall tenant operational status | True, False |

#### Viewing Conditions with kubectl

```bash
# Get all conditions
kubectl get cm demo-config -n hosted-tenants -o jsonpath='{.status.conditions[*]}' | jq

# Check if tenant is ready
kubectl get cm demo-config -n hosted-tenants -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'

# See migration status
kubectl get cm demo-config -n hosted-tenants -o jsonpath='{.status.conditions[?(@.type=="MigrationComplete")]}'
```

### 2. Child Preservation Pattern

**Problem:** Metacontroller deletes any child resources not returned in the webhook response. If external tools create resources or resources are created in different reconciliation phases, they could be accidentally deleted.

**Solution:** Echo back all existing children except those explicitly managed in the current reconciliation.

#### Implementation

```javascript
function preserveUnmanagedChildren(children, response) {
  const managedChildren = new Set();
  
  // Build set of managed children by kind+name
  response.children.forEach(child => {
    const key = `${child.kind}/${child.metadata.name}`;
    managedChildren.add(key);
  });
  
  // Echo back all unmanaged children
  Object.entries(children).forEach(([kindVersion, resourceMap]) => {
    Object.entries(resourceMap).forEach(([name, resource]) => {
      const key = `${resource.kind}/${name}`;
      if (!managedChildren.has(key)) {
        response.children.push(resource);  // Preserve!
      }
    });
  });
}
```

#### When Child Preservation Matters

✅ **With Preservation (Safe)**:
- External secrets added by operators → Preserved
- ConfigMaps created by other controllers → Preserved
- Debug pods created manually → Preserved
- Resources from previous phases → Preserved

❌ **Without Preservation (Dangerous)**:
- External secrets → **Deleted!**
- ConfigMaps from other tools → **Deleted!**
- Debug resources → **Deleted!**
- Resources from previous phases → **Deleted!**

#### Example Scenario

```yaml
# External operator adds a secret
apiVersion: v1
kind: Secret
metadata:
  name: external-api-key
  namespace: hosted-tenants
  labels:
    created-by: external-operator
data:
  key: <base64-encoded>
```

**Without child preservation**: Next reconciliation deletes this secret!  
**With child preservation**: Secret is echoed back in response and preserved.

### 3. Observed State vs Desired State

Following Metacontroller best practices:

#### ✅ DO: Compute status from OBSERVED state

```javascript
// Good: Based on what Metacontroller sent us
const mongoReady = isMongoReady(children);
const migrationStatus = getMigrationStatus(children);

response.status = {
  mongodb: { ready: mongoReady },
  migration: { phase: migrationStatus }
};
```

#### ❌ DON'T: Base status on desired state

```javascript
// Bad: Based on what we're trying to create
response.children.push(renderMongoDB(parent));

response.status = {
  mongodb: { ready: true }  // Wrong! MongoDB might not exist yet
};
```

### 4. ObservedGeneration Pattern

Track which version of the parent we've reconciled:

```javascript
response.status = {
  observedGeneration: parent.metadata?.generation,
  conditions: [...]
};
```

This allows users to see if status is stale:

```bash
# Check if status matches current spec
kubectl get cm demo-config -o jsonpath='{.metadata.generation}' # 5
kubectl get cm demo-config -o jsonpath='{.status.observedGeneration}' # 5

# If different, reconciliation is in progress or delayed
```

## Comparison with Other Patterns

### State Machine Pattern (lib/webhook/tenant-webhook-handler.js)

The `lib/` directory contains an alternative state machine pattern:

```javascript
switch(parent.status?.phase || 'Initial') {
  case 'Initial':
    handleStoragePhase();
    break;
  case 'StorageProvisioning':
    if (checkStorageReady()) {
      handleMigrationPhase();
    }
    break;
  // ...
}
```

**Pros:**
- Explicit phase transitions
- Clear sequential dependencies
- Easy to visualize workflow

**Cons:**
- More complex (phase handlers in separate files)
- Slower (sequential, not parallel)
- More code to maintain

### Concurrent Pattern (cmd/webhook/handlers/composite-sync.js)

Our current implementation uses concurrent rendering with gates:

```javascript
// Render all core resources
response.children.push(...renderMongoDB(parent));
response.children.push(...renderNightscout(parent));

// Conditionally render based on readiness
if (migrationEnabled && mongoReady && !migrationComplete) {
  response.children.push(renderMigrationJob(parent));
}
```

**Pros:**
- Simpler codebase (one file for orchestration)
- Faster (parallel rendering)
- Self-contained (no external phase tracking)

**Cons:**
- Less explicit about dependencies
- Readiness checks must be correct

**When to use each:**
- Use **state machine** for strict sequential workflows with complex dependencies
- Use **concurrent** for independent resources with simple gates

## Testing Patterns

### Test Kubernetes Conditions

```bash
curl -X POST http://localhost:3000/composite/sync \
  -H "Content-Type: application/json" \
  -d @test/fixtures/composite-sync-mongo-ready.json \
  | jq '.status.conditions'
```

### Test Child Preservation

```bash
# Add external resource to fixture
# Verify it appears in response.children
curl -X POST http://localhost:3000/composite/sync \
  -H "Content-Type: application/json" \
  -d @test/fixtures/composite-sync-with-external-resources.json \
  | jq '.children[] | select(.metadata.name == "external-api-key")'
```

### Test Ready Condition

```bash
# All components ready → Ready=True
curl ... | jq '.status.conditions[] | select(.type == "Ready")'
```

## Best Practices Summary

1. ✅ **Use Kubernetes conditions** for status reporting
2. ✅ **Preserve unmanaged children** to avoid accidental deletion
3. ✅ **Compute status from observed state**, not desired state
4. ✅ **Track observedGeneration** to show reconciliation progress
5. ✅ **Think "kubectl apply"** - declare desired state declaratively
6. ✅ **Be idempotent** - safe to call multiple times with same input
7. ✅ **Return HTTP 200** on success
8. ✅ **Keep webhooks pure functions** - no side effects

## References

- [Metacontroller API Documentation](https://metacontroller.github.io/metacontroller/api/compositecontroller.html)
- [Kubernetes API Conventions - Conditions](https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md#typical-status-properties)
- [Controller Best Practices](https://metacontroller.github.io/metacontroller/guide/best-practices.html)
