# Architecture Evolution: The Facade Pattern Journey

## Overview

This project demonstrates a textbook implementation of the **Facade Pattern** across five architectural generations (Gen 1, Gen 2, Gen 3a, Gen 3b, Gen 4). Each generation improved on the previous implementation while maintaining compatibility where possible, allowing the platform to evolve from a simple process-based system to a fully declarative Kubernetes-native orchestration platform.

**Key Insight:** By wisely configuring components and maintaining interface compatibility, the project stayed flexible and evolved over time without breaking existing integrations.

## The Generations

| Generation | Implementation | Configuration Source | Orchestration | API Type | Status |
|------------|----------------|----------------------|---------------|----------|--------|
| **Gen 1** | Process-based | `.env` files | Node.js cluster | REST | Legacy |
| **Gen 2** | StatefulSet + demuxer | Kubernetes ConfigMaps | Demuxer routes admin changes | REST (compatible) | Legacy |
| **Gen 3a** | StatefulSet + ConfigMap watch | ConfigMaps (watched) | Demuxer propagates ConfigMap changes | REST | Legacy |
| **Gen 3b** | Deployment controller | ConfigMaps + Dispatcher | Per-tenant Deployments | REST + Webhooks | Legacy |
| **Gen 4** | Metacontroller webhooks | ConfigMaps (declarative) | Metacontroller | Webhooks only | Current |

---

## Generation 1: multienv (Process-Based Multi-Tenancy)

**Implementation:** `server.js` + `master.js`  
**Configuration:** `.env` files in `WORKER_ENV` directory  
**OpenAPI Spec:** [docs/openapi-gen1-multienv.yaml](openapi-gen1-multienv.yaml)

### Architecture

```
┌─────────────────┐
│   master.js     │
│  (File Watcher) │
└────────┬────────┘
         │ watches WORKER_ENV/*.env
         │ forks processes
         v
┌─────────────────┐       ┌──────────────────┐
│   server.js     │<──────│  REST API Client │
│   (REST API)    │       └──────────────────┘
└────────┬────────┘
         │ manages
         v
┌─────────────────┐
│ Worker Processes│ (one Nightscout per .env file)
│  PORT: 5001     │
│  PORT: 5002     │
│  PORT: 5003     │
└─────────────────┘
```

### Key Characteristics

- **Configuration:** `.env` files (one per tenant)
- **Process Management:** Node.js `cluster` module
- **Isolation:** Each tenant runs as separate process with unique PORT
- **Orchestration:** File system watching triggers process lifecycle
- **Scaling Limit:** Single host, ~50 tenants max

### REST API Endpoints

```
GET  /cluster                    # List all running processes
GET  /cluster/:id                # Get process by ID
GET  /environs                   # List all environments (.env files)
POST /environs/:name             # Create environment (creates .env file)
GET  /environs/:name             # Get environment details
DELETE /environs/:name           # Delete environment (deletes .env file)
POST /environs/:name/env/:field  # Set environment variable
GET  /environs/:name/env/:field  # Get environment variable
GET  /resolve/:id                # Resolve process for nginx proxying
GET  /stats/active               # Get cluster statistics
```

### Use Cases

✅ Development and testing  
✅ Small-scale production (< 50 tenants)  
✅ Single-host deployments  
✅ Quick prototyping  

❌ Multi-node clusters  
❌ High availability  
❌ Cloud-native deployments  

### Why It Worked

- **Simple**: Easy to understand and debug
- **Fast**: Direct process communication
- **Self-contained**: No external dependencies
- **Familiar**: Standard Unix process model

### Why We Evolved

- **Scaling limits**: Single host bottleneck
- **No cloud-native**: Can't leverage Kubernetes
- **Manual operations**: No declarative config
- **State management**: File system as source of truth

---

## Generation 2: Inspector (StatefulSet Runners + Demuxer for Admin)

**Implementation:** `k8s-inspector.js` + StatefulSet of `master.js` runners + demuxer  
**Configuration:** Kubernetes ConfigMaps  
**OpenAPI Spec:** [docs/openapi-gen2-inspector.yaml](openapi-gen2-inspector.yaml)

### Architecture

```
┌──────────────────┐       ┌──────────────────┐
│ k8s-inspector.js │<──────│  REST API Client │
│   (REST API)     │       └──────────────────┘
└────────┬─────────┘
         │ CRUD operations
         v
┌─────────────────────────┐
│  Kubernetes ConfigMaps  │
│                         │
│  - demo (enabled=true)  │
│  - prod (enabled=true)  │
│  - test (enabled=true)  │
└─────────────────────────┘
         │
         v
    ┌────────┐     Internal admin change
    │ Demuxer│ ────────────────────────────┐
    └────────┘                             │
         │                                 │
         ├─────────────────────────────────┤
         v                                 v
┌──────────────────┐          ┌──────────────────┐
│ master.js        │          │ master.js        │
│ (StatefulSet-0)  │          │ (StatefulSet-1)  │
│                  │          │                  │
│ Consul update    │          │ Consul update    │
└──────────────────┘          └──────────────────┘
```

