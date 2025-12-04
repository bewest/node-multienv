# Two-Composite Architecture: Storage and Compute Separation

## Overview

The two-composite architecture separates storage (MongoDB) from compute (Nightscout deployment) concerns using distinct Metacontroller composites. This design provides credential isolation, independent lifecycles, and blast radius protection.

## Design Goals

1. **Credential Isolation**: Environs API cannot see storage credentials (stored in Secret, not ConfigMap)
2. **Blast Radius Protection**: Related resources survive parent deletion (PVC, StatefulSet protected)
3. **Independent Lifecycles**: Storage upgrades (shared → dedicated) don't affect compute
4. **Mixed Environment**: Gen 3b and Gen 4 run simultaneously via label-based routing
5. **Gradual Migration**: 1300 existing sites migrate one-at-a-time using label changes

## Gen 4 Component Architecture

Gen 4 introduces Metacontroller-based webhooks with Custom Resource Definitions (CRDs) for orchestration while preserving critical Gen 1-3 components for specific purposes:

### Active Components in Gen 4

**New: Metacontroller Webhooks with CRDs**
- **multienv-metactl-webhooks**: Provides declarative API via Kubernetes CRDs
  - Handles Storage composite (StorageAccount CRD → MongoDB StatefulSet + Migration)
  - Handles Compute composite (ComputeInstance CRD → Nightscout Deployment + CDC)
  - Handles PVC decorator (backup policy enforcement)
  - Entry point: `cmd/webhook/server.js`
  - Port: 3000
  - **CRDs**: `StorageAccount` and `ComputeInstance` in `nightscout.io` API group

**Preserved: Frontend API**
- **deployment-controller**: Provides `/environs/` REST API for frontend dashboard
  - Allows users to personalize configuration via web interface
  - Handles account/site provisioning endpoints
  - Entry point: `k8s-deployment-controller.js`
  - **Why kept**: Frontend dashboard depends on this API

**Preserved: Service Discovery**
- **deployment-operator**: Watches pods and syncs Consul updates
  - Entry point: `k8s-dispatcher.js` with `SYNC_CONTROLLER="deployment"`
  - **Why kept**: Maintains Consul service discovery state
- **resolver**: Traffic routing via Consul DNS
  - Entry point: `redirector-server.js`
  - **Why kept**: Core traffic component for tenant HTTP requests

**Preserved: Health Validation**
- **tenant-pod-healthcheck**: Sidecar for localhost-based health checks
  - Entry point: `cmd/pod-healthcheck/server.js`
  - **Why kept**: Eliminates DNS/API bottlenecks, enables 10,000+ tenant scaling

**Optional: Alternative APIs**
- **inspector**: Alternative `/environs/` API using direct K8s access
  - Entry point: `k8s-inspector.js`
  - **Use case**: Lightweight environments without full deployment-controller

### Deprecated Components in Gen 4

**Replaced by Metacontroller:**
- **dispatcher** (ConfigMap watcher): Metacontroller handles ConfigMap watching and triggers webhooks
- **deployment-controller orchestration**: Webhooks generate resources, deployment-controller only serves API

**Legacy (Gen 1):**
- **multienv**: Single-host architecture (master.js + redirector-server.js + nginx)
- **runner**: Process manager (master.js)
- **Status**: Not used in Kubernetes-based deployments

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                      Gen 4 Architecture                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  kubectl apply -f storageaccount.yaml                           │
│  kubectl apply -f computeinstance.yaml                          │
│         │                                                        │
│         ▼                                                        │
│  ┌──────────────────┐                                           │
│  │ Metacontroller   │  Watches CRDs:                            │
│  │  (External)      │  - storageaccounts.nightscout.io          │
│  │                  │  - computeinstances.nightscout.io         │
│  └────────┬─────────┘                                           │
│           │                                                      │
│           │ HTTP POST (customize + sync hooks)                  │
│           ▼                                                      │
│  ┌──────────────────────────────────┐                           │
│  │ multienv-metactl-webhooks        │  Gen 4 Orchestration      │
│  │  /composite/storage/customize    │  - Discover related       │
│  │  /composite/storage/sync         │  - Generate StatefulSets  │
│  │  /composite/compute/customize    │  - Generate Deployments   │
│  │  /composite/compute/sync         │  - Update CRD status      │
│  │  /decorator/sync                 │  - Inject backup policies │
│  └──────────────────────────────────┘                           │
│                                                                  │
│  ┌────────────────────────────┐                                 │
│  │  deployment-controller     │  Preserved for:                 │
│  │  /environs/ API            │  - Frontend dashboard           │
│  │  /accounts/ API            │  - User configuration           │
│  └────────────────────────────┘                                 │
│                                                                  │
│  ┌────────────────────────────┐                                 │
│  │  deployment-operator       │  Preserved for:                 │
│  │  Pod → Consul sync         │  - Service discovery            │
│  └────────────────────────────┘                                 │
│                                                                  │
│  ┌────────────────────────────┐                                 │
│  │  resolver                  │  Preserved for:                 │
│  │  redirector-server.js      │  - Traffic routing              │
│  └────────────────────────────┘                                 │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Migration Summary

| Component | Gen 3 | Gen 4 | Notes |
|-----------|-------|-------|-------|
| Tenant Resources | ConfigMap + Secret | StorageAccount + ComputeInstance CRDs | Declarative Kubernetes-native API |
| Orchestration | dispatcher | multienv-metactl-webhooks + Metacontroller | CRD-based CompositeController pattern |
| Resource Generation | deployment-controller | multienv-metactl-webhooks | Webhooks handle resource templates |
| Frontend API | deployment-controller | deployment-controller | **Kept** - dashboard dependency |
| Consul Sync | deployment-operator | deployment-operator | **Kept** - service discovery |
| Traffic Routing | resolver | resolver | **Kept** - core traffic component |
| Health Check | tenant-pod-healthcheck | tenant-pod-healthcheck | **Kept** - scaling performance |

## Architecture

### Custom Resource Definitions (CRDs)

Gen 4 introduces two custom resources that provide a declarative, Kubernetes-native API for multi-tenant deployments:

#### StorageAccount CRD
- **API Group**: `nightscout.io/v1alpha1`
- **Kind**: `StorageAccount`
- **Purpose**: Declares MongoDB storage infrastructure requirements for a tenant
- **Spec Fields**:
  - `mongodbVersion`: MongoDB version (e.g., "7.0")
  - `replicas`: Number of MongoDB replica set members (1-7)
  - `tier`: Service tier (free, basic, premium, enterprise)
  - `resources`: CPU/memory requests and limits
  - `storageSize`: PVC size per replica
  - `storageClass`: StorageClass for PVCs
  - `backup`: Backup configuration (enabled, retentionPolicy)
  - `migration`: Migration from external MongoDB (enabled, sourceType, sourceConnectionSecret)
- **Status Fields**:
  - `phase`: Pending, Migrating, Ready, Failed
  - `conditions`: Kubernetes-standard conditions array
  - `connectionSecret`: Name of Secret with MongoDB credentials
  - `databaseName`: MongoDB database name

#### ComputeInstance CRD
- **API Group**: `nightscout.io/v1alpha1`
- **Kind**: `ComputeInstance`
- **Purpose**: Declares Nightscout application deployment requirements for a tenant
- **Spec Fields**:
  - `storageAccountRef`: Reference to StorageAccount (same namespace)
  - `nightscoutImage`: Container image for Nightscout
  - `replicas`: Number of Nightscout replicas (1-10)
  - `tier`: Service tier (free, basic, premium, enterprise)
  - `resources`: CPU/memory requests and limits
  - `env`: Additional environment variables
  - `cdc`: Change Data Capture config (enabled, kafkaCluster, kafkaConnectCluster)
  - `healthcheck`: Health check sidecar config (enabled, image)
