# Utility Container Implementation Summary

## Overview

Successfully extracted embedded bash scripts from Kubernetes resource manifests into a versioned, testable utility container (`ns-utility`). This addresses the original question: **"Is it feasible to stub out scripts or bash utility functions... so we can shift the embedded bash outside the logic for templating a JSON metacontroller response?"**

**Answer: YES** - It's not only feasible, it's a best practice.

## What Was Created

### 1. Utility Container Image (`ns-utility`)

**Location:** `container-images/ns-utility/`

**Components:**
- **3 Library Modules** (335 lines of reusable bash functions):
  - `lib/common.sh`: Logging, retry, error handling, wait functions
  - `lib/mongodb-utils.sh`: MongoDB operations (init RS, health checks, backup/restore)
  - `lib/kafka-utils.sh`: Kafka/CDC operations (connector management, topic checks)

- **4 Entrypoint Scripts** (500 lines):
  - `entrypoints/init-replica-set.sh`: Replaces initContainer bash (was 15 lines inline → now structured)
  - `entrypoints/migrate-database.sh`: Replaces migration Job bash (was 25 lines inline → now structured with verification)
  - `entrypoints/verify-tenant.sh`: New - tenant health verification
  - `entrypoints/debug-shell.sh`: New - interactive debugging with preloaded utilities

**Total:** 835 lines of well-structured, reusable bash code

### 2. Webhook Updates

**Before (resources.js):**
```javascript
initContainers: [{
  name: 'init-replica-set',
  image: mongoImage,
  command: ['/bin/bash', '-c'],
  args: [`
    until mongosh --host ${pod0Hostname} --eval "rs.status()" > /dev/null 2>&1; do
      echo "Waiting for MongoDB to start...";
      sleep 2;
    done;
    mongosh --host ${pod0Hostname} --eval "
      try {
        rs.initiate({
          _id: 'rs0',
          members: [{ _id: 0, host: '${pod0Hostname}:27017' }]
        });
      } catch(e) {
        print('RS already initialized or error:', e);
      }
    " || true
  `]
}]
```

**After (resources.js):**
```javascript
initContainers: [{
  name: 'init-replica-set',
  image: parent.data.NS_UTILITY_IMAGE || 'ns-utility:latest',
  command: ['init-replica-set.sh'],
  env: [
    { name: 'MONGO_HOST', value: pod0Hostname },
    { name: 'MONGO_PORT', value: '27017' },
    { name: 'MONGO_RS_NAME', value: 'rs0' }
  ]
}]
```

**Benefits:**
✅ Clean separation: JSON manifest only contains configuration
✅ Versioned scripts: Can rollback, test independently
✅ Reusable: Same utilities across init, migration, debugging
✅ Maintainable: Update scripts without webhook changes

### 3. Audit Metadata System

Added comprehensive labels and annotations to all resources for data recovery and compliance:

**PVC Labels:**
- `ns.mdn.io/tier`: Tenant tier (basic, premium)
- `ns.mdn.io/data-class`: Data classification (production, test)
- `ns.mdn.io/region`: Deployment region

**PVC Annotations:**
- `ns.mdn.io/created-at`: Creation timestamp
- `ns.mdn.io/parent-generation`: ConfigMap generation
- `ns.mdn.io/tenant-email`: Contact email
- `ns.mdn.io/backup-schedule`: Backup frequency
- `ns.mdn.io/last-backup-check`: Last verification

**VolumeSnapshot Annotations:**
- `ns.mdn.io/snapshot-created`: Snapshot timestamp
- `ns.mdn.io/source-pvc`: Source PVC name
- `ns.mdn.io/source-created-at`: Original creation time
- `ns.mdn.io/tenant-email`: Contact for recovery
- `ns.mdn.io/backup-trigger`: What triggered snapshot

**Use Cases:**
```bash
# Find all premium tenant resources
kubectl get all,pvc -l ns.mdn.io/tier=premium

# Find all production data for compliance audit
kubectl get pvc -l ns.mdn.io/data-class=production

# Find all snapshots from deleted PVCs for data recovery
kubectl get volumesnapshot -l ns.mdn.io/backup-type=final

# Find tenants in specific region
kubectl get pvc -l ns.mdn.io/region=us-west
```

### 4. Decorator Passthrough Logic

**Question:** "Does the decorator need similar logic to persist or pass through items that are unaffected by this logic?"

**Answer:** YES - Decorator now preserves all existing annotations and only adds/modifies its own:

```javascript
const enhancedAnnotations = {
  ...currentAnnotations,  // ✅ Preserve everything
  'ns.mdn.io/backup-policy': currentAnnotations['ns.mdn.io/backup-policy'] || 'snapshot',
  'ns.mdn.io/backup-ttl': currentAnnotations['ns.mdn.io/backup-ttl'] || '30d'
};

// Only add if not already present
if (!currentAnnotations['ns.mdn.io/last-backup-check']) {
  enhancedAnnotations['ns.mdn.io/last-backup-check'] = new Date().toISOString();
}
```

