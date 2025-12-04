# Metacontroller Integration Guide

> **Note**: This is a technical reference for Metacontroller webhook protocol. For Gen 4 architecture and implementation, see [TWO-COMPOSITE-ARCHITECTURE.md](TWO-COMPOSITE-ARCHITECTURE.md).

## Overview

This document describes how the webhook server integrates with Metacontroller and provides the technical details for the webhook protocol implementation in the **two-composite architecture**.

## Version Requirements

**Metacontroller v4.0 or higher is required** for the Gen 4 architecture. The Jsonnet library generates CompositeController CRDs with `revisionHistory` fields, which are mandatory in Metacontroller v4.x+.

- **Tested Version**: v4.12.0
- **Minimum Version**: v4.0.0
- **Required Feature**: `parentResource.revisionHistory.fieldPaths` support

The `revisionHistory` field tells Metacontroller which fields to track for changes (e.g., `data` field in ConfigMaps/Secrets). Without this field, v4.x will return errors like `"CustomResourceDefinition.apiextensions.k8s.io \"configmaps.\" not found"`.

## Child Update Strategies and ControllerRevision

Understanding update strategies is critical for reliable reconciliation. The choice of strategy determines whether Metacontroller uses the ControllerRevision machinery, which has significant implications for performance and error handling.

### Update Strategy Decision Tree

| Strategy | ControllerRevision Created? | Best For | Behavior |
|----------|---------------------------|----------|----------|
| **OnDelete** | No | Manual control | Updates only when child is externally deleted |
| **Recreate** | No | Single children, morphing lifecycles | Delete + recreate immediately on change |
| **InPlace** | No | Mutable resources (Secrets, ConfigMaps) | Patch existing resource in place |
| **RollingRecreate** | **Yes** | Multi-replica StatefulSet-like Pods | Gradual rollout, one at a time |
| **RollingInPlace** | **Yes** | Multi-replica with in-place updates | Gradual patch, one at a time |

### When ControllerRevision Machinery Activates

The ControllerRevision system activates when **any** child resource uses a rolling update strategy (`RollingRecreate` or `RollingInPlace`). This is determined by the CompositeController configuration, not by the actual children returned by the webhook.

```go
// From Metacontroller source: pkg/controller/composite/controller_revision.go
if !pc.updateStrategy.anyRolling() || ... {
    // Skip revision machinery - direct sync
    syncResult, err := pc.callHook(parent, observedChildren, relatedObjects)
}
// Otherwise, full revision tracking enabled
```

**Key insight**: Even if your webhook returns `children: []`, the ControllerRevision machinery runs if any child type is configured with rolling updates.

### ControllerRevision Race Condition

When rolling updates are enabled, Metacontroller creates ControllerRevision objects to track parent spec changes. A race condition can occur:

1. **Sync 1** starts → creates ControllerRevision in etcd
2. **Sync 2** starts immediately (before informer cache updates)
3. **Sync 2** reads from stale cache → doesn't find ControllerRevision
4. **Sync 2** tries to create → **"already exists" error**

```
Error: can't create ControllerRevision nightscouttenants.nightscout.io-38fe168c954...
controllerrevisions.metacontroller.k8s.io "..." already exists
```

This error is transient and typically resolves once the informer cache syncs, but it can cause reconciliation failures during rapid parent updates.

### Strategy Selection Guidelines

**Use `Recreate` when:**
- Managing single-instance resources (one Pod per tenant)
- Children "morph" during lifecycle phases (e.g., Init → Storage → Compute)
- Parent updates are frequent during initialization
- You don't need gradual rollouts

**Use `RollingRecreate` when:**
- Managing multiple identical replicas (StatefulSet-like patterns)
- Gradual rollout is important (one Pod at a time)
- Parent spec changes are infrequent after initial creation
- Children are stable (not appearing/disappearing based on lifecycle)

**Use `InPlace` when:**
- Resource supports patching (Secrets, ConfigMaps, Deployments)
- You want to preserve Pod identity during config changes
- Minimizing Pod restarts is important

