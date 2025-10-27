# Gen 4 Migration Playbook

**Purpose**: Step-by-step operational guide for migrating 1300 tenants from Gen 3b (shared MongoDB) to Gen 4 (two-composite architecture with dedicated MongoDB).

**Audience**: Platform operators, DevOps engineers

**Prerequisites**:
- Deployment controller running at `$CONTROLLER` (e.g., `http://multienv-deployment-controller:3000`)
- `json` CLI tool installed (`npm install -g json`)
- Access to Kubernetes cluster
- Migration tools in `tools/` directory

---

## Migration Strategy

### The Two-Composite Architecture

Gen 4 separates storage from compute:

```
Storage Composite          Compute Composite
Secret → MongoDB          ConfigMap → Nightscout
      → Migration                  → CDC
```

**Migration Path**: Shared MongoDB (Gen 3b) → Dedicated MongoDB (Gen 4)

**Key Insight**: Use deployment-controller REST API for consistent, scriptable operations with per-tenant rollback capability.

---

## Phase 1: Pre-Migration Assessment

### Step 1.1: Identify Tenants Needing Migration

List all tenants currently on shared MongoDB:

```bash
# Using migration tool
./tools/gen4-migration.sh list-pending > tenants-to-migrate.txt

# Manual curl + json
curl -s $CONTROLLER/configmaps \
  | json -a response.body.items \
  | json -c 'this.data.MONGODB_URI && this.data.MONGODB_URI.includes("shared-mongodb")' \
  | json -a metadata.name > tenants-to-migrate.txt

# Count
wc -l tenants-to-migrate.txt
```

**Expected Output**:
```
1300 tenants-to-migrate.txt
```

### Step 1.2: Validate Tenant Health

Check a sample of tenants before migration:

```bash
# Check single tenant
./tools/tenant-operations.sh tenant-health demo

# Batch check
while IFS= read -r tenant; do
  echo "Checking $tenant..."
  
  # Verify ConfigMap exists
  if ! curl -s -f "$CONTROLLER/configmaps/$tenant" > /dev/null 2>&1; then
    echo "✗ ConfigMap missing: $tenant"
    continue
  fi
  
  # Verify MONGODB_URI is set
  if ! ./tools/tenant-operations.sh check-config "$tenant" MONGODB_URI > /dev/null 2>&1; then
    echo "✗ Missing MONGODB_URI: $tenant"
    continue
  fi
  
  # Verify Consul registration
  srv_count=$(./tools/tenant-operations.sh check-srv "$tenant" | wc -l)
  if [ "$srv_count" -eq 0 ]; then
    echo "⚠ No Consul registration: $tenant"
  fi
  
  echo "✓ $tenant ready for migration"
done < tenants-to-migrate.txt | tee pre-migration-health.log
```

### Step 1.3: Create Migration Plan

Determine batch sizes and timing:

```bash
# Calculate batches (10 tenants per batch, 1300 total = 130 batches)
BATCH_SIZE=10
TOTAL=$(wc -l < tenants-to-migrate.txt)
BATCHES=$(( (TOTAL + BATCH_SIZE - 1) / BATCH_SIZE ))

echo "Migration Plan:"
echo "  Total tenants: $TOTAL"
echo "  Batch size: $BATCH_SIZE"
echo "  Number of batches: $BATCHES"
echo "  Estimated time: $(( BATCHES * 6 )) minutes (assuming 5min per batch + 1min cooldown)"

# Split into batches
split -l $BATCH_SIZE tenants-to-migrate.txt batch-
ls batch-* | wc -l  # Should match $BATCHES
```

---

## Phase 2: Pilot Migration

**Goal**: Migrate 2-3 non-critical tenants to validate the process.

### Step 2.1: Select Pilot Tenants

```bash
# Pick test/staging tenants
echo "demo-test" > pilot-tenants.txt
echo "staging-001" >> pilot-tenants.txt
```

### Step 2.2: Manual Migration Walkthrough

**Migrate One Tenant Manually** to understand each step:

#### Create Storage Secret

