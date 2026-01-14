# Container Image & Resource Parameters

This document lists all ConfigMap parameters for controlling container images, pull policies, resource limits, and secrets.

## Summary of Changes

All container images and resource specifications are now fully parameterizable via ConfigMap data fields. This allows for:
- **Different images per environment** (dev, staging, production)
- **Private registry support** via `IMAGE_PULL_SECRET`
- **Image pull policy control** (Always, IfNotPresent, Never)
- **Per-component resource tuning** (CPU/memory for MongoDB, Nightscout, utility containers)

## Global Container Parameters

### Image Pull Secrets

**IMAGE_PULL_SECRET** (optional)
- **Description**: Name of Kubernetes Secret containing registry credentials for pulling images from private registries
- **Default**: None (public registries)
- **Used by**: All pods (MongoDB StatefulSet, Nightscout Deployment, Migration Job)
- **Example**: `my-registry-secret`
- **Note**: Create the secret separately: `kubectl create secret docker-registry my-registry-secret --docker-server=registry.example.com --docker-username=user --docker-password=pass`

## MongoDB Parameters

### MongoDB Image

**MONGO_IMAGE**
- **Description**: MongoDB container image and tag
- **Default**: `mongo:6`
- **Example**: `mongo:7.0`, `my-registry.io/mongodb:6.0-custom`

**MONGO_IMAGE_PULL_POLICY**
- **Description**: Image pull policy for MongoDB container
- **Default**: `IfNotPresent`
- **Options**: `Always`, `IfNotPresent`, `Never`
- **Use Cases**:
  - `Always`: Force pull on every pod restart (development with `:latest` tags)
  - `IfNotPresent`: Pull only if not cached (production with version tags)
  - `Never`: Never pull, must be pre-loaded (air-gapped environments)

### MongoDB Resources

**MONGO_CPU_REQUEST**
- **Default**: `100m`
- **Example**: `500m`, `1`, `2000m`

**MONGO_CPU_LIMIT**
- **Default**: `500m`
- **Example**: `1`, `2`, `4000m`

**MONGO_MEM_REQUEST**
- **Default**: `256Mi`
- **Example**: `512Mi`, `1Gi`, `2Gi`

**MONGO_MEM_LIMIT**
- **Default**: `512Mi`
- **Example**: `1Gi`, `2Gi`, `4Gi`

## Nightscout Parameters

### Nightscout Image

**NS_IMAGE**
- **Description**: Nightscout application container image and tag
- **Default**: `nightscout/cgm-remote-monitor:latest`
- **Example**: `nightscout/cgm-remote-monitor:15.0.0`, `my-registry.io/nightscout:custom`

**NS_IMAGE_PULL_POLICY**
- **Description**: Image pull policy for Nightscout container
- **Default**: `IfNotPresent`
- **Options**: `Always`, `IfNotPresent`, `Never`

### Nightscout Resources

**NS_CPU_REQUEST**
- **Default**: `100m`
- **Example**: `200m`, `500m`, `1`

**NS_CPU_LIMIT**
- **Default**: `500m`
- **Example**: `1`, `2`, `4000m`

**NS_MEM_REQUEST**
- **Default**: `256Mi`
- **Example**: `512Mi`, `1Gi`

**NS_MEM_LIMIT**
- **Default**: `512Mi`
- **Example**: `1Gi`, `2Gi`

## Utility Container Parameters

The utility container is used for:
- MongoDB replica set initialization (initContainer)
- Database migration (Job)
- Tenant verification and debugging

### Utility Image

**NS_UTILITY_IMAGE**
- **Description**: Utility container image containing initialization and migration scripts
- **Default**: `ns-utility:latest`
- **Example**: `my-registry.io/ns-utility:v1.0.0`, `ghcr.io/myorg/ns-utility:v1.2.3`
- **Build**: See `container-images/ns-utility/README.md`

**NS_UTILITY_IMAGE_PULL_POLICY**
- **Description**: Image pull policy for utility container
- **Default**: `IfNotPresent`
- **Options**: `Always`, `IfNotPresent`, `Never`
- **Recommendation**: Use `Always` in development, `IfNotPresent` in production with version tags

### Utility Container Resources

Used for migration Jobs and initContainers.

**NS_UTILITY_CPU_REQUEST**
- **Default**: `100m`
- **Example**: `200m`, `500m` (increase for large migrations)

**NS_UTILITY_CPU_LIMIT**
- **Default**: `500m`
- **Example**: `1`, `2` (increase for large migrations)

**NS_UTILITY_MEM_REQUEST**
- **Default**: `256Mi`
- **Example**: `512Mi`, `1Gi` (increase for large migrations)