### Key Characteristics

- **Configuration:** Kubernetes ConfigMaps instead of .env files
- **Process Management:** StatefulSet of master.js runners
- **Admin Routing:** Demuxer globally routes internal admin change requests across StatefulSet runners
- **API Compatibility:** Maintains Gen 1 `/environs` endpoints
- **Kubernetes-Native:** Uses @kubernetes/client-node
- **Consul Update:** `master.js` manually updates Consul based on internal process state
- **Migration Bridge:** Designed as stepping stone to Gen 3

### REST API Endpoints

```
# ConfigMap-specific endpoints
GET  /inspect/:name              # Get ConfigMap (raw K8s object)
POST /inspect/:name              # Create/update ConfigMap
DELETE /inspect/:name            # Delete ConfigMap
GET  /inspect/:name/env          # Get ConfigMap data fields
GET  /inspect/:name/env/:field   # Get single data field

# Gen 1 compatible endpoints
GET  /environs/:name             # Get environment (multienv-compatible)
POST /environs/:name             # Create environment
DELETE /environs/:name           # Delete environment
GET  /environs/:name/env         # Get environment variables
POST /environs/:name/env/:field  # Set environment variable
```

### Response Format (Compatibility Layer)

**Generation 1 response:**
```json
{
  "id": "1234",
  "custom_env": { "WEB_NAME": "demo", "PORT": "5001" },
  "state": "online",
  "isDead": false
}
```

**Generation 2 response (compatible):**
```json
{
  "custom_env": { "WEB_NAME": "demo", "MONGO_IMAGE": "mongo:6" },
  "state": "persisted",
  "metadata": { "name": "demo", "namespace": "hosted-tenants" }
}
```

### Use Cases

✅ Kubernetes-based config persistence  
✅ GitOps workflows (ConfigMaps in Git)  
✅ Testing Kubernetes integration  
✅ Migration from Gen 1 to Gen 3  

❌ Actual pod creation (no workloads)  
❌ Production deployments (needs Gen 3)  

### Why It Worked

- **Kubernetes-Native:** Uses standard K8s resources
- **API Compatible:** Drop-in replacement for Gen 1
- **Separation of Concerns:** Config persistence separate from orchestration
- **GitOps Ready:** ConfigMaps can be version controlled

### Why We Evolved

- **No Orchestration:** Doesn't create actual pods/deployments
- **Manual Operations:** Still requires separate deployment mechanism
- **Incomplete Solution:** Just one piece of the puzzle

---

## Generation 3a: StatefulSet Runners (ConfigMap Watch + Demuxer Propagation)

**Implementation:** `master.js` StatefulSet + `tenant-availability-keeper.js` (demuxer)  
**Configuration:** ConfigMap watch triggers demuxer to propagate changes to runners  
**Timeframe:** Early Kubernetes adoption

### Architecture

```
┌─────────────────────┐
│  Kubernetes API     │
│  (ConfigMap watch)  │
└──────────┬──────────┘
           │ watch events
           v
┌─────────────────────────────────┐
│ tenant-availability-keeper.js   │
│  (Demuxer)                      │
│  - Watches ConfigMaps           │
│  - Propagates changes to        │
│    runners                      │
└──────────┬──────────────────────┘
           │ propagate
           v
┌─────────────────────────────────┐
│   StatefulSet: master.js        │
│   (Multi-Instance Runners)      │
│                                 │
│   master-0 (10 tenants)         │
│   master-1 (15 tenants)         │
│   master-2 (8 tenants)          │
│                                 │
│   Each pod runs server.js       │
│   Manages tenant processes      │
│   Manually updates Consul       │
└──────────┬──────────────────────┘
           │ register with Consul
           v
┌─────────────────────────────────┐
│         Consul                  │
│   (Service Discovery)           │
│   - cluster service             │
│   - tenant tags                 │
└──────────┬──────────────────────┘
           │ query for routing
           v
┌─────────────────────────────────┐
│  Resolver (demuxer)             │
│  - Routes traffic to            │
│    StatefulSet members          │
│  - Uses Consul for discovery    │
└─────────────────────────────────┘
```

### Key Characteristics

- **Configuration:** ConfigMap watch triggers demuxer to propagate changes to runners
- **Orchestration:** Demuxer watches ConfigMaps and propagates changes to appropriate master.js instance
- **Load Balancing:** New tenants assigned to least loaded/dense runner
- **Isolation:** Each StatefulSet member manages multiple tenant processes
- **Scaling:** Horizontal scaling via StatefulSet replicas
- **State:** Runners maintain in-memory state of their tenants
- **Consul Update:** `master.js` manually updates Consul based on internal process state
- **Resolver:** Demuxer routes traffic to StatefulSet members via Consul

### How It Worked

**ConfigMap Change Flow:**
1. User creates/updates ConfigMap
2. Demuxer detects change
3. Demuxer queries Consul for tenant location
4. If existing tenant: Route to current runner (sticky routing)
5. If new tenant: Elect least loaded runner
6. Stream change request to elected runner
7. Runner updates tenant process

