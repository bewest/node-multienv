# Cloud-Native Startup: Multi-Mode Container Architecture

## Overview

The Nightscout multi-tenant platform uses a **single container image** that can run in multiple modes via the `start_container.sh` entrypoint script. This design enables:

- **One image, many modes:** Same container runs as multienv, inspector, dispatcher, demuxer, or webhook server
- **Flexible deployment:** Choose orchestration generation at deployment time, not build time
- **Easy testing:** Test multiple generations side-by-side
- **Gradual migration:** Run old and new architectures simultaneously

## Architecture Philosophy

```
┌─────────────────────────────────────────┐
│     Single Container Image              │
│  (nightscout/multienv:latest)          │
└──────────────┬──────────────────────────┘
               │ start_container.sh [MODE]
               │
      ┌────────┼────────┬──────────────┐
      │        │        │              │
      v        v        v              v
  ┌───────┐ ┌──────┐ ┌──────────┐  ┌─────────┐
  │ Gen 1 │ │ Gen 2│ │  Gen 3   │  │  Gen 4  │
  │runner │ │insp. │ │disp.+ctl │  │ webhook │
  └───────┘ └──────┘ └──────────┘  └─────────┘
```

**Key Insight:** By parameterizing the entrypoint, we avoid image sprawl and enable A/B testing of generations.

## Entrypoint Script: `start_container.sh`

### Usage

```bash
start_container.sh [MODE]
```

### Available Modes

| Mode | File | Description | Generation | Port | Clustering |
|------|------|-------------|------------|------|------------|
| `multienv` | `master.js` + nginx | Full setup with master/worker processes | Gen 1 | 4545 | PM2 (4 processes) |
| `runner` | `master.js` | Process manager only (no nginx) | Gen 1 | 3434 | PM2 (no restart) |
| `resolver` | `redirector-server.js` | Resolver/proxy server | Gen 1 | 3636 | PM2 (max cores) |
| `inspector` | `k8s-inspector.js` | ConfigMap REST API | Gen 2 | 2828 | PM2 (max cores) |
| `dispatcher` | `k8s-dispatcher.js` | ConfigMap watcher | Gen 3 | 2929 | Single process |
| `deployment-controller` | `k8s-deployment-controller.js` | Deployment orchestration | Gen 3 | 2831 | PM2 (max cores) |
| `deployment-operator` | `k8s-dispatcher.js` | Dispatcher for deployment controller | Gen 3 | 2929 | Single process |
| `demuxer` | `tenant-availability-keeper.js` | Consul-based load balancer | Gen 3 | 2829 | PM2 (max cores) |
| `bash` | - | Interactive shell | Debug | - | - |

### Helper Commands

| Command | Description |
|---------|-------------|
| `help` | Show usage information |
| `env` | Print environment variables |
| `setup_workdir` | Install npm dependencies in WORKER_DIR |
| `nginx-for [mode] [output]` | Generate nginx config for specific mode |

## Mode Details

### Generation 1: Classic Process-Based Multi-Tenancy

#### Mode: `multienv`

**Full Stack:** nginx + master.js + redirector-server.js

```bash
docker run nightscout/multienv:latest multienv
```

**What it does:**
1. Sets up nginx with ERB templating
2. Starts redirector-server.js (4 processes via PM2)
3. Starts master.js (process manager)
4. Registers with Consul (if available)

**Environment:**
```bash
INTERNAL_PORT=3434      # Master.js port
REDIRECTOR_PORT=3636    # Redirector port
PORT=4545               # nginx port
WORKER_DIR=/app/worker  # Where Nightscout instances run
MAX_TENANT_LIMIT=50     # Auto-calculated from memory
```

**Consul Registration:**
```bash
CLUSTER_CONSUL_ID="cluster:$HOSTNAME"
BACKENDS_CONSUL_ID="backend:$HOSTNAME"
```

**Process Tree:**
```
nginx (port 4545)
  ├─ master.js (port 3434)
  │   └─ worker.js (port 5001, 5002, 5003...)
  └─ redirector-server.js (port 3636, 4 processes)
```

#### Mode: `runner`

**Minimal:** Just master.js (no nginx, no redirector)

```bash
docker run nightscout/multienv:latest runner
```

**Use case:** Run process manager in Kubernetes without nginx reverse proxy

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: multienv-runner
spec:
  template:
    spec:
      containers:
        - name: runner
          image: nightscout/multienv:latest
          args: ["runner"]
          ports:
            - containerPort: 3434
```

#### Mode: `resolver`

**Resolver Only:** Just redirector-server.js

```bash
docker run nightscout/multienv:latest resolver
```

**Use case:** Separate resolver tier for nginx x-accel-redirect

```yaml
apiVersion: v1
kind: Service
metadata:
  name: resolvers
