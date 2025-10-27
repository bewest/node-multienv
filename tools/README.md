# Operational Tooling for Gen 4 Migration

## Overview

This directory contains bash scripts for operational management of the Nightscout multi-tenant platform, specifically for migrating from Gen 3b (shared MongoDB) to Gen 4 (two-composite architecture with dedicated MongoDB).

**Key Design Decision**: These tools use the **deployment-controller REST API** rather than direct `kubectl` commands. This provides:
- Consistent interface across generations
- Simplified operational workflows  
- Easy integration into migration pipelines
- Per-tenant rollback capability

## Prerequisites

```bash
# Install json CLI tool for parsing
npm install -g json

# Set environment variables
export CONTROLLER=http://multienv-deployment-controller:3000
export NAMESPACE=hosted-tenants
```

## Scripts

### tenant-operations.sh

**Purpose**: Core tenant operations using deployment-controller REST API

**Key Functions:**
```bash
# List all tenants
./tenant-operations.sh list-tenants

# List tenants with specific label
./tenant-operations.sh list-tenants 'ns.mdn.io/storage-type=shared'

# Check tenant config
./tenant-operations.sh check-config demo MONGODB_URI

# Apply label to ConfigMap
./tenant-operations.sh apply-label demo ns.mdn.io/tier premium

# Apply annotation to Secret (triggers migration)
./tenant-operations.sh apply-annotation storage-demo ns.mdn.io/migration-needed true

# Check Secret status from webhook
./tenant-operations.sh get-secret-status storage-demo

# Overall tenant health
./tenant-operations.sh tenant-health demo
```

**Common Workflows:**

#### List All Tenants Needing Migration
```bash
# Get tenants on shared MongoDB
./tenant-operations.sh list-secrets 'ns.mdn.io/storage-type=shared' > pending-migration.txt
```

#### Check Single Tenant Status
```bash
# Complete health check
./tenant-operations.sh tenant-health demo
```

Output:
```
=== Tenant Health Check: demo ===

ConfigMap exists: ✓
Storage Secret exists: ✓
Consul SRV records: 1 record(s)
Storage type: shared
```

---

### gen4-migration.sh

**Purpose**: Automated Gen 3b → Gen 4 migration workflows

**Migration Workflow:**
1. Create storage Secret with shared MongoDB credentials
2. Trigger migration by adding annotations
3. Storage webhook creates migration Job
4. Job copies data from shared → dedicated MongoDB
5. Validate migration completed successfully

**Key Functions:**

#### Single Tenant Migration
```bash
# Complete migration workflow (create + trigger + validate)
./gen4-migration.sh migrate-tenant demo
```

Output:
```
=== Migrating demo to Gen 4 ===

Creating storage Secret for demo...
✓ Storage Secret created for demo

Triggering migration for demo...
✓ Migration triggered for demo
  - Migration Job will be created by storage webhook
  - Check status with: ./gen4-migration.sh validate-migration demo

Waiting for migration to complete (timeout: 5 minutes)...
..........
✓ Migration COMPLETE for demo
✓ Storage Secret is Ready
```

#### Batch Migration
```bash
# Get list of tenants needing migration
./gen4-migration.sh list-pending > tenants.txt

# Migrate all tenants in batches
./gen4-migration.sh batch-migrate tenants.txt
```

Output:
```
=== Batch Migration: 10 tenants ===

[1/10] Migrating demo...
✓ Success: demo

[2/10] Migrating test...
✓ Success: test

...

=== Migration Summary ===
Total: 10
Success: 10
Failed: 0
```

#### Check Migration Progress
```bash
./gen4-migration.sh migration-progress
```

Output:
```
=== Gen 4 Migration Progress ===

Total tenants: 1300
Migrated: 325 (25%)
In progress: 25
Pending: 950
```

#### Rollback Failed Migration
```bash
# Rollback single tenant
./gen4-migration.sh rollback-tenant demo
```

Output:
```
Rolling back demo to shared MongoDB...
✓ Rollback complete for demo
  - Storage type reverted to 'shared'
  - Migration annotations removed
  - StatefulSet will be deleted by storage webhook
```

---

## Common Operational Patterns

### Pattern 1: Safe Batch Migration with Validation

```bash
#!/bin/bash
# Migrate tenants in small batches with validation between batches

BATCH_SIZE=10

# Get all pending tenants
./gen4-migration.sh list-pending > all-pending.txt

# Split into batches
split -l $BATCH_SIZE all-pending.txt batch-

# Migrate each batch
for batch in batch-*; do
  echo "Processing $batch..."
  
  # Migrate batch
  ./gen4-migration.sh batch-migrate "$batch"
  
  # Validate all succeeded
  if ./gen4-migration.sh batch-validate "$batch"; then
    echo "✓ Batch $batch successful"
    rm "$batch"
  else
    echo "✗ Batch $batch had failures - stopping"
    exit 1
  fi
  
  # Cooldown between batches
  sleep 30
done
```

### Pattern 2: Check Consul Registration After Migration