**Load Distribution:**
```javascript
// Demuxer assigns new tenant to least loaded runner
function elect_runner(runners) {
  return _.sortBy(runners, (r) => {
    return r.activeCount / r.maxCapacity;
  })[0];
}

// Example:
// master-0: 10/50 = 0.20 ← ELECTED
// master-1: 15/50 = 0.30
// master-2:  8/50 = 0.16 ← Actually ELECTED (least dense)
```

### Use Cases

✅ Multi-instance process management  
✅ Load balancing across runners  
✅ Horizontal scaling of runners  
✅ Sticky routing for existing tenants  

❌ Per-tenant Kubernetes resources  
❌ Full resource isolation  
❌ Declarative infrastructure  

### Why It Worked

- **Scalability:** Multiple runner instances vs single Gen 1 host
- **Load Balancing:** Intelligent tenant assignment
- **State Preservation:** Runners maintain tenant state
- **Consul Integration:** Service discovery and health checking

### Why We Evolved to Gen 3b

- **Resource Isolation:** Tenants share runner pods, not isolated
- **Complexity:** Streaming changes to stateful runners
- **Operational Overhead:** Managing StatefulSet state
- **Kubernetes-Native:** Per-tenant Deployments more idiomatic

---

## Generation 3b: Deployment Controller (Per-Tenant Kubernetes Resources)

**Implementation:** `k8s-deployment-controller.js` + `k8s-dispatcher.js` (deployment-operator)  
**Configuration:** ConfigMaps trigger Deployments via dispatcher  
**OpenAPI Spec:** [docs/openapi-gen3-deployment.yaml](openapi-gen3-deployment.yaml)  
**Note:** API spec represents Gen 3b architecture

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Kubernetes Cluster                      │
│                                                             │
│  ┌────────────────┐                                         │
│  │   ConfigMaps   │ (Tenant Configuration)                  │
│  └────────┬───────┘                                         │
│           │ watch                                           │
│           v                                                 │
│  ┌──────────────────────────────┐                           │
│  │   k8s-dispatcher.js          │ (Watches ConfigMaps)      │
│  │   (Event Dispatcher)         │                           │
│  └──────────┬───────────────────┘                           │
│             │ POST /sync/additions                          │
│             │ POST /sync/updates                            │
│             │ POST /sync/deletions                          │
│             v                                               │
│  ┌──────────────────────────────┐                           │
│  │ k8s-deployment-controller.js │                           │
│  │ (Creates Deployments ONLY)   │                           │
│  └──────────┬───────────────────┘                           │
│             │ creates Deployment                            │
│             v                                               │
│  ┌─────────────────────────────────────────┐                │
│  │     Per-Tenant Deployment               │                │
│  │  - Deployment (Nightscout + MongoDB)    │                │
│  │  - PVC (MongoDB data)                   │                │
│  └──────────┬──────────────────────────────┘                │
│             │ pod becomes Running                           │
│             v                                               │
│  ┌──────────────────────────────┐                           │
│  │  k8s-dispatcher.js           │ (deployment-operator mode)│
│  │  (Watches Pods)              │                           │
│  └──────────┬───────────────────┘                           │
└─────────────┼───────────────────────────────────────────────┘
              │ register pod
              v
     ┌─────────────────────┐
     │      Consul         │
     │  Service Catalog    │
     │  - backends         │
     │    - tags: [demo]   │
     └──────────┬──────────┘
                │ query for routing
                v
     ┌──────────────────────────────┐
     │   Resolver + Consul          │
     │   (Routes traffic to         │
     │    per-tenant Deployments)   │
     └──────────────────────────────┘

