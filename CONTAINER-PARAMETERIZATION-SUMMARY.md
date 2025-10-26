# Container Parameterization - Implementation Summary

## Question
"Will the images and other container details need to be parameterized?"

## Answer
**YES** - And it's now fully implemented! All container images, pull policies, resource limits, and registry secrets are now completely parameterizable via ConfigMap.

## What Was Added

### 1. Image Pull Policies (3 new parameters)

All containers now support configurable pull policies:

| Parameter | Default | Applied To |
|-----------|---------|------------|
| `MONGO_IMAGE_PULL_POLICY` | `IfNotPresent` | MongoDB StatefulSet |
| `NS_IMAGE_PULL_POLICY` | `IfNotPresent` | Nightscout Deployment |
| `NS_UTILITY_IMAGE_PULL_POLICY` | `IfNotPresent` | InitContainer + Migration Job |

**Values**: `Always`, `IfNotPresent`, `Never`

### 2. Private Registry Support (1 new parameter)

| Parameter | Default | Applied To |
|-----------|---------|------------|
| `IMAGE_PULL_SECRET` | None | All pods (MongoDB, Nightscout, Migration) |

**Usage**:
```bash
kubectl create secret docker-registry my-registry-secret \
  --docker-server=registry.example.com \
  --docker-username=user \
  --docker-password=pass \
  --namespace=hosted-tenants
```

```yaml
data:
  IMAGE_PULL_SECRET: "my-registry-secret"
```

### 3. Utility Container Resources (4 new parameters)

Previously hardcoded, now fully configurable:

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `NS_UTILITY_CPU_REQUEST` | `100m` | CPU request for utility container |
| `NS_UTILITY_CPU_LIMIT` | `500m` | CPU limit for utility container |
| `NS_UTILITY_MEM_REQUEST` | `256Mi` | Memory request for utility container |
| `NS_UTILITY_MEM_LIMIT` | `512Mi` | Memory limit for utility container |

**Applied to**:
- InitContainer (replica set initialization)
- Migration Job (database migration)

### 4. Removed Obsolete Parameter

**`MIGRATION_IMAGE`** - REMOVED
- Was: Migration job used separate `MIGRATION_IMAGE` parameter
- Now: Uses `NS_UTILITY_IMAGE` (consistent with initContainer)

## Code Changes

### Before (Hardcoded)

```javascript
// initContainer
image: parent.data.NS_UTILITY_IMAGE || 'ns-utility:latest'
// No imagePullPolicy specified (defaults to cluster settings)

// Migration Job
image: migrationImage  // Separate parameter, inconsistent
resources: {
  requests: { cpu: '100m', memory: '256Mi' },  // HARDCODED
  limits: { cpu: '500m', memory: '512Mi' }     // HARDCODED
}
```

### After (Parameterized)

```javascript
// initContainer
image: parent.data.NS_UTILITY_IMAGE || 'ns-utility:latest',
imagePullPolicy: parent.data.NS_UTILITY_IMAGE_PULL_POLICY || 'IfNotPresent',

// Pod spec
imagePullSecrets: parent.data.IMAGE_PULL_SECRET 
  ? [{ name: parent.data.IMAGE_PULL_SECRET }] 
  : undefined,

// Migration Job
image: utilityImage,  // Uses NS_UTILITY_IMAGE
imagePullPolicy: utilityImagePullPolicy,
resources: {
  requests: {
    cpu: utilityCpuRequest,     // Configurable
    memory: utilityMemRequest    // Configurable
  },
  limits: {
    cpu: utilityCpuLimit,        // Configurable
    memory: utilityMemLimit      // Configurable
  }
}
```

## Use Cases

### 1. Development Environment (Always Pull Latest)

```yaml
data:
  MONGO_IMAGE: "mongo:latest"
  NS_IMAGE: "nightscout/cgm-remote-monitor:latest"
  NS_UTILITY_IMAGE: "localhost:5000/ns-utility:latest"
  
  MONGO_IMAGE_PULL_POLICY: "Always"
  NS_IMAGE_PULL_POLICY: "Always"
  NS_UTILITY_IMAGE_PULL_POLICY: "Always"
```

### 2. Production Environment (Versioned Images, Private Registry)