This ensures the decorator doesn't accidentally remove annotations added by:
- The CompositeController webhook
- Other operators (CSI driver, backup systems)
- Manual kubectl annotations

## REST API Integration Pattern

Based on your mention of having a utility container in another repo with REST API scripts, here's how to integrate:

### Example: Tenant Management REST API

```bash
# Your existing pattern
CONTROLLER_URL="https://ns-controller.example.com"

# Trigger migration via REST API
curl -X POST "${CONTROLLER_URL}/tenants/demo/migrate" \
  -H "Content-Type: application/json" \
  -d '{
    "source_uri_secret": "legacy-mongo-credentials",
    "method": "mongodump-restore-single-db"
  }'

# Update tier label
curl -X PATCH "${CONTROLLER_URL}/environs/demo/labels" \
  -d "ns.mdn.io/tier=premium"

# Restart instance
curl -X POST "${CONTROLLER_URL}/environs/demo/env/d" -d "d=1"

# List all premium tenants
curl "${CONTROLLER_URL}/tenants?label=ns.mdn.io/tier=premium"
```

The ns-utility container can be used in debug Pods to access these APIs:

```bash
kubectl run debug --rm -it \
  --image=ns-utility:latest \
  --env="CONTROLLER_URL=https://ns-controller.example.com" \
  -- debug-shell.sh

# Inside debug shell
curl "${CONTROLLER_URL}/tenants" | jq '.[] | select(.labels["ns.mdn.io/tier"] == "premium")'
```

## PVC Naming - Unique by Design

**Question:** "Do the volumeClaimTemplates and PVC need unique names?"

**Answer:** NO extra work needed - StatefulSet automatically creates unique PVCs:

```yaml
volumeClaimTemplates:
- metadata:
    name: data  # Template name
```

StatefulSet creates:
- `data-demo-mongo-0` (for pod demo-mongo-0)
- `data-demo-mongo-1` (for pod demo-mongo-1)
- `data-demo-mongo-2` (for pod demo-mongo-2)

Pattern: `{template-name}-{statefulset-name}-{ordinal}`

Since we use `{tenantId}-mongo` for StatefulSet names, PVCs are automatically unique per tenant.

## Migration: Separate Watch/Webhook?

**Question:** "Would it be better if migration was handled by a different watch/webhook?"

**Current Approach (Composite):**
- ✅ Single reconciliation loop
- ✅ Migration gated by MongoDB readiness
- ✅ Status tracking in one place
- ✅ Simpler architecture

**Alternative (Separate Controller):**
- 🤔 Watch ConfigMaps with `ns.mdn.io/migration-enabled=true`
- 🤔 Independent reconciliation
- ❌ More complex coordination
- ❌ Status tracking split across controllers

**Recommendation:** Keep in CompositeController
- Migration is lifecycle event (happens once)
- Benefits from readiness gates (wait for MongoDB)
- Status naturally fits with tenant status

If migrations become frequent or complex, then split into separate controller.

## File Organization

```
container-images/ns-utility/
├── Dockerfile              # Multi-stage build with mongo + kafka tools
├── build.sh               # Build script with registry push support
├── .dockerignore          # Exclude unnecessary files
├── README.md              # Complete usage guide (100+ examples)
└── scripts/
    ├── lib/               # Reusable libraries
    │   ├── common.sh      # Logging, retry, error handling
    │   ├── mongodb-utils.sh  # MongoDB operations
    │   └── kafka-utils.sh    # Kafka/CDC operations
    └── entrypoints/       # Executable scripts
        ├── init-replica-set.sh
        ├── migrate-database.sh
        ├── verify-tenant.sh
        └── debug-shell.sh
```

## Next Steps

1. **Build and test utility container:**
   ```bash
   cd container-images/ns-utility
   ./build.sh ns-utility v1.0.0
   ```

2. **Test scripts locally:**
   ```bash
   docker run --rm -e MONGO_HOST=localhost ns-utility:v1.0.0 verify-tenant.sh
   ```

3. **Push to registry:**
   ```bash
   REGISTRY=your-registry.io PUSH=true ./build.sh ns-utility v1.0.0
   ```

4. **Update tenant ConfigMaps:**
   ```yaml
   data:
     NS_UTILITY_IMAGE: "your-registry.io/ns-utility:v1.0.0"
   ```

5. **Add audit metadata to existing tenants:**
   ```yaml
   data:
     TENANT_EMAIL: "tenant@example.com"
     BACKUP_SCHEDULE: "daily"
     REGION: "us-west"
   ```

## Key Takeaways

✅ **Separation of Concerns**: Bash logic separate from JSON templating
✅ **Versioning**: Script changes tracked independently
✅ **Testability**: Scripts testable outside Kubernetes
✅ **Reusability**: Same utilities for init, migration, debug
✅ **Audit Trail**: Comprehensive metadata for data recovery
✅ **Passthrough**: Decorator preserves unmanaged annotations
✅ **REST API Ready**: Debug container integrates with your REST API