Note: In Gen 3b, demuxer and StatefulSet runners from Gen 3a
are scaled down and no longer used.
```

### Key Characteristics

- **Configuration:** ConfigMaps trigger Deployment creation via dispatcher
- **Orchestration:** Per-tenant Deployments (one Deployment per tenant)
- **Resource Scope:** Deployment controller creates Deployments ONLY (experimental code for additional resources exists but not used)
- **Consul Registration:** deployment-operator watches pods and automatically updates Consul
- **Isolation:** Full Kubernetes resource isolation per tenant
- **Resolver Interface:** Continues using resolver + Consul coordination for traffic serving
- **Demuxer & Runners:** Scaled down from Gen 3a (no longer needed)
- **Consul Update Evolution:** Changed from manual updates by `master.js` to automatic updates by deployment-operator

### Two-Interface Architecture

The platform offers two distinct, independent interfaces:

#### 1. Administration Interface: Managing Tenant Configurations/Environments
Evolved significantly across generations:
- **Gen 1**: REST API (`/environs`) operates on `.env` files
- **Gen 2**: REST API (`/environs`, `/inspect`) operates on ConfigMaps; demuxer globally routes internal admin change requests across StatefulSet of runners
- **Gen 3a**: ConfigMap watch triggers demuxer to propagate ConfigMap changes to StatefulSet runners
- **Gen 3b**: Dispatcher watches ConfigMaps → deployment-controller creates per-tenant Deployments (demuxer and runners scaled down)
- **Gen 4**: Metacontroller watches ConfigMaps, calls webhook (fully declarative)

#### 2. Resolver Interface: Routing and Serving Nightscout Traffic
**Persistent pattern across ALL generations** - resolver + Consul coordination:
- **Gen 1, Gen 2, Gen 3a**: `master.js` manually updates Consul based on internal process state
- **Gen 3a**: `tenant-availability-keeper.js` (demuxer) routes to StatefulSet members via Consul
- **Gen 3b**: Resolver routes to per-tenant Deployments via Consul; deployment-operator watches pods and updates Consul automatically
- **Gen 4**: Resolver routes to Deployments via Consul

**Critical Design Choice:** The resolver interface + Consul coordination ensures workload is performed by scalable worker nodes, rather than the control plane. This architectural pattern is fundamental and persists across all generations regardless of how the administration interface evolves.

**Consul Update Evolution:** In Gen 1-3a, `master.js` manually updated Consul based on internal process state. Starting in Gen 3b, the deployment-operator watches pods and updates Consul automatically.

### Key Components

#### 1. ConfigMap Dispatcher (`k8s-dispatcher.js`)

**Role:** Watches ConfigMaps, dispatches events to deployment-controller

```javascript
// Watches ConfigMaps with labels: managed=multienv, app=tenant
watch.watch('/api/v1/namespaces/default/configmaps', params, callback);

// On ADDED event
POST http://deployment-controller:2831/sync/additions
{
  "type": "ADDED",
  "object": { /* ConfigMap */ }
}

// On MODIFIED event  
POST http://deployment-controller:2831/sync/updates

// On DELETED event
POST http://deployment-controller:2831/sync/deletions
```

**Configuration:**
```bash
WATCH_ENDPOINT=/api/v1/namespaces/hosted-tenants/configmaps
WATCH_LABELSELECTOR=app=tenant,managed=multienv
CLUSTER_GATEWAY=http://deployment-controller:2831
SYNC_CONTROLLER=deployment  # or 'runner', 'consul'
```

#### 2. Deployment Controller (`k8s-deployment-controller.js`)

**Role:** Receives sync events, creates Deployments

**Resources Created Per Tenant (Current Scope):**
1. Deployment with 2 containers:
   - `nightscout`: nightscout/cgm-remote-monitor
   - `mongodb`: mongo:4.4
2. PersistentVolumeClaim (MongoDB data)

**Note:** Experimental code exists for creating additional resources (Services, StatefulSets, etc.), but current production usage is limited to Deployments only. Future Gen 4 (Metacontroller) will handle multi-resource orchestration declaratively.

**Sync Endpoints:**
```
POST /sync/additions   # Create Deployment
POST /sync/updates     # Trigger rolling restart
POST /sync/deletions   # Delete Deployment
```

**REST API (Manual Operations):**
```
GET  /deployments              # List all deployments
GET  /deployments/:name        # Get deployment details
POST /deployments/:name        # Create/update deployment
DELETE /deployments/:name      # Delete deployment
POST /template/:name           # Generate template (no creation)
```

#### 3. Deployment Operator (`k8s-dispatcher.js` in pod-watch mode)

**Role:** Watches pods, registers with Consul

**Configuration:**
```bash
SYNC_CONTROLLER=deployment  # Enables deployment-operator mode
# Watches pods created by deployment-controller
# Registers running pods with Consul
```

**Workflow:**
1. Deployment controller creates Deployment
2. Kubernetes creates pod(s)
3. Deployment-operator detects pod Running
4. Registers pod in Consul with tenant tags
5. Demuxer can now route traffic to pod

**Why Separate from Dispatcher:**
- Dispatcher watches ConfigMaps (source of truth)
- Deployment-operator watches Pods (runtime state)
- Clean separation of concerns

#### 4. Tenant Availability Keeper (`tenant-availability-keeper.js`)

**Role (Gen 3b):** User request routing via Consul (no longer routes ConfigMap changes)

**Endpoints:**
```
GET /elected/consul/:service
    Returns best service based on health and capacity

GET /scheduled/consul/:service/:tenant/:suffix
    Routes request to appropriate cluster based on:
    - Existing tenant location (sticky routing)
    - Cluster health and capacity
    - Consul service discovery

GET /available/consul/:service
    Lists all available services with health status
```

**Routing Algorithm:**
1. Check if tenant exists in Consul (sticky routing)
2. If found, route to existing cluster
3. If new tenant, elect best cluster based on:
   - Health status
   - Capacity (active/max ratio)
   - Availability

#### 4. Consul Integration

**Service Registration:**
```
POST /consul/sync/additions   # Register pod in Consul
POST /consul/sync/updates     # Update service health
POST /consul/sync/deletions   # Deregister pod
```

**Service Structure:**
```
Service: cluster (multienv runners)
Service: backends (tenant pods)
Tags: [tenant-name, cluster-id]
```

### Workflow Example

**1. User creates ConfigMap:**
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: demo
  labels:
    managed: "multienv"
    app: "tenant"
data:
  WEB_NAME: "demo"
  MONGODB_URI: "mongodb://localhost:27017/demo"
```

