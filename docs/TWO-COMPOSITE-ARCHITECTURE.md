# Two-Composite Architecture: Storage and Compute Separation

## Overview

The two-composite architecture separates storage (MongoDB) from compute (Nightscout deployment) concerns using distinct Metacontroller composites. This design provides credential isolation, independent lifecycles, and blast radius protection.

## Design Goals

1. **Credential Isolation**: Environs API cannot see storage credentials (stored in Secret, not ConfigMap)
2. **Blast Radius Protection**: Related resources survive parent deletion (PVC, StatefulSet protected)
3. **Independent Lifecycles**: Storage upgrades (shared → dedicated) don't affect compute
4. **Mixed Environment**: Gen 3b and Gen 4 run simultaneously via label-based routing
5. **Gradual Migration**: 1300 existing sites migrate one-at-a-time using label changes

## Architecture

### Storage Composite

**Parent**: Secret (labeled `ns.mdn.io/composite=storage`)

**Children** (owned, deleted with parent):
- MongoDB StatefulSet (if `storage-type=dedicated`)
- MongoDB Service (headless)
- Migration Job (if `ns.mdn.io/migration-needed=true`)

**Related** (discovered, NOT deleted with parent):
- PersistentVolumeClaim (created by StatefulSet volumeClaimTemplates)

**Webhook**: `POST /composite/storage/sync`

### Compute Composite

**Parent**: ConfigMap (labeled `ns.mdn.io/composite=compute`)

**Children** (owned, deleted with parent):
- Nightscout Deployment
- Nightscout Service
- PodDisruptionBudget
- Optional: KafkaTopic, KafkaConnector, Jobs

**Related** (discovered, NOT deleted with parent):
- Storage Secret (provides MongoDB credentials)
- MongoDB StatefulSet (blast radius protection)

**Webhook**: `POST /composite/compute/sync`

## Annotation-Driven Behavior

### Storage Composite Annotations

```yaml
metadata:
  annotations:
    # Storage Type (required)
    ns.mdn.io/storage-type: "shared" | "dedicated"
    
    # Migration Control
    ns.mdn.io/migration-needed: "true"  # Triggers migration Job
    ns.mdn.io/migration-source-uri: "mongodb://..."  # Source MongoDB URI
    ns.mdn.io/migration-complete: "true"  # Prevents re-running
    
    # Migration Configuration (optional)
    ns.mdn.io/migration-image: "mongo:6"
    ns.mdn.io/migration-method: "mongodump-restore"
```

### Storage Type Behavior

| Storage Type | StatefulSet Created? | PVC Created? | Migration Supported? |
|--------------|---------------------|--------------|---------------------|
| `shared` | ❌ No (uses external cluster) | ❌ No | ❌ No (source only) |
| `dedicated` | ✅ Yes (per-tenant) | ✅ Yes (via volumeClaimTemplates) | ✅ Yes |

### Compute Composite Labels

```yaml
metadata:
  labels:
    ns.mdn.io/composite: compute  # Triggers compute controller
    storage.nightscout.org/account: demo-account  # Links to storage Secret
```

## Blast Radius Protection

### Scenario 1: Storage Secret Deleted

```
Storage Secret deleted
  ↓
StatefulSet deleted (child resource)
  ↓
PVC SURVIVES (related resource, not owned)
  ↓
Recreate Secret with same labels
  ↓
StatefulSet recreated, mounts existing PVC
  ↓
Data intact ✅
```

### Scenario 2: Compute ConfigMap Deleted

```
Compute ConfigMap deleted
  ↓
Nightscout Deployment deleted (child resource)
  ↓
Storage Secret SURVIVES (related resource, not owned)
MongoDB StatefulSet SURVIVES (related resource, not owned)
PVC SURVIVES (related to StatefulSet)
  ↓
Database intact ✅
```

## Migration Workflow

### Shared → Dedicated MongoDB Migration

**Step 1: Initial State (Shared)**
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: storage-demo
  labels:
    ns.mdn.io/composite: storage
    storage.nightscout.org/account: demo
  annotations:
    ns.mdn.io/storage-type: shared  # ← No StatefulSet
stringData:
  mongoHost: "shared-mongodb.database.svc.cluster.local"
  username: "shared-user"
  password: "shared-password"
```

**Result**: No StatefulSet created, uses shared MongoDB cluster

---

**Step 2: Trigger Migration**
```bash
kubectl annotate secret storage-demo \
  ns.mdn.io/storage-type=dedicated \
  ns.mdn.io/migration-needed=true \
  ns.mdn.io/migration-source-uri=mongodb://shared-user:shared-password@shared-mongodb:27017/nightscout