### Recommended Configuration for Tenant Composite

For single-Pod-per-tenant architectures with lifecycle phases:

```yaml
childResources:
  - apiVersion: v1
    resource: pods
    updateStrategy:
      method: Recreate  # NOT RollingRecreate
  - apiVersion: v1
    resource: secrets
    updateStrategy:
      method: InPlace
```

**Why `Recreate` over `RollingRecreate`:**
1. Single Pod has nothing to "roll" - it's all-or-nothing
2. Avoids ControllerRevision machinery and race conditions
3. Simpler debugging (no revision tracking to understand)
4. Better for morphing children patterns (lifecycle phases)

### revisionHistory.fieldPaths Optimization

Even with non-rolling strategies, `revisionHistory.fieldPaths` affects how Metacontroller detects changes:

```yaml
parentResource:
  apiVersion: nightscout.io/v1alpha1
  resource: nightscouttenants
  revisionHistory:
    fieldPaths:
      - spec.nightscoutImage  # Only image changes trigger child updates
      - spec.mongodbVersion
```

**Narrower paths = fewer spurious syncs.** The CatSet example uses `spec.template` rather than the full `spec`, reducing hash changes.

### Debugging ControllerRevision Issues

```bash
# List all ControllerRevisions
kubectl get controllerrevisions.metacontroller.k8s.io -n <namespace>

# Check revision ownership
kubectl get controllerrevisions.metacontroller.k8s.io <name> -n <namespace> \
  -o jsonpath='{.metadata.ownerReferences}'

# Delete orphaned revisions (if needed)
kubectl delete controllerrevisions.metacontroller.k8s.io -n <namespace> --all
```

## Metacontroller Webhook Protocol

Metacontroller uses a webhook-based reconciliation model. Controllers watch resources and call webhooks to determine desired state.

### CompositeController Protocol

#### Sync Hook Request
```json
{
  "controller": {
    "metadata": {
      "name": "nightscout-tenant-controller"
    }
  },
  "parent": {
    "apiVersion": "v1",
    "kind": "ConfigMap",
    "metadata": { ... },
    "data": { ... }
  },
  "children": {
    "Secret.v1": { "secret-name": { ... } },
    "StatefulSet.apps/v1": { "sts-name": { ... } }
  }
}
```

#### Sync Hook Response
```json
{
  "status": {
    "mongo": {
      "ready": true
    }
  },
  "children": [
    { "apiVersion": "v1", "kind": "Secret", ... },
    { "apiVersion": "apps/v1", "kind": "StatefulSet", ... }
  ]
}
```

**Key Points:**
- Return array of desired children
- Metacontroller performs diff and applies changes
- Status updates set on parent resource
- Children not in response are deleted

#### Finalize Hook Request
Same as sync request, but sent when parent has deletionTimestamp.

#### Finalize Hook Response
```json
{
  "status": {
    "finalized": true
  },
  "children": [...]
}
```

**Key Points:**
- Return desired state during finalization (e.g., scaled down)
- Returning no children allows deletion to proceed
- Can run multiple finalization cycles

### DecoratorController Protocol

#### Sync Hook Request
```json
{
  "controller": {
    "metadata": {
      "name": "pvc-backup-decorator"
    }
  },
  "object": {
    "apiVersion": "v1",
    "kind": "PersistentVolumeClaim",
    "metadata": { ... },
    "spec": { ... }
  },
  "attachments": [
    { "apiVersion": "snapshot.storage.k8s.io/v1", "kind": "VolumeSnapshot", ... }
  ]
}
```

#### Sync Hook Response
```json
{
  "attachments": [
    {
      "apiVersion": "v1",
      "kind": "PersistentVolumeClaim",
      "metadata": {
        "annotations": {
          "ns.mdn.io/backup-policy": "snapshot"
        },
        "finalizers": ["mdn.io/backup-protect"]
      }
    }
  ]
}
```

**Key Points:**
- Return modified object (PVC with annotations/finalizers)
- Attachments are related resources (VolumeSnapshots)
- Decorator doesn't manage children, only decorates the target