**2. Dispatcher detects ADDED event:**
```bash
POST http://deployment-controller:2831/sync/additions
```

**3. Controller creates resources:**
```yaml
# PVC
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: demo-mongodb-data
spec:
  resources:
    requests:
      storage: 10Gi

---
# Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo
spec:
  template:
    spec:
      containers:
        - name: nightscout
          image: nightscout/cgm-remote-monitor:latest
          envFrom:
            - configMapRef:
                name: demo
        - name: mongodb
          image: mongo:4.4
          volumeMounts:
            - name: data
              mountPath: /data/db
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: demo-mongodb-data
```

**4. Pod starts, registered in Consul:**
```bash
POST /consul/sync/additions
```

**5. Traffic routing via demuxer:**
```bash
GET /scheduled/consul/cluster/demo/backends
# Returns elected cluster for tenant "demo"
```

### Use Cases

✅ Production Kubernetes clusters  
✅ Multi-node deployments  
✅ Service mesh integration  
✅ High availability (multiple clusters)  
✅ Dynamic load balancing  

❌ Fully declarative (still has imperative REST API)  
❌ GitOps friendly (dispatcher pattern is complex)  

### Why It Worked

- **Full Kubernetes:** Creates actual pods and resources
- **Scalable:** Multi-node, multi-cluster support
- **Service Discovery:** Consul integration for routing
- **Production Ready:** HA, load balancing, health checks

### Why We Evolved

- **Complexity:** Dispatcher + controller + demuxer = 3 moving parts
- **Imperative:** REST API calls, not declarative
- **Custom Controller:** Reinventing Kubernetes patterns
- **Operational Overhead:** Maintaining custom control plane

---

## Generation 4: Metacontroller (Declarative Webhooks)

**Implementation:** `cmd/webhook/server.js` + Metacontroller  
**Configuration:** ConfigMaps (declarative)  
**OpenAPI Spec:** [docs/openapi-gen4-metacontroller.yaml](openapi-gen4-metacontroller.yaml)

### Architecture

```
┌─────────────────────┐
│  Kubernetes API     │
│  (ConfigMap events) │
└──────────┬──────────┘
           │ watch (built-in)
           v
┌─────────────────────────┐
│    Metacontroller       │ (Kubernetes Controller)
│  (Control Loop)         │
└──────────┬──────────────┘
           │ webhook calls
           │ POST /composite/sync
           │ POST /decorator/sync
           v
┌──────────────────────────┐
│  cmd/webhook/server.js   │ (Stateless Webhook Server)
│  - composite-sync.js     │
│  - decorator-sync.js     │
└──────────┬───────────────┘
           │ returns manifests
           v
┌────────────────────────────────────┐
│   Kubernetes Resources (11-12)     │
│  1. Secret (MongoDB credentials)   │
│  2. Service (MongoDB)              │
│  3. StatefulSet (MongoDB)          │
│  4. PodDisruptionBudget (MongoDB)  │
│  5. Service (Nightscout)           │
│  6. Deployment (Nightscout)        │
│  7. PodDisruptionBudget (NS)       │
│  8. KafkaTopic (CDC)               │
│  9. KafkaConnector (CDC)           │
│ 10. Job (Migration)                │
│ 11. VolumeSnapshot (Backup)        │
└────────────────────────────────────┘
```

### Key Components

#### 1. Metacontroller (Kubernetes Add-On)

**Role:** Watches ConfigMaps, calls webhooks, applies manifests

**CompositeController:**
```yaml
apiVersion: metacontroller.k8s.io/v1alpha1
kind: CompositeController
metadata:
  name: nightscout-tenant-controller
spec:
  parentResource:
    apiVersion: v1
    resource: configmaps
    labelSelector:
      matchLabels:
        ns.mdn.io/enabled: "true"
  childResources:
    - apiVersion: apps/v1
      resource: statefulsets
    - apiVersion: apps/v1
      resource: deployments
    # ... 8 more resource types
  hooks:
    sync:
      webhook:
        url: http://webhook-server:3000/composite/sync
```

**DecoratorController:**
```yaml
apiVersion: metacontroller.k8s.io/v1alpha1
kind: DecoratorController
metadata:
  name: pvc-backup-decorator
spec:
  resources:
    - apiVersion: v1
      resource: persistentvolumeclaims
      labelSelector:
        matchLabels:
          app.kubernetes.io/component: database
  hooks:
    sync:
      webhook:
        url: http://webhook-server:3000/decorator/sync
    finalize:
      webhook:
        url: http://webhook-server:3000/decorator/finalize
```

#### 2. Webhook Server (`cmd/webhook/server.js`)