- **Status Fields**:
  - `phase`: Pending, Ready, Failed
  - `conditions`: Kubernetes-standard conditions array
  - `endpoints`: Service endpoints for the application

**Example Usage:**

```yaml
apiVersion: nightscout.io/v1alpha1
kind: StorageAccount
metadata:
  name: tenant-abc-storage
  namespace: hosted-tenants
spec:
  mongodbVersion: "7.0"
  replicas: 3
  tier: basic
  storageSize: "10Gi"
---
apiVersion: nightscout.io/v1alpha1
kind: ComputeInstance
metadata:
  name: tenant-abc-app
  namespace: hosted-tenants
  labels:
    # REQUIRED: StorageAccount reference for related resource discovery
    storage.nightscout.org/account: tenant-abc-storage
spec:
  storageAccountRef:
    name: tenant-abc-storage
  nightscoutImage: "nightscout/cgm-remote-monitor:latest"
  replicas: 2
```

### Storage Composite

**Parent**: StorageAccount CRD (`nightscout.io/v1alpha1`)

**Children** (owned, deleted with parent):
- MongoDB StatefulSet (if `storage-type=dedicated`)
- MongoDB Service (headless)
- Migration Job (if `ns.mdn.io/migration-needed=true`)

**Related** (discovered, NOT deleted with parent):
- PersistentVolumeClaim (created by StatefulSet volumeClaimTemplates)
- ConfigMap (tenants using this storage account - for auditing)

**Webhook**: `POST /composite/storage/sync`

**Status Reporting**:
- MongoDB readiness (`MongoDBReady` condition)
- Migration progress (`MigrationComplete` condition)
- Tenant usage count (how many tenants use this storage account)

### Compute Composite

**Parent**: ComputeInstance CRD (`nightscout.io/v1alpha1`)

**Children** (owned, deleted with parent):
- Nightscout Deployment
- Nightscout Service (optional)
- PodDisruptionBudget
- Optional: KafkaTopic, KafkaConnector (if CDC enabled)

**Related** (discovered, NOT deleted with parent):
- StorageAccount CRD (referenced via spec.storageAccountRef.name)
- MongoDB StatefulSet (blast radius protection)
- App-credentials Secret (managed by decorator, not composite)

**Webhooks**: 
- `POST /composite/compute/customize` - Discover related resources
- `POST /composite/compute/sync` - Generate Nightscout infrastructure

**Status Reporting**:
- Nightscout readiness (`Ready` condition)
- Storage availability check
- CDC status (if enabled)

### Kafka/CDC Integration Scope

**Optional per-tenant CDC** (enabled via `CDC_ENABLED: "true"` in ConfigMap):

**Children** (owned by Compute Composite):
- KafkaTopic resources (per collection: entries, treatments, etc.)
- KafkaConnector resource (MongoDB source connector)

**External Infrastructure** (NOT managed by this repository):
- Strimzi Kafka Operator (installation, CRD management)
- Kafka cluster (brokers, Zookeeper, storage)
- KafkaConnect cluster (workers, MongoDB connector plugin)
- Connection endpoints (bootstrap servers, Connect REST API)

**Integration Contract:**
- External infrastructure provides running Kafka + Connect clusters
- Connection details exported via ConfigMap/Secret to tenant namespace
- This repository generates per-tenant KafkaTopic and KafkaConnector resources
- Webhooks validate Kafka availability before generating CDC resources

See [Kafka CDC Integration Contract](KAFKA-CDC-INTEGRATION.md) for complete details on:
- What infrastructure must exist before enabling CDC
- Required ConfigMaps/Secrets format
- Per-tenant resource generation
- Validation and troubleshooting

### Decorator Controllers

Decorators watch resources **outside** the composite lifecycle to implement domain-specific logic and **blast radius protection**. Unlike composites, decorators don't own their watched resources, allowing critical data to survive composite controller garbage collection.

#### Storage-Credentials Decorator

**Watches**: ComputeInstance CRDs (via label selector: `storage.nightscout.org/account` exists)

**Attachments** (managed, but not owned by parent):
- App-credentials Secret (per-tenant MongoDB credentials)
- Create-user Job (MongoDB user initialization)
- Migration Job (Gen3→Gen4 data migration)

**Webhooks**:
- `POST /decorator/storage-credentials/customize` - Discover StorageAccount, Jobs, Secrets, ConfigMaps
- `POST /decorator/storage-credentials/sync` - Generate app credentials and migration Jobs

**Purpose**:
- Creates unique per-tenant MongoDB credentials separate from root credentials
- Initializes MongoDB users after replica set is ready
- Orchestrates Gen3→Gen4 migration (shared→dedicated storage)
- Regenerates app-credentials Secrets on-demand from preserved mongo-auth

**Pipeline**:
1. Discover StorageAccount to determine storage mode (shared/dedicated)
2. Track user initialization status via Job completion
3. Render create-user Job if user not initialized
4. Render migration Job if migration annotation present (with prerequisite guards)
5. Generate/preserve app-credentials Secret with connection details

#### Storage-Initialization Decorator

**Watches**: mongo-auth Secrets (via labels: `storage.nightscout.org/account` exists, `ns.mdn.io/composite` in [key, mongodb-auth])

**Purpose**:
- Tracks replica set initialization state outside composite lifecycle
- Sets runtime annotations (`ns.mdn.io/runtime-required`) based on StorageAccount spec
- Marks replica set initialized timestamp after observing init Job completion
- Protects mongo-auth Secret state from composite garbage collection

**Webhooks**:
- `POST /decorator/storage-initialization/customize` - Discover init Jobs and StorageAccount
- `POST /decorator/storage-initialization/sync` - Update Secret annotations with state

**Why Decorator**: mongo-auth Secret contains root MongoDB credentials that MUST survive StorageAccount CRD deletion to prevent data loss during CRD recreation or migration scenarios.

#### Instance-Userdata Decorator

**Watches**: Gen3 ConfigMaps (via label: `role=config-as-deploy`)

**Purpose**:
- Orchestrates Gen3→Gen4 migration by managing ConfigMap lifecycle
- Ensures ComputeInstance CRD exists before ConfigMap deletion
- Provides gradual cutover from Gen3 to Gen4 architecture

**Webhooks**:
- `POST /decorator/instance-userdata/customize` - Discover related ComputeInstances
- `POST /decorator/instance-userdata/sync` - Coordinate migration cutover

**Why Decorator**: Gen3 ConfigMaps exist before Gen4 adoption and must be preserved until migration completes. Decorator pattern allows observing both old (ConfigMap) and new (CRD) resources during transition.

#### PVC-Backup Decorator

**Watches**: PersistentVolumeClaims (via labels: `app.kubernetes.io/component=database`)

**Attachments**:
- VolumeSnapshot (backup on PVC deletion)

**Webhooks**:
- `POST /decorator/sync` - Enforce backup policy
- `POST /decorator/finalize` - Create snapshot before PVC deletion

**Purpose**:
- Automatically creates VolumeSnapshots when MongoDB PVCs are deleted
- Provides recovery mechanism for accidental deletion
- Implements backup retention policies

## Provisioner API Lifecycle

The deployment-controller provides a **thin provisioning facade** (`/accounts/` API) that creates Gen4 CRDs without requiring external systems to understand Kubernetes or Metacontroller internals.

### Complete Lifecycle Flow