spec:
  selector:
    app: resolver
  ports:
    - port: 3000
      targetPort: 3636
```

### Generation 2: ConfigMap-Based Persistence

#### Mode: `inspector`

**ConfigMap REST API**

```bash
docker run nightscout/multienv:latest inspector
```

**What it does:**
1. Connects to Kubernetes API
2. Starts k8s-inspector.js REST server
3. Exposes `/environs` and `/inspect` endpoints

**Environment:**
```bash
PORT=2828                           # Inspector API port
MULTIENV_K8S_NAMESPACE=default      # Namespace to watch
MULTIENV_K8S_AUTH=local             # or 'cluster'
```

**Kubernetes Deployment:**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: inspector
spec:
  template:
    spec:
      containers:
        - name: inspector
          image: nightscout/multienv:latest
          args: ["inspector"]
          ports:
            - containerPort: 2828
          env:
            - name: MULTIENV_K8S_NAMESPACE
              value: "hosted-tenants"
```

**API Endpoints:**
```
GET  /inspect/:name       # Raw ConfigMap
POST /inspect/:name       # Create/update ConfigMap
GET  /environs/:name      # multienv-compatible
```

### Generation 3: Full Kubernetes Orchestration

#### Mode: `deployment-controller`

**Deployment Orchestration**

```bash
docker run nightscout/multienv:latest deployment-controller
```

**What it does:**
1. Connects to Kubernetes API
2. Starts k8s-deployment-controller.js REST server
3. Exposes `/sync/*` and `/deployments/*` endpoints
4. Creates Deployments, StatefulSets, PVCs, Services

**Environment:**
```bash
PORT=2831
MULTIENV_K8S_NAMESPACE=hosted-tenants
MULTIENV_TENANT_REQUESTS_ENABLE=true
MULTIENV_TENANT_LIMITS_ENABLE=true
MULTIENV_TENANT_NODEPOOL_TARGET=tenant-pool  # Optional
```

**API Endpoints:**
```
POST /sync/additions      # Handle ConfigMap ADDED events
POST /sync/updates        # Handle ConfigMap MODIFIED events
POST /sync/deletions      # Handle ConfigMap DELETED events
GET  /deployments         # List deployments
POST /deployments/:name   # Create deployment
```

#### Mode: `dispatcher`

**ConfigMap Watcher**

```bash
docker run nightscout/multienv:latest dispatcher
```

**What it does:**
1. Watches ConfigMaps in namespace
2. Filters by labelSelector
3. Dispatches ADDED/MODIFIED/DELETED events to controller

**Environment:**
```bash
PORT=2929
MULTIENV_K8S_NAMESPACE=hosted-tenants
WATCH_ENDPOINT=/api/v1/namespaces/hosted-tenants/configmaps
WATCH_LABELSELECTOR=app=tenant,managed=multienv
CLUSTER_GATEWAY=http://deployment-controller:2831
SYNC_CONTROLLER=deployment  # or 'runner', 'consul'
PARALLEL_UPDATES=12
INIT_WITH_FULL_AUDIT=0  # 1 = full resync on start
```

**Workflow:**
```
ConfigMap created
  ↓
Dispatcher detects ADDED event
  ↓
POST http://deployment-controller:2831/sync/additions
  ↓
Controller creates Deployment
```

#### Mode: `deployment-operator`

**Dispatcher for Deployment Controller** (sets SYNC_CONTROLLER=deployment)

```bash
docker run nightscout/multienv:latest deployment-operator
```

Equivalent to:
```bash
SYNC_CONTROLLER="deployment" node k8s-dispatcher.js
```

#### Mode: `demuxer`

**Consul-Based Load Balancer**

```bash
docker run nightscout/multienv:latest demuxer
```

**What it does:**
1. Connects to Consul
2. Queries service catalog
3. Provides load balancing and routing decisions

**Environment:**
```bash
PORT=2829
CONSUL_HOST=consul.service.consul
CONSUL_PORT=8500
SEARCH_TENANT_CLUSTER_TAG=1  # Use cluster tag in searches
```

**API Endpoints:**
```
GET /elected/consul/:service
    # Returns best service based on health

GET /scheduled/consul/:service/:tenant/:suffix
    # Routes tenant to appropriate cluster

GET /available/consul/:service
    # Lists all services with health status
```

**Use Case: Multi-Cluster Routing**

```
User Request: demo.nightscout.net
  ↓
nginx → GET /scheduled/consul/cluster/demo/backends
  ↓
Demuxer: Checks Consul for existing "demo" tenant
  ↓
  ├─ Found in Cluster A → Return Cluster A URL
  └─ Not found → Elect best cluster based on capacity
  ↓
nginx → Proxies to elected cluster
```

