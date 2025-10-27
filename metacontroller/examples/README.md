# Two-Composite Architecture Examples

## Overview

This directory contains example manifests for the **Gen 4 two-composite architecture**. Each example demonstrates how to create and configure tenant resources using the storage and compute composites.

## Architecture

Gen 4 separates storage concerns (MongoDB) from compute concerns (Nightscout) using two independent Metacontroller composites:

```
┌─────────────────────────┐
│  Storage Composite      │
│  (storage-secret.yaml)  │
│                         │
│  Secret → MongoDB       │
│         → Migration     │
└─────────────────────────┘

┌─────────────────────────┐
│  Compute Composite      │
│  (compute-configmap.yaml)│
│                         │
│  ConfigMap → Nightscout │
│           → CDC         │
└─────────────────────────┘
```

## Quick Start

### 1. Create Storage (Secret)

```bash
kubectl apply -f storage-secret.yaml
```

**What it creates**:
- MongoDB StatefulSet (if `storage-type: dedicated`)
- MongoDB Service (headless)
- PVCs (for MongoDB data)

**Check status**:
```bash
kubectl get secret storage-demo -n hosted-tenants -o jsonpath='{.status}'
```

### 2. Create Compute (ConfigMap)

```bash
kubectl apply -f compute-configmap.yaml
```

**What it creates**:
- Nightscout Deployment
- Nightscout Service
- PodDisruptionBudget

**Check status**:
```bash
kubectl get configmap demo -n hosted-tenants -o jsonpath='{.status}'
```

### 3. Verify Everything is Running

```bash
# Check all resources
kubectl get all,secret,pvc -n hosted-tenants -l storage.nightscout.org/account=demo

# Check storage readiness
kubectl get secret storage-demo -n hosted-tenants -o jsonpath='{.status.conditions[?(@.type=="Ready")]}'

# Check compute readiness
kubectl get configmap demo -n hosted-tenants -o jsonpath='{.status.conditions[?(@.type=="Ready")]}'
```

## Examples

### storage-secret.yaml

**Basic dedicated MongoDB storage**

Creates a Secret that triggers the storage composite to provision a dedicated MongoDB StatefulSet.

**Key annotations**:
- `ns.mdn.io/storage-type: dedicated` - Creates StatefulSet
- `storage.nightscout.org/account: demo` - Links to compute

**Use when**: Creating a new tenant with dedicated MongoDB

---

### compute-configmap.yaml

**Nightscout application deployment**

Creates a ConfigMap that triggers the compute composite to deploy Nightscout.

**Key labels**:
- `storage.nightscout.org/account: demo` - Links to storage Secret

**Use when**: Deploying Nightscout application (after storage is ready)

---

### storage-migration-example.yaml

**Shared → Dedicated MongoDB migration workflow**

Shows the complete lifecycle of migrating from shared MongoDB to dedicated StatefulSet.

**Phases documented**:
1. Initial state (shared storage, no StatefulSet)
2. Trigger migration (add annotations)
3. Migration runs (Job created)
4. Migration completes (annotation added)

**Use when**: Migrating existing 1300 sites from Gen 3b shared MongoDB

## Storage Types

### Shared Storage

**When to use**: Existing tenants on shared MongoDB cluster (Gen 3b migration)

```yaml
apiVersion: v1
kind: Secret
metadata:
  annotations:
    ns.mdn.io/storage-type: shared  # ← No StatefulSet created
stringData:
  mongoHost: "shared-mongodb.database.svc.cluster.local"
  username: "shared-user"
  password: "shared-password"
```

**Result**: 
- ✅ No StatefulSet created (uses external cluster)
- ✅ Marked as ready immediately
- ✅ Compute can deploy Nightscout

### Dedicated Storage

**When to use**: New tenants or migrated tenants

```yaml
apiVersion: v1
kind: Secret
metadata:
  annotations:
    ns.mdn.io/storage-type: dedicated  # ← StatefulSet created
stringData:
  replicas: "1"
  storageGi: "2"
  mongoImage: "mongo:6"
  username: "nsuser"
  password: "dedicated-password"
```

**Result**:
- ✅ MongoDB StatefulSet created
- ✅ PVC provisioned
- ✅ Marked as ready when pods running

## Migration Workflow

### Trigger Migration

Add annotations to existing shared-storage Secret:

```bash
kubectl annotate secret storage-demo \
  ns.mdn.io/migration-needed=true \
  ns.mdn.io/migration-source-uri=mongodb://user:pass@shared-mongodb:27017/nightscout
  
kubectl patch secret storage-demo --type=merge -p '
metadata:
  annotations:
    ns.mdn.io/storage-type: dedicated
data:
  replicas: MQ==          # "1" base64
  storageGi: Mg==         # "2" base64  
  mongoImage: bW9uZ286Ng== # "mongo:6" base64
'
```

### Monitor Migration