```
External System (Dashboard, CLI, Automation)
    ↓
POST /accounts/:accountId
    ↓
deployment-controller creates:
  1. StorageAccount CRD (declares storage needs)
  2. mongo-auth Secret (root credentials - PROTECTED from GC)
    ↓
Metacontroller watches StorageAccount CRD
    ↓
Storage Composite creates:
  - MongoDB StatefulSet (if dedicated)
  - MongoDB Service
  - Init-replica-set Job
    ↓
Storage-Initialization Decorator:
  - Observes init Job completion
  - Marks mongo-auth Secret with replica-set-initialized timestamp
    ↓
POST /accounts/:accountId/sites/:tenantId
    ↓
deployment-controller creates:
  1. ComputeInstance CRD (declares compute needs)
    ↓
Metacontroller watches ComputeInstance CRD
    ↓
Storage-Credentials Decorator creates:
  - App-credentials Secret (per-tenant credentials)
  - Create-user Job (MongoDB user initialization)
  - Migration Job (if migration annotation present)
    ↓
Compute Composite creates:
  - Nightscout Deployment
  - Nightscout Service
  - PodDisruptionBudget
    ↓
Deployment-Operator syncs to Consul
    ↓
Resolver routes HTTP traffic
    ↓
Tenant site is live ✅
```

### API Endpoints

**Create Storage Account:**
```bash
POST /accounts/:accountId
{
  "tier": "basic|premium|enterprise",
  "storageType": "shared|dedicated",
  "mongodbVersion": "7.0",
  "replicas": 3,
  "storageSize": "10Gi"
}
```

Creates:
- `StorageAccount` CRD named `{accountId}`
- `mongo-auth` Secret named `{accountId}-mongo-auth` (root credentials, label-protected)

**Create Compute Instance:**
```bash
POST /accounts/:accountId/sites/:tenantId
{
  "internal_name": "tenantId",
  "storageAccountRef": {"name": "accountId"},
  "nightscoutImage": "nightscout/cgm-remote-monitor:latest",
  "replicas": 2,
  "cdc": {"enabled": false}
}
```

Creates:
- `ComputeInstance` CRD named `{tenantId}`
- Labels: `storage.nightscout.org/account: accountId`, `nightscout.io/tenant: tenantId`

### Blast Radius Protection Pattern

The provisioner creates resources with specific **ownership patterns** to prevent cascading deletions:

**Owned by CRD** (deleted with parent):
- MongoDB StatefulSet (owned by StorageAccount)
- Nightscout Deployment (owned by ComputeInstance)
- Services, PDBs, Jobs (owned by respective composites)

**Protected by Decorator** (survives CRD deletion):
- `mongo-auth` Secret - Root MongoDB credentials (watched by Storage-Initialization Decorator)
- PersistentVolumeClaims - Data volumes (related resource, not owned)

**Regenerated by Decorator** (deleted with CRD, recreated on-demand):
- `app-credentials` Secret - Per-tenant credentials (regenerated by Storage-Credentials Decorator from mongo-auth)

**Why**: If a StorageAccount CRD is accidentally deleted, the mongo-auth Secret survives because it's watched by a decorator outside the composite lifecycle. When the CRD is recreated, the decorator reconnects it to the existing Secret, preserving root credentials and enabling StatefulSet to remount existing PVCs. The app-credentials Secret is regenerated from mongo-auth when needed, providing secure credential rotation capability.

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

## Label Strategy: Storage Account vs Tenant ID

**Critical distinction**:
- **Storage Account ID**: ObjectID from provisioner system (e.g., `507f1f77bcf86cd799439011`)
- **Tenant ID**: 8-character DNS-friendly ID (e.g., `demo1234`, `prod9999`)

**Cardinality**:
- **Shared storage**: 1 storage account → N tenants (no StatefulSet/PVCs)
- **Dedicated storage**: 1 storage account → 1 tenant (has StatefulSet/PVCs)

### Storage Resource Labels

```yaml
# Storage Secret
metadata:
  labels:
    ns.mdn.io/composite: storage
    storage.nightscout.org/account: "507f1f77bcf86cd799439011"  # Storage account ObjectID

# MongoDB StatefulSet (dedicated only)
metadata:
  labels:
    storage.nightscout.org/account: "507f1f77bcf86cd799439011"  # Storage account
    app.kubernetes.io/name: mongodb

# PersistentVolumeClaim (created by StatefulSet)
metadata:
  labels:
    storage.nightscout.org/account: "507f1f77bcf86cd799439011"  # Belongs to storage account
    app.kubernetes.io/name: mongodb
    # NO ns.mdn.io/tenant label - PVCs belong to storage, not specific tenant
```

### Compute ConfigMap Labels

```yaml
metadata:
  labels:
    ns.mdn.io/composite: compute  # Triggers compute controller
    ns.mdn.io/tenant: "demo1234"  # 8-char tenant ID
    storage.nightscout.org/account: "507f1f77bcf86cd799439011"  # Links to storage account
```

### PVC Decorator Controller

Watches PVCs by **storage account**, not tenant:

```yaml
labelSelector:
  matchExpressions:
    - key: app.kubernetes.io/name
      operator: In
      values: ["mongodb"]
    - key: storage.nightscout.org/account
      operator: Exists  # Matches any storage account
```

This works because:
- Dedicated storage: PVCs labeled with storage account
- Shared storage: No PVCs created (decorator never sees them)

## Blast Radius Protection (Gen4)

Gen4 uses **Decorator Controllers** to protect critical resources outside the composite lifecycle. This prevents accidental data loss from CRD deletion while maintaining clean Kubernetes ownership semantics.

### Protection Mechanism

**Composite Controllers** (own children):
- StorageAccount CRD → owns StatefulSet, Service, Init Jobs
- ComputeInstance CRD → owns Deployment, Service, PDB
- Deletion cascades to owned children via K8s garbage collection

**Decorator Controllers** (protect and regenerate):
- Storage-Initialization → watches mongo-auth Secret (root credentials, survives deletion)
- Storage-Credentials → regenerates app-credentials Secret on-demand from mongo-auth
- Instance-Userdata → watches Gen3 ConfigMaps (migration coordination)
- PVC-Backup → watches PVCs (snapshot enforcement)

**Related Resources** (discovered, not owned):
- PersistentVolumeClaims (created by StatefulSet volumeClaimTemplates)
- Survive parent deletion, can be remounted after recreation

### Scenario 1: StorageAccount CRD Deleted (Accidental)

```
kubectl delete storageaccount demo-storage
  ↓
Composite Controller deletes children:
  - MongoDB StatefulSet ❌ deleted
  - MongoDB Service ❌ deleted  
  - Init Jobs ❌ deleted
  ↓
Decorator-watched resources SURVIVE:
  - mongo-auth Secret ✅ survives (watched by Storage-Initialization Decorator)
  - PVCs ✅ survive (related resource, not owned)
  ↓
Operator recreates StorageAccount CRD with same name
  ↓
Storage Composite recreates:
  - StatefulSet (mounts existing PVCs ✅ data intact)
  - Service
  ↓
Storage-Initialization Decorator:
  - Reconnects to existing mongo-auth Secret
  - Skips replica set init (already marked initialized)
  ↓
Database operational with original data ✅
```

**Key**: mongo-auth Secret survived because it's watched by a **decorator outside the composite lifecycle**, not owned by the StorageAccount CRD.

### Scenario 2: ComputeInstance CRD Deleted

```
kubectl delete computeinstance demo-tenant
  ↓
Composite Controller deletes children:
  - Nightscout Deployment ❌ deleted
  - Service ❌ deleted
  - PDB ❌ deleted
  - app-credentials Secret ❌ deleted (owned by compute)
  ↓
Storage resources SURVIVE:
  - StorageAccount CRD ✅ survives (not owned by compute)
  - mongo-auth Secret ✅ survives (watched by Storage-Initialization Decorator)
  - MongoDB StatefulSet ✅ survives (owned by StorageAccount)
  - PVCs ✅ survive (owned by StatefulSet volumeClaimTemplates)
  ↓
Operator recreates ComputeInstance CRD with same name
  ↓
Compute Composite recreates:
  - Deployment (waiting for credentials)
  - Service
  ↓
Storage-Credentials Decorator triggers:
  - Detects missing app-credentials Secret
  - Spawns create-user Job using preserved mongo-auth Secret
  - Job creates new MongoDB user with fresh password
  - Creates new app-credentials Secret
  ↓
Compute Composite reconciles:
  - Deployment starts successfully with new credentials
  ↓
Application operational, database untouched ✅
```

