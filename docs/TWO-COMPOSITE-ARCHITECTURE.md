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

Gen 4 introduces Metacontroller-based webhooks for orchestration while preserving critical Gen 1-3 components for specific purposes:

### Active Components in Gen 4

**New: Metacontroller Webhooks**
- **multienv-metactl-webhooks**: Replaces Gen 3 `dispatcher` for ConfigMap/Secret orchestration
  - Handles Storage composite (Secret → MongoDB StatefulSet + Migration)
  - Handles Compute composite (ConfigMap → Nightscout Deployment + CDC)
  - Handles PVC decorator (backup policy enforcement)
  - Entry point: `cmd/webhook/server.js`
  - Port: 3000

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
┌─────────────────────────────────────────────────────────────┐
│                      Gen 4 Architecture                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ConfigMap/Secret Changes                                   │
│         │                                                    │
│         ▼                                                    │
│  ┌──────────────────┐                                       │
│  │ Metacontroller   │  Watches resources with               │
│  │  (External)      │  ns.mdn.io/composite label            │
│  └────────┬─────────┘                                       │
│           │                                                  │
│           │ HTTP POST                                        │
│           ▼                                                  │
│  ┌────────────────────────────┐                             │
│  │ multienv-metactl-webhooks  │  Gen 4 Orchestration        │
│  │  /composite/storage/sync   │  - Generate StatefulSets    │
│  │  /composite/compute/sync   │  - Generate Deployments     │
│  │  /decorator/sync           │  - Inject backup policies   │
│  └────────────────────────────┘                             │
│                                                              │
│  ┌────────────────────────────┐                             │
│  │  deployment-controller     │  Preserved for:             │
│  │  /environs/ API            │  - Frontend dashboard       │
│  │  /accounts/ API            │  - User configuration       │
│  └────────────────────────────┘                             │
│                                                              │
│  ┌────────────────────────────┐                             │
│  │  deployment-operator       │  Preserved for:             │
│  │  Pod → Consul sync         │  - Service discovery        │
│  └────────────────────────────┘                             │
│                                                              │
│  ┌────────────────────────────┐                             │
│  │  resolver                  │  Preserved for:             │
│  │  redirector-server.js      │  - Traffic routing          │
│  └────────────────────────────┘                             │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Migration Summary

| Component | Gen 3 | Gen 4 | Notes |
|-----------|-------|-------|-------|
| ConfigMap Orchestration | dispatcher | multienv-metactl-webhooks | Metacontroller replaces custom watcher |
| Resource Generation | deployment-controller | multienv-metactl-webhooks | Webhooks handle resource templates |
| Frontend API | deployment-controller | deployment-controller | **Kept** - dashboard dependency |
| Consul Sync | deployment-operator | deployment-operator | **Kept** - service discovery |
| Traffic Routing | resolver | resolver | **Kept** - core traffic component |
| Health Check | tenant-pod-healthcheck | tenant-pod-healthcheck | **Kept** - scaling performance |

## Architecture

### Storage Composite

**Parent**: Secret (labeled `ns.mdn.io/composite=storage`)

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

**Philosophy**: Leverages provisioner API facade for Secret creation, uses declarative triggers (labels/annotations) to orchestrate resources via webhooks

## REST API Provisioning

The deployment controller (`k8s-deployment-controller.js`) provides REST APIs that serve as a **provisioner facade** over the two-composite architecture. External systems can provision tenants without understanding Kubernetes or Metacontroller.

### Create Storage Account

**Endpoint**: `POST /accounts` or `POST /accounts/:account`

Creates a storage Secret that triggers the storage composite controller.

```bash
# Create new account with auto-generated ID
curl -X POST http://deployment-controller:3000/accounts \
  -H "Content-Type: application/json" \
  -d '{
    "tier": "basic",
    "storageType": "shared"
  }'

# Response:
{
  "account": "507f1f77bcf86cd799439011",
  "storageType": "shared",
  "tier": "basic"
}

# Create/update specific account
curl -X POST http://deployment-controller:3000/accounts/507f1f77bcf86cd799439011 \
  -H "Content-Type: application/json" \
  -d '{
    "tier": "premium",
    "storageType": "dedicated"
  }'
```

**What it creates**:
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: 507f1f77bcf86cd799439011-secret
  labels:
    ns.mdn.io/composite: storage          # ← Triggers storage controller
    storage.nightscout.org/account: 507f1f77bcf86cd799439011
    app.kubernetes.io/managed-by: metacontroller
  annotations:
    ns.mdn.io/storage-type: shared        # ← "shared" or "dedicated"
    ns.mdn.io/tier: basic
stringData:
  MONGO_INITDB_ROOT_USERNAME: user_507f1f77bcf86cd799439011
  MONGO_INITDB_ROOT_PASSWORD: <random>
  MONGO_INITDB_DATABASE: ns
```

### Create Tenant Site

**Endpoint**: `POST /accounts/:account/sites/:name`

Creates a compute ConfigMap linked to the storage account.

```bash
curl -X POST http://deployment-controller:3000/accounts/507f1f77bcf86cd799439011/sites/demo1234 \
  -H "Content-Type: application/json" \
  -d '{
    "internal_name": "demo1234",
    "API_SECRET": "my-secret-token-12345",
    "DISPLAY_UNITS": "mg/dl",
    "ENABLE_CAREPORTAL": "true"
  }'

# Response:
{
  "tenant": "demo1234",
  "account": "507f1f77bcf86cd799439011"
}
```

**What it creates**:
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: demo1234
  labels:
    ns.mdn.io/composite: compute           # ← Triggers compute controller
    ns.mdn.io/tenant: demo1234
    storage.nightscout.org/account: 507f1f77bcf86cd799439011  # ← Links to storage
    app.kubernetes.io/managed-by: metacontroller
data:
  TENANT_ID: demo1234
  API_SECRET: my-secret-token-12345
  DISPLAY_UNITS: mg/dl
  ENABLE_CAREPORTAL: "true"
```

**Validation**:
- `internal_name` must match URL parameter `:name`
- Tenant ID must be DNS-compatible (lowercase alphanumeric + hyphens, max 63 chars)
- Both endpoints are **idempotent** (safe to retry)

### Complete Provisioning Flow

```bash
# 1. Create storage account
ACCOUNT=$(curl -s -X POST http://deployment-controller:3000/accounts \
  -H "Content-Type: application/json" \
  -d '{"tier": "basic", "storageType": "shared"}' | jq -r '.account')

echo "Created account: $ACCOUNT"

# 2. Create tenant site linked to account
curl -X POST http://deployment-controller:3000/accounts/$ACCOUNT/sites/demo1234 \
  -H "Content-Type: application/json" \
  -d '{
    "internal_name": "demo1234",
    "API_SECRET": "my-secret-token-12345"
  }'

# 3. Metacontroller takes over:
#    - Storage controller sees Secret, creates nothing (shared storage)
#    - Compute controller sees ConfigMap, creates Deployment + Service
#    - Tenant is live!
```

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

## Implementation Files

| Component | File |
|-----------|------|
| Storage Webhook | `cmd/webhook/handlers/storage-composite-sync.js` |
| Compute Webhook | `cmd/webhook/handlers/compute-composite-sync.js` |
| Storage Controller | `metacontroller/controllers/storage-composite.yaml` |
| Compute Controller | `metacontroller/controllers/compute-composite.yaml` |
| Migration Tool | `tools/gen4-migration.sh` |
| Provisioner API | `k8s-deployment-controller.js` (account/site endpoints) |
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