**NS_UTILITY_MEM_LIMIT**
- **Default**: `512Mi`
- **Example**: `1Gi`, `2Gi` (increase for large migrations)

**Note**: Migration jobs temporarily store database dumps in memory/disk. For large databases (>1GB), increase memory limits accordingly.

## Example ConfigMaps

### Basic Tenant (Public Images)

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tenant-demo
  namespace: hosted-tenants
  labels:
    ns.mdn.io/enabled: "true"
    ns.mdn.io/tier: "basic"
data:
  TENANT_ID: "demo"
  
  # Use default public images
  MONGO_IMAGE: "mongo:6"
  NS_IMAGE: "nightscout/cgm-remote-monitor:latest"
  NS_UTILITY_IMAGE: "ns-utility:latest"
  
  # Default pull policy (only pull if not cached)
  MONGO_IMAGE_PULL_POLICY: "IfNotPresent"
  NS_IMAGE_PULL_POLICY: "IfNotPresent"
  NS_UTILITY_IMAGE_PULL_POLICY: "IfNotPresent"
  
  # Basic resources
  MONGO_CPU_REQUEST: "100m"
  MONGO_MEM_REQUEST: "256Mi"
  NS_CPU_REQUEST: "100m"
  NS_MEM_REQUEST: "256Mi"
```

### Premium Tenant (Private Registry, Higher Resources)

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tenant-premium
  namespace: hosted-tenants
  labels:
    ns.mdn.io/enabled: "true"
    ns.mdn.io/tier: "premium"
data:
  TENANT_ID: "premium"
  
  # Private registry images
  MONGO_IMAGE: "registry.example.com/mongodb:6.0-enterprise"
  NS_IMAGE: "registry.example.com/nightscout:15.0.0-custom"
  NS_UTILITY_IMAGE: "registry.example.com/ns-utility:v1.0.0"
  
  # Always pull to ensure latest security patches
  MONGO_IMAGE_PULL_POLICY: "Always"
  NS_IMAGE_PULL_POLICY: "Always"
  NS_UTILITY_IMAGE_PULL_POLICY: "IfNotPresent"  # Utility image is versioned
  
  # Pull secret for private registry
  IMAGE_PULL_SECRET: "registry-credentials"
  
  # Premium resources
  MONGO_CPU_REQUEST: "500m"
  MONGO_CPU_LIMIT: "2"
  MONGO_MEM_REQUEST: "1Gi"
  MONGO_MEM_LIMIT: "4Gi"
  
  NS_CPU_REQUEST: "200m"
  NS_CPU_LIMIT: "1"
  NS_MEM_REQUEST: "512Mi"
  NS_MEM_LIMIT: "2Gi"
  
  # Large migration resources
  NS_UTILITY_CPU_REQUEST: "500m"
  NS_UTILITY_CPU_LIMIT: "2"
  NS_UTILITY_MEM_REQUEST: "1Gi"
  NS_UTILITY_MEM_LIMIT: "2Gi"
  
  # Migration enabled
  MIGRATION_ENABLED: "true"
  MIGRATION_SOURCE_SECRET: "legacy-mongo-credentials"
  MIGRATION_METHOD: "mongodump-restore-single-db"
  MIGRATION_SOURCE_DB: "nightscout"
```

### Development Tenant (Always Pull Latest)

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tenant-dev
  namespace: hosted-tenants
  labels:
    ns.mdn.io/enabled: "true"
    ns.mdn.io/tier: "development"
data:
  TENANT_ID: "dev"
  
  # Development images with :latest tags
  MONGO_IMAGE: "mongo:latest"
  NS_IMAGE: "nightscout/cgm-remote-monitor:latest"
  NS_UTILITY_IMAGE: "localhost:5000/ns-utility:latest"  # Local registry
  
  # Always pull latest in development
  MONGO_IMAGE_PULL_POLICY: "Always"
  NS_IMAGE_PULL_POLICY: "Always"
  NS_UTILITY_IMAGE_PULL_POLICY: "Always"
  
  # Minimal resources for dev
  MONGO_CPU_REQUEST: "50m"
  MONGO_MEM_REQUEST: "128Mi"
  NS_CPU_REQUEST: "50m"
  NS_MEM_REQUEST: "128Mi"