```bash
TENANT=demo-test
MONGO_URI=$(curl -s "$CONTROLLER/configmaps/$TENANT/env/MONGODB_URI" | json)

# Extract MongoDB host from connection string
MONGO_HOST="${MONGO_URI#mongodb://}"
MONGO_HOST="${MONGO_HOST%%/*}"

# Create storage Secret
curl -s -X POST -H "Content-Type: application/json" \
  -d "{
    \"name\": \"storage-$TENANT\",
    \"labels\": {
      \"ns.mdn.io/composite\": \"storage\",
      \"storage.nightscout.org/account\": \"$TENANT\"
    },
    \"annotations\": {
      \"ns.mdn.io/storage-type\": \"shared\"
    },
    \"stringData\": {
      \"mongoHost\": \"$MONGO_HOST\",
      \"database\": \"nightscout\"
    }
  }" \
  "$CONTROLLER/secrets/storage-$TENANT" | json

# Verify creation
curl -s "$CONTROLLER/secrets/storage-$TENANT" | json metadata.name
```

**Expected**: Secret `storage-demo-test` created with `storage-type: shared`

#### Trigger Migration

```bash
# Add migration-needed annotation
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"ns.mdn.io/migration-needed":"true"}' \
  "$CONTROLLER/secrets/storage-$TENANT/metadata/annotations/ns.mdn.io%2Fmigration-needed" \
  | json

# Add migration source URI
curl -s -X POST -H "Content-Type: application/json" \
  -d "{\"ns.mdn.io/migration-source-uri\":\"$MONGO_URI\"}" \
  "$CONTROLLER/secrets/storage-$TENANT/metadata/annotations/ns.mdn.io%2Fmigration-source-uri" \
  | json

# Change storage type to dedicated (triggers StatefulSet + migration Job)
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"ns.mdn.io/storage-type":"dedicated"}' \
  "$CONTROLLER/secrets/storage-$TENANT/metadata/annotations/ns.mdn.io%2Fstorage-type" \
  | json

# Verify annotations
curl -s "$CONTROLLER/secrets/storage-$TENANT" \
  | json metadata.annotations
```

**Expected Output**:
```json
{
  "ns.mdn.io/composite": "storage",
  "ns.mdn.io/storage-type": "dedicated",
  "ns.mdn.io/migration-needed": "true",
  "ns.mdn.io/migration-source-uri": "mongodb://..."
}
```

#### Watch Migration Progress

```bash
# Watch migration Job
watch -n 5 "kubectl get job $TENANT-migration -n hosted-tenants"

# Check Job logs
kubectl logs -n hosted-tenants job/$TENANT-migration -f

# Check Secret status
watch -n 5 "curl -s $CONTROLLER/secrets/storage-$TENANT | json status"
```

**Expected**: Job runs, copies data, completes successfully.

#### Validate Migration

```bash
# Check migration-complete annotation
curl -s "$CONTROLLER/secrets/storage-$TENANT/metadata/annotations/ns.mdn.io%2Fmigration-complete" | json

# Should return: "true"

# Check Secret status
curl -s "$CONTROLLER/secrets/storage-$TENANT" | json status.conditions
```

**Expected Output**:
```json
[
  {
    "type": "Ready",
    "status": "True",
    "reason": "StatefulSetReady"
  },
  {
    "type": "MigrationComplete",
    "status": "True",
    "reason": "JobSucceeded"
  }
]
```

#### Verify Consul Registration

```bash
# Check SRV records
dig +short $TENANT.backends.service.consul SRV

# Should return exactly 1 record
```

### Step 2.3: Automated Pilot Migration

Use the migration script for remaining pilot tenants:

```bash
./tools/gen4-migration.sh batch-migrate pilot-tenants.txt
```

**Expected**: All pilot tenants migrate successfully.

### Step 2.4: Pilot Rollback Test

Test rollback capability:

```bash
TENANT=staging-001

# Rollback
./tools/gen4-migration.sh rollback-tenant $TENANT

# Verify reverted to shared
curl -s "$CONTROLLER/secrets/storage-$TENANT/metadata/annotations/ns.mdn.io%2Fstorage-type" | json
# Expected: "shared"

# StatefulSet should be deleted
kubectl get statefulset $TENANT-mongodb -n hosted-tenants
# Expected: NotFound

# Re-migrate
./tools/gen4-migration.sh migrate-tenant $TENANT
```

**Decision Point**: If pilot migrations succeed, proceed to Phase 3.

---

## Phase 3: Batch Migration (Production)

### Step 3.1: Batch Migration with Monitoring

Migrate in batches with validation between each batch:

```bash
#!/bin/bash
# Production batch migration script

BATCH_SIZE=10
LOG_DIR=migration-logs
mkdir -p $LOG_DIR

batch_num=0
for batch_file in batch-*; do
  batch_num=$((batch_num + 1))
  echo "=== Processing Batch $batch_num: $batch_file ==="
  
  # Migrate batch
  ./tools/gen4-migration.sh batch-migrate "$batch_file" \
    | tee "$LOG_DIR/batch-$batch_num.log"
  
  # Check exit code
  if [ $? -eq 0 ]; then
    echo "✓ Batch $batch_num successful"
    
    # Validate all tenants in batch
    ./tools/gen4-migration.sh batch-validate "$batch_file"
    
    # Archive batch file
    mv "$batch_file" "$LOG_DIR/$batch_file.completed"
  else
    echo "✗ Batch $batch_num had failures - pausing"
    
    # Extract failed tenants
    grep "✗ Failed:" "$LOG_DIR/batch-$batch_num.log" \
      | awk '{print $3}' > "$LOG_DIR/batch-$batch_num.failed"
    
    echo "Failed tenants saved to: $LOG_DIR/batch-$batch_num.failed"
    echo "Review logs and resume with: ./tools/gen4-migration.sh batch-migrate $batch_file"
    exit 1
  fi
  
  # Cooldown between batches
  sleep 60
  
  # Show overall progress
  ./tools/gen4-migration.sh migration-progress
done

echo "=== Migration Complete ==="
./tools/gen4-migration.sh migration-progress
```

### Step 3.2: Real-Time Monitoring

Monitor migration progress across multiple terminals:

**Terminal 1**: Batch migration script (above)

**Terminal 2**: Watch active migration Jobs
```bash
watch -n 5 'kubectl get jobs -n hosted-tenants -l job-type=migration --sort-by=.metadata.creationTimestamp'
```

**Terminal 3**: Monitor overall progress
```bash
watch -n 30 './tools/gen4-migration.sh migration-progress'
```

**Terminal 4**: Watch for failed Jobs
```bash
watch -n 10 "kubectl get jobs -n hosted-tenants -l job-type=migration --field-selector status.successful!=1 | grep -v Complete"
```

### Step 3.3: Handle Migration Failures

If a batch fails, investigate and retry:

```bash
FAILED_BATCH=batch-05

# Get failed tenants
grep "✗ Failed:" migration-logs/batch-05.log | awk '{print $3}' > retry-tenants.txt

# Investigate first failure
FAILED_TENANT=$(head -1 retry-tenants.txt)

# Check Job logs
kubectl logs -n hosted-tenants job/$FAILED_TENANT-migration

# Common issues:
#   - Timeout: Increase timeout, retry
#   - Network error: Check shared MongoDB connectivity, retry
#   - Disk space: Expand PVC, retry
#   - Data corruption: Rollback, fix source data, retry

# Rollback failed tenant
./tools/gen4-migration.sh rollback-tenant $FAILED_TENANT

# Fix issue (e.g., expand PVC)
kubectl patch pvc data-$FAILED_TENANT-mongodb-0 -n hosted-tenants \
  -p '{"spec":{"resources":{"requests":{"storage":"5Gi"}}}}'

# Retry
./tools/gen4-migration.sh migrate-tenant $FAILED_TENANT

# If successful, retry entire batch
./tools/gen4-migration.sh batch-migrate $FAILED_BATCH
```

---

## Phase 4: Post-Migration Validation

### Step 4.1: Verify All Migrations Complete

```bash
# Check overall status
./tools/gen4-migration.sh migration-progress
```

