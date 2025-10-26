# Component Relationships: Generation 3 Architecture

## Overview

Generation 3 represents the **full Kubernetes orchestration** generation, featuring:
- **Dispatcher:** Watches ConfigMaps, dispatches events
- **Deployment Controller:** Creates Kubernetes resources
- **Demuxer (tenant-availability-keeper):** Consul-based load balancing
- **Consul:** Service discovery and health checking

This document explains how these components work together to provide production-ready multi-tenant Nightscout hosting.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Kubernetes Cluster                      │
│                                                             │
│  ┌────────────────┐                                         │
│  │   ConfigMaps   │ (Tenant Configuration)                  │
│  │  - demo        │                                         │
│  │  - prod        │                                         │
│  │  - test        │                                         │
│  └────────┬───────┘                                         │
│           │ watch (Kubernetes API)                          │
│           v                                                 │
│  ┌──────────────────────────────┐                           │
│  │   k8s-dispatcher.js          │ (1 replica)               │
│  │   (ConfigMap Watcher)        │                           │
│  └──────────┬───────────────────┘                           │
│             │ HTTP POST                                     │
│             │ /sync/additions                               │
│             │ /sync/updates                                 │
│             │ /sync/deletions                               │
│             v                                               │
│  ┌──────────────────────────────┐                           │
│  │ k8s-deployment-controller.js │ (3+ replicas)             │
│  │ (Resource Orchestration)     │                           │
│  └──────────┬───────────────────┘                           │
│             │ kubectl apply                                 │
│             v                                               │
│  ┌─────────────────────────────────────────┐                │
│  │     Tenant Resources Per ConfigMap      │                │
│  │  - PVC (MongoDB data)                   │                │
│  │  - Deployment (Nightscout + MongoDB)    │                │
│  │  - Service (optional)                   │                │
│  └──────────┬──────────────────────────────┘                │
│             │ pod becomes Running                           │
│             v                                               │
│  ┌──────────────────────────────┐                           │
│  │    Pod IP Assignment         │                           │
│  │  demo-abc123 → 10.244.1.5    │                           │
│  └──────────┬───────────────────┘                           │
└─────────────┼───────────────────────────────────────────────┘
              │ register
              v
     ┌─────────────────────┐
     │      Consul         │ (Outside K8s or In-Cluster)
     │  Service Catalog    │
     │  - cluster          │
     │    - tags: [demo]   │
     │  - backends         │
     │    - tags: [demo]   │
     └──────────┬──────────┘
                │ query
                v
     ┌──────────────────────────────┐
     │ tenant-availability-keeper   │ (2+ replicas)
     │     (Demuxer / LB)           │
     └──────────┬───────────────────┘
                │ routing decision
                v
     ┌──────────────────────────────┐
     │    nginx / Ingress           │
     │  (Frontend Load Balancer)    │
     └──────────────────────────────┘
                │
                v
     [User Request: demo.nightscout.net]
```

## Component Details

### 1. Dispatcher (k8s-dispatcher.js)

**Role:** Watches Kubernetes ConfigMaps, dispatches change events to controllers

#### Configuration

```yaml
env:
  - name: WATCH_ENDPOINT
    value: "/api/v1/namespaces/hosted-tenants/configmaps"
  - name: WATCH_LABELSELECTOR
    value: "app=tenant,managed=multienv"
  - name: CLUSTER_GATEWAY
    value: "http://deployment-controller:2831"
  - name: SYNC_CONTROLLER
    value: "deployment"  # or 'runner', 'consul'
  - name: PARALLEL_UPDATES
    value: "12"
```

#### Event Processing Pipeline

```javascript
// Simplified dispatcher logic
const watch = new k8s.Watch(kubeconfig);

watch.watch(WATCH_ENDPOINT, params, (type, apiObj, watchObj) => {
  console.log(apiObj.metadata.name, type, apiObj.metadata.resourceVersion);
  
  // Stream processing pipeline
  req
    .pipe(toJSONStream())          // Parse NDJSON
    .pipe(ignoreBookmark())        // Filter out BOOKMARK events
    .pipe(pre())                   // Filter ConfigMaps without data
    .pipe(slowRateStream())        // Rate limiting (prevent thundering herd)
    .pipe(syncPostToController())  // POST to controller
    .pipe(post());                 // Log completion
});