**Endpoints:**
```
POST /composite/sync       # Tenant orchestration
POST /composite/finalize   # Tenant cleanup
POST /decorator/sync       # PVC backup policy
POST /decorator/finalize   # PVC snapshot creation
GET  /health               # Health check
```

**No REST API:** Pure webhook-based, no imperative operations

#### 3. Webhook Handlers

**Composite Sync (`handlers/composite-sync.js`):**
```javascript
function compositeSync(req, res) {
  const parent = req.body.parent;  // ConfigMap
  const children = req.body.children;  // Existing resources
  
  // Generate 11-12 child resources
  const desiredChildren = [
    createMongoSecret(parent),
    createMongoService(parent),
    createMongoStatefulSet(parent),
    createMongoPDB(parent),
    createNightscoutService(parent),
    createNightscoutDeployment(parent),
    createNightscoutPDB(parent),
    createKafkaTopic(parent),
    createKafkaConnector(parent),
    createMigrationJob(parent)
  ];
  
  // Compute status conditions
  const status = computeStatus(children);
  
  res.json({
    status,
    children: desiredChildren
  });
}
```

**Decorator Sync (`handlers/decorator-sync.js`):**
```javascript
function decoratorSync(req, res) {
  const pvc = req.body.object;  // PersistentVolumeClaim
  
  // Add backup annotations
  const annotations = {
    'ns.mdn.io/backup-schedule': 'daily',
    'ns.mdn.io/backup-retention': '30d',
    'ns.mdn.io/tenant-email': extractEmail(pvc)
  };
  
  // Add finalizer to enable pre-deletion snapshot
  const finalizers = ['ns.mdn.io/backup-finalizer'];
  
  res.json({
    attachments: [{
      ...pvc,
      metadata: {
        ...pvc.metadata,
        finalizers,
        annotations: {
          ...pvc.metadata.annotations,
          ...annotations
        }
      }
    }]
  });
}
```

### Workflow Example

**1. User creates ConfigMap:**
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: demo
  labels:
    ns.mdn.io/enabled: "true"
    ns.mdn.io/tier: "premium"
data:
  TENANT_ID: "demo"
  MONGO_IMAGE: "mongo:6"
  MONGO_REPLICAS: "1"
  MIGRATION_ENABLED: "true"
```

**2. Metacontroller detects ConfigMap:**
```
Metacontroller: New ConfigMap "demo" with label ns.mdn.io/enabled=true
```

**3. Metacontroller calls /composite/sync:**
```bash
POST http://webhook-server:3000/composite/sync
{
  "parent": { /* ConfigMap */ },
  "children": {},
  "finalizing": false
}
```

**4. Webhook returns desired state:**
```json
{
  "status": {
    "conditions": [
      { "type": "MongoDBReady", "status": "False", "reason": "Creating" },
      { "type": "Ready", "status": "False", "reason": "WaitingForMongoDB" }
    ]
  },
  "children": [
    { "apiVersion": "v1", "kind": "Secret", "metadata": {"name": "demo-mongo-credentials"} },
    { "apiVersion": "apps/v1", "kind": "StatefulSet", "metadata": {"name": "demo-mongo"} },
    { "apiVersion": "apps/v1", "kind": "Deployment", "metadata": {"name": "demo-nightscout"} }
    // ... 8 more resources
  ]
}
```

**5. Metacontroller applies manifests:**
```
Creating Secret/demo-mongo-credentials
Creating Service/demo-mongo
Creating StatefulSet/demo-mongo
Creating Deployment/demo-nightscout
...
```

**6. Reconciliation loop (automatic):**
```
# Next sync call
POST /composite/sync
{
  "parent": { /* ConfigMap */ },
  "children": {
    "StatefulSet.apps/v1": {
      "demo-mongo": { "status": { "readyReplicas": 1, "replicas": 1 } }
    }
  }
}

# Response
{
  "status": {
    "conditions": [
      { "type": "MongoDBReady", "status": "True" },
      { "type": "Ready", "status": "True" }
    ]
  },
  "children": [ /* same */ ]
}
```

### Use Cases

✅ Production Kubernetes clusters  
✅ GitOps workflows (fully declarative)  
✅ Declarative infrastructure  
✅ Multi-tenant SaaS platforms  
✅ Automatic reconciliation  
✅ Standard Kubernetes patterns  

### Why It Works

- **Declarative:** No imperative API calls
- **Kubernetes-Native:** Standard controller pattern
- **Automatic Reconciliation:** Metacontroller handles watch/sync loop
- **Stateless Webhooks:** Easy to scale and maintain
- **Standard Status:** Kubernetes conditions
- **GitOps Friendly:** ConfigMaps in Git = infrastructure as code

---

## Facade Pattern Benefits

### What is the Facade Pattern?

> **Facade Pattern:** Provides a unified interface to a set of interfaces in a subsystem. Facade defines a higher-level interface that makes the subsystem easier to use.

In this project, the "facade" is the **tenant configuration interface** that evolved across generations while hiding implementation complexity.

### How We Applied It

#### Consistent Abstraction: "Tenant Configuration"

All generations expose the same core concept:
- **Gen 1:** `.env` file = tenant config
- **Gen 2:** ConfigMap = tenant config
- **Gen 3:** ConfigMap = tenant config (+ orchestration)
- **Gen 4:** ConfigMap = tenant config (fully declarative)

#### Interface Evolution (Not Breaking Changes)

**Gen 1 → Gen 2:**
- **Kept:** `/environs/:name` REST API
- **Changed:** Backend (files → ConfigMaps)
- **Result:** Drop-in replacement

**Gen 2 → Gen 3:**
- **Kept:** ConfigMap as source of truth
- **Added:** Dispatcher + Controller pattern
- **Result:** ConfigMaps trigger deployments automatically

**Gen 3 → Gen 4:**
- **Kept:** ConfigMap as source of truth
- **Removed:** Custom dispatcher, REST API
- **Added:** Metacontroller (standard K8s pattern)
- **Result:** Fully declarative, GitOps friendly

### Flexibility Gained

#### 1. Progressive Migration

Each generation could coexist:
```
Gen 1 (legacy tenants on .env files)
  ↓ migrate configs