**Expected Output**:
```
=== Gen 4 Migration Progress ===

Total tenants: 1300
Migrated: 1300 (100%)
In progress: 0
Pending: 0
```

### Step 4.2: Validate Sample Tenants

```bash
# Random sample of 50 tenants
./tools/gen4-migration.sh list-migrated | shuf -n 50 > validation-sample.txt

# Validate each
while IFS= read -r tenant; do
  echo "Validating $tenant..."
  
  # Check migration complete
  ./tools/gen4-migration.sh validate-migration "$tenant" || {
    echo "✗ Migration validation failed: $tenant"
    continue
  }
  
  # Check StatefulSet exists
  kubectl get statefulset "$tenant-mongodb" -n hosted-tenants > /dev/null 2>&1 || {
    echo "✗ StatefulSet missing: $tenant"
    continue
  }
  
  # Check Consul registration
  srv_count=$(./tools/tenant-operations.sh check-srv "$tenant" | wc -l)
  if [ "$srv_count" -ne 1 ]; then
    echo "⚠ Unexpected Consul records ($srv_count): $tenant"
    continue
  fi
  
  # Check Secret status
  ready=$(curl -s "$CONTROLLER/secrets/storage-$tenant" \
    | json status.conditions \
    | json -c 'this.type=="Ready" && this.status=="True"' \
    | json -a type)
  
  if [ "$ready" != "Ready" ]; then
    echo "✗ Secret not ready: $tenant"
    continue
  fi
  
  echo "✓ $tenant validated"
done < validation-sample.txt
```

### Step 4.3: Check Consul Health

Ensure all migrated tenants are properly registered:

```bash
# Check Consul service count
consul catalog services -tags | grep backends | wc -l
# Should match total tenant count (1300)

# Check for duplicate registrations
while IFS= read -r tenant; do
  count=$(dig +short $tenant.backends.service.consul SRV | wc -l)
  if [ "$count" -ne 1 ]; then
    echo "⚠ $tenant has $count SRV records (expected 1)"
  fi
done < <(./tools/gen4-migration.sh list-migrated)
```

---

## Phase 5: Cleanup

### Step 5.1: Verify Shared MongoDB Can Be Decommissioned

```bash
# Ensure no tenants remain on shared MongoDB
remaining=$(./tools/gen4-migration.sh list-pending | wc -l)

if [ "$remaining" -eq 0 ]; then
  echo "✓ All tenants migrated - safe to decommission shared MongoDB"
else
  echo "⚠ $remaining tenants still on shared MongoDB"
  ./tools/gen4-migration.sh list-pending
fi
```

### Step 5.2: Archive Migration Logs

```bash
# Create archive
tar -czf migration-logs-$(date +%Y%m%d).tar.gz migration-logs/

# Upload to storage
# aws s3 cp migration-logs-*.tar.gz s3://nightscout-backups/migration-logs/
# Or your preferred storage
```

---

## Rollback Procedures

### Scenario 1: Single Tenant Issues Post-Migration

```bash
TENANT=problematic-tenant

# Rollback to shared MongoDB
./tools/gen4-migration.sh rollback-tenant $TENANT

# Verify rollback
curl -s "$CONTROLLER/secrets/storage-$TENANT/metadata/annotations/ns.mdn.io%2Fstorage-type" | json
# Expected: "shared"

# StatefulSet should be deleted
kubectl get statefulset $TENANT-mongodb -n hosted-tenants
# Expected: NotFound

# Tenant should continue working on shared MongoDB
```

### Scenario 2: Batch Rollback

```bash
# Rollback entire batch
./tools/gen4-migration.sh batch-rollback batch-05
```

### Scenario 3: Emergency Full Rollback

**ONLY IF CATASTROPHIC FAILURE** - Rollback all tenants:

```bash
# Get all migrated tenants
./tools/gen4-migration.sh list-migrated > all-migrated.txt

# Rollback in batches (avoid overwhelming API server)
split -l 50 all-migrated.txt rollback-batch-

for batch in rollback-batch-*; do
  echo "Rolling back $batch..."
  ./tools/gen4-migration.sh batch-rollback "$batch"
  sleep 30
done
```