```yaml
data:
  MONGO_IMAGE: "registry.example.com/mongodb:6.0-enterprise"
  NS_IMAGE: "registry.example.com/nightscout:15.0.0"
  NS_UTILITY_IMAGE: "registry.example.com/ns-utility:v1.0.0"
  
  MONGO_IMAGE_PULL_POLICY: "IfNotPresent"
  NS_IMAGE_PULL_POLICY: "IfNotPresent"
  NS_UTILITY_IMAGE_PULL_POLICY: "IfNotPresent"
  
  IMAGE_PULL_SECRET: "registry-credentials"
```

### 3. Large Database Migration (Increased Resources)

```yaml
data:
  MIGRATION_ENABLED: "true"
  MIGRATION_SOURCE_SECRET: "legacy-credentials"
  
  # Large migration needs more resources
  NS_UTILITY_CPU_REQUEST: "500m"
  NS_UTILITY_CPU_LIMIT: "2"
  NS_UTILITY_MEM_REQUEST: "1Gi"
  NS_UTILITY_MEM_LIMIT: "4Gi"
```

### 4. Air-Gapped Environment (Never Pull)

```yaml
data:
  MONGO_IMAGE: "local-registry.cluster.local/mongodb:6.0"
  NS_IMAGE: "local-registry.cluster.local/nightscout:15.0.0"
  NS_UTILITY_IMAGE: "local-registry.cluster.local/ns-utility:v1.0.0"
  
  # Images must be pre-loaded
  MONGO_IMAGE_PULL_POLICY: "Never"
  NS_IMAGE_PULL_POLICY: "Never"
  NS_UTILITY_IMAGE_PULL_POLICY: "Never"
  
  IMAGE_PULL_SECRET: "local-registry-secret"
```

## New Parameters Summary

Total new/updated parameters: **9**

**Image Pull Policies (3)**:
- `MONGO_IMAGE_PULL_POLICY`
- `NS_IMAGE_PULL_POLICY`
- `NS_UTILITY_IMAGE_PULL_POLICY`

**Registry Authentication (1)**:
- `IMAGE_PULL_SECRET`

**Utility Container Resources (4)**:
- `NS_UTILITY_CPU_REQUEST`
- `NS_UTILITY_CPU_LIMIT`
- `NS_UTILITY_MEM_REQUEST`
- `NS_UTILITY_MEM_LIMIT`

**Removed (1)**:
- `MIGRATION_IMAGE` (replaced by `NS_UTILITY_IMAGE`)

## Documentation Created

**[docs/CONTAINER-PARAMETERS.md](docs/CONTAINER-PARAMETERS.md)** - Comprehensive guide including:
- All container parameters with defaults and examples
- Image pull policy guidelines
- Resource sizing recommendations
- Example ConfigMaps for different environments
- Troubleshooting guide (ImagePullBackOff, OOMKilled, etc.)
- Best practices

## Benefits

✅ **Multi-Environment Support**: Different images/policies for dev/staging/prod  
✅ **Private Registry Support**: Secure pull secrets for enterprise registries  
✅ **Resource Optimization**: Tune resources per tenant tier (basic/premium)  
✅ **Migration Flexibility**: Adjust resources for large database migrations  
✅ **Air-Gap Support**: Pre-loaded images with `imagePullPolicy: Never`  
✅ **Consistency**: All images use same parameterization pattern  

## Migration Impact

**Breaking Change**: `MIGRATION_IMAGE` parameter removed

**Before**:
```yaml
data:
  MIGRATION_IMAGE: "mongo:6"  # OBSOLETE
```

**After**:
```yaml
data:
  NS_UTILITY_IMAGE: "ns-utility:v1.0.0"
```

**Impact**: Existing tenants using `MIGRATION_IMAGE` will fall back to `NS_UTILITY_IMAGE` default. Update ConfigMaps to use `NS_UTILITY_IMAGE` explicitly.

## Testing Checklist

- [ ] Build utility container: `cd container-images/ns-utility && ./build.sh`
- [ ] Test with public images (default configuration)
- [ ] Test with private registry + IMAGE_PULL_SECRET
- [ ] Test with `imagePullPolicy: Always` (development)
- [ ] Test with `imagePullPolicy: Never` (air-gapped)
- [ ] Test migration with custom utility resources
- [ ] Verify all 3 pod types get imagePullSecrets (MongoDB, Nightscout, Migration)

## Files Modified

1. **cmd/webhook/handlers/resources.js** - Added all parameterization logic
2. **docs/CONTAINER-PARAMETERS.md** - Complete documentation (NEW)
3. **CONTAINER-PARAMETERIZATION-SUMMARY.md** - This summary (NEW)