Gen 2 (ConfigMaps, no pods yet)
  ↓ add dispatcher
Gen 3 (Full orchestration, REST API)
  ↓ add metacontroller
Gen 4 (Declarative webhooks)
```

#### 2. Feature Parity Testing

New generation tested alongside old:
```
Old: POST /environs/demo {...}
New: kubectl apply -f demo-configmap.yaml

Both create same tenant, different backends
```

#### 3. Rollback Safety

If new generation has issues:
```
Gen 4 broken? → Revert to Gen 3 controller
Gen 3 broken? → Revert to Gen 2 persistence
Gen 2 broken? → Revert to Gen 1 .env files
```

#### 4. Component Reuse

**Utility Container** used across Gen 3 and Gen 4:
```
container-images/ns-utility/
  scripts/
    init-replica-set.sh      # Gen 3: initContainer
    migration.sh             # Gen 3 & 4: Job
    mongodb-utils.sh         # Gen 3 & 4: Shared library
```

**Configuration Parameters** evolved but remained compatible:
```yaml
# Gen 1
WEB_NAME=demo
PORT=5001

# Gen 2
data:
  WEB_NAME: "demo"

# Gen 3
data:
  WEB_NAME: "demo"
  MONGO_IMAGE: "mongo:4.4"

# Gen 4
data:
  TENANT_ID: "demo"
  MONGO_IMAGE: "mongo:6"
  MONGO_REPLICAS: "1"
  MIGRATION_ENABLED: "true"
```

---

## Migration Paths

### Gen 1 → Gen 2

**Goal:** Move from .env files to ConfigMaps

**Steps:**
1. For each `.env` file in `WORKER_ENV`:
```bash
# Convert demo.env to ConfigMap
cat $WORKER_ENV/demo.env | \
kubectl create configmap demo \
  --from-env-file=- \
  --namespace=hosted-tenants
```

2. Add labels:
```bash
kubectl label configmap demo \
  managed=multienv \
  app=tenant
```

3. Test inspector API:
```bash
curl http://inspector:2828/environs/demo
# Should return similar to Gen 1
```

4. Cutover: Point clients to inspector instead of multienv

### Gen 2 → Gen 3a

**Goal:** Add multi-instance runner orchestration with load balancing

**Steps:**
1. Deploy StatefulSet of master.js runners:
```bash
kubectl apply -f k8s/multienv-statefulset.yaml
# Creates master-0, master-1, master-2, etc.
```

2. Deploy Consul for service discovery:
```bash
kubectl apply -f k8s/consul.yaml
```

3. Deploy demuxer for load balancing:
```bash
kubectl apply -f k8s/demuxer-deployment.yaml
```

4. Configure demuxer to stream changes to runners:
```bash
# Demuxer watches ConfigMaps
# Routes changes to appropriate StatefulSet member
# Assigns new tenants to least loaded runner
```

5. Test: Create ConfigMap, watch demuxer assign to runner:
```bash
kubectl create configmap test --from-literal=WEB_NAME=test
# Demuxer routes to master-2 (least loaded)
```

### Gen 3a → Gen 3b

**Goal:** Transition from StatefulSet runners to per-tenant Deployments

**Motivation:**
- Full resource isolation per tenant
- Kubernetes-native per-tenant resources
- Eliminate stateful runner complexity
- Per-tenant PVCs for data isolation

**Steps:**
1. Deploy dispatcher (ConfigMap watcher):
```bash
kubectl apply -f k8s/dispatcher-deployment.yaml
```

2. Deploy deployment-controller:
```bash
kubectl apply -f k8s/deployment-controller.yaml
# Limited to creating Deployments only
```

3. Deploy deployment-operator (pod watcher):
```bash
kubectl apply -f k8s/deployment-operator.yaml
# Watches pods, registers with Consul
```

4. Test side-by-side:
```bash
# Old: ConfigMap → demuxer → StatefulSet runner
# New: ConfigMap → dispatcher → deployment-controller → Deployment