```bash
# Watch migration progress
kubectl get secret storage-demo -n hosted-tenants -w -o jsonpath='{.status.migration}'

# Check migration Job logs
kubectl logs -n hosted-tenants job/demo-migration

# Verify migration complete
kubectl get secret storage-demo -n hosted-tenants \
  -o jsonpath='{.status.conditions[?(@.type=="MigrationComplete")]}'
```

### Migration Complete

Storage composite automatically adds annotation when Job succeeds:

```yaml
metadata:
  annotations:
    ns.mdn.io/migration-complete: "true"
```

## Label-Based Linking

Storage and compute resources link via `storage.nightscout.org/account` label:

**Storage Secret**:
```yaml
metadata:
  name: storage-demo
  labels:
    storage.nightscout.org/account: demo  # ← Account identifier
```

**Compute ConfigMap**:
```yaml
metadata:
  name: demo  
  labels:
    storage.nightscout.org/account: demo  # ← Must match storage
```

Compute composite uses related resources to discover storage:

```javascript
relatedResourceRules: [
  {
    apiVersion: 'v1',
    resource: 'secrets',
    labelSelector: {
      matchLabels: {
        'storage.nightscout.org/account': storageAccountLabel,
        'ns.mdn.io/composite': 'storage'
      }
    }
  }
]
```

## Blast Radius Protection

Related resources survive parent deletion:

**Scenario 1: Delete Storage Secret**
```bash
kubectl delete secret storage-demo
```
- ✅ StatefulSet deleted (child resource)
- ✅ PVC **survives** (created by StatefulSet, not owned by Secret)
- ✅ Recreate Secret → StatefulSet → mounts existing PVC → data intact

**Scenario 2: Delete Compute ConfigMap**
```bash
kubectl delete configmap demo
```
- ✅ Nightscout Deployment deleted (child resource)
- ✅ Storage Secret **survives** (related, not owned)
- ✅ MongoDB **survives** (related, not owned)
- ✅ Database untouched

## Status Conditions

Both composites report Kubernetes-idiomatic status:

### Storage Status

```yaml
status:
  conditions:
    - type: Ready
      status: "True"
      reason: StatefulSetReady
    - type: MigrationComplete
      status: "True"
      reason: JobSucceeded
  storage:
    type: dedicated
    host: demo-mongodb
    ready: true
  migration:
    enabled: true
    phase: Complete
```

### Compute Status

```yaml
status:
  conditions:
    - type: MongoDBReady
      status: "True"
      reason: StatefulSetReady
    - type: Ready
      status: "True"
      reason: AllComponentsReady
  storage:
    account: demo
    mongoReady: true
```

## Common Patterns

### Create Shared Storage Tenant

```bash
# 1. Create storage Secret (shared)
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Secret
metadata:
  name: storage-tenant-a
  namespace: hosted-tenants
  labels:
    ns.mdn.io/composite: storage
    storage.nightscout.org/account: tenant-a
  annotations:
    ns.mdn.io/storage-type: shared
stringData:
  mongoHost: "shared-mongodb.database.svc.cluster.local"
  username: "shared-user"
  password: "shared-password"
  database: "nightscout"
EOF

# 2. Create compute ConfigMap
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: tenant-a
  namespace: hosted-tenants
  labels:
    ns.mdn.io/composite: compute
    storage.nightscout.org/account: tenant-a
data:
  TENANT_ID: tenant-a
  NS_IMAGE: nightscout/cgm-remote-monitor:latest
  NS_REPLICAS: "2"
EOF
```

### Create Dedicated Storage Tenant

```bash
# 1. Create storage Secret (dedicated)
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Secret
metadata:
  name: storage-tenant-b
  namespace: hosted-tenants
  labels:
    ns.mdn.io/composite: storage
    storage.nightscout.org/account: tenant-b
  annotations:
    ns.mdn.io/storage-type: dedicated
stringData:
  replicas: "1"
  storageGi: "2"
  mongoImage: "mongo:6"
  username: "nsuser"
  password: "secure-password"
  database: "nightscout"
EOF

# 2. Wait for storage ready
kubectl wait --for=condition=Ready secret/storage-tenant-b -n hosted-tenants --timeout=5m

# 3. Create compute ConfigMap
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: tenant-b
  namespace: hosted-tenants
  labels:
    ns.mdn.io/composite: compute
    storage.nightscout.org/account: tenant-b
data:
  TENANT_ID: tenant-b
  NS_IMAGE: nightscout/cgm-remote-monitor:latest
  NS_REPLICAS: "2"
EOF
```

## See Also

- [Two-Composite Architecture](../../docs/TWO-COMPOSITE-ARCHITECTURE.md) - Full architecture documentation
- [Architecture Evolution](../../docs/ARCHITECTURE-EVOLUTION.md) - Design decisions and rationale
- [Webhook Architecture](../../docs/WEBHOOK-ARCHITECTURE.md) - Webhook implementation patterns