### Generation 4: Metacontroller Webhooks

**Note:** Generation 4 uses a separate webhook server (`cmd/webhook/server.js`), not `start_container.sh`.

**Deployment:**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: webhook-server
spec:
  template:
    spec:
      containers:
        - name: webhook
          image: nightscout/multienv:latest
          workingDir: /app/cmd/webhook
          command: ["node", "server.js"]
          ports:
            - containerPort: 3000
```

**Why separate?**
- Webhook server is stateless
- No legacy compatibility needed
- Simpler Dockerfile, clearer separation
- Node.js + Express, not PM2

## Nginx Configuration Generation

### Command: `nginx-for`

Generates nginx configuration for specific modes.

```bash
start_container.sh nginx-for [mode] [output]
```

### Modes

#### `std-multienv`

**Classic hybrid runner+resolver**

```bash
start_container.sh nginx-for std-multienv /etc/nginx/nginx.conf
```

**Generated Config:**
```nginx
http {
  upstream multienv {
    server localhost:3434;  # master.js
  }
  
  upstream resolver {
    server localhost:3636;  # redirector-server.js
  }
  
  server {
    listen 4545;
    
    location / {
      proxy_pass http://multienv;
    }
    
    location @proxy {
      # x-accel-redirect internal routing
      internal;
      proxy_pass http://resolver;
    }
  }
}
```

#### `inspector`

**ConfigMap REST API**

```bash
start_container.sh nginx-for inspector /etc/nginx/nginx.conf
```

```nginx
http {
  upstream inspector {
    server localhost:2828;
  }
  
  server {
    listen 80;
    location / {
      proxy_pass http://inspector;
    }
  }
}
```

#### `demuxer`

**Cluster-wide load balancer**

```bash
export DEMUXER_SERVICE_URI=http://demuxers:3000
export CLUSTER_SERVICE_NAME=cluster
start_container.sh nginx-for demuxer /etc/nginx/nginx.conf
```

```nginx
http {
  upstream demuxer {
    server demuxers:3000;
  }
  
  server {
    listen $PORT;
    
    location / {
      # Subrequest to demuxer for routing decision
      auth_request /auth-proxy;
      auth_request_set $elected_backend $upstream_http_x_elected_runner;
      
      proxy_pass $elected_backend;
    }
    
    location = /auth-proxy {
      internal;
      proxy_pass http://demuxer/scheduled/consul/cluster/$host/backends;
      proxy_pass_request_body off;
      proxy_set_header Content-Length "";
    }
  }
}
```

#### `resolver`

**Resolver interface**

```bash
export RESOLVER_SERVICE_URI=http://resolvers:3000
start_container.sh nginx-for resolver /etc/nginx/nginx.conf
```

## Deployment Examples

### Gen 1: Legacy Single-Host

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: multienv-legacy
spec:
  containers:
    - name: multienv
      image: nightscout/multienv:latest
      args: ["multienv"]
      ports:
        - containerPort: 4545
      volumeMounts:
        - name: envfiles
          mountPath: /app/environs
  volumes:
    - name: envfiles
      hostPath:
        path: /opt/nightscout/environs
```

### Gen 2: ConfigMap Inspector

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: inspector
  namespace: hosted-tenants
spec:
  replicas: 3
  selector:
    matchLabels:
      app: inspector
  template:
    metadata:
      labels:
        app: inspector
    spec:
      serviceAccountName: inspector
      containers:
        - name: inspector
          image: nightscout/multienv:latest
          args: ["inspector"]
          ports:
            - containerPort: 2828
          env:
            - name: PORT
              value: "2828"
            - name: MULTIENV_K8S_NAMESPACE
              value: "hosted-tenants"
---
apiVersion: v1
kind: Service
metadata:
  name: inspector
spec:
  selector:
    app: inspector
  ports:
    - port: 80
      targetPort: 2828
```

### Gen 3: Dispatcher + Controller

```yaml
---
# Dispatcher
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dispatcher
spec:
  replicas: 1  # Single watcher
  template:
    spec:
      containers:
        - name: dispatcher
          image: nightscout/multienv:latest
          args: ["dispatcher"]
          env:
            - name: CLUSTER_GATEWAY
              value: "http://deployment-controller:2831"
            - name: WATCH_LABELSELECTOR
              value: "app=tenant,managed=multienv"

---
# Deployment Controller
apiVersion: apps/v1
kind: Deployment
metadata:
  name: deployment-controller
spec:
  replicas: 3  # Can scale
  template:
    spec:
      containers:
        - name: controller
          image: nightscout/multienv:latest
          args: ["deployment-controller"]
          ports:
            - containerPort: 2831