**Key**: app-credentials Secret is regenerated from preserved mongo-auth Secret. Compute and Storage are **independent lifecycles** - deleting compute never affects storage infrastructure.

### Scenario 3: Complete Tenant Deletion (Intentional)

```
kubectl delete storageaccount demo-storage
kubectl delete computeinstance demo-tenant
  ↓
Composites delete owned children:
  - StatefulSet, Deployment, Services, Jobs all deleted ❌
  - app-credentials Secret ❌ deleted (owned by compute)
  ↓
Decorator-watched resources SURVIVE:
  - mongo-auth Secret ✅ (contains root credentials)
  - PVCs ✅ (contain MongoDB data)
  ↓
PVC-Backup Decorator triggers:
  - Creates VolumeSnapshot from each PVC
  - Provides recovery mechanism
  ↓
Operator decision:
  - Recreate CRDs → Fast recovery (mongo-auth regenerates app-credentials)
  - Delete mongo-auth + PVCs → Clean removal
  - Keep VolumeSnapshots → Long-term recovery (days/months)
```

**Key**: Only mongo-auth Secret and PVCs survive full deletion. app-credentials can be regenerated from mongo-auth. Operators must explicitly delete mongo-auth Secret and PVCs to fully remove tenant data.

### Protection Summary

| Resource Type | Owned By | Survives CRD Deletion? | Recovery Path |
|--------------|----------|----------------------|---------------|
| MongoDB StatefulSet | StorageAccount CRD | ❌ No | Recreate CRD → mounts existing PVCs |
| Nightscout Deployment | ComputeInstance CRD | ❌ No | Recreate CRD → triggers credential regeneration |
| mongo-auth Secret | **Storage-Init Decorator** | ✅ Yes | Automatic reconnection on CRD recreation |
| app-credentials Secret | ComputeInstance CRD | ❌ No | **Regenerated** by Storage-Creds Decorator from mongo-auth |
| PersistentVolumeClaims | StatefulSet (volumeClaimTemplates) | ✅ Yes | Remounted by new StatefulSet |
| VolumeSnapshots | **PVC-Backup Decorator** | ✅ Yes | Manual restore via CSI driver |

### Why Decorators for Blast Radius Protection?

**Problem**: Kubernetes garbage collection deletes all children when a parent is deleted. If mongo-auth Secret was owned by StorageAccount CRD, deleting the CRD would delete root credentials → **permanent data loss**.

**Solution**: Storage-Initialization Decorator **watches mongo-auth Secret independently** using label selectors, not ownership references. When StorageAccount CRD is recreated, the decorator reconnects it to the existing mongo-auth Secret.

**Regeneration Pattern**: app-credentials Secret is owned by ComputeInstance CRD (deleted with parent), but Storage-Credentials Decorator regenerates it on-demand from preserved mongo-auth Secret. This provides secure credential rotation capability while maintaining recovery guarantees.

**Trade-off**: Operators must manually delete mongo-auth Secrets and PVCs when permanently removing tenants. This is intentional - better to require explicit deletion than risk accidental data loss.

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

### Migration Tooling: gen4-migration.sh

The canonical migration tool is `tools/gen4-migration.sh`, which uses the REST API and lets Metacontroller orchestrate the migration. This is **infrastructure-native** - it triggers declarative behavior rather than directly manipulating resources.

**Single Tenant Migration**:
```bash
# Complete migration workflow (create + trigger + validate)
./tools/gen4-migration.sh migrate-tenant demo1234

# Or step-by-step:
./tools/gen4-migration.sh create-storage demo1234      # Create Secret with shared MongoDB
./tools/gen4-migration.sh trigger-migration demo1234   # Add migration annotations
./tools/gen4-migration.sh validate-migration demo1234  # Check completion
```

**Batch Migration**:
```bash
# List tenants needing migration
./tools/gen4-migration.sh list-pending > tenants.txt

# Migrate batch from file
./tools/gen4-migration.sh batch-migrate tenants.txt

# Check overall progress
./tools/gen4-migration.sh migration-progress
```

**How it works**:
1. Creates storage Secret via provisioner API (`POST /accounts/:tenant`)
2. Adds migration annotations via metadata patching API
3. Storage webhook sees annotations, creates migration Job
4. Waits for migration to complete
5. Labels ConfigMap with `ns.mdn.io/composite: compute` (triggers compute controller)
6. Compute controller creates Deployment + Service

**Philosophy**: Leverages provisioner API facade for CRD creation, uses declarative triggers (labels/annotations) to orchestrate resources via webhooks

## Gen 3b → Gen 4 Migration via REST API

Existing Gen 3b tenants (managed by deployment-controller) can be migrated to Gen 4 (Metacontroller) without recreation or downtime. The key is **label cycling** - adding labels to existing resources to make Metacontroller aware of them.

### Architecture: Storage Account vs Tenant

Gen 4 separates concerns:
- **Storage Account** (Secret): Owns MongoDB resources, identified by account ID
  - Created via `POST /accounts/:accountId`
  - Secret name: `{accountId}-secret`
  - Account ID is typically an ObjectID (e.g., `507f1f77bcf86cd799439011`)
- **Tenant** (ConfigMap): Owns Nightscout compute, identified by tenant ID
  - Created via `POST /accounts/:accountId/sites/:tenantId`
  - ConfigMap name: `{tenantId}`
  - Tenant ID is DNS-compatible (e.g., `demo1234`)
  - Linked to storage via `storage.nightscout.org/account` label

**Important**: Account ID ≠ Tenant ID. These are separate identifiers from the legacy system.

**For Gen 3b migration**: Existing tenants have both tenant IDs and storage account IDs from the legacy system. Both must be preserved to maintain external mapping consistency.

### Migration Strategy

Gen 3b ConfigMaps already exist with tenant configuration. Instead of recreating them:
1. Create a storage account (Secret) with "do nothing" state (storageType: shared)
2. Trigger migration by adding annotations and switching to dedicated storage
3. Add Gen 4 labels to the existing ConfigMap (links compute to storage)

**ConfigMap names stay the same** - only labels change.

### Step 1: Create Storage Account (Primed for Migration)

For each Gen 3b tenant, create a storage Secret using the existing storage account ID from the legacy system.

```bash
TENANT_ID="demo1234"  # Tenant ID (compute, DNS-compatible)
ACCOUNT_ID="507f1f77bcf86cd799439011"  # Storage account ID from legacy system (ObjectID)
OLD_MONGO_URI="mongodb://shared-user:password@shared-mongodb:27017/nightscout"

# Create storage account with existing account ID (preserves external mapping)
# Use POST /accounts/:account to record existing storage account ID
curl -X POST http://deployment-controller:3000/accounts/$ACCOUNT_ID \
  -H "Content-Type: application/json" \
  -d '{
    "tier": "basic",
    "storageType": "shared"
  }'

# This creates Secret "507f1f77bcf86cd799439011-secret"
# with storageType: shared, which means "do nothing" - no MongoDB StatefulSet yet
```

### Step 2: Trigger Migration to Dedicated Storage

Add migration annotations and switch storage type to trigger the migration.