kubectl create configmap new-tenant --from-literal=WEB_NAME=new-tenant
kubectl get deployment new-tenant -w
```

5. Migrate existing tenants:
```bash
# For each tenant in StatefulSet:
# - Create corresponding ConfigMap (if not exists)
# - Dispatcher creates Deployment
# - Wait for pod Ready
# - Migrate PVC data (if applicable)
# - Remove from StatefulSet runner
```

6. Decomission StatefulSet runners:
```bash
kubectl delete statefulset master
```

**Key Difference:**
- Gen 3a: Multiple tenants per runner pod (shared resources)
- Gen 3b: One Deployment per tenant (isolated resources)

### Gen 3b → Gen 4

**Goal:** Move to declarative metacontroller

**Steps:**
1. Install Metacontroller:
```bash
kubectl apply -f https://github.com/metacontroller/metacontroller/releases/latest/download/metacontroller.yaml
```

2. Deploy webhook server:
```bash
kubectl apply -f k8s/metactl/webhook-deployment.yaml
```

3. Create CompositeController:
```bash
kubectl apply -f k8s/metactl/tenant-composite-controller.yaml
```

4. Test: ConfigMap with new label:
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: test
  labels:
    ns.mdn.io/enabled: "true"  # NEW LABEL
data:
  TENANT_ID: "test"
```

5. Verify resources created:
```bash
kubectl get all,pvc,secret -l app.kubernetes.io/instance=test
```

6. Migrate existing tenants:
```bash
# Add new label to existing ConfigMaps
kubectl label configmap demo ns.mdn.io/enabled=true
```

7. Decomission Gen 3:
```bash
kubectl delete deployment dispatcher deployment-controller
```

---

## Lessons Learned

### ✅ What Worked

**1. Interface Stability**
- Keeping `/environs` API across Gen 1 → Gen 2 enabled smooth migration
- ConfigMap as configuration source (Gen 2 → Gen 4) provided consistency

**2. Component Extraction**
- Utility container extracted common scripts
- Made them reusable across generations
- Easier to test and version

**3. Incremental Complexity**
- Each generation added ONE major concept:
  - Gen 1: Process management
  - Gen 2: Kubernetes persistence
  - Gen 3: Full orchestration
  - Gen 4: Declarative webhooks

**4. Cloud-Native Startup**
- `start_container.sh` with entry points enabled multi-mode container
- Same image can run as: multienv, inspector, dispatcher, demuxer, webhook

### ⚠️ Challenges

**1. Dispatcher Complexity (Gen 3)**
- Custom watch loop reimplemented Kubernetes controller pattern
- Should have used Metacontroller earlier

**2. API Versioning**
- Gen 1 used `WEB_NAME`, Gen 4 uses `TENANT_ID`
- Should have versioned ConfigMap schema from Gen 2

**3. Migration Timing**
- Gen 3 had shortest lifespan (transitional architecture)
- Could have gone Gen 2 → Gen 4 directly

### 🎯 Best Practices

**1. Design for Evolution**
- Keep configuration source stable
- Abstract implementation details
- Version your APIs and schemas

**2. Embrace Standards**
- Metacontroller is standard Kubernetes pattern
- Don't reinvent controller framework
- Use standard status conditions

**3. Gradual Migration**
- Support multiple generations simultaneously
- Test new generation alongside old
- Migrate tenant-by-tenant, not all-at-once

**4. Document Everything**
- OpenAPI specs for every API
- Architecture diagrams for every generation
- Migration guides for every transition

---

## Summary

This project demonstrates how **wise component configuration** and the **facade pattern** enabled continuous evolution:

1. **Gen 1 (multienv):** Proved the concept with simple process-based multi-tenancy
2. **Gen 2 (inspector):** Kubernetes-native persistence, API compatibility
3. **Gen 3 (deployment-controller):** Full orchestration, production-ready
4. **Gen 4 (metacontroller):** Declarative, GitOps, industry-standard

Each generation improved on the previous while maintaining core abstractions. The result: a production-ready, multi-tenant Nightscout platform that evolved from 50-line bash scripts to a sophisticated Kubernetes operator, all without breaking existing tenants.

**Key Takeaway:** Great software evolves. Design for change from day one.

---

## Related Documentation

- [OpenAPI Gen 1 - multienv](openapi-gen1-multienv.yaml)
- [OpenAPI Gen 2 - Inspector](openapi-gen2-inspector.yaml)
- [OpenAPI Gen 3 - Deployment Controller](openapi-gen3-deployment.yaml)
- [OpenAPI Gen 4 - Metacontroller](openapi-gen4-metacontroller.yaml)
- [Cloud-Native Startup](CLOUD-NATIVE-STARTUP.md)
- [Component Relationships (Gen 3)](COMPONENT-RELATIONSHIPS.md)
- [Container Parameters](CONTAINER-PARAMETERS.md)
- [Utility Container Summary](../UTILITY-CONTAINER-SUMMARY.md)