```

### Air-Gapped Environment (Pre-loaded Images)

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tenant-airgap
  namespace: hosted-tenants
  labels:
    ns.mdn.io/enabled: "true"
data:
  TENANT_ID: "airgap"
  
  # Local registry (no external access)
  MONGO_IMAGE: "local-registry.cluster.local/mongodb:6.0"
  NS_IMAGE: "local-registry.cluster.local/nightscout:15.0.0"
  NS_UTILITY_IMAGE: "local-registry.cluster.local/ns-utility:v1.0.0"
  
  # Never pull (images must be pre-loaded)
  MONGO_IMAGE_PULL_POLICY: "Never"
  NS_IMAGE_PULL_POLICY: "Never"
  NS_UTILITY_IMAGE_PULL_POLICY: "Never"
  
  # Pull secret for local registry
  IMAGE_PULL_SECRET: "local-registry-secret"
```

## Image Pull Secret Setup

If using private registries, create the pull secret first:

```bash
# Docker Hub
kubectl create secret docker-registry registry-credentials \
  --docker-server=docker.io \
  --docker-username=myuser \
  --docker-password=mypassword \
  --namespace=hosted-tenants

# Custom registry
kubectl create secret docker-registry registry-credentials \
  --docker-server=registry.example.com \
  --docker-username=myuser \
  --docker-password=mypassword \
  --docker-email=user@example.com \
  --namespace=hosted-tenants

# GitHub Container Registry
kubectl create secret docker-registry ghcr-credentials \
  --docker-server=ghcr.io \
  --docker-username=myuser \
  --docker-password=ghp_xxxxxxxxxxxxx \
  --namespace=hosted-tenants
```

Then reference it in the ConfigMap:
```yaml
data:
  IMAGE_PULL_SECRET: "registry-credentials"
```

## Migration Notes

### Removed Parameters

**MIGRATION_IMAGE** has been **removed** and replaced with **NS_UTILITY_IMAGE**. The utility container now handles both initialization and migration.

**Before:**
```yaml
data:
  MIGRATION_IMAGE: "mongo:6"  # OBSOLETE
```

**After:**
```yaml
data:
  NS_UTILITY_IMAGE: "ns-utility:v1.0.0"
  NS_UTILITY_IMAGE_PULL_POLICY: "IfNotPresent"
  NS_UTILITY_CPU_REQUEST: "200m"
  NS_UTILITY_MEM_REQUEST: "512Mi"
```

## Resource Sizing Guidelines

### MongoDB

| Tenant Size | Data Size | CPU Request | CPU Limit | Memory Request | Memory Limit |
|-------------|-----------|-------------|-----------|----------------|--------------|
| Small       | <1GB      | 100m        | 500m      | 256Mi          | 512Mi        |
| Medium      | 1-10GB    | 500m        | 2         | 1Gi            | 2Gi          |
| Large       | 10-50GB   | 1           | 4         | 2Gi            | 8Gi          |
| Enterprise  | >50GB     | 2           | 8         | 4Gi            | 16Gi         |

### Nightscout

| Usage Level | Users/Day | CPU Request | CPU Limit | Memory Request | Memory Limit |
|-------------|-----------|-------------|-----------|----------------|--------------|
| Light       | <100      | 100m        | 500m      | 256Mi          | 512Mi        |
| Normal      | 100-1000  | 200m        | 1         | 512Mi          | 1Gi          |
| Heavy       | >1000     | 500m        | 2         | 1Gi            | 2Gi          |

### Utility Container (Migration)

| Database Size | CPU Request | CPU Limit | Memory Request | Memory Limit |
|---------------|-------------|-----------|----------------|--------------|
| <1GB          | 100m        | 500m      | 256Mi          | 512Mi        |
| 1-5GB         | 200m        | 1         | 512Mi          | 1Gi          |
| 5-20GB        | 500m        | 2         | 1Gi            | 2Gi          |
| >20GB         | 1           | 4         | 2Gi            | 4Gi          |

**Note**: Migration jobs temporarily use memory for database dumps. Ensure limits are 2-3x the source database size.

## Troubleshooting

### ImagePullBackOff Error

```bash
# Check pod events
kubectl describe pod <pod-name> -n hosted-tenants

# Common causes:
# 1. Image doesn't exist or wrong tag
# 2. Missing or invalid IMAGE_PULL_SECRET
# 3. Network connectivity to registry
# 4. Registry authentication failed
```

**Solutions:**
```yaml
# Verify image exists
docker pull nightscout/cgm-remote-monitor:15.0.0

# Check secret
kubectl get secret registry-credentials -n hosted-tenants

# Test pull policy
data:
  NS_IMAGE_PULL_POLICY: "Always"  # Force fresh pull
```

### OOMKilled (Out of Memory)

If migration jobs or pods are killed due to OOM:

```yaml
data:
  # Increase memory limits
  NS_UTILITY_MEM_REQUEST: "1Gi"
  NS_UTILITY_MEM_LIMIT: "2Gi"
  
  # For very large databases
  NS_UTILITY_MEM_LIMIT: "4Gi"
```