```bash
# OLD_MONGO_URI provided in migration file (from legacy system)
# or retrieved from existing Gen 3b ConfigMap if needed

# Add migration annotations (primes the Secret)
curl -X POST http://deployment-controller:3000/secrets/${ACCOUNT_ID}-secret/metadata/annotations/ns.mdn.io%2Fmigration-needed \
  -H "Content-Type: application/json" \
  -d '{"ns.mdn.io/migration-needed": "true"}'

curl -X POST http://deployment-controller:3000/secrets/${ACCOUNT_ID}-secret/metadata/annotations/ns.mdn.io%2Fmigration-source-uri \
  -H "Content-Type: application/json" \
  -d "{\"ns.mdn.io/migration-source-uri\": \"$OLD_MONGO_URI\"}"

# Switch storage type: shared → dedicated (triggers migration Job)
curl -X POST http://deployment-controller:3000/secrets/${ACCOUNT_ID}-secret/metadata/annotations/ns.mdn.io%2Fstorage-type \
  -H "Content-Type: application/json" \
  -d '{"ns.mdn.io/storage-type": "dedicated"}'
```

**What happens**:
1. Storage controller sees Secret with `storage-type: dedicated` and `migration-needed: true`
2. Creates new MongoDB StatefulSet for storage account `$ACCOUNT_ID`
3. Renders migration Job that copies data from `OLD_MONGO_URI` to new MongoDB
4. Sets `migration-complete: true` when Job succeeds

### Step 3: Label Existing ConfigMap

The Gen 3b ConfigMap already exists at `/configmaps/demo1234` with all the tenant configuration. Add Gen 4 labels to link it to the storage account and trigger compute controller.

```bash
# Add composite label (triggers compute controller)
curl -X POST http://deployment-controller:3000/configmaps/$TENANT_ID/metadata/labels/ns.mdn.io%2Fcomposite \
  -H "Content-Type: application/json" \
  -d '{"ns.mdn.io/composite": "compute"}'

# Add storage account link (links ConfigMap to Secret via account ID)
curl -X POST http://deployment-controller:3000/configmaps/$TENANT_ID/metadata/labels/storage.nightscout.org%2Faccount \
  -H "Content-Type: application/json" \
  -d "{\"storage.nightscout.org/account\": \"$ACCOUNT_ID\"}"

# Remove old Gen 3b label (triggers deletion of old deployment)
curl -X DELETE http://deployment-controller:3000/configmaps/$TENANT_ID/metadata/labels/ns.mdn.io%2Fcontroller
```

**What happens**:
1. Removing `ns.mdn.io/controller` label causes Gen 3b deployment-controller to delete old Deployment
2. Compute controller sees ConfigMap with `ns.mdn.io/composite: compute`
3. Discovers storage Secret via `storage.nightscout.org/account` label match (`$ACCOUNT_ID`)
4. Waits for migration to complete (checks Secret status)
5. Creates new Gen 4 Deployment + Service pointing to dedicated MongoDB
6. Tenant cutover complete!


### Complete Migration Example

Migration file format: space-delimited with `tenant_id`, `account_id`, and `mongo_uri` from legacy system:

```
# tenants.txt - space-delimited migration file
demo1234 507f1f77bcf86cd799439011 mongodb://user:pass@shared:27017/ns_demo1234
demo5678 507f1f77bcf86cd799439022 mongodb://user:pass@shared:27017/ns_demo5678
```

Single tenant migration example:

```bash
#!/bin/bash
set -e

TENANT_ID="demo1234"  # Tenant ID from legacy system
ACCOUNT_ID="507f1f77bcf86cd799439011"  # Storage account ID from legacy system
OLD_MONGO_URI="mongodb://user:pass@shared:27017/ns_demo1234"  # From legacy system
CONTROLLER="http://deployment-controller:3000"

echo "=== Migrating tenant to Gen 4 ==="
echo "  - Tenant ID: $TENANT_ID (compute ConfigMap)"
echo "  - Storage account: $ACCOUNT_ID (storage Secret)"
echo "  - Source MongoDB: $OLD_MONGO_URI"

# 1. Create storage account with existing account ID (preserves external mapping)
echo "Creating storage account..."
curl -s -X POST $CONTROLLER/accounts/$ACCOUNT_ID \
  -H "Content-Type: application/json" \
  -d '{"tier": "basic", "storageType": "shared"}' > /dev/null

# Wait for Secret to be created
sleep 2

# 2. Trigger migration (prime → switch)
echo "Triggering migration to dedicated MongoDB..."

# Add migration annotations (prime)
curl -s -X POST $CONTROLLER/secrets/${ACCOUNT_ID}-secret/metadata/annotations/ns.mdn.io%2Fmigration-needed \
  -H "Content-Type: application/json" \
  -d '{"ns.mdn.io/migration-needed": "true"}' > /dev/null

curl -s -X POST $CONTROLLER/secrets/${ACCOUNT_ID}-secret/metadata/annotations/ns.mdn.io%2Fmigration-source-uri \
  -H "Content-Type: application/json" \
  -d "{\"ns.mdn.io/migration-source-uri\": \"$OLD_MONGO_URI\"}" > /dev/null

# Switch storage type: shared → dedicated (triggers migration Job)
curl -s -X POST $CONTROLLER/secrets/${ACCOUNT_ID}-secret/metadata/annotations/ns.mdn.io%2Fstorage-type \
  -H "Content-Type: application/json" \
  -d '{"ns.mdn.io/storage-type": "dedicated"}' > /dev/null

# 3. Wait for migration to complete
echo "Waiting for migration Job to complete..."
# In production, poll: curl -s $CONTROLLER/secrets/${ACCOUNT_ID}-secret | jq -r '.metadata.annotations["ns.mdn.io/migration-complete"]'
sleep 60

# 4. Label existing ConfigMap for Gen 4 (deletes old deployment, creates new one)
echo "Labeling ConfigMap for Gen 4..."
curl -s -X POST $CONTROLLER/configmaps/$TENANT_ID/metadata/labels/ns.mdn.io%2Fcomposite \
  -H "Content-Type: application/json" \
  -d '{"ns.mdn.io/composite": "compute"}' > /dev/null

curl -s -X POST $CONTROLLER/configmaps/$TENANT_ID/metadata/labels/storage.nightscout.org%2Faccount \
  -H "Content-Type: application/json" \
  -d "{\"storage.nightscout.org/account\": \"$ACCOUNT_ID\"}" > /dev/null

curl -s -X DELETE $CONTROLLER/configmaps/$TENANT_ID/metadata/labels/ns.mdn.io%2Fcontroller > /dev/null 2>&1

echo "=== Migration complete! ==="
echo "  - Tenant ID: $TENANT_ID"
echo "  - Storage account: $ACCOUNT_ID"
echo "  - Storage: Dedicated MongoDB StatefulSet"
echo "  - Compute: Nightscout Deployment (Gen 4)"
echo "  - Traffic: Resolver → Consul → Pod"
```

**Or use the gen4-migration.sh script**:

```bash
# Single tenant migration
tools/gen4-migration.sh migrate-tenant demo1234 507f1f77bcf86cd799439011 "mongodb://user:pass@shared:27017/ns_demo1234"

# Batch migration from file
tools/gen4-migration.sh batch-migrate tenants.txt
```

### REST API Metadata Endpoints

These endpoints enable label/annotation manipulation for migration:

**Add/Update Label or Annotation**:
```bash
POST /configmaps/:name/metadata/labels/:field
POST /configmaps/:name/metadata/annotations/:field
POST /secrets/:name/metadata/labels/:field
POST /secrets/:name/metadata/annotations/:field

Body: { "key": "value" }
```

**Remove Label or Annotation**:
```bash
DELETE /configmaps/:name/metadata/labels/:field
DELETE /configmaps/:name/metadata/annotations/:field
DELETE /secrets/:name/metadata/labels/:field
DELETE /secrets/:name/metadata/annotations/:field
```

**Examples**:
```bash
# Add composite label to ConfigMap
curl -X POST http://deployment-controller:3000/configmaps/demo1234/metadata/labels/ns.mdn.io%2Fcomposite \
  -H "Content-Type: application/json" \
  -d '{"ns.mdn.io/composite": "compute"}'

# Add migration annotation to Secret
curl -X POST http://deployment-controller:3000/secrets/account-secret/metadata/annotations/ns.mdn.io%2Fmigration-needed \
  -H "Content-Type: application/json" \
  -d '{"ns.mdn.io/migration-needed": "true"}'

# Remove old label
curl -X DELETE http://deployment-controller:3000/configmaps/demo1234/metadata/labels/ns.mdn.io%2Fcontroller
```