function syncPostToController(update) {
  const endpoint = {
    'ADDED': '/sync/additions',
    'MODIFIED': '/sync/updates',
    'DELETED': '/sync/deletions'
  }[update.type];
  
  await got.post(CLUSTER_GATEWAY + endpoint, { json: update });
}
```

#### Stream Processing Stages

1. **toJSONStream():** Parse Kubernetes watch NDJSON stream
2. **ignoreBookmark():** Filter out BOOKMARK events (used for watch resumption)
3. **pre():** Filter ConfigMaps without `data` field
4. **slowRateStream():** Rate limit updates (default: 100ms delay + random 0-300ms)
5. **syncPostToController():** POST event to deployment controller
6. **post():** Log completion, drop from memory

#### Rate Limiting Configuration

```bash
# Prevent thundering herd during full resync
DELAY_CROWD_INTERVAL_MS=100         # Base delay
DELAY_CROWD_EXTRA_MIN=0             # Random min
DELAY_CROWD_EXTRA_MAX=300           # Random max
DELAY_CROWD_PARALLEL=1              # Parallel processing
DELAY_CROWD_NO_RANDOM_EXTRA=0       # Disable random delay
```

**Example:** With defaults, each update takes 100-400ms, processing 12 in parallel = ~100 tenants/second

#### Bookmark Support (Watch Resumption)

```javascript
// Save last seen resourceVersion to ConfigMap
function saveBookMark(chunk) {
  if (chunk.type == 'BOOKMARK') {
    const resourceVersion = chunk.object.metadata.resourceVersion;
    
    // Update bookmark ConfigMap
    k8s.replaceNamespacedConfigMap('dispatcher-bookmark', namespace, {
      data: {
        resourceVersion: resourceVersion,
        WATCH_RESOURCEVERSION: resourceVersion
      }
    });
  }
}
```

**Benefit:** On dispatcher restart, resume from last bookmark instead of full resync

#### Event Types

```javascript
// ADDED: New ConfigMap created
{
  "type": "ADDED",
  "object": {
    "metadata": { "name": "demo", "resourceVersion": "12345" },
    "data": { "WEB_NAME": "demo", "MONGODB_URI": "..." }
  }
}

// MODIFIED: ConfigMap updated
{
  "type": "MODIFIED",
  "object": { /* ... */ }
}

// DELETED: ConfigMap deleted
{
  "type": "DELETED",
  "object": { /* ... */ }
}

// BOOKMARK: Watch checkpoint (for resumption)
{
  "type": "BOOKMARK",
  "object": { "metadata": { "resourceVersion": "12399" } }
}

// ERROR: Watch expired (resourceVersion too old)
{
  "type": "ERROR",
  "object": {
    "status": "Failure",
    "reason": "Expired",
    "message": "too old resource version: 12000 (12500)"
  }
}
```

### 2. Deployment Controller (k8s-deployment-controller.js)

**Role:** Receives sync events, creates/updates/deletes Kubernetes resources

#### Sync Endpoints

```javascript
// Handle ConfigMap addition
server.post('/sync/additions', 
  suggest_deployment_template_params,
  suggest_deployment,
  handle_sync_addition,
  format_result
);

// Handle ConfigMap update
server.post('/sync/updates', handle_sync_updates, format_result);