#### Finalize Hook Request
Same as sync request, but object has deletionTimestamp.

#### Finalize Hook Response
```json
{
  "finalized": true,
  "attachments": [
    { "apiVersion": "snapshot.storage.k8s.io/v1", "kind": "VolumeSnapshot", ... }
  ]
}
```

**Key Points:**
- `finalized: true` removes finalizer, allowing deletion
- Can create attachments during finalization (e.g., snapshots)
- Runs in loops until finalized

## Implementation Details

### CompositeController Sync Logic

```javascript
// 1. Check if CDC is enabled
const cdcEnabled = parent.data?.CDC_ENABLED === 'true';

// 2. Always render core resources
response.children.push(...renderMongoDB(parent));
response.children.push(...renderNightscout(parent));

// 3. If CDC enabled, render topics
if (cdcEnabled) {
  response.children.push(...renderKafkaTopics(parent));
  
  // 4. Only create connector after MongoDB ready
  const mongoReady = isMongoReady(children);
  if (mongoReady) {
    response.children.push(renderKafkaConnector(parent));
  }
}

// 5. Update status
response.status = {
  mongo: { ready: mongoReady },
  connector: getConnectorStatus(children)
};
```

### MongoDB Readiness Check

```javascript
function isMongoReady(children) {
  const statefulSets = children['StatefulSet.apps/v1'] || {};
  
  for (const [name, sts] of Object.entries(statefulSets)) {
    if (name.includes('ns-mongo')) {
      return sts.status?.readyReplicas >= 1;
    }
  }
  
  return false;
}
```

### CompositeController Finalize Logic

```javascript
// 1. Check if connector exists and needs pausing
for (const [name, connector] of Object.entries(connectors)) {
  if (!connector.spec?.pause) {
    // First cycle: pause connector
    response.children.push({
      ...connector,
      spec: { ...connector.spec, pause: true }
    });
  } else {
    // Subsequent cycles: wait for idle, then delete
    const taskState = connector.status?.connectorStatus?.tasks?.[0]?.state;
    if (taskState !== 'RUNNING') {
      // Don't include in children = delete
    } else {
      // Keep connector until tasks idle
      response.children.push(connector);
    }
  }
}

// 2. Scale down Nightscout
for (const [name, deployment] of Object.entries(deployments)) {
  if (name.includes('nightscout')) {
    response.children.push({
      ...deployment,
      spec: { ...deployment.spec, replicas: 0 }
    });
  }
}
```

### DecoratorController Sync Logic

```javascript
// Add annotations and finalizer
const pvc = {
  ...object,
  metadata: {
    ...object.metadata,
    annotations: {
      ...object.metadata.annotations,
      'ns.mdn.io/backup-policy': object.metadata.annotations?.['ns.mdn.io/backup-policy'] || 'snapshot',
      'ns.mdn.io/backup-ttl': object.metadata.annotations?.['ns.mdn.io/backup-ttl'] || '30d'
    },
    finalizers: [
      ...(object.metadata.finalizers || []),
      'mdn.io/backup-protect'
    ].filter((v, i, a) => a.indexOf(v) === i) // dedupe
  }
};

response.attachments.push(pvc);
```

### DecoratorController Finalize Logic

```javascript
const backupPolicy = object.metadata?.annotations?.['ns.mdn.io/backup-policy'];

// 1. If policy is skip, immediately finalize
if (backupPolicy === 'skip') {
  return { finalized: true, attachments: [] };
}

// 2. Check if snapshot exists and is ready
const snapshotName = `${pvcName}-final-snapshot`;
let snapshotReady = false;

for (const snapshot of attachments) {
  if (snapshot.kind === 'VolumeSnapshot' && snapshot.metadata.name === snapshotName) {
    snapshotReady = snapshot.status?.readyToUse === true;
    break;
  }
}

// 3. If snapshot not ready, create/wait
if (!snapshotReady) {
  const volumeSnapshot = {
    apiVersion: 'snapshot.storage.k8s.io/v1',
    kind: 'VolumeSnapshot',
    metadata: { name: snapshotName, namespace: namespace },
    spec: {
      volumeSnapshotClassName: 'csi-snapclass',
      source: { persistentVolumeClaimName: pvcName }
    }
  };
  
  return { finalized: false, attachments: [volumeSnapshot] };
}

// 4. Snapshot ready, finalize
return { finalized: true, attachments: existingAttachments };
```