### CrashLoopBackOff

If utility container crashes during initialization:

```bash
# Check logs
kubectl logs <pod-name> -c init-replica-set -n hosted-tenants

# Common causes:
# 1. Script errors (check utility container version)
# 2. MongoDB not ready (network/DNS issues)
# 3. Resource constraints (CPU/memory too low)
```

## Webhook Configuration Environment Variables

The Metacontroller webhook server (cmd/webhook/server.js) uses environment variables to configure global defaults for all tenants. These defaults are applied when tenant-specific ConfigMap values are not provided.

### Server Configuration

**WEBHOOK_PORT**
- **Description**: HTTP port for the webhook server
- **Default**: `3000`
- **Example**: `8080`, `3000`
- **Note**: Must match the Metacontroller webhook configuration

### Global Image Defaults

These environment variables set cluster-wide defaults. Tenant ConfigMaps can override any of these values.

**DEFAULT_MONGO_IMAGE**
- **Description**: Default MongoDB image for all tenants
- **Default**: `mongo:6`
- **Override**: Set `MONGO_IMAGE` in tenant ConfigMap

**DEFAULT_MONGO_IMAGE_PULL_POLICY**
- **Description**: Default image pull policy for MongoDB
- **Default**: `IfNotPresent`
- **Override**: Set `MONGO_IMAGE_PULL_POLICY` in tenant ConfigMap

**DEFAULT_NS_IMAGE**
- **Description**: Default Nightscout application image for all tenants
- **Default**: `nightscout/cgm-remote-monitor:latest`
- **Override**: Set `NS_IMAGE` in tenant ConfigMap

**DEFAULT_NS_IMAGE_PULL_POLICY**
- **Description**: Default image pull policy for Nightscout
- **Default**: `IfNotPresent`
- **Override**: Set `NS_IMAGE_PULL_POLICY` in tenant ConfigMap

**DEFAULT_NS_UTILITY_IMAGE**
- **Description**: Default utility container image for initialization and migration
- **Default**: `ns-utility:latest`
- **Override**: Set `NS_UTILITY_IMAGE` in tenant ConfigMap

**DEFAULT_NS_UTILITY_IMAGE_PULL_POLICY**
- **Description**: Default image pull policy for utility container
- **Default**: `IfNotPresent`
- **Override**: Set `NS_UTILITY_IMAGE_PULL_POLICY` in tenant ConfigMap

**DEFAULT_POD_HEALTHCHECK_IMAGE**
- **Description**: Default pod health check sidecar image
- **Default**: `pod-healthcheck:latest`
- **Override**: Set `POD_HEALTHCHECK_IMAGE` in tenant ConfigMap

**DEFAULT_POD_HEALTHCHECK_IMAGE_PULL_POLICY**
- **Description**: Default image pull policy for pod health check sidecar
- **Default**: `IfNotPresent`
- **Override**: Set `POD_HEALTHCHECK_IMAGE_PULL_POLICY` in tenant ConfigMap

### Global Resource Defaults (MongoDB)

**DEFAULT_MONGO_CPU_REQUEST**
- **Default**: `100m`
- **Override**: Set `MONGO_CPU_REQUEST` in tenant ConfigMap

**DEFAULT_MONGO_CPU_LIMIT**
- **Default**: `500m`
- **Override**: Set `MONGO_CPU_LIMIT` in tenant ConfigMap

**DEFAULT_MONGO_MEM_REQUEST**
- **Default**: `256Mi`
- **Override**: Set `MONGO_MEM_REQUEST` in tenant ConfigMap

**DEFAULT_MONGO_MEM_LIMIT**
- **Default**: `512Mi`
- **Override**: Set `MONGO_MEM_LIMIT` in tenant ConfigMap

### Global Resource Defaults (Nightscout)

**DEFAULT_NS_CPU_REQUEST**
- **Default**: `100m`
- **Override**: Set `NS_CPU_REQUEST` in tenant ConfigMap

**DEFAULT_NS_CPU_LIMIT**
- **Default**: `500m`
- **Override**: Set `NS_CPU_LIMIT` in tenant ConfigMap

**DEFAULT_NS_MEM_REQUEST**
- **Default**: `256Mi`
- **Override**: Set `NS_MEM_REQUEST` in tenant ConfigMap

**DEFAULT_NS_MEM_LIMIT**
- **Default**: `512Mi`
- **Override**: Set `NS_MEM_LIMIT` in tenant ConfigMap

### Global Resource Defaults (Utility Container)

**DEFAULT_NS_UTILITY_CPU_REQUEST**
- **Default**: `100m`
- **Override**: Set `NS_UTILITY_CPU_REQUEST` in tenant ConfigMap