---

## Troubleshooting

### Issue: Migration Job Hangs

**Symptoms**: Job stuck in Running state for >10 minutes

**Diagnosis**:
```bash
kubectl logs -n hosted-tenants job/$TENANT-migration -f
```

**Common Causes**:
- Network issues to shared MongoDB
- Large database (>10GB) taking time
- Resource limits (CPU/memory)

**Resolution**:
```bash
# Increase Job timeout
kubectl edit job $TENANT-migration -n hosted-tenants
# Set spec.activeDeadlineSeconds: 7200  (2 hours)

# Or delete and recreate with higher resources
kubectl delete job $TENANT-migration -n hosted-tenants
# Webhook will recreate automatically
```

### Issue: Secret Status Shows "Ready: False"

**Diagnosis**:
```bash
curl -s "$CONTROLLER/secrets/storage-$TENANT" | json status.conditions
```

**Common Causes**:
- StatefulSet pods not running
- PVC not bound
- Image pull errors

**Resolution**:
```bash
# Check StatefulSet status
kubectl get statefulset $TENANT-mongodb -n hosted-tenants -o yaml

# Check pod events
kubectl get pods -n hosted-tenants -l app=$TENANT-mongodb
kubectl describe pod $TENANT-mongodb-0 -n hosted-tenants

# Check PVC
kubectl get pvc -n hosted-tenants -l app=$TENANT-mongodb
```

### Issue: Duplicate Consul Registrations

**Symptoms**: `check-srv` returns multiple records

**Diagnosis**:
```bash
dig +short $TENANT.backends.service.consul SRV
```

**Resolution**:
```bash
# Deregister all instances
consul catalog services -tags | grep $TENANT
consul catalog deregister -id=<instance-id>

# Restart deployment-operator to re-register correctly
kubectl rollout restart deployment deployment-operator -n hosted-tenants
```

---

## Metrics and Reporting

### Daily Migration Report

```bash
#!/bin/bash
# Generate daily migration report

REPORT_DATE=$(date +%Y-%m-%d)
REPORT_FILE="migration-report-$REPORT_DATE.txt"

{
  echo "=== Gen 4 Migration Report ==="
  echo "Date: $REPORT_DATE"
  echo ""
  
  ./tools/gen4-migration.sh migration-progress
  echo ""
  
  echo "=== Active Migration Jobs ==="
  kubectl get jobs -n hosted-tenants -l job-type=migration --field-selector status.successful!=1
  echo ""
  
  echo "=== Failed Migrations (Last 24h) ==="
  kubectl get jobs -n hosted-tenants -l job-type=migration \
    --field-selector status.failed=1 \
    --sort-by=.status.startTime \
    | grep $(date -d '1 day ago' +%Y-%m-%d)
  
} | tee "$REPORT_FILE"

# Email report (optional)
# mail -s "Gen 4 Migration Report - $REPORT_DATE" ops@example.com < "$REPORT_FILE"
```

---

## Success Criteria

Migration is complete when:

- ✅ All 1300 tenants show `migration-complete: true` annotation
- ✅ All tenants have Ready status in Secret
- ✅ All tenants have exactly 1 Consul SRV record
- ✅ All StatefulSets are Running with 1/1 replicas
- ✅ No pending migrations remain
- ✅ Shared MongoDB can be safely decommissioned

**Final Validation**:
```bash
./tools/gen4-migration.sh migration-progress
# Expected: Total tenants: 1300, Migrated: 1300 (100%), Pending: 0
```

---

## See Also

- [tools/README.md](../tools/README.md) - Operational tooling reference
- [TWO-COMPOSITE-ARCHITECTURE.md](TWO-COMPOSITE-ARCHITECTURE.md) - Gen 4 architecture details
- [MIGRATION-FROM-LEGACY.md](MIGRATION-FROM-LEGACY.md) - Migration strategy overview
- [openapi-gen4-metacontroller.yaml](openapi-gen4-metacontroller.yaml) - API specification