**URL Encoding**: Special characters in label/annotation keys must be URL-encoded:
- `/` → `%2F`
- `.` → `.` (no encoding needed)

### Migration Validation

After migration, verify the tenant is running on Gen 4:

```bash
TENANT="demo1234"
CONTROLLER="http://deployment-controller:3000"

# Check ConfigMap has Gen 4 labels
curl -s $CONTROLLER/configmaps/$TENANT/metadata/labels | jq

# Expected output:
# {
#   "ns.mdn.io/composite": "compute",
#   "storage.nightscout.org/account": "507f1f77bcf86cd799439011"
# }

# Check Deployment exists (created by compute controller)
kubectl get deployment $TENANT-nightscout -n hosted-tenants

# Check migration completed
curl -s $CONTROLLER/secrets/507f1f77bcf86cd799439011-secret/metadata/annotations | jq

# Expected annotation:
# {
#   "ns.mdn.io/migration-complete": "true"
# }
```

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

## Gen 5 Tenant Composite Architecture

Gen5 introduces a unified **Tenant Composite** that combines storage and compute concerns into a single NightscoutTenant CRD, with direct Pod management instead of Deployments.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Gen 5 Architecture                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Provisioner creates:                                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                       │
│  │ PVC          │  │ mongo-auth   │  │ NightscoutTen│                       │
│  │ (storage)    │  │ Secret       │  │ ant CR       │                       │
│  └──────────────┘  └──────────────┘  └──────┬───────┘                       │
│         │                 │                  │                               │
│         │                 │                  │                               │
│         └─────────────────┼──────────────────┘                               │
│                           │ related resources                                │
│                           ▼                                                  │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ Metacontroller                                                         │   │
│  │   Watches: nightscouttenants.nightscout.io                            │   │
│  └───────────────────────────────┬──────────────────────────────────────┘   │
│                                  │ HTTP POST (sync hook)                    │
│                                  ▼                                          │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    Tenant Composite Controller                         │   │
│  │  /composite/tenant/sync                                               │   │
│  │                                                                        │   │
│  │  Renders children based on lifecycle phase:                           │   │
│  │                                                                        │   │
│  │  Phase 1: No ConfigMap     Phase 2a: Initializing   Phase 2b: Ready   │   │
│  │  ┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐│   │
│  │  │ Keyfile Secret  │      │ Keyfile Secret  │      │ Keyfile Secret  ││   │
│  │  │ (only)          │      │ Pod (Mongo only)│      │ Pod (Mongo+NS)  ││   │
│  │  │                 │      │ app-credentials │      │ app-credentials ││   │
│  │  └─────────────────┘      └─────────────────┘      └─────────────────┘│   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                   Secret-Watching Decorators                           │   │
│  │  (Stamp annotations on Secrets, attach initialization Jobs)          │   │
│  │                                                                        │   │
│  │  ┌─────────────────────┐    ┌─────────────────────────┐              │   │
│  │  │ mongo-auth-init     │    │ app-credentials-init    │              │   │
│  │  │ Decorator           │    │ Decorator               │              │   │
│  │  │                     │    │                         │              │   │
│  │  │ Watches: mongo-auth │    │ Watches: app-credentials│              │   │
│  │  │ Creates: init-      │    │ Creates: create-user    │              │   │
│  │  │   replica-set Job   │    │   Job                   │              │   │
│  │  │ Stamps: replica-set-│    │ Stamps: user-initialized│              │   │
│  │  │   initialized       │    │                         │              │   │
│  │  └─────────────────────┘    └─────────────────────────┘              │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                      Preserved Components                              │   │
│  │                                                                        │   │
│  │  ┌─────────────────────┐    ┌─────────────────────────┐              │   │
│  │  │ deployment-operator │    │ resolver                │              │   │
│  │  │ Pod → Consul sync   │    │ Traffic routing         │              │   │
│  │  └─────────────────────┘    └─────────────────────────┘              │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Resource Ownership Model

Gen5 uses a three-tier ownership model for blast radius protection:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Resource Ownership Model                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  COMPOSITE-OWNED (deleted when NightscoutTenant CR deleted)            │  │
│  │                                                                         │  │
│  │    ┌─────────────────┐    ┌─────────────────┐                          │  │
│  │    │ Pod             │    │ Keyfile Secret  │                          │  │
│  │    │ (MongoDB + NS)  │    │ (replica auth)  │                          │  │
│  │    └─────────────────┘    └─────────────────┘                          │  │
│  │                                                                         │  │
│  │    ┌─────────────────┐                                                 │  │
│  │    │ app-credentials │                                                 │  │
│  │    │ Secret          │ ◄── Rendered by composite, watched by decorator │  │
│  │    └─────────────────┘                                                 │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  PROVISIONER-OWNED (survives CR deletion for recovery)                 │  │
│  │                                                                         │  │
│  │    ┌─────────────────┐    ┌─────────────────┐                          │  │
│  │    │ mongo-auth      │    │ PVC             │                          │  │
│  │    │ Secret          │    │ (data storage)  │                          │  │
│  │    │                 │    │                 │                          │  │
│  │    │ Root credentials│    │ MongoDB data    │                          │  │
│  │    │ for recovery    │    │ files           │                          │  │
│  │    └─────────────────┘    └─────────────────┘                          │  │
│  │                                                                         │  │
│  │    These resources are created by the provisioner API before the       │  │
│  │    NightscoutTenant CR, and referenced via spec.mongoAuthSecretRef     │  │
│  │    and spec.pvcName. They survive CR deletion for fast recovery.       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  DECORATOR-ATTACHED (attached to Secrets, not owned)                   │  │
│  │                                                                         │  │
│  │    ┌─────────────────┐    ┌─────────────────┐                          │  │
│  │    │ init-replica-set│    │ create-user     │                          │  │
│  │    │ Job             │    │ Job             │                          │  │
│  │    │                 │    │                 │                          │  │
│  │    │ Initializes     │    │ Creates app     │                          │  │
│  │    │ MongoDB replica │    │ MongoDB user    │                          │  │
│  │    │ set             │    │                 │                          │  │
│  │    └─────────────────┘    └─────────────────┘                          │  │
│  │                                                                         │  │
│  │    Jobs are attached to mongo-auth and app-credentials Secrets.        │  │
│  │    Decorators stamp completion annotations on Secrets, not CRs.        │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Lifecycle Phases (Dedicated Mode)