**DEFAULT_NS_UTILITY_CPU_LIMIT**
- **Default**: `500m`
- **Override**: Set `NS_UTILITY_CPU_LIMIT` in tenant ConfigMap

**DEFAULT_NS_UTILITY_MEM_REQUEST**
- **Default**: `256Mi`
- **Override**: Set `NS_UTILITY_MEM_REQUEST` in tenant ConfigMap

**DEFAULT_NS_UTILITY_MEM_LIMIT**
- **Default**: `512Mi`
- **Override**: Set `NS_UTILITY_MEM_LIMIT` in tenant ConfigMap

### Global Resource Defaults (Pod Health Check Sidecar)

**DEFAULT_POD_HEALTHCHECK_CPU_REQUEST**
- **Default**: `10m`
- **Override**: Set `POD_HEALTHCHECK_CPU_REQUEST` in tenant ConfigMap

**DEFAULT_POD_HEALTHCHECK_CPU_LIMIT**
- **Default**: `50m`
- **Override**: Set `POD_HEALTHCHECK_CPU_LIMIT` in tenant ConfigMap

**DEFAULT_POD_HEALTHCHECK_MEM_REQUEST**
- **Default**: `16Mi`
- **Override**: Set `POD_HEALTHCHECK_MEM_REQUEST` in tenant ConfigMap

**DEFAULT_POD_HEALTHCHECK_MEM_LIMIT**
- **Default**: `64Mi`
- **Override**: Set `POD_HEALTHCHECK_MEM_LIMIT` in tenant ConfigMap

### Pod Health Check Command Configuration

**DEFAULT_POD_HEALTHCHECK_COMMAND**
- **Description**: Command to run for pod health check sidecar (JSON array format)
- **Default**: `["node", "cmd/pod-healthcheck/server.js"]`
- **Override**: Set `POD_HEALTHCHECK_COMMAND` in tenant ConfigMap
- **Example**: `["node", "cmd/pod-healthcheck/server.js"]`
- **Note**: Must be valid JSON array when set via environment variable

**DEFAULT_POD_HEALTHCHECK_ARGS**
- **Description**: Arguments for pod health check command (JSON array format)
- **Default**: `[]`
- **Override**: Set `POD_HEALTHCHECK_ARGS` in tenant ConfigMap
- **Example**: `["--verbose", "--debug"]`
- **Note**: Must be valid JSON array when set via environment variable

### Backup Policy Defaults

**DEFAULT_BACKUP_POLICY**
- **Description**: Default backup policy for PVCs managed by DecoratorController
- **Default**: `snapshot`
- **Options**: `snapshot`, `skip`
- **Note**: Applied to MongoDB PVCs via decorator webhook

**DEFAULT_BACKUP_TTL**
- **Description**: Default time-to-live for backup snapshots
- **Default**: `30d`
- **Format**: Number followed by unit (d=days, h=hours, m=minutes)
- **Example**: `7d`, `90d`, `1h`

**DEFAULT_BACKUP_SNAPSHOT_CLASS**
- **Description**: Default VolumeSnapshotClass for creating snapshots
- **Default**: `csi-snapclass`
- **Note**: Must match an existing VolumeSnapshotClass in your cluster

### CDC (Change Data Capture) Defaults

**DEFAULT_KAFKA_CONNECT_CLUSTER**
- **Description**: Default Kafka Connect cluster name for CDC
- **Default**: `kafka-connect`
- **Override**: Set `KAFKA_CONNECT_CLUSTER_NAME` in tenant ConfigMap
- **Note**: Must match the Strimzi KafkaConnect resource name

## Webhook Environment Variable Deployment

### Kubernetes Deployment Example

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: metacontroller-webhook
  namespace: metacontroller-system
spec:
  template:
    spec:
      containers:
      - name: webhook
        image: nightscout-webhook:v1.0.0
        env:
        # Server config
        - name: WEBHOOK_PORT
          value: "3000"
        
        # Global image defaults
        - name: DEFAULT_MONGO_IMAGE
          value: "mongo:6"
        - name: DEFAULT_NS_IMAGE
          value: "nightscout/cgm-remote-monitor:15.0.0"
        - name: DEFAULT_NS_UTILITY_IMAGE
          value: "ghcr.io/myorg/ns-utility:v1.0.0"
        - name: DEFAULT_POD_HEALTHCHECK_IMAGE
          value: "ghcr.io/myorg/pod-healthcheck:v1.0.0"
        
        # Global pull policies (production: IfNotPresent)
        - name: DEFAULT_MONGO_IMAGE_PULL_POLICY
          value: "IfNotPresent"
        - name: DEFAULT_NS_IMAGE_PULL_POLICY
          value: "IfNotPresent"
        
        # Backup defaults
        - name: DEFAULT_BACKUP_POLICY
          value: "snapshot"
        - name: DEFAULT_BACKUP_TTL
          value: "90d"
        - name: DEFAULT_BACKUP_SNAPSHOT_CLASS
          value: "csi-snapclass"
        
        # CDC defaults
        - name: DEFAULT_KAFKA_CONNECT_CLUSTER
          value: "kafka-connect-prod"
        
        # Optional: Override resource defaults for specific tier
        - name: DEFAULT_MONGO_MEM_LIMIT
          value: "1Gi"
        - name: DEFAULT_NS_MEM_LIMIT
          value: "1Gi"