---
# Demuxer
apiVersion: apps/v1
kind: Deployment
metadata:
  name: demuxer
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: demuxer
          image: nightscout/multienv:latest
          args: ["demuxer"]
          env:
            - name: CONSUL_HOST
              value: "consul.default.svc.cluster.local"
```

## Environment Variable Reference

### Common Variables

```bash
PORT=3000                   # Server listen port
WORKER_DIR=/app/worker      # Nightscout worker directory
MAX_TENANT_LIMIT=50         # Max tenants (auto-calculated from memory)
```

### Kubernetes Variables

```bash
MULTIENV_K8S_NAMESPACE=hosted-tenants    # Namespace to operate in
MULTIENV_K8S_AUTH=cluster                # 'cluster' or 'local'
```

### Dispatcher Variables

```bash
WATCH_ENDPOINT=/api/v1/namespaces/hosted-tenants/configmaps
WATCH_FIELDSELECTOR=                     # Field selector
WATCH_LABELSELECTOR=app=tenant           # Label selector
WATCH_RESOURCEVERSION=                   # Start from specific version
CLUSTER_GATEWAY=http://controller:2831   # Controller URL
SYNC_CONTROLLER=deployment               # 'deployment', 'runner', 'consul'
PARALLEL_UPDATES=12                      # Concurrent updates
INIT_WITH_FULL_AUDIT=0                   # 1 = full resync on start
```

### Demuxer Variables

```bash
CONSUL_HOST=consul.service.consul
CONSUL_PORT=8500
SEARCH_TENANT_CLUSTER_TAG=1              # Use cluster tag in searches
```

### Resource Limits (Gen 3)

```bash
MULTIENV_TENANT_REQUESTS_ENABLE=true
MULTIENV_TENANT_LIMITS_ENABLE=true
MULTIENV_TENANT_NODEPOOL_TARGET=tenant-pool
```

## Testing Multiple Modes

### Local Development

```bash
# Terminal 1: Inspector
docker run -p 2828:2828 nightscout/multienv:latest inspector

# Terminal 2: Dispatcher
docker run \
  -e CLUSTER_GATEWAY=http://host.docker.internal:2831 \
  nightscout/multienv:latest dispatcher

# Terminal 3: Deployment Controller
docker run -p 2831:2831 nightscout/multienv:latest deployment-controller
```

### Kubernetes Testing

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: test-modes
spec:
  containers:
    - name: inspector
      image: nightscout/multienv:latest
      args: ["inspector"]
      
    - name: dispatcher
      image: nightscout/multienv:latest
      args: ["dispatcher"]
      
    - name: controller
      image: nightscout/multienv:latest
      args: ["deployment-controller"]
```

## Best Practices

### 1. Use Appropriate Mode for Generation

- **Gen 1:** Use `multienv` or `runner`
- **Gen 2:** Use `inspector`
- **Gen 3:** Use `dispatcher` + `deployment-controller` + `demuxer`
- **Gen 4:** Use separate webhook server

### 2. Resource Allocation

```yaml
# Dispatcher: Low resources (single process)
resources:
  requests:
    memory: "128Mi"
    cpu: "100m"

# Controller: Scale horizontally
resources:
  requests:
    memory: "256Mi"
    cpu: "200m"

# Demuxer: Scale for high traffic
resources:
  requests:
    memory: "512Mi"
    cpu: "500m"
```

### 3. High Availability

- **Dispatcher:** Single replica (watch once)
- **Controller:** Multiple replicas (stateless)
- **Demuxer:** Multiple replicas (stateless)
- **Inspector:** Multiple replicas (stateless)

### 4. Health Checks

```yaml
livenessProbe:
  httpGet:
    path: /health  # or /stats/active for Gen 1
    port: 2828
  initialDelaySeconds: 10
  periodSeconds: 30

readinessProbe:
  httpGet:
    path: /health
    port: 2828
  initialDelaySeconds: 5
  periodSeconds: 10
```

## Summary

The `start_container.sh` multi-mode entrypoint enables:

✅ **Single image** for all generations  
✅ **Flexible deployment** (choose mode at runtime)  
✅ **Easy migration** (run multiple modes simultaneously)  
✅ **Simple testing** (A/B test generations)  
✅ **Reduced complexity** (one build pipeline, many use cases)  

**Key Takeaway:** Cloud-native doesn't mean microservices sprawl. One well-designed image with runtime parameterization beats maintaining 10 different images.

## Related Documentation

- [Architecture Evolution](ARCHITECTURE-EVOLUTION.md)
- [Component Relationships (Gen 3)](COMPONENT-RELATIONSHIPS.md)
- [Container Parameters](CONTAINER-PARAMETERS.md)
- [OpenAPI Specifications](.)