Gen5 currently implements **dedicated mode** with co-located MongoDB + Nightscout:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Dedicated Mode Lifecycle                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Storage-Only              Phase 2a: Initializing     Phase 2b: Ready       │
│  (No ConfigMap)            (MongoDB only)             (Full Pod)            │
│  phase: Error              phase: Initializing        phase: Ready          │
│                                                                              │
│  Provisioner creates:      User adds ConfigMap:       Decorators complete:  │
│  - PVC                     - ConfigMap created        - init-replica-set ✓  │
│  - mongo-auth Secret       - spec.configMapRef set    - create-user ✓       │
│  - NightscoutTenant CR     - Compute activates                              │
│                                                                              │
│  ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐    │
│  │NightscoutTenant  │     │NightscoutTenant  │     │NightscoutTenant  │    │
│  │CR                │ ──► │CR                │ ──► │CR                │    │
│  │                  │     │                  │     │                  │    │
│  │spec:             │     │spec:             │     │spec:             │    │
│  │  configMapRef:   │     │  configMapRef:   │     │  configMapRef:   │    │
│  │    (none)        │     │    name: cfg     │     │    name: cfg     │    │
│  │  pvcName: data   │     │  pvcName: data   │     │  pvcName: data   │    │
│  │  mongoAuthSecret │     │  mongoAuthSecret │     │  mongoAuthSecret │    │
│  │    Ref: auth     │     │    Ref: auth     │     │    Ref: auth     │    │
│  └────────┬─────────┘     └────────┬─────────┘     └────────┬─────────┘    │
│           │                        │                        │               │
│           ▼                        ▼                        ▼               │
│                                                                              │
│  Composite renders:        Composite renders:        Composite renders:     │
│                                                                              │
│  ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐    │
│  │ Keyfile Secret   │     │ Keyfile Secret   │     │ Keyfile Secret   │    │
│  │ (only)           │     └──────────────────┘     └──────────────────┘    │
│  └──────────────────┘     ┌──────────────────┐     ┌──────────────────┐    │
│                           │ Pod              │     │ Pod              │    │
│  No Pod rendered -        │ ┌──────────────┐ │     │ ┌──────────────┐ │    │
│  waiting for ConfigMap    │ │ MongoDB      │ │     │ │ MongoDB      │ │    │
│  to activate compute      │ │ Container    │ │     │ └──────────────┘ │    │
│                           │ │              │ │     │ ┌──────────────┐ │    │
│                           │ │ (waiting for │ │     │ │ Nightscout   │ │    │
│                           │ │  init Jobs)  │ │     │ │ Container    │ │    │
│                           │ └──────────────┘ │     │ └──────────────┘ │    │
│                           └──────────────────┘     └──────────────────┘    │
│                           ┌──────────────────┐     ┌──────────────────┐    │
│                           │ app-credentials  │     │ app-credentials  │    │
│                           │ Secret           │     │ Secret           │    │
│                           └────────┬─────────┘     └──────────────────┘    │
│                                    │                                        │
│  Decorators:                       ▼                                        │
│  (waiting for                Decorators attach:                             │
│   mongo-auth)                                                               │
│                           ┌──────────────────┐                              │
│                           │ init-replica-set │                              │
│                           │ Job (on mongo-   │──┐                           │
│                           │ auth Secret)     │  │                           │
│                           └──────────────────┘  │ After Jobs complete:      │
│                           ┌──────────────────┐  │ - Annotations stamped     │
│                           │ create-user Job  │  │ - Composite re-syncs      │
│                           │ (on app-creds    │──┘ - Pod gets NS container   │
│                           │ Secret)          │                              │
│                           └──────────────────┘                              │
│                                                                              │
│  Status:                   Status:                   Status:                │
│  phase: Error              phase: Initializing       phase: Ready           │
│  conditions:               conditions:               conditions:            │
│  - ComputeActivated:       - ComputeActivated:       - ComputeActivated:    │
│      False                     True                      True               │
│  - reason:                 - Ready: False            - Ready: True          │
│      NoConfigMapRef        - reason: Initializing    - reason: PodReady     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

NOTE: Storage-only mode intentionally surfaces as phase=Error with 
ComputeActivated=False/NoConfigMapRef. This prompts provisioners to supply 
the ConfigMap to activate the tenant. The Error phase is expected behavior 
for tenants awaiting configuration, not a failure state.
```

### Two-Phase Container Gating

The Pod morphs during initialization to enable safe MongoDB setup:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Two-Phase Container Gating                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  WHY: MongoDB must be initialized (replica set + user) before Nightscout    │
│       can connect. Running both containers immediately would cause errors.  │
│                                                                              │
│  Phase 2a: MongoDB Only                Phase 2b: MongoDB + Nightscout       │
│  (userInitialized: false)              (userInitialized: true)              │
│                                                                              │
│  ┌──────────────────────────┐         ┌──────────────────────────┐         │
│  │ Pod                      │         │ Pod                      │         │
│  │                          │         │                          │         │
│  │ ┌──────────────────────┐ │         │ ┌──────────────────────┐ │         │
│  │ │ MongoDB Container    │ │         │ │ MongoDB Container    │ │         │
│  │ │                      │ │         │ │                      │ │         │
│  │ │ • Listening on 27017 │ │         │ │ • Replica set init'd │ │         │
│  │ │ • Bound to Pod IP    │ │         │ │ • App user created   │ │         │
│  │ │ • Uses PVC           │ │         │ │ • Ready for traffic  │ │         │
│  │ └──────────────────────┘ │         │ └──────────────────────┘ │         │
│  │                          │         │ ┌──────────────────────┐ │         │
│  │                          │         │ │ Nightscout Container │ │         │
│  │                          │         │ │                      │ │         │
│  │                          │         │ │ • Connects localhost │ │         │
│  │                          │         │ │ • Uses app-creds     │ │         │
│  │                          │         │ │ • Serves HTTP 1337   │ │         │
│  │                          │   ───►  │ └──────────────────────┘ │         │
│  └──────────────────────────┘         └──────────────────────────┘         │
│           │                                     ▲                           │
│           │                                     │                           │
│           ▼                                     │                           │
│  ┌──────────────────────────┐                  │                           │
│  │ Initialization Jobs      │                  │                           │
│  │                          │                  │                           │
│  │ 1. init-replica-set Job  │                  │                           │
│  │    - Connects via Pod IP │                  │                           │
│  │    - Runs rs.initiate()  │                  │                           │
│  │    - Stamps annotation   │                  │                           │
│  │                          │                  │                           │
│  │ 2. create-user Job       │                  │                           │
│  │    - Waits for #1        │                  │                           │
│  │    - Creates app user    │                  │                           │
│  │    - Stamps annotation   │──────────────────┘                           │
│  │      on app-credentials  │  Triggers composite re-sync                  │
│  │      Secret              │  Pod recreated with both containers          │
│  └──────────────────────────┘                                               │
│                                                                              │
│  Annotation Flow:                                                           │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐                   │
│  │ mongo-auth  │────►│ app-creds   │────►│ Composite   │                   │
│  │ Secret      │     │ Secret      │     │ re-renders  │                   │
│  │             │     │             │     │ Pod with    │                   │
│  │ ns.mdn.io/  │     │ ns.mdn.io/  │     │ both        │                   │
│  │ replica-set-│     │ user-       │     │ containers  │                   │
│  │ initialized │     │ initialized │     │             │                   │
│  └─────────────┘     └─────────────┘     └─────────────┘                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Recovery Scenario

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Recovery: NightscoutTenant CR Deleted                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Before Deletion:                  After Deletion:                          │
│                                                                              │
│  ┌──────────────────┐              ┌──────────────────┐                     │
│  │ NightscoutTenant │              │ (CR deleted)     │                     │
│  │ CR               │  ─────────►  │                  │                     │
│  └────────┬─────────┘              └──────────────────┘                     │
│           │                                                                  │
│           │ owns                                                             │
│           ▼                                                                  │
│  ┌──────────────────┐              ┌──────────────────┐                     │
│  │ Pod              │  ─────────►  │ ❌ DELETED       │                     │
│  │ Keyfile Secret   │              │ (owned children  │                     │
│  │ app-credentials  │              │  garbage         │                     │
│  └──────────────────┘              │  collected)      │                     │
│                                    └──────────────────┘                     │
│                                                                              │
│  Provisioner-owned:                Provisioner-owned:                       │
│  ┌──────────────────┐              ┌──────────────────┐                     │
│  │ mongo-auth Secret│  ─────────►  │ ✅ SURVIVES      │                     │
│  │ PVC              │              │ (not owned by CR)│                     │
│  └──────────────────┘              └──────────────────┘                     │
│                                                                              │
│  Recovery Steps:                                                             │
│  ───────────────                                                             │
│  1. Recreate NightscoutTenant CR with same spec references                  │
│  2. Composite renders new Pod → mounts existing PVC                         │
│  3. MongoDB starts with existing data files                                 │
│  4. Decorators detect mongo-auth exists, skip init if annotated             │
│  5. App user still exists in MongoDB → create-user Job skips                │
│  6. Nightscout container starts, connects to MongoDB                        │
│  7. ✅ Tenant operational with original data, minimal downtime              │
│                                                                              │
│  Key Insight: Data survives because PVC and mongo-auth are                  │
│  provisioner-owned, not composite-owned. Only transient resources           │
│  (Pod, Keyfile, app-credentials) are deleted.                               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Future: Shared Mode Migration

> **Note**: Shared mode (Nightscout-only Pod with external MongoDB) is planned
> for future implementation to enable gradual migration from shared infrastructure.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Planned: Shared → Dedicated Migration                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Current State:                    Target State:                            │
│  (Shared - not yet implemented)    (Dedicated - current)                    │
│                                                                              │
│  ┌──────────────────┐              ┌──────────────────┐                     │
│  │ NightscoutTenant │              │ NightscoutTenant │                     │
│  │                  │   migrate    │                  │                     │
│  │ spec:            │  ─────────►  │ spec:            │                     │
│  │   storageType:   │              │   storageType:   │                     │
│  │     shared       │              │     dedicated    │                     │
│  │   sharedMongoUri:│              │   pvcName: data  │                     │
│  │     mongodb://...│              │   mongoAuthSecret│                     │
│  └────────┬─────────┘              │     Ref: auth    │                     │
│           │                        └────────┬─────────┘                     │
│           ▼                                 ▼                               │
│  ┌──────────────────┐              ┌──────────────────┐                     │
│  │ Pod              │              │ Pod              │                     │
│  │ ┌──────────────┐ │              │ ┌──────────────┐ │                     │
│  │ │ Nightscout   │ │              │ │ MongoDB      │ │                     │
│  │ │ (connects to │ │              │ │ (co-located) │ │                     │
│  │ │  shared DB)  │ │              │ └──────────────┘ │                     │
│  │ └──────────────┘ │              │ ┌──────────────┐ │                     │
│  └──────────────────┘              │ │ Nightscout   │ │                     │
│           │                        │ │ (localhost)  │ │                     │
│           ▼                        │ └──────────────┘ │                     │
│  ┌──────────────────┐              └────────┬─────────┘                     │
│  │ Central Shared   │                       ▼                               │
│  │ MongoDB Cluster  │              ┌──────────────────┐                     │
│  │ (external)       │              │ Local PVC        │                     │
│  └──────────────────┘              └──────────────────┘                     │
│                                                                              │
│  Migration would involve:                                                   │
│  1. Create PVC and mongo-auth for tenant                                    │
│  2. Spawn Migration Job to copy data from shared → local                    │
│  3. Update spec to dedicated mode                                           │
│  4. Pod recreated with co-located MongoDB                                   │
│  5. Tenant now fully independent                                            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Design Rationale

**Why unify storage and compute?**
- Single CRD simplifies tenant lifecycle management
- Co-located MongoDB + Nightscout in same Pod eliminates network hops
- Two-phase provisioning allows storage-first, compute-later activation
- Reduces control plane load (fewer resources per tenant)

**Why the three-tier ownership model?**
- Composite-owned resources can be safely recreated without data loss
- Provisioner-owned resources (PVC, mongo-auth) survive CR deletion for recovery
- Decorator-attached Jobs provide initialization without ownership conflicts

### Child Update Strategy: Recreate vs RollingRecreate

The tenant composite uses **`Recreate`** for Pod children, not `RollingRecreate`:

```yaml
childResources:
  - apiVersion: v1
    resource: pods
    updateStrategy:
      method: Recreate  # NOT RollingRecreate