```

### ConfigMap for Environment Variables

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: webhook-config
  namespace: metacontroller-system
data:
  # Image configuration
  DEFAULT_MONGO_IMAGE: "mongo:6"
  DEFAULT_NS_IMAGE: "nightscout/cgm-remote-monitor:15.0.0"
  DEFAULT_NS_UTILITY_IMAGE: "ns-utility:v1.0.0"
  DEFAULT_POD_HEALTHCHECK_IMAGE: "pod-healthcheck:v1.0.0"
  
  # Backup configuration
  DEFAULT_BACKUP_POLICY: "snapshot"
  DEFAULT_BACKUP_TTL: "90d"
  DEFAULT_BACKUP_SNAPSHOT_CLASS: "csi-snapclass"
  
  # CDC configuration
  DEFAULT_KAFKA_CONNECT_CLUSTER: "kafka-connect"
```

Reference in Deployment:
```yaml
envFrom:
- configMapRef:
    name: webhook-config
```

## Configuration Hierarchy

The system uses a three-tier configuration hierarchy:

1. **Webhook Environment Variables** (lowest priority) - Global defaults for entire cluster
2. **Webhook Config Defaults** (hardcoded fallbacks) - Built-in defaults in cmd/webhook/config.js
3. **Tenant ConfigMap** (highest priority) - Tenant-specific overrides

Example flow for MongoDB image selection:
1. Check tenant ConfigMap `MONGO_IMAGE` field → if present, use it
2. Check webhook env var `DEFAULT_MONGO_IMAGE` → if present, use it
3. Use hardcoded default from config.js → `mongo:6`

This allows operators to:
- Set cluster-wide standards via webhook environment variables
- Override for specific tiers or tenants via ConfigMaps
- Maintain sensible fallback defaults in code

## Container Entry Points

The platform uses a single multi-mode container image that can run different components based on command-line arguments. The `start_container.sh` script serves as the entrypoint, accepting a mode argument to determine which component to launch.

### Usage

```bash
# In Kubernetes Pod spec
command: ["./start_container.sh"]
args: ["<mode>"]

# Examples
args: ["multienv-metactl-webhooks"]  # Gen 4 webhook server
args: ["resolver"]                    # Traffic resolver
args: ["tenant-pod-healthcheck"]      # Health check sidecar
```

### Gen 4 Active Components

These components are actively used in Gen 4 deployments alongside Metacontroller:

**multienv-metactl-webhooks**
- **Purpose**: Metacontroller webhook server for Gen 4 two-composite architecture
- **Entry Point**: `cmd/webhook/server.js`
- **Endpoints**:
  - `POST /composite/storage/sync` - Storage composite (Secret → MongoDB + Migration)
  - `POST /composite/compute/sync` - Compute composite (ConfigMap → Nightscout + CDC)
  - `POST /decorator/sync` - PVC backup policy decorator
  - `POST /decorator/finalize` - PVC cleanup finalizer
  - `GET /health` - Health check
- **Port**: 3000 (configurable via `PORT` env var)
- **Use Case**: Primary orchestration engine for Gen 4, handles resource generation from ConfigMaps/Secrets

**deployment-controller**
- **Purpose**: Gen 3 deployment controller providing /environs/ REST API
- **Entry Point**: `k8s-deployment-controller.js`
- **Endpoints**:
  - `GET /environs/:name` - Fetch tenant configuration
  - `POST /environs/:name` - Create/update tenant configuration
  - `POST /accounts` - Provision new storage account (Gen 4)
  - `POST /accounts/:account/sites/:name` - Provision new site (Gen 4)
- **Use Case**: Frontend dashboard API for tenant configuration management
- **Note**: Kept in Gen 4 for /environs/ API compatibility, orchestration handled by Metacontroller