// Handle ConfigMap deletion
server.post('/sync/deletions', handle_sync_deletion);
```

#### Resource Creation Sequence

When `/sync/additions` is called:

```javascript
function handle_sync_addition(req, res, next) {
  const deployment = req.deployment;  // Generated from ConfigMap
  const tenantName = req.body.object.metadata.name;
  
  // 1. Create PersistentVolumeClaim
  k8s.createNamespacedPersistentVolumeClaim(namespace, {
    metadata: { name: `${tenantName}-mongodb-data` },
    spec: {
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: '10Gi' } }
    }
  });
  
  // 2. Create Deployment
  appsApi.createNamespacedDeployment(namespace, deployment);
  
  res.json({ result: deployment });
}
```

#### Deployment Template

```javascript
function template_deployment(data) {
  return {
    kind: "Deployment",
    metadata: {
      name: data.WEB_NAME,
      labels: {
        managed: 'multienv',
        app: 'tenant',
        internal_name: data.WEB_NAME
      }
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { internal_name: data.WEB_NAME } },
      template: {
        metadata: {
          labels: {
            internal_name: data.WEB_NAME,
            tenant: data.WEB_NAME,
            app: 'tenant'
          }
        },
        spec: {
          hostname: `${data.WEB_NAME}`,
          subdomain: "backends",  // DNS: <tenant>.backends.svc.cluster.local
          volumes: [{
            name: "mongodb-data",
            persistentVolumeClaim: { claimName: `${data.WEB_NAME}-mongodb-data` }
          }],
          containers: [
            {
              name: 'nightscout',
              image: 'nightscout/cgm-remote-monitor:latest',
              envFrom: [
                { configMapRef: { name: data.WEB_NAME } },
                { secretRef: { name: `${data.WEB_NAME}-secrets`, optional: true } }
              ],
              env: [{
                name: 'MONGODB_URI',
                value: `mongodb://localhost:27017/${data.WEB_NAME}`
              }]
            },
            {
              name: 'mongodb',
              image: 'mongo:4.4',
              volumeMounts: [{
                name: "mongodb-data",
                mountPath: "/data/db"
              }]
            }
          ]
        }
      }
    }
  };
}
```

#### Update Handling (Rolling Restart)

```javascript
function handle_sync_updates(req, res, next) {
  const tenantName = req.body.object.metadata.name;
  
  // Trigger rolling restart by updating annotation
  const patch = [{
    op: "add",
    path: "/spec/template/metadata/annotations/updated-at",
    value: new Date().toISOString()
  }];
  
  appsApi.patchNamespacedDeployment(
    tenantName,
    namespace,
    patch,
    undefined, undefined, undefined, undefined, undefined,
    { headers: { "Content-Type": "application/json-patch+json" } }
  );
}
```

**Why this works:** Changing pod template annotation triggers Kubernetes rolling update

#### Deletion Handling

```javascript
function handle_sync_deletion(req, res, next) {
  const tenantName = req.body.object.metadata.name;
  
  appsApi.deleteNamespacedDeployment(tenantName, namespace)
    .then(() => res.status(204).end());
  
  // Note: PVC is NOT deleted (data preservation)
}
```

### 3. Consul Integration

**Role:** Service discovery and health checking

#### Service Registration

```javascript
// POST /consul/sync/additions
function sync_consul_update(req, res, next) {
  const pod = req.body.object;
  
  if (pod.status.phase != 'Running') {
    return next();  // Wait for pod to be Running
  }
  
  const tenantName = pod.metadata.labels.tenant;
  const podIP = pod.status.podIP;
  const podPort = 80;  // Nightscout port
  
  // Register in Consul
  consul.agent.service.register({
    id: `${tenantName}-${pod.metadata.name}`,
    name: 'backends',
    tags: [tenantName, 'tenant'],
    address: podIP,
    port: podPort,
    check: {
      http: `http://${podIP}:${podPort}/api/v1/status.json`,
      interval: '30s',
      timeout: '5s'
    }
  });
  
  res.json({ ok: true });
}
```

#### Service Catalog Structure

```
Consul Services:
  - cluster (multienv runners)
    - Service: cluster
    - Node: runner-1, IP: 10.10.1.5, Port: 3434
    - Node: runner-2, IP: 10.10.1.6, Port: 3434
    - Tags: [cluster, multienv]
    
  - backends (tenant pods)
    - Service: backends
    - Node: demo-abc123, IP: 10.244.1.5, Port: 80
    - Tags: [demo, tenant]
    - Node: prod-def456, IP: 10.244.1.6, Port: 80
    - Tags: [prod, tenant]
```

#### Health Checks

```javascript
// Consul checks pod health every 30s
{
  "check": {
    "http": "http://10.244.1.5:80/api/v1/status.json",
    "interval": "30s",
    "timeout": "5s"
  }
}

// Nightscout status endpoint returns:
{
  "status": "ok",
  "name": "Nightscout",
  "version": "14.2.6",
  "apiEnabled": true,
  "careportalEnabled": true
}
```

### 4. Demuxer (tenant-availability-keeper.js)

**Role:** Consul-based load balancing and tenant routing

#### Routing Decision Logic

```javascript
// GET /scheduled/consul/:service/:tenant/:suffix
function scheduled_routing(req, res, next) {
  const tenantName = req.params.tenant;  // e.g., "demo"
  const service = req.params.service;     // e.g., "cluster"
  const suffix = req.params.suffix;       // e.g., "backends"
  
  // 1. Check if tenant exists in Consul (sticky routing)
  consul.catalog.service.nodes({
    service: suffix,
    tag: [tenantName, 'tenant']
  }, (err, tenants) => {
    if (tenants.length >= 1) {
      // Tenant found! Use existing cluster (sticky routing)
      const existingCluster = elect_cluster_for_tenant(tenants);
      res.header('X-ELECTED-RUNNER', existingCluster.url);
      return res.json({ elected: existingCluster });
    }
    
    // 2. New tenant - elect best cluster
    fetch_services(service, (err, clusters) => {
      require_health(clusters, (err, services) => {
        const ordered = apply_policies(services);
        const elected = ordered[0];  // Best cluster
        
        res.header('X-ELECTED-RUNNER', elected.url);
        res.json({ elected });
      });
    });
  });
}
```

#### Policy: Capacity-Based Selection

```javascript
function apply_policies(services) {
  // Sort by capacity quotient (lower is better)
  return _.sortBy(services, (service) => {
    return service.HealthStatus.total.expected / service.HealthStatus.total.max;
  });
}

