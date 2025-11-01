# RBAC Design Guide

## Overview

This document explains the Role-Based Access Control (RBAC) architecture for the Nightscout multi-tenant Kubernetes platform. It covers the current permission model, security design rationale, blue/green deployment considerations, and patterns for extending RBAC as the platform evolves.

## Table of Contents

- [Current RBAC Architecture](#current-rbac-architecture)
- [Permission Breakdown](#permission-breakdown)
- [Security Design Rationale](#security-design-rationale)
- [Blue/Green Deployment RBAC](#blue-green-deployment-rbac)
- [Extension Patterns](#extension-patterns)
- [Troubleshooting](#troubleshooting)
- [Production Hardening](#production-hardening)

---

## Current RBAC Architecture

### Components

The platform uses a **ClusterRole-based RBAC model** with the following components:

```yaml
# ServiceAccount: Identity for webhook pods
apiVersion: v1
kind: ServiceAccount
metadata:
  name: webhook-service
  namespace: default

# ClusterRole: Permissions needed for multi-tenant orchestration
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: webhook-service

# ClusterRoleBinding: Links ServiceAccount to ClusterRole
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: webhook-service
subjects:
  - kind: ServiceAccount
    name: webhook-service
    namespace: default
roleRef:
  kind: ClusterRole
  name: webhook-service
```

**Key decision: ClusterRole vs Role**

We use `ClusterRole` instead of namespace-scoped `Role` because:
- All tenants deploy to a single namespace (`hosted-tenants`)
- Metacontroller webhooks need cluster-wide visibility to discover parent resources (ConfigMaps, Secrets)
- Simplifies RBAC management for multi-tenant orchestration

---

## Permission Breakdown

Each permission set maps directly to specific webhook operations. The principle: **grant only what's needed to orchestrate tenant resources**.

### Core API Group (`apiGroups: [""]`)

```yaml
resources: ["configmaps", "secrets", "services", "persistentvolumeclaims"]
verbs: ["get", "list", "watch", "create", "update", "patch"]
```

| Resource | Operations | Purpose |
|----------|------------|---------|
| **ConfigMaps** | Read (get, list, watch) | Discover tenant configurations (compute composite parents) |
| | Write (create, update, patch) | Update tenant status conditions (Kubernetes-idiomatic status reporting) |
| **Secrets** | Read (get, list, watch) | Discover storage account configurations (storage composite parents) |
| | Write (create, update, patch) | Create MongoDB credentials, update migration status annotations |
| **Services** | All | Create MongoDB headless Services, Nightscout ClusterIP Services |
| **PersistentVolumeClaims** | All | PVC Decorator adds finalizers/annotations (`patch`), StatefulSets may trigger PVC creation (`create`) |

**Why no `delete` verb?**
- Metacontroller handles deletion automatically via owner references
- Child resources (Deployments, StatefulSets, Services) are garbage-collected when parent (ConfigMap/Secret) is deleted
- Prevents accidental deletion bugs in webhook code
- Forces declarative cleanup patterns

### Apps API Group (`apiGroups: ["apps"]`)

```yaml
resources: ["deployments", "statefulsets"]
verbs: ["get", "list", "watch", "create", "update", "patch"]
```

| Resource | Operations | Purpose |
|----------|------------|---------|
| **Deployments** | All | Create/update Nightscout Deployment (compute composite child) |
| **StatefulSets** | All | Create/update MongoDB StatefulSet (storage composite child) |

**Implementation mapping:**
- `compute-composite-sync.js` → Creates/updates Deployments for Nightscout pods
- `storage-composite-sync.js` → Creates/updates StatefulSets for MongoDB replica sets

### Policy API Group (`apiGroups: ["policy"]`)

```yaml
resources: ["poddisruptionbudgets"]
verbs: ["get", "list", "watch", "create", "update", "patch"]
```

| Resource | Purpose |
|----------|---------|
| **PodDisruptionBudgets** | Ensure high availability during node drains, cluster upgrades |

**HA Strategy:**
- MongoDB StatefulSet: PDB with `minAvailable: 1` (keeps replica set quorum)
- Nightscout Deployment: PDB with `minAvailable: 1` (maintains tenant availability)

### Kafka API Group (`apiGroups: ["kafka.strimzi.io"]`)

```yaml
resources: ["kafkatopics", "kafkaconnectors"]
verbs: ["get", "list", "watch", "create", "update", "patch"]
```

| Resource | Purpose |
|----------|---------|
| **KafkaTopics** | Create CDC topics: `ns.{tenant}.entries`, `ns.{tenant}.treatments`, `dlq.ns.{tenant}` |
| **KafkaConnectors** | Create MongoDB CDC connector (when tenant enables CDC) |

**CDC Workflow:**
1. Compute composite webhook reads `CDC_ENABLED` from ConfigMap
2. Creates KafkaTopics (via Strimzi operator CRDs)
3. Waits for MongoDB StatefulSet to be ready
4. Creates KafkaConnector pointing to MongoDB replica set

### Snapshot API Group (`apiGroups: ["snapshot.storage.k8s.io"]`)

```yaml
resources: ["volumesnapshots"]
verbs: ["get", "list", "watch", "create", "update", "patch"]
```

| Resource | Purpose |
|----------|---------|
| **VolumeSnapshots** | Backup MongoDB PVCs before deletion (decorator controller pattern) |

**Backup Decorator Flow:**
1. PVC Decorator watches all PVCs with label `app.kubernetes.io/component: database`
2. Adds finalizer `ns.mdn.io/backup-pvc` to PVC
3. On PVC deletion, creates VolumeSnapshot
4. Removes finalizer after snapshot succeeds

### Batch API Group (`apiGroups: ["batch"]`)

```yaml
resources: ["jobs"]
verbs: ["get", "list", "watch", "create", "update", "patch"]
```

| Resource | Purpose |
|----------|---------|
| **Jobs** | Execute database migration (Gen 3b shared → Gen 4 dedicated MongoDB) |

**Migration Job Pattern:**
1. Storage composite detects annotations: `ns.mdn.io/migration-needed: true`, `ns.mdn.io/migration-source-uri`
2. Creates Job with `mongodump` → `mongorestore` logic
3. Job runs to completion, sets `ns.mdn.io/migration-complete: true` on Secret
4. Compute composite waits for `migration-complete` before creating Deployment

### Nightscout CRD API Group (`apiGroups: ["nightscout.io"]`) - Gen 4

```yaml
# CRD parent resources
resources: ["storageaccounts", "computeinstances"]
verbs: ["get", "list", "watch", "create", "update", "patch"]

# CRD status subresources (webhook only)
resources: ["storageaccounts/status", "computeinstances/status"]
verbs: ["update", "patch"]
```

| Resource | Operations | Purpose |
|----------|------------|---------|
| **StorageAccount** | Read (get, list, watch) | Discover storage account CRDs (storage composite parent - Gen 4) |
| | Write (create, update, patch) | Provisioner API creates/updates storage accounts |
| | Status (update, patch) | Webhook updates `.status.phase`, `.status.conditions`, `.status.connectionSecret` |
| **ComputeInstance** | Read (get, list, watch) | Discover compute instance CRDs (compute composite parent - Gen 4) |
| | Write (create, update, patch) | Provisioner API creates/updates tenants |
| | Status (update, patch) | Webhook updates `.status.phase`, `.status.conditions`, `.status.endpoints` |

**Gen 4 CRD-Based Architecture:**
- **Parent resources**: StorageAccount and ComputeInstance CRDs replace Secret/ConfigMap as Metacontroller parent resources
- **Status subresources**: Separate RBAC rule for `.status` updates enables Kubernetes-standard status reporting
- **Provisioner permissions**: Provisioner API needs full CRUD (including `delete`) for tenant lifecycle management
- **Webhook permissions**: Webhooks need read/write on main resources + status updates, but no `delete` (owner references handle cleanup)

**Implementation mapping:**
- `storage-composite-sync.js` → Reads StorageAccount CRD spec, updates `.status` with phase/conditions
- `compute-composite-sync.js` → Reads ComputeInstance CRD spec, updates `.status` with endpoints
- `lib/routes/storage-accounts.js` → Provisioner API creates/updates/deletes StorageAccount CRDs
- `lib/routes/compute-instances.js` → Provisioner API creates/updates/deletes ComputeInstance CRDs

**Why separate status subresource permissions?**
- Kubernetes best practice: Status updates use different API endpoints (`/status`)
- Enables field-level RBAC: Different controllers can update spec vs status
- Prevents accidental spec overwrites during status updates (Server-Side Apply)

---

## Security Design Rationale

### 1. Least Privilege Principle

**Granted:**
- `get`, `list`, `watch` - Read operations for discovery and status checking
- `create`, `update`, `patch` - Write operations for child resource management

**Denied:**
- `delete`, `deletecollection` - Unnecessary (owner references handle cleanup)
- `escalate`, `bind`, `impersonate` - Privilege escalation vectors
- Wildcard verbs (`*`) - Too broad, violates least privilege

**Why `patch` is included:**
Metacontroller uses Server-Side Apply (SSA) via PATCH requests to update child resources. This enables:
- Declarative field ownership (webhook owns specific fields, other controllers can own others)
- Safe concurrent updates (multiple controllers can modify same resource)
- Kubernetes-idiomatic status reporting (webhooks update `.status` via PATCH)

### 2. No Namespace Isolation (Single Namespace Strategy)

**Design choice:**
All tenants deploy to `hosted-tenants` namespace with resource-level isolation via:
- Tenant ID prefix (e.g., `demo1234-nightscout`)
- Labels: `ns.mdn.io/tenant`, `app.kubernetes.io/instance`

**Alternatives considered:**
- **Namespace-per-tenant**: Would require dynamic RBAC (create RoleBindings per namespace)
  - Rejected: Complexity of managing 1000+ namespaces, RBAC sprawl
- **Namespaced Roles**: Would require separate Role per namespace
  - Rejected: ClusterRole + single namespace is simpler for webhook service

**Trade-offs:**
- ✅ Simpler RBAC management (single ClusterRole)
- ✅ Easier service discovery (all tenants in one namespace)
- ⚠️ Requires careful labeling discipline (critical for resolver routing)
- ⚠️ ResourceQuotas apply namespace-wide (not per-tenant)

### 3. ServiceAccount vs User Accounts

**Why ServiceAccount:**
- Pods authenticate as ServiceAccount (not user)
- Token auto-mounted to pod at `/var/run/secrets/kubernetes.io/serviceaccount/token`
- Scoped to namespace (webhook-service ServiceAccount in `default` namespace)

**Security features:**
- Token rotation (Kubernetes 1.21+: time-bound tokens)
- Pod-level identity (each webhook pod uses same ServiceAccount)
- Audit trail (API server logs show `system:serviceaccount:default:webhook-service`)

### 4. ClusterRole vs ClusterRoleBinding Scope

**ClusterRole:** Defines permissions (resource + verbs)
**ClusterRoleBinding:** Grants those permissions to a subject (ServiceAccount)

**Why ClusterRoleBinding (not RoleBinding):**
- Grants cluster-wide access to `webhook-service` ServiceAccount
- Necessary because all tenants are in one namespace (`hosted-tenants`)
- Simpler than multiple RoleBindings per namespace

**Scoping strategy:**
```
ClusterRole (webhook-service)
    ↓
ClusterRoleBinding (webhook-service)
    ↓
ServiceAccount (default/webhook-service)
    ↓
Pods (webhook-service-*)
```

---

## Blue/Green Deployment RBAC

As the platform scales, you may deploy **blue/green environments** for zero-downtime upgrades:
- **Blue environment:** Current production webhook + resolvers
- **Green environment:** New version being validated
- **Resolver routing:** Tenants route to blue or green based on labels

### Architecture: Dual Webhook Deployments

```
┌─────────────────────────────────────────────────────────┐
│                   Kubernetes Cluster                     │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  Metacontroller                                          │
│  ├── CompositeController (storage)                      │
│  │   └── Webhook: http://webhook-blue:3000/sync-storage│
│  └── CompositeController (compute)                      │
│      └── Webhook: http://webhook-blue:3000/sync-compute│
│                                                           │
│  Blue Deployment                   Green Deployment     │
│  ├── webhook-blue-*                ├── webhook-green-*  │
│  ├── ServiceAccount: webhook-blue  ├── SA: webhook-green│
│  └── Service: webhook-blue         └── Service: webhook-green│
│                                                           │
│  Resolver Blue                     Resolver Green        │
│  ├── resolver-blue-*               ├── resolver-green-*  │
│  ├── ServiceAccount: resolver-blue ├── SA: resolver-green│
│  └── Routes tenants with           └── Routes tenants w/│
│      label: deployment.env=blue        label: env=green │
└─────────────────────────────────────────────────────────┘
```

### RBAC Strategy for Blue/Green

#### Option 1: Shared ServiceAccount (Simpler)

Both blue and green webhooks use the **same ServiceAccount** (`webhook-service`):

**Pros:**
- Single ClusterRole to maintain
- No RBAC changes during cutover
- Simpler deployment automation

**Cons:**
- Both environments have identical permissions (can't test permission changes)
- Audit logs don't distinguish blue vs green actions

**When to use:**
- Blue/green is for application code changes (not RBAC changes)
- You trust both environments equally

#### Option 2: Separate ServiceAccounts (Safer)

Each environment has its own ServiceAccount:

```yaml
# Blue environment
apiVersion: v1
kind: ServiceAccount
metadata:
  name: webhook-blue
  namespace: default
---
# Green environment
apiVersion: v1
kind: ServiceAccount
metadata:
  name: webhook-green
  namespace: default
---
# Shared ClusterRole (both use same permissions)
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: webhook-orchestrator
---
# Blue ClusterRoleBinding
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: webhook-blue
subjects:
  - kind: ServiceAccount
    name: webhook-blue
    namespace: default
roleRef:
  kind: ClusterRole
  name: webhook-orchestrator
---
# Green ClusterRoleBinding
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: webhook-green
subjects:
  - kind: ServiceAccount
    name: webhook-green
    namespace: default
roleRef:
  kind: ClusterRole
  name: webhook-orchestrator
```

**Pros:**
- Audit logs distinguish blue vs green (different ServiceAccount names)
- Can test RBAC changes in green before promoting to blue
- Easier to revoke permissions for one environment

**Cons:**
- More RBAC resources to manage
- Must update both bindings when changing permissions

**When to use:**
- You need audit trail separation
- Testing RBAC changes before production cutover

### Resolver RBAC (Read-Only Pattern)

Resolvers route Nightscout traffic to tenant pods. They need **read-only access** to discover Services and Endpoints:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: resolver
  namespace: default
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: resolver-reader
rules:
  - apiGroups: [""]
    resources: ["services", "endpoints", "configmaps"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: resolver
subjects:
  - kind: ServiceAccount
    name: resolver
    namespace: default
roleRef:
  kind: ClusterRole
  name: resolver-reader
```

**Why these permissions:**
- `services`: Discover Nightscout Services by label (`ns.mdn.io/tenant`)
- `endpoints`: Get pod IPs for load balancing
- `configmaps`: Read tenant configuration for routing logic (optional)
- `pods`: Check pod readiness before routing traffic

**Blue/Green resolver routing:**

Resolvers can route tenants to blue or green based on labels:

```javascript
// Resolver logic (pseudo-code)
const tenantConfig = await k8s.getConfigMap(tenantId);
const deploymentEnv = tenantConfig.labels['deployment.env'] || 'blue';

// Route to blue or green service
const service = await k8s.getService(`${tenantId}-nightscout-${deploymentEnv}`);
const endpoints = await k8s.getEndpoints(service.name);
return loadBalance(endpoints);
```

### Gradual Cutover Pattern

**Phase 1: Green validation (no traffic)**
1. Deploy `webhook-green` with new code
2. Update Metacontroller to point to `http://webhook-green:3000/sync-*`
3. Create test tenant with label `deployment.env: green`
4. Verify green webhook creates resources correctly

**Phase 2: Canary rollout (10% traffic)**
1. Label 10% of tenants with `deployment.env: green`
2. Resolvers route those tenants to green pods
3. Monitor metrics, logs, errors

**Phase 3: Full cutover**
1. Label all tenants with `deployment.env: green`
2. Verify all traffic on green
3. Delete `webhook-blue` deployment

**RBAC considerations:**
- No RBAC changes needed during cutover (permissions don't change)
- Audit logs show which ServiceAccount created each resource (blue vs green)

---

## Extension Patterns

### Adding New Resource Types

**Scenario:** You want to add NetworkPolicies to isolate tenant traffic.

1. **Update ClusterRole:**

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: webhook-service
rules:
  # Existing rules...
  - apiGroups: ["networking.k8s.io"]
    resources: ["networkpolicies"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
```

2. **Update webhook code:**

```javascript
// compute-composite-sync.js
function syncComposite(parent) {
  const children = {
    deployment: renderDeployment(parent),
    service: renderService(parent),
    networkPolicy: renderNetworkPolicy(parent),  // NEW
  };
  return { status: {}, children };
}

function renderNetworkPolicy(parent) {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: `${parent.data.TENANT_ID}-netpol`,
    },
    spec: {
      podSelector: {
        matchLabels: { 'ns.mdn.io/tenant': parent.data.TENANT_ID },
      },
      policyTypes: ['Ingress'],
      ingress: [{
        from: [{ podSelector: { matchLabels: { app: 'resolver' } } }],
      }],
    },
  };
}
```

3. **Apply updated ClusterRole:**

```bash
kubectl apply -f k8s/metactl/webhook-deployment.yaml
# No webhook pod restart needed (RBAC is checked per-request)
```

### Adding Custom CRDs

**Scenario:** You create a custom `NightscoutTenant` CRD for better API abstraction.

1. **Define CRD and permissions:**

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: nightscouttenants.nightscout.io
spec:
  group: nightscout.io
  names:
    kind: NightscoutTenant
    plural: nightscouttenants
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: webhook-service
rules:
  # Existing rules...
  - apiGroups: ["nightscout.io"]
    resources: ["nightscouttenants"]
    verbs: ["get", "list", "watch", "update", "patch"]
  - apiGroups: ["nightscout.io"]
    resources: ["nightscouttenants/status"]
    verbs: ["update", "patch"]
```

**Why `/status` subresource:**
- Separates spec (desired state) from status (observed state)
- Webhooks update status, users update spec
- Kubernetes convention for CRDs

### Deployment Controller Combined RBAC (Gen 4)

**Scenario:** `k8s-deployment-controller.js` handles both webhook operations AND provisioner API, requiring combined permissions.

The `deploymentControllerRBAC()` function in `rbac.libsonnet` provides an ergonomic export that bundles:
- Webhook orchestration permissions (fullOrchestrationRole)
- Provisioner API permissions (provisionerRole with delete verb)
- Gen 3 (ConfigMap/Secret) and Gen 4 (CRD) support

**Usage in Jsonnet:**

```jsonnet
local rbac = import 'lib-k8s-multienv/rbac.libsonnet';

{
  // Single function call creates ServiceAccount + ClusterRole + ClusterRoleBinding
  deployment_controller_rbac: rbac.deploymentControllerRBAC('deployment-controller', 'default'),
}
```

**Generated resources:**
1. **ServiceAccount**: `deployment-controller` (namespace: default)
2. **ClusterRole**: Combined permissions including:
   - ConfigMaps/Secrets: full CRUD (Gen 3 legacy + provisioner delete)
   - StorageAccount/ComputeInstance CRDs: full CRUD (Gen 4)
   - CRD status subresources: update/patch (webhook status reporting)
   - Child resources: Deployments, StatefulSets, Services, Jobs, etc.
3. **ClusterRoleBinding**: Links ServiceAccount to ClusterRole

**Permission highlights:**
- `delete` verb on ConfigMaps/Secrets/CRDs: Provisioner API tenant removal
- Status subresource access: Kubernetes-standard status reporting
- No `delete` on child resources: Owner references handle cleanup

**Alternative approaches:**

If you need separate webhook and provisioner services:

```jsonnet
// Separate webhook service (no delete permissions)
webhook_rbac: rbac.webhookServiceAccount('webhook-service'),

// Separate provisioner service (with delete permissions)
provisioner_rbac: rbac.provisionerServiceAccount('provisioner-api'),
```

This allows finer-grained RBAC if you split the deployment-controller into microservices.

### Multi-Namespace Expansion

**Scenario:** You want to deploy tenants across multiple namespaces (e.g., `tenants-us`, `tenants-eu`).

**Option 1: ClusterRole + RoleBindings per namespace**

```yaml
# ClusterRole stays the same (defines permissions)
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: webhook-service

# RoleBinding in each namespace (grants permissions)
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: webhook-service
  namespace: tenants-us
subjects:
  - kind: ServiceAccount
    name: webhook-service
    namespace: default
roleRef:
  kind: ClusterRole
  name: webhook-service
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: webhook-service
  namespace: tenants-eu
subjects:
  - kind: ServiceAccount
    name: webhook-service
    namespace: default
roleRef:
  kind: ClusterRole
  name: webhook-service
  apiGroup: rbac.authorization.k8s.io
```

**Why RoleBinding instead of ClusterRoleBinding:**
- Limits webhook to specific namespaces (defense in depth)
- Prevents webhook from accessing other namespaces

**Option 2: Keep ClusterRoleBinding (simpler)**

If you trust the webhook to access all namespaces, keep the current ClusterRoleBinding. The webhook code can filter by namespace.

### ServiceAccount per Component (Recommended for Production)

**Scenario:** You have multiple daemons with different responsibilities and scaling needs.

**Current components:**
1. **Metacontroller webhooks** - Sync endpoints for composite/decorator controllers
2. **Deployment server** - REST API provisioner (accounts, sites, metadata)
3. **Consul health checks** - High-traffic endpoints for resolver service discovery

**Problem:** Consul health check traffic is overwhelming the webhook pods. You want to scale health checks independently without scaling the heavier webhook logic.

**Solution:** Separate ServiceAccounts with least-privilege permissions per component.

#### 1. Webhook Service (Metacontroller Sync)

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: webhook-metacontroller
  namespace: default
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: webhook-metacontroller
rules:
  # Full orchestration permissions (current webhook-service role)
  - apiGroups: [""]
    resources: ["configmaps", "secrets", "services", "persistentvolumeclaims"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  - apiGroups: ["policy"]
    resources: ["poddisruptionbudgets"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  - apiGroups: ["kafka.strimzi.io"]
    resources: ["kafkatopics", "kafkaconnectors"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  - apiGroups: ["snapshot.storage.k8s.io"]
    resources: ["volumesnapshots"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: webhook-metacontroller
subjects:
  - kind: ServiceAccount
    name: webhook-metacontroller
    namespace: default
roleRef:
  kind: ClusterRole
  name: webhook-metacontroller
  apiGroup: rbac.authorization.k8s.io
```

#### 2. Deployment Server (REST API Provisioner)

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: deployment-server
  namespace: default
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: deployment-server
rules:
  # ConfigMaps: Create/update tenant configs
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  # Secrets: Create/update storage accounts
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  # Read-only for status queries
  - apiGroups: [""]
    resources: ["services", "pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: deployment-server
subjects:
  - kind: ServiceAccount
    name: deployment-server
    namespace: default
roleRef:
  kind: ClusterRole
  name: deployment-server
  apiGroup: rbac.authorization.k8s.io
```

**Note:** Deployment server gets `delete` for ConfigMaps/Secrets (supports tenant deletion via API).

#### 3. Consul Health Check Service (Read-Only, High-Traffic)

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: consul-healthcheck
  namespace: default
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: consul-healthcheck
rules:
  # Read-only: Query tenant status for health checks
  - apiGroups: [""]
    resources: ["configmaps", "services", "endpoints", "pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: consul-healthcheck
subjects:
  - kind: ServiceAccount
    name: consul-healthcheck
    namespace: default
roleRef:
  kind: ClusterRole
  name: consul-healthcheck
  apiGroup: rbac.authorization.k8s.io
```

**Scaling strategy:**

```yaml
# Webhook pods (Metacontroller sync endpoints)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: webhook-metacontroller
spec:
  replicas: 2  # Low traffic, stateless sync logic
  template:
    spec:
      serviceAccountName: webhook-metacontroller
      containers:
        - name: webhook
          env:
            - name: RUNTIME_MODE
              value: "webhook"  # Only /sync-storage, /sync-compute endpoints
---
# Consul health check pods (high-traffic, read-only)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: consul-healthcheck
spec:
  replicas: 10  # Scale independently for Consul traffic
  template:
    spec:
      serviceAccountName: consul-healthcheck
      containers:
        - name: healthcheck
          env:
            - name: RUNTIME_MODE
              value: "healthcheck"  # Only /health, /v1/health/* endpoints
---
# Deployment server pods (REST API provisioner)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: deployment-server
spec:
  replicas: 3
  template:
    spec:
      serviceAccountName: deployment-server
      containers:
        - name: provisioner
          env:
            - name: RUNTIME_MODE
              value: "provisioner"  # Only /accounts, /sites endpoints
```

**Benefits:**
- ✅ Scale Consul health checks independently (10+ replicas without scaling webhook logic)
- ✅ Least privilege per component (health checks can't write, webhooks can't delete)
- ✅ Clear audit trail (logs show which component performed action)
- ✅ Fault isolation (compromised health check pods can't modify resources)
- ✅ Easier debugging (separate ServiceAccount = separate token, easier to trace API calls)

**Container runtime mode implementation:**

```javascript
// cmd/webhook/server.js
const RUNTIME_MODE = process.env.RUNTIME_MODE || 'all';

if (RUNTIME_MODE === 'webhook' || RUNTIME_MODE === 'all') {
  // Metacontroller sync endpoints
  app.post('/sync-storage', syncStorageComposite);
  app.post('/sync-compute', syncComputeComposite);
  app.post('/sync-pvc-decorator', syncPvcDecorator);
}

if (RUNTIME_MODE === 'healthcheck' || RUNTIME_MODE === 'all') {
  // Consul health check endpoints
  app.get('/health', healthCheck);
  app.get('/v1/health/service/:tenant', consulHealthCheck);
}

if (RUNTIME_MODE === 'provisioner' || RUNTIME_MODE === 'all') {
  // REST API provisioner endpoints
  app.post('/accounts/:account', createAccount);
  app.post('/accounts/:account/sites/:tenant', createSite);
  app.post('/configmaps/:name/metadata/labels/:field', addLabel);
}
```

### Read-Only Operator Accounts

**Scenario:** You want a monitoring tool to read tenant status without write access.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: tenant-observer
  namespace: default
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: tenant-observer
rules:
  - apiGroups: [""]
    resources: ["configmaps", "secrets", "services", "pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: tenant-observer
subjects:
  - kind: ServiceAccount
    name: tenant-observer
    namespace: default
roleRef:
  kind: ClusterRole
  name: tenant-observer
  apiGroup: rbac.authorization.k8s.io
```

**Use case:**
- Prometheus scraping tenant metrics
- Grafana dashboards querying tenant status
- External monitoring tools

---

## Troubleshooting

### Common RBAC Errors

#### Error: `forbidden: User "system:serviceaccount:default:webhook-service" cannot create resource "deployments"`

**Cause:** ServiceAccount doesn't have `create` permission for Deployments.

**Debug:**

```bash
# Check what the ServiceAccount can do
kubectl auth can-i create deployments \
  --as=system:serviceaccount:default:webhook-service \
  -n hosted-tenants

# Output: no
```

**Fix:** Ensure ClusterRole includes Deployments:

```yaml
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["create", "update", "patch"]
```

#### Error: `forbidden: User "system:serviceaccount:default:webhook-service" cannot patch resource "configmaps/status"`

**Cause:** ConfigMaps don't have a `/status` subresource (only CRDs do).

**Debug:**

```bash
# ConfigMaps use main resource for status
kubectl auth can-i patch configmaps \
  --as=system:serviceaccount:default:webhook-service

# Output: yes
```

**Fix:** Update ConfigMap using PATCH on main resource (not `/status`):

```javascript
// WRONG: ConfigMaps don't have /status subresource
await k8s.patchConfigMapStatus(name, { status: { ... } });

// CORRECT: Patch main resource
await k8s.patchConfigMap(name, { status: { ... } });
```

#### Error: `webhook-service cannot impersonate resource "users"`

**Cause:** Webhook code tries to impersonate a user (not allowed).

**Debug:**

```bash
kubectl auth can-i impersonate users \
  --as=system:serviceaccount:default:webhook-service

# Output: no
```

**Fix:** Remove impersonation code. Webhooks should act as their own ServiceAccount.

### Debugging RBAC Issues

#### 1. Check ServiceAccount permissions

```bash
# Can the ServiceAccount create Deployments?
kubectl auth can-i create deployments \
  --as=system:serviceaccount:default:webhook-service \
  -n hosted-tenants

# List all permissions
kubectl auth can-i --list \
  --as=system:serviceaccount:default:webhook-service
```

#### 2. Inspect ClusterRoleBinding

```bash
# Get ClusterRoleBinding details
kubectl get clusterrolebinding webhook-service -o yaml

# Expected output:
# subjects:
# - kind: ServiceAccount
#   name: webhook-service
#   namespace: default
# roleRef:
#   kind: ClusterRole
#   name: webhook-service
```

#### 3. Verify ClusterRole rules

```bash
# Get ClusterRole permissions
kubectl get clusterrole webhook-service -o yaml

# Check specific resource
kubectl get clusterrole webhook-service -o jsonpath='{.rules[?(@.resources[0]=="deployments")]}'
```

#### 4. Check API server logs (if still failing)

```bash
# On the API server node (requires cluster admin)
journalctl -u kube-apiserver | grep -i "forbidden"

# Look for RBAC audit denials
audit.k8s.io/v1 "forbidden" user="system:serviceaccount:default:webhook-service"
```

### RBAC Audit Logging

Enable audit logging to track RBAC denials:

```yaml
# kube-apiserver flags
--audit-policy-file=/etc/kubernetes/audit-policy.yaml
--audit-log-path=/var/log/kubernetes/audit.log
```

**Audit policy (track RBAC denials):**

```yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  # Log RBAC denials
  - level: RequestResponse
    verbs: ["create", "update", "patch", "delete"]
    omitStages:
      - RequestReceived
    resources:
      - group: ""
      - group: "apps"
      - group: "policy"
      - group: "kafka.strimzi.io"
      - group: "snapshot.storage.k8s.io"
      - group: "batch"
```

**Query audit log:**

```bash
# Find RBAC denials for webhook-service
jq 'select(.user.username == "system:serviceaccount:default:webhook-service" and .responseStatus.code == 403)' \
  /var/log/kubernetes/audit.log
```

---

## Production Hardening

### 1. Pod Security Standards

Restrict webhook pod capabilities using Pod Security Standards (PSS):

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: default
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
```

**Webhook Deployment adjustments:**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: webhook-service
spec:
  template:
    spec:
      serviceAccountName: webhook-service
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: webhook
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
            readOnlyRootFilesystem: true
          volumeMounts:
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tmp
          emptyDir: {}
```

### 2. Network Policies

Isolate webhook traffic using NetworkPolicies:

```yaml
# Restrict webhook ingress (only from Metacontroller)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: webhook-service
  namespace: default
spec:
  podSelector:
    matchLabels:
      app: webhook-service
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Allow from Metacontroller
    - from:
        - namespaceSelector:
            matchLabels:
              name: metacontroller
        - podSelector:
            matchLabels:
              app: metacontroller
      ports:
        - protocol: TCP
          port: 3000
  egress:
    # Allow to Kubernetes API server
    - to:
        - namespaceSelector: {}
          podSelector:
            matchLabels:
              component: kube-apiserver
      ports:
        - protocol: TCP
          port: 443
    # Allow DNS
    - to:
        - namespaceSelector:
            matchLabels:
              name: kube-system
        - podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
```

### 3. Secret Encryption at Rest

Enable encryption for Secrets containing MongoDB credentials:

```yaml
# EncryptionConfiguration for kube-apiserver
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
      - secrets
    providers:
      - aescbc:
          keys:
            - name: key1
              secret: <base64-encoded-32-byte-key>
      - identity: {}
```

**Apply to kube-apiserver:**

```bash
# kube-apiserver flags
--encryption-provider-config=/etc/kubernetes/encryption-config.yaml
```

### 4. RBAC Best Practices Checklist

- ✅ **No wildcard permissions** (`*` verbs or resources)
- ✅ **No `cluster-admin` ClusterRole** for webhook
- ✅ **No `delete` verbs** (owner references handle cleanup)
- ✅ **No `escalate`, `bind`, `impersonate`** verbs (privilege escalation)
- ✅ **Separate read-only accounts** (resolver, monitoring)
- ✅ **Audit logging enabled** (track RBAC denials)
- ✅ **ServiceAccount tokens time-bound** (Kubernetes 1.21+)
- ✅ **Pod Security Standards enforced** (restricted profile)
- ✅ **Network Policies** (limit webhook network access)

### 5. Regular RBAC Audits

**Monthly audit checklist:**

```bash
# 1. List all ClusterRoleBindings
kubectl get clusterrolebindings -o wide | grep webhook

# 2. Check for over-privileged accounts
kubectl get clusterrolebindings -o json | \
  jq -r '.items[] | select(.roleRef.name == "cluster-admin") | .metadata.name'

# 3. Review webhook ServiceAccount permissions
kubectl auth can-i --list \
  --as=system:serviceaccount:default:webhook-service

# 4. Check for unused ServiceAccounts
kubectl get sa --all-namespaces -o json | \
  jq -r '.items[] | select(.metadata.name | startswith("webhook")) | "\(.metadata.namespace)/\(.metadata.name)"'

# 5. Verify no secrets exposed in logs
kubectl logs -l app=webhook-service | grep -i "mongodb://"
```

---

## Summary

**Current RBAC model:**
- ClusterRole with minimal permissions (no `delete`, no wildcards)
- Single ServiceAccount (`webhook-service`) for all webhook pods
- ClusterRoleBinding grants cluster-wide access (all tenants in `hosted-tenants` namespace)

**Blue/green deployment options:**
- **Shared ServiceAccount**: Simpler, same permissions for blue and green
- **Separate ServiceAccounts**: Better audit trail, can test RBAC changes in green

**Extension patterns:**
- Add new resource types (NetworkPolicies, CRDs) by updating ClusterRole
- Multi-namespace: Use RoleBindings per namespace instead of ClusterRoleBinding
- Read-only accounts: Create separate ServiceAccounts for monitoring/observability

**Production hardening:**
- Pod Security Standards (restricted profile)
- Network Policies (limit webhook network access)
- Secret encryption at rest
- Regular RBAC audits

For questions or clarifications, refer to:
- [Webhook Architecture](./WEBHOOK-ARCHITECTURE.md)
- [Metacontroller Integration](./METACONTROLLER-INTEGRATION.md)
- [Two-Composite Architecture](./TWO-COMPOSITE-ARCHITECTURE.md)