**deployment-operator**
- **Purpose**: Pod watcher that syncs Consul updates via deployment-controller
- **Entry Point**: `k8s-dispatcher.js` with `SYNC_CONTROLLER="deployment"`
- **Behavior**: Watches Pod events, triggers deployment-controller sync
- **Use Case**: Maintains Consul service discovery state for tenant pods
- **Note**: Works alongside Gen 4 webhooks for Consul integration

**resolver**
- **Purpose**: Traffic routing and resolution for tenant HTTP requests
- **Entry Point**: `redirector-server.js`
- **Port**: Configured via `REDIRECTOR_PORT` (default: 3636)
- **Use Case**: Routes external user requests to correct Nightscout instance via Consul DNS
- **Note**: Core traffic component used across all generations

**inspector**
- **Purpose**: Alternative /environs/ REST API using direct ConfigMap access
- **Entry Point**: `k8s-inspector.js`
- **Endpoints**: Similar to deployment-controller but with direct K8s API access
- **Use Case**: Lightweight alternative to deployment-controller for simple environments

**tenant-pod-healthcheck**
- **Purpose**: Health check sidecar injected into Nightscout pods
- **Entry Point**: `cmd/pod-healthcheck/server.js`
- **Port**: Configured via `HEALTHCHECK_PORT` (default: varies)
- **Use Case**: Provides localhost-based health validation for Consul, eliminates DNS/API bottlenecks
- **Note**: Critical for scaling to 10,000+ tenants (see [POD-HEALTHCHECK.md](POD-HEALTHCHECK.md))

**demuxer**
- **Purpose**: Consul-based load balancer and availability keeper
- **Entry Point**: `tenant-availability-keeper.js`
- **Use Case**: Cluster-wide load balancing and tenant availability tracking

### Gen 3 Components (Replaced by Metacontroller)

These components were used in Gen 3 but are replaced by Metacontroller webhooks in Gen 4:

**dispatcher**
- **Purpose**: ConfigMap watcher that triggers deployment-controller
- **Entry Point**: `k8s-dispatcher.js`
- **Status**: ⚠️ **Deprecated in Gen 4** - Metacontroller handles ConfigMap watching
- **Migration**: Use Metacontroller CompositeController instead

### Gen 1 Components (Legacy)

These components supported the original single-host multi-tenant architecture:

**multienv**
- **Purpose**: Full Gen 1 stack: master.js + redirector-server.js + nginx
- **Entry Point**: Runs `setup_main()` then launches both master.js and redirector-server.js
- **Use Case**: Legacy single-host deployments (pre-Kubernetes)
- **Status**: Legacy - Gen 4 uses Kubernetes-native orchestration

**runner**
- **Purpose**: Process manager only (master.js)
- **Entry Point**: `master.js`
- **Use Case**: Worker process management for Gen 1
- **Status**: Legacy - Gen 4 uses Kubernetes Deployments for process management

### Utility Commands

**bash**
- **Purpose**: Interactive shell for debugging
- **Example**: `kubectl exec -it <pod> -- ./start_container.sh bash`

**env**
- **Purpose**: Print all environment variables
- **Example**: `kubectl exec <pod> -- ./start_container.sh env`

**setup_workdir**
- **Purpose**: Install npm dependencies in worker directory
- **Command**: `cd $WORKER_DIR && npm install`

**nginx-for <type> [output]**
- **Purpose**: Generate nginx configuration templates
- **Types**:
  - `std-multienv` - Legacy nginx config for hybrid runner+resolver
  - `inspector` - Nginx config for inspector interface
  - `demuxer` - Nginx config for cluster-wide demuxer
  - `resolver` - Nginx config for resolver interface
- **Example**: `./start_container.sh nginx-for resolver /etc/nginx/nginx.conf`

**help**
- **Purpose**: Display usage information
- **Example**: `./start_container.sh help`

### Kubernetes Pod Examples

#### Gen 4 Webhook Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gen4-webhooks
  namespace: default
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: webhook
        image: nightscout-multienv:latest
        command: ["./start_container.sh"]
        args: ["multienv-metactl-webhooks"]
        env:
        - name: PORT
          value: "3000"
        - name: DEFAULT_MONGO_IMAGE
          value: "mongo:6"
        ports:
        - containerPort: 3000
          name: http
```

#### Deployment Controller (Frontend API)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: deployment-controller
  namespace: default
spec:
  replicas: 2
  template:
    spec:
      containers:
      - name: controller
        image: nightscout-multienv:latest
        command: ["./start_container.sh"]
        args: ["deployment-controller"]
        env:
        - name: PORT
          value: "3000"
        - name: NAMESPACE
          value: "hosted-tenants"
```

#### Resolver (Traffic Routing)

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: resolvers
  namespace: default
