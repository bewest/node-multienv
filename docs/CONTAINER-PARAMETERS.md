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

## Best Practices

1. **Use version tags in production**: Never use `:latest` in production
2. **Set pull policy based on tags**:
   - Version tags (`v1.0.0`): Use `IfNotPresent`
   - Latest tag: Use `Always` only in development
3. **Size resources appropriately**: Start conservative, monitor, then increase
4. **Use pull secrets for private registries**: Keep credentials in Secrets, not ConfigMaps
5. **Test migrations with increased resources**: Migration jobs need more memory than runtime
6. **Version your utility container**: Tag utility images with versions for rollback capability

## See Also

- [Utility Container README](../container-images/ns-utility/README.md) - Building and using ns-utility
- [ConfigMap Parameters (Main)](../replit.md) - All ConfigMap parameters
- [Kubernetes Image Pull Policy](https://kubernetes.io/docs/concepts/containers/images/#image-pull-policy)
- [Kubernetes Resource Management](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