## Reconciliation Loops

### CompositeController Loop
1. User creates ConfigMap with label
2. Metacontroller calls `/composite/sync`
3. Webhook returns desired children
4. Metacontroller creates/updates children
5. **Loop**: Every 30s or when children change
6. MongoDB becomes ready → next sync creates connector

### DecoratorController Loop
1. MongoDB StatefulSet creates PVC
2. PVC matches label selector
3. Metacontroller calls `/decorator/sync`
4. Webhook returns PVC with annotations/finalizer
5. Metacontroller updates PVC
6. **Loop**: Every 30s

### Finalization Loop
1. User deletes ConfigMap
2. Kubernetes sets deletionTimestamp
3. Metacontroller calls `/composite/finalize`
4. Webhook returns scaled-down state
5. Metacontroller applies changes
6. **Loop**: Until finalized
7. Once finalized, Metacontroller removes its finalizer
8. ConfigMap deletes

## Error Handling

### Webhook Errors
- **500 status**: Metacontroller retries with exponential backoff
- **4xx status**: Logged but not retried
- **Timeout**: Configured per hook (30s default)

### Transient Failures
Use status conditions to track errors:
```javascript
response.status = {
  conditions: [{
    type: 'Reconciliation',
    status: 'False',
    reason: 'MongoDBNotReady',
    message: 'Waiting for MongoDB to become ready',
    lastTransitionTime: new Date().toISOString()
  }]
};
```

### Permanent Failures
Mark parent resource as failed:
```javascript
response.status = {
  phase: 'Failed',
  conditions: [{
    type: 'Reconciliation',
    status: 'False',
    reason: 'InvalidConfiguration',
    message: 'TENANT_ID is required but not provided'
  }]
};
```

## Best Practices

### 1. Idempotency
Webhooks are called repeatedly. Ensure:
- Same input → same output
- No side effects (Metacontroller handles K8s changes)
- Password generation should be stable (or use existing secret)

### 2. Resource Ownership
- Parent owns children via `metadata.ownerReferences` (automatic)
- Deleting parent cascades to children
- Don't create children in other namespaces

### 3. Status Updates
- Use status to track phase/conditions
- Don't store large data in status
- Update status every sync

### 4. Performance
- Minimize webhook response time
- Avoid K8s API calls in webhook (use provided children)
- Cache expensive computations

### 5. Observability
- Log all sync/finalize calls
- Include parent name/namespace in logs
- Return detailed status conditions

## Testing Webhooks

### Unit Testing
```bash
curl -X POST http://localhost:3000/composite/sync \
  -H "Content-Type: application/json" \
  -d @test/fixtures/composite-sync-request.json
```

### Integration Testing
```bash
# Apply controller
kubectl apply -f k8s/metactl/composite-controller.yaml

# Apply parent
kubectl apply -f k8s/metactl/example-tenant.yaml

# Watch reconciliation
kubectl get cm,secret,svc,sts,deploy -l ns.mdn.io/tenant=demo -w
```

### Debugging
```bash
# Webhook logs
kubectl logs -l app=webhook-service -f

# Metacontroller logs
kubectl logs -n metacontroller -l app=metacontroller -f

# Parent status
kubectl get cm tenant-demo -o yaml
```

## References

- [Metacontroller Documentation](https://metacontroller.github.io/metacontroller/)
- [CompositeController Spec](https://metacontroller.github.io/metacontroller/api/compositecontroller.html)
- [DecoratorController Spec](https://metacontroller.github.io/metacontroller/api/decoratorcontroller.html)
- [Webhook Architecture](https://metacontroller.github.io/metacontroller/concepts.html#hooks)