```bash
#!/bin/bash
# Verify Consul SRV records for migrated tenants

while IFS= read -r tenant; do
  echo "Checking $tenant..."
  
  # Check migration status
  if ./gen4-migration.sh validate-migration "$tenant"; then
    # Check Consul has exactly one record
    srv_count=$(./tenant-operations.sh check-srv "$tenant" | wc -l)
    
    if [ "$srv_count" -eq 1 ]; then
      echo "✓ $tenant: migrated + consul OK"
    else
      echo "⚠ $tenant: migrated but $srv_count Consul records (expected 1)"
    fi
  fi
done < migrated-tenants.txt
```

### Pattern 3: Dry-Run Migration Check

```bash
#!/bin/bash
# Check which tenants are ready for migration

while IFS= read -r tenant; do
  # Check ConfigMap has MONGODB_URI
  if ./tenant-operations.sh check-config "$tenant" MONGODB_URI; then
    # Check not already migrated
    if ! ./tenant-operations.sh is-migrated "$tenant" 2>/dev/null; then
      echo "$tenant - READY"
    else
      echo "$tenant - ALREADY MIGRATED"
    fi
  else
    echo "$tenant - MISSING CONFIG"
  fi
done < all-tenants.txt
```

### Pattern 4: Monitor Migration Jobs

```bash
#!/bin/bash
# Watch migration progress in real-time

watch -n 5 '
echo "=== Active Migration Jobs ==="
kubectl get jobs -n hosted-tenants -l job-type=migration --sort-by=.metadata.creationTimestamp

echo ""
echo "=== Migration Progress ==="
./gen4-migration.sh migration-progress
'
```

---

## REST API Endpoints Used

These scripts interact with the deployment-controller REST API:

### ConfigMap Endpoints
```
GET  /configmaps?labelSelector=...        List ConfigMaps
GET  /configmaps/:name                    Get ConfigMap
POST /configmaps/:name/metadata/labels/:key    Apply label
DELETE /configmaps/:name/metadata/labels/:key  Remove label
GET  /configmaps/:name/env/:field         Get config field
```

### Secret Endpoints (New in Gen 4)
```
GET  /secrets?labelSelector=...           List Secrets
GET  /secrets/:name                       Get Secret + status
POST /secrets/:name                       Create/update Secret
POST /secrets/:name/metadata/annotations/:key  Apply annotation
DELETE /secrets/:name/metadata/annotations/:key Remove annotation
GET  /secrets/:name/data/:field           Get credential field
```

See [k8s-deployment-controller.js](../k8s-deployment-controller.js) for full API reference.

---

## Integration with Two-Composite Architecture

### How Migration Works

1. **Create Storage Secret** (`create-storage`):
   ```bash
   POST /secrets/storage-demo
   {
     "labels": {
       "ns.mdn.io/composite": "storage",
       "storage.nightscout.org/account": "demo"
     },
     "annotations": {
       "ns.mdn.io/storage-type": "shared"
     }
   }
   ```
   → Storage webhook marks Secret as ready (no StatefulSet needed)

2. **Trigger Migration** (`trigger-migration`):
   ```bash
   POST /secrets/storage-demo/metadata/annotations/ns.mdn.io%2Fmigration-needed
   {"ns.mdn.io/migration-needed": "true"}
   
   POST /secrets/storage-demo/metadata/annotations/ns.mdn.io%2Fstorage-type
   {"ns.mdn.io/storage-type": "dedicated"}
   ```
   → Storage webhook renders migration Job

3. **Migration Job Runs**:
   - Job copies data from shared MongoDB to new dedicated StatefulSet
   - On success, adds annotation: `ns.mdn.io/migration-complete: true`

4. **Validation** (`validate-migration`):
   ```bash
   GET /secrets/storage-demo
   ```
   Check `status.conditions[?(@.type=="MigrationComplete")]`

### Rollback Safety

**Per-Tenant Rollback**:
```bash
./gen4-migration.sh rollback-tenant demo
```
→ Reverts annotations, storage webhook deletes StatefulSet, data survives in PVC

**Batch Rollback**:
```bash
./gen4-migration.sh batch-rollback failed-tenants.txt
```

---

## Troubleshooting

### Migration Job Fails

```bash
# Check Job logs
kubectl logs -n hosted-tenants job/demo-migration

# Check Secret annotations
./tenant-operations.sh get-secret storage-demo | json metadata.annotations

# Rollback and retry
./gen4-migration.sh rollback-tenant demo
sleep 10
./gen4-migration.sh migrate-tenant demo
```

### Consul Registration Missing

```bash
# Check SRV records
./tenant-operations.sh check-srv demo

# Should show exactly 1 record like:
# 0 100 1337 10.244.1.5.
```

### Secret Not Found

```bash
# List all storage Secrets
./tenant-operations.sh list-secrets

# Create manually if missing
./gen4-migration.sh create-storage demo
```

---

## See Also

- [TWO-COMPOSITE-ARCHITECTURE.md](../docs/TWO-COMPOSITE-ARCHITECTURE.md) - Gen 4 architecture overview
- [MIGRATION-FROM-LEGACY.md](../docs/MIGRATION-FROM-LEGACY.md) - Gen 3b → Gen 4 migration guide
- [openapi-gen4-metacontroller.yaml](../docs/openapi-gen4-metacontroller.yaml) - API specification