```

**Why this matters:**

| Aspect | RollingRecreate | Recreate |
|--------|-----------------|----------|
| ControllerRevision created | Yes | No |
| Suitable for single Pod | No | Yes |
| Morphing children (lifecycle phases) | Problematic | Works well |
| Race condition risk | Higher | None |
| Debugging complexity | Higher | Lower |

**Key insight**: `RollingRecreate` activates Metacontroller's ControllerRevision machinery, which tracks parent spec changes for gradual rollouts. For single-Pod-per-tenant architectures, this adds complexity without benefit and can cause transient "ControllerRevision already exists" errors during rapid parent updates.

### Morphing Children Pattern

Tenant composite children change based on lifecycle phase:

**Phase 1: Storage Only** (no ConfigMap)
- MongoDB Keyfile Secret

**Phase 2a: Pre-Initialization** (ConfigMap present, user not initialized)
- MongoDB Keyfile Secret
- Pod with MongoDB container only
- App-Credentials Secret

**Phase 2b: Fully Operational** (user initialized)
- MongoDB Keyfile Secret
- Pod with MongoDB + Nightscout containers
- App-Credentials Secret

This morphing pattern requires `Recreate` strategy because:
1. Children appear/disappear based on lifecycle state
2. Pod spec changes fundamentally between phases (container count)
3. There's no concept of "rolling" between fundamentally different configs

### generateSelector=false Pattern

Tenant composite uses `generateSelector=false` to prevent Metacontroller from injecting `controller-uid` labels:

```yaml
spec:
  generateSelector: false
  parentResource:
    apiVersion: nightscout.io/v1alpha1
    resource: nightscouttenants
```

**Benefits:**
- Webhook controls all child labels via spec-hash pattern
- Avoids drift detection on server-managed Pod fields
- Enables idempotent Pod rendering without preservation logic

**Trade-off:** Parent must provide valid `spec.selector.matchLabels` for child adoption.

### Comparison with CatSet Example

The Metacontroller CatSet example uses `RollingRecreate` successfully because:

| CatSet | Tenant Composite |
|--------|------------------|
| Multiple Pods (replicas > 1) | Single Pod per tenant |
| Stable child set after creation | Children morph during lifecycle |
| `revisionHistory.fieldPaths: [spec.template]` | `revisionHistory.fieldPaths: [spec]` |
| Infrequent spec changes | Frequent changes during initialization |

**Lesson learned**: `RollingRecreate` is designed for StatefulSet-like multi-replica workloads, not single-instance or morphing child patterns.

## Implementation Files

| Component | File |
|-----------|------|
| **Webhooks** | |
| Storage Composite | `cmd/webhook/handlers/storage-composite-sync.js` |
| Compute Composite | `cmd/webhook/handlers/compute-composite-sync.js` |
| Tenant Composite | `cmd/webhook/handlers/tenant-composite-sync.js` |
| Storage-Credentials Decorator | `cmd/webhook/handlers/storage-credentials-decorator-sync.js` |
| Storage-Initialization Decorator | `cmd/webhook/handlers/storage-initialization-decorator-sync.js` |
| Instance-Userdata Decorator | `cmd/webhook/handlers/instance-userdata-decorator-sync.js` |
| **Controller Definitions** (jsonnet) | |
| Metacontroller Library | `jsonnet/lib-k8s-multienv/metacontroller.libsonnet` |
| Gen4 Stack Generator | `jsonnet/lib-k8s-multienv/gen4.libsonnet` |
| Test Environment | `jsonnet/environments/gen4-test/main.jsonnet` |
| **CRDs** | |
| StorageAccount CRD | `metacontroller/crds/storageaccount.yaml` |
| ComputeInstance CRD | `metacontroller/crds/computeinstance.yaml` |
| NightscoutTenant CRD | Generated via jsonnet in `lib-k8s-multienv/crds.libsonnet` |
| **APIs & Tools** | |
| Provisioner API | `k8s-deployment-controller.js` (/accounts/ endpoints) |
| NightscoutTenant API | `lib/routes/nightscout-tenant.js` |
| Migration Tool | `tools/gen4-migration.sh` |

**Note**: Controller definitions are generated from jsonnet, not manually written YAML. See `metacontroller/controllers/README.md` for details.

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