// Example:
// Cluster A: 10 tenants / 50 max = 0.20 (20% utilized)
// Cluster B: 30 tenants / 50 max = 0.60 (60% utilized)
// Cluster C: 45 tenants / 50 max = 0.90 (90% utilized)
//
// Elected: Cluster A (lowest capacity quotient)
```

#### Health Status Fetching

```javascript
function get_health(runner, done) {
  const uri = `http://${runner.ServiceAddress}:${runner.ServicePort}/stats/active`;
  
  got(uri).json().then((body) => {
    // body = { total: { active: 12, expected: 12, max: 50 } }
    runner.HealthStatus = body;
    done();
  }).catch(() => {
    // Skip unhealthy runners
    done();
  });
}

// Filter out unhealthy runners
services = services.filter((s) => s && s.HealthStatus);
```

#### Sticky Routing Example

**Scenario:** Tenant "demo" already exists in Cluster B

```
Request: GET /scheduled/consul/cluster/demo/backends

Step 1: Check Consul for tenant "demo"
  consul.catalog.service.nodes({
    service: 'backends',
    tag: ['demo', 'tenant']
  })
  → Found: demo-abc123 @ 10.10.1.6:3434 (Cluster B)

Step 2: Return existing cluster
  X-ELECTED-RUNNER: http://10.10.1.6:3434/environs/demo
```

**Benefit:** Tenant always routes to same cluster, avoiding split-brain

#### New Tenant Example

**Scenario:** Tenant "newuser" doesn't exist yet

```
Request: GET /scheduled/consul/cluster/newuser/backends

Step 1: Check Consul for tenant "newuser"
  → Not found (new tenant)

Step 2: Fetch all clusters and health
  Cluster A: 10/50 = 0.20
  Cluster B: 30/50 = 0.60
  Cluster C: 45/50 = 0.90

Step 3: Elect best cluster (lowest capacity)
  Elected: Cluster A

Step 4: Return elected cluster
  X-ELECTED-RUNNER: http://10.10.1.5:3434/environs/newuser
```

## Complete Workflow Examples

### Example 1: New Tenant Creation

**User Action:** Create ConfigMap

```bash
kubectl create configmap alice \
  --from-literal=WEB_NAME=alice \
  --from-literal=MONGODB_URI=mongodb://localhost:27017/alice
  
kubectl label configmap alice managed=multienv app=tenant
```

**System Response:**

```
1. Dispatcher detects ADDED event
   └─ ConfigMap: alice, resourceVersion: 12345
   
2. Dispatcher POSTs to controller
   POST http://deployment-controller:2831/sync/additions
   {
     "type": "ADDED",
     "object": {
       "metadata": { "name": "alice" },
       "data": { "WEB_NAME": "alice", "MONGODB_URI": "..." }
     }
   }
   
3. Controller creates resources
   ├─ PVC: alice-mongodb-data (10Gi)
   ├─ Deployment: alice
   │   ├─ Pod: alice-abc123
   │   │   ├─ Container: nightscout (port 80)
   │   │   └─ Container: mongodb (port 27017)
   │   └─ Volume: alice-mongodb-data → /data/db
   └─ Service: alice (optional)
   
4. Pod becomes Running
   └─ Pod IP: 10.244.1.10
   
5. Consul registration (if enabled)
   POST /consul/sync/additions
   consul.agent.service.register({
     id: 'alice-abc123',
     name: 'backends',
     tags: ['alice', 'tenant'],
     address: '10.244.1.10',
     port: 80
   })
   
6. User request routing
   GET /scheduled/consul/cluster/alice/backends
   └─ Demuxer checks Consul
      └─ Found: alice @ 10.244.1.10:80
      └─ Return: http://10.244.1.10/