spec:
  template:
    spec:
      containers:
      - name: resolver
        image: nightscout-multienv:latest
        command: ["./start_container.sh"]
        args: ["resolver"]
        env:
        - name: REDIRECTOR_PORT
          value: "3636"
        - name: CONSUL_HOST
          value: "consul.service.consul"
```

#### Pod Healthcheck Sidecar

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: nightscout-tenant
spec:
  containers:
  - name: nightscout
    image: nightscout/cgm-remote-monitor:latest
    # ... nightscout config ...
  
  - name: healthcheck
    image: nightscout-multienv:latest
    command: ["./start_container.sh"]
    args: ["tenant-pod-healthcheck"]
    env:
    - name: NIGHTSCOUT_HOST
      value: "localhost"
    - name: NIGHTSCOUT_PORT
      value: "1337"
```

### Migration Guide: Gen 3 → Gen 4

**Gen 3 Setup:**
```yaml
# ConfigMap watcher
- args: ["dispatcher"]

# Deployment controller
- args: ["deployment-controller"]

# Operator (pod watcher)
- args: ["deployment-operator"]
```

**Gen 4 Setup:**
```yaml
# NEW: Metacontroller webhooks (replaces dispatcher)
- args: ["multienv-metactl-webhooks"]

# KEEP: Deployment controller (provides /environs/ API)
- args: ["deployment-controller"]

# KEEP: Operator (syncs Consul)
- args: ["deployment-operator"]

# REMOVE: dispatcher (Metacontroller handles ConfigMap watching)
```

### Environment Variables by Component

| Component | Key Variables | Default |
|-----------|--------------|---------|
| **multienv-metactl-webhooks** | `PORT` | `3000` |
| | `DEFAULT_MONGO_IMAGE` | `mongo:6` |
| | `DEFAULT_NS_IMAGE` | `nightscout/cgm-remote-monitor:latest` |
| **deployment-controller** | `PORT` | `3000` |
| | `NAMESPACE` | `hosted-tenants` |
| **deployment-operator** | `SYNC_CONTROLLER` | `deployment` |
| **resolver** | `REDIRECTOR_PORT` | `3636` |
| | `CONSUL_HOST` | Auto-discovered |
| **tenant-pod-healthcheck** | `NIGHTSCOUT_HOST` | `localhost` |
| | `NIGHTSCOUT_PORT` | `1337` |
| **inspector** | `PORT` | `3000` |
| **demuxer** | `PORT` | `3000` |
| | `DEMUXER_SERVICE_URI` | `http://demuxers:3000` |

### Troubleshooting Entry Points

**Check which component is running:**
```bash
kubectl exec <pod> -- ps aux
# Look for process name (-a flag from exec)
```

**View startup logs:**
```bash
kubectl logs <pod>
# First line: "starting container..."
# Shows which entry point was executed
```

**Test entry point locally:**
```bash
docker run -it nightscout-multienv:latest ./start_container.sh help
docker run -it nightscout-multienv:latest ./start_container.sh bash
```

**Common issues:**

1. **Wrong entry point**: Pod crashes immediately
   - Check args in Pod spec matches available modes
   - View: `./start_container.sh help`

2. **Missing environment variables**: Process starts but fails
   - Check required env vars for specific component
   - Use: `kubectl exec <pod> -- ./start_container.sh env`

3. **Port conflicts**: Pod runs but health check fails
   - Ensure PORT environment variable matches containerPort
   - Verify no port overlap between components

## Best Practices

1. **Use version tags in production**: Never use `:latest` in production
2. **Set pull policy based on tags**:
   - Version tags (`v1.0.0`): Use `IfNotPresent`
   - Latest tag: Use `Always` only in development
3. **Size resources appropriately**: Start conservative, monitor, then increase
4. **Use pull secrets for private registries**: Keep credentials in Secrets, not ConfigMaps
5. **Test migrations with increased resources**: Migration jobs need more memory than runtime
6. **Version your utility container**: Tag utility images with versions for rollback capability
7. **Configure webhook defaults once**: Set global standards via webhook environment variables
8. **Override per tier**: Use ConfigMap parameters for tier-specific requirements (basic, premium, enterprise)
9. **Keep backup policies consistent**: Use webhook defaults unless tenant has specific compliance requirements
10. **Use correct entry point for Gen 4**: `multienv-metactl-webhooks` for orchestration, keep `deployment-controller` for /environs/ API

## See Also

- [Utility Container README](../container-images/ns-utility/README.md) - Building and using ns-utility
- [ConfigMap Parameters (Main)](../replit.md) - All ConfigMap parameters
- [Kubernetes Image Pull Policy](https://kubernetes.io/docs/concepts/containers/images/#image-pull-policy)
- [Kubernetes Resource Management](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