kubectl patch secret storage-demo --type=json -p='[
  {"op": "add", "path": "/stringData/replicas", "value": "1"},
  {"op": "add", "path": "/stringData/storageGi", "value": "2"},
  {"op": "add", "path": "/stringData/mongoImage", "value": "mongo:6"}
]'
```

**Result**: 
1. StatefulSet created (storage-type changed to dedicated)
2. Migration Job created (migration-needed annotation)
3. Data copied from shared to dedicated MongoDB

---

**Step 3: Migration Completes**

Storage controller adds annotation:
```yaml
annotations:
  ns.mdn.io/migration-complete: "true"
  ns.mdn.io/migration-completed-at: "2025-01-15T12:30:00Z"
```

**Result**: Migration Job no longer rendered, tenant uses dedicated MongoDB

## Mixed Environment Migration

### Label-Based Routing

**Gen 3b (deployment-controller)**:
```yaml
labels:
  ns.mdn.io/controller: deployment  # ← Triggers deployment-controller
  managed: multienv
```

**Gen 4 (compute composite)**:
```yaml
labels:
  ns.mdn.io/composite: compute  # ← Triggers compute composite
  storage.nightscout.org/account: demo-account
```

Both controllers run simultaneously - label determines which handles each tenant.

### Migration Utility

```bash
# Dry run - see what would happen
node cmd/migrate-to-two-composite.js --dry-run

# Migrate single tenant
node cmd/migrate-to-two-composite.js --tenant demo

# Migrate batch (10 at a time)
node cmd/migrate-to-two-composite.js --batch 10

# Migrate all (with confirmation)
node cmd/migrate-to-two-composite.js --all
```

**What it does**:
1. Creates storage Secret from ConfigMap (extracts credentials)
2. Updates ConfigMap labels (`controller` → `composite`)
3. Removes credentials from ConfigMap
4. Links ConfigMap to storage account

## Status Reporting

### Storage Composite Status

```yaml
status:
  observedGeneration: 1
  conditions:
    - type: Ready
      status: "True"
      reason: StatefulSetReady
      message: "MongoDB StatefulSet is ready (1/1 replicas)"
    - type: MigrationComplete
      status: "True"
      reason: JobSucceeded
      message: "Database migration completed successfully"
  storage:
    type: dedicated
    host: demo-mongodb
    ready: true
    replicas: "1/1"
  migration:
    enabled: true
    phase: Complete
    complete: true
```

### Compute Composite Status

```yaml
status:
  observedGeneration: 1
  conditions:
    - type: MongoDBReady
      status: "True"
      reason: StatefulSetReady
      message: "MongoDB StatefulSet is ready (1/1 replicas)"
    - type: Ready
      status: "True"
      reason: AllComponentsReady
      message: "Tenant is ready and operational"
  storage:
    account: demo-account
    mongoReady: true
```

## Implementation Files

| Component | File |
|-----------|------|
| Storage Webhook | `cmd/webhook/handlers/storage-composite-sync.js` |
| Compute Webhook | `cmd/webhook/handlers/compute-composite-sync.js` |
| Storage Controller | `metacontroller/controllers/storage-composite.yaml` |
| Compute Controller | `metacontroller/controllers/compute-composite.yaml` |
| Migration Utility | `cmd/migrate-to-two-composite.js` |
| Examples | `metacontroller/examples/storage-*.yaml` |

## Benefits

### Security
- ✅ Storage credentials in Secret (not ConfigMap)
- ✅ Environs API cannot see credentials
- ✅ Compute composite uses Secret reference only

### Reliability
- ✅ PVC survives Secret deletion (related resource)
- ✅ Storage survives ConfigMap deletion (related resource)
- ✅ Can recreate controllers without data loss

### Flexibility
- ✅ Shared → Dedicated migration via annotations
- ✅ Independent storage/compute lifecycles
- ✅ Gradual rollout (1300 sites migrate one-at-a-time)

### Operational
- ✅ Mixed Gen 3b/Gen 4 environment
- ✅ No downtime migration path
- ✅ Label-based routing (automatic)
- ✅ Annotation-driven behavior (declarative)

## See Also

- [Storage Migration Example](../metacontroller/examples/storage-migration-example.yaml)
- [Compute ConfigMap Example](../metacontroller/examples/compute-configmap.yaml)
- [Architecture Evolution](./ARCHITECTURE-EVOLUTION.md)
- [Component Separation](../COMPONENT-SEPARATION-SUMMARY.md)