```

### Example 2: Tenant Update (Rolling Restart)

**User Action:** Update ConfigMap

```bash
kubectl patch configmap alice \
  --type merge \
  -p '{"data":{"ENABLE":"careportal basal"}}'
```

**System Response:**

```
1. Dispatcher detects MODIFIED event
   └─ ConfigMap: alice, resourceVersion: 12350
   
2. Dispatcher POSTs to controller
   POST http://deployment-controller:2831/sync/updates
   
3. Controller patches Deployment
   appsApi.patchNamespacedDeployment('alice', namespace, [{
     op: "add",
     path: "/spec/template/metadata/annotations/updated-at",
     value: "2025-10-26T12:34:56Z"
   }])
   
4. Kubernetes rolling update
   ├─ Creates new pod: alice-def789
   │   └─ Reads updated ConfigMap
   ├─ Waits for new pod to be Ready
   └─ Terminates old pod: alice-abc123
   
5. Consul health check updates
   └─ alice-def789 becomes healthy
   └─ alice-abc123 deregistered
```

### Example 3: Tenant Deletion

**User Action:** Delete ConfigMap

```bash
kubectl delete configmap alice
```

**System Response:**

```
1. Dispatcher detects DELETED event
   └─ ConfigMap: alice, resourceVersion: 12355
   
2. Dispatcher POSTs to controller
   POST http://deployment-controller:2831/sync/deletions
   
3. Controller deletes Deployment
   appsApi.deleteNamespacedDeployment('alice', namespace)
   
4. Kubernetes cascading deletion
   ├─ Deletes ReplicaSet: alice-abc123
   └─ Deletes Pod: alice-abc123-xyz
   
5. PVC preserved (data safety)
   └─ alice-mongodb-data remains
   └─ Can be restored later or manually deleted
   
6. Consul deregistration
   └─ alice removed from service catalog
```

### Example 4: Multi-Cluster Load Balancing

**Scenario:** 3 Kubernetes clusters, shared Consul

```
Cluster A (GKE us-central1):
  - 10 tenants (20% capacity)
  - Health: OK
  
Cluster B (GKE us-east1):
  - 30 tenants (60% capacity)
  - Health: OK
  
Cluster C (EKS us-west-2):
  - 45 tenants (90% capacity)
  - Health: WARNING
```

**New Tenant "bob" Arrives:**

```
1. User creates account → tenant "bob"
   
2. Ingress → Demuxer
   GET /scheduled/consul/cluster/bob/backends
   
3. Demuxer queries Consul
   consul.catalog.service.nodes({ service: 'backends', tag: 'bob' })
   → Not found (new tenant)
   
4. Demuxer fetches all clusters
   consul.catalog.service.nodes({ service: 'cluster' })
   → [Cluster A, Cluster B, Cluster C]
   
5. Demuxer fetches health
   GET http://cluster-a:3434/stats/active
   → { total: { active: 10, max: 50 } }
   
   GET http://cluster-b:3434/stats/active
   → { total: { active: 30, max: 50 } }
   
   GET http://cluster-c:3434/stats/active
   → { total: { active: 45, max: 50 } }
   
6. Demuxer applies policy (capacity-based)
   Cluster A: 10/50 = 0.20 ← ELECTED
   Cluster B: 30/50 = 0.60
   Cluster C: 45/50 = 0.90
   
7. Demuxer returns elected cluster
   X-ELECTED-RUNNER: http://cluster-a:3434/environs/bob
   
8. Ingress creates tenant in Cluster A
   POST http://cluster-a:3434/environs/bob
   
9. Dispatcher in Cluster A creates deployment
   kubectl create configmap bob --namespace=hosted-tenants
   
10. Future requests for "bob" stick to Cluster A
```

## Component Interactions: Sequence Diagram

```
┌────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐
│ User   │  │Dispatcher│  │Controller│  │Kubernetes│  │ Consul │
└───┬────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬───┘
    │            │             │             │             │
    │ create     │             │             │             │
    │ configmap  │             │             │             │
    ├───────────>│             │             │             │
    │            │             │             │             │
    │            │ watch       │             │             │
    │            │ event       │             │             │
    │            │<────────────┼─────────────┤             │
    │            │             │             │             │
    │            │ POST        │             │             │
    │            │ /sync/      │             │             │
    │            │ additions   │             │             │
    │            ├────────────>│             │             │
    │            │             │             │             │
    │            │             │ create PVC  │             │
    │            │             ├────────────>│             │
    │            │             │             │             │
    │            │             │ create      │             │
    │            │             │ deployment  │             │
    │            │             ├────────────>│             │
    │            │             │             │             │
    │            │             │             │ pod         │
    │            │             │             │ running     │
    │            │             │<────────────┤             │
    │            │             │             │             │
    │            │             │ register    │             │
    │            │             │ service     │             │
    │            │             ├─────────────────────────>│
    │            │             │             │             │
    │<───────────┴─────────────┴─────────────┴─────────────┤
    │                     tenant ready                     │
```

## Best Practices

### 1. Dispatcher Deployment

```yaml
replicas: 1  # Only ONE dispatcher per cluster
strategy:
  type: Recreate  # Don't run multiple simultaneously
```

**Why:** Multiple dispatchers would send duplicate events to controller

### 2. Controller Scaling

```yaml
replicas: 3  # Scale horizontally
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 1
    maxUnavailable: 0
```

**Why:** Controller is stateless, can handle concurrent requests

### 3. Rate Limiting

```bash
PARALLEL_UPDATES=12          # Don't overwhelm Kubernetes API
DELAY_CROWD_INTERVAL_MS=100  # Prevent thundering herd
```

### 4. Resource Requests/Limits

```yaml
# Dispatcher: Low resources
resources:
  requests:
    memory: "128Mi"
    cpu: "100m"
  limits:
    memory: "256Mi"
    cpu: "200m"

# Controller: Medium resources
resources:
  requests:
    memory: "256Mi"
    cpu: "200m"
  limits:
    memory: "512Mi"
    cpu: "500m"

# Demuxer: Medium-High resources
resources:
  requests:
    memory: "512Mi"
    cpu: "500m"
  limits:
    memory: "1Gi"
    cpu: "1000m"
```

### 5. Monitoring

```yaml
# Dispatcher metrics
- dispatcher_events_total{type="ADDED"}
- dispatcher_events_total{type="MODIFIED"}
- dispatcher_events_total{type="DELETED"}
- dispatcher_watch_restarts_total

# Controller metrics
- controller_sync_duration_seconds{endpoint="/sync/additions"}
- controller_k8s_api_calls_total{operation="createDeployment"}
- controller_errors_total

# Demuxer metrics
- demuxer_routing_decisions_total
- demuxer_consul_queries_total
- demuxer_elected_clusters{cluster="cluster-a"}
```

## Troubleshooting

### Problem: Dispatcher not sending events

**Check:**
```bash
# Verify dispatcher is watching correct namespace
kubectl logs deployment/dispatcher | grep WATCH_ENDPOINT

# Check label selector
kubectl get configmaps -l app=tenant,managed=multienv

# Verify controller is reachable
kubectl exec -it deployment/dispatcher -- curl http://deployment-controller:2831/health
```

### Problem: Controller not creating deployments

**Check:**
```bash
# Check controller logs
kubectl logs deployment/deployment-controller | grep ERROR

# Verify RBAC permissions
kubectl auth can-i create deployments --as=system:serviceaccount:hosted-tenants:controller

# Check API server connectivity
kubectl exec -it deployment/deployment-controller -- curl https://kubernetes.default.svc/api/v1/namespaces
```

### Problem: Demuxer routing to wrong cluster

**Check:**
```bash
# Verify Consul connectivity
kubectl exec -it deployment/demuxer -- curl http://consul:8500/v1/catalog/services

# Check service registration
curl http://consul:8500/v1/catalog/service/backends

# Verify health checks
curl http://consul:8500/v1/health/service/backends
```

## Summary

Generation 3 architecture demonstrates a **custom Kubernetes controller** pattern with:

✅ **Dispatcher:** Event-driven ConfigMap watching  
✅ **Controller:** Resource orchestration  
✅ **Demuxer:** Intelligent load balancing  
✅ **Consul:** Service discovery and health  

This architecture powers production multi-tenant hosting with:
- Automatic tenant provisioning
- Rolling updates on config changes
- Multi-cluster load balancing
- Health-based routing

**Next Evolution:** Generation 4 replaces custom dispatcher + controller with Metacontroller, achieving full declarative orchestration.

## Related Documentation

- [Architecture Evolution](ARCHITECTURE-EVOLUTION.md)
- [Cloud-Native Startup](CLOUD-NATIVE-STARTUP.md)
- [OpenAPI Gen 3 Specification](openapi-gen3-deployment.yaml)
- [Container Parameters](CONTAINER-PARAMETERS.md)
