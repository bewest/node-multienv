# Automated Database Migration

## Overview

The Metacontroller webhook now supports **automated database migration** for moving tenant data from legacy MongoDB clusters to dedicated per-tenant MongoDB instances. This eliminates the need for manual `mongodump`/`mongorestore` operations.

## How It Works

When you enable migration on a tenant ConfigMap:

1. **New MongoDB Created** - The webhook creates a dedicated MongoDB StatefulSet for the tenant
2. **Wait for Ready** - System waits for the new MongoDB to be fully ready
3. **Migration Job Launched** - Kubernetes Job automatically runs to copy data
4. **Status Tracked** - Migration status is monitored and reported
5. **Job Completes** - Once successful, the job is not re-rendered
6. **Auto-Cleanup** - Job is automatically deleted after 24 hours (configurable via TTL)

## ConfigMap Parameters

### Migration Configuration

Add these parameters to your tenant ConfigMap to enable migration:

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `MIGRATION_ENABLED` | Yes | `false` | Set to `"true"` to enable migration |
| `MIGRATION_SOURCE_URI` | Conditional | - | Source MongoDB connection URI (if not using secret) |
| `MIGRATION_SOURCE_SECRET` | Conditional | - | Secret name containing source URI (key: `uri`) |
| `MIGRATION_METHOD` | No | `mongodump-restore` | Migration method (see below) |
| `MIGRATION_IMAGE` | No | `mongo:6` | Docker image to use for migration job |
| `MIGRATION_SOURCE_DB` | No | `nightscout` | Source database name (for single-db method) |

**Note:** You must provide either `MIGRATION_SOURCE_URI` (plain text) OR `MIGRATION_SOURCE_SECRET` (recommended for production).

### Migration Methods

#### `mongodump-restore` (Default)
Full database dump and restore. Migrates all databases and collections from source.

```yaml
MIGRATION_METHOD: "mongodump-restore"
```

**Use when:**
- Source has multiple databases
- You want a complete copy of everything
- Source structure is unknown

#### `mongodump-restore-single-db`
Migrates a single specific database.

```yaml
MIGRATION_METHOD: "mongodump-restore-single-db"
MIGRATION_SOURCE_DB: "nightscout"
```

**Use when:**
- Source has a specific database name (e.g., `nightscout`, `cgm-data`)
- You want to rename the database during migration (source → `ns`)
- More precise control over what gets migrated

## Example Configurations

### Example 1: Basic Migration (Plain Text URI)

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: demo-config
  namespace: hosted-tenants
  labels:
    ns.mdn.io/enabled: "true"
    ns.mdn.io/migration-from: "legacy"
data:
  TENANT_ID: "demo"
  NS_IMAGE: "nightscout/cgm-remote-monitor:latest"
  MONGO_IMAGE: "mongo:6"
  MONGO_REPLICAS: "1"
  NS_REPLICAS: "2"
  
  # Migration settings
  MIGRATION_ENABLED: "true"
  MIGRATION_SOURCE_URI: "mongodb://legacy-cluster.default.svc:27017/tenant-demo"
  MIGRATION_METHOD: "mongodump-restore"
```

### Example 2: Secure Migration (Using Secret)

**Recommended for production!**

```yaml
---
# Create secret first
apiVersion: v1
kind: Secret
metadata:
  name: demo-legacy-creds
  namespace: hosted-tenants
type: Opaque
stringData:
  uri: "mongodb://admin:SecurePassword123@legacy-cluster.default.svc:27017/tenant-demo?authSource=admin"

---
# ConfigMap references the secret
apiVersion: v1
kind: ConfigMap
metadata:
  name: demo-config
  namespace: hosted-tenants
  labels:
    ns.mdn.io/enabled: "true"
data:
  TENANT_ID: "demo"
  NS_IMAGE: "nightscout/cgm-remote-monitor:latest"
  MONGO_IMAGE: "mongo:6"
  
  # Migration settings (secret-based)
  MIGRATION_ENABLED: "true"
  MIGRATION_SOURCE_SECRET: "demo-legacy-creds"
  MIGRATION_METHOD: "mongodump-restore"
```

### Example 3: Single Database Migration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: demo-config
  namespace: hosted-tenants
  labels:
    ns.mdn.io/enabled: "true"
data:
  TENANT_ID: "demo"
  NS_IMAGE: "nightscout/cgm-remote-monitor:latest"
  MONGO_IMAGE: "mongo:6"
  
  # Migration settings
  MIGRATION_ENABLED: "true"
  MIGRATION_SOURCE_SECRET: "legacy-mongo-creds"
  MIGRATION_METHOD: "mongodump-restore-single-db"
  MIGRATION_SOURCE_DB: "nightscout"  # Source database name
```

## Migration Workflow

### Step-by-Step Process

#### 1. Create Source Credentials Secret (Recommended)

```bash
kubectl create secret generic demo-legacy-creds \
  --from-literal=uri='mongodb://admin:password@legacy-host:27017/nightscout?authSource=admin' \
  -n hosted-tenants
```

#### 2. Create Tenant ConfigMap with Migration Enabled

```bash
kubectl apply -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: demo-config
  namespace: hosted-tenants
  labels:
    ns.mdn.io/enabled: "true"
data:
  TENANT_ID: "demo"
  MIGRATION_ENABLED: "true"
  MIGRATION_SOURCE_SECRET: "demo-legacy-creds"
  # ... other tenant parameters
EOF
```

#### 3. Monitor Migration Progress

```bash
# Watch migration job
kubectl get job demo-migration -n hosted-tenants -w

# Check job logs
kubectl logs job/demo-migration -n hosted-tenants

# Check migration status via webhook
kubectl get cm demo-config -n hosted-tenants -o yaml
```

#### 4. Verify Migration Completion

```bash
# Check if job completed successfully
kubectl get job demo-migration -n hosted-tenants

# Verify data in new MongoDB
kubectl exec -it demo-mongo-0 -n hosted-tenants -- mongosh --eval "
  use ns
  db.entries.countDocuments()
  db.treatments.countDocuments()
"
```

#### 5. Verify Completion (Automatic Tracking)

The webhook **automatically tracks** migration completion. Once the job succeeds, the status is persisted:

```bash
# Check migration status
kubectl get cm demo-config -n hosted-tenants -o jsonpath='{.status.migration}'
```

Expected output:
```json
{
  "complete": true,
  "completedAt": "2025-10-25T12:00:00Z",
  "status": "Complete"
}
```

The migration will **NOT re-run** even after the job is garbage-collected (24-hour TTL).

Optionally, disable migration entirely to reduce status checks:

```bash
kubectl patch cm demo-config -n hosted-tenants --type=merge -p '{"data":{"MIGRATION_ENABLED":"false"}}'
```

## Migration Status Tracking

The webhook reports migration status in the composite-sync response:

```json
{
  "status": {
    "mongo": {
      "ready": true
    },
    "migration": {
      "enabled": true,
      "status": "Running",
      "job": "demo-migration"
    }
  }
}
```

### Status Values

| Status | Description |
|--------|-------------|
| `Not Started` | Migration enabled but MongoDB not ready yet |
| `Pending` | Job created but not running yet |
| `Running` | Migration job actively copying data |
| `Complete` | Migration finished successfully |
| `Failed` | Migration job failed (check logs) |

## Monitoring Migration Jobs

### Check Job Status

```bash
# Get job status
kubectl get job -n hosted-tenants -l app.kubernetes.io/component=migration

# Describe job for details
kubectl describe job demo-migration -n hosted-tenants
```

### View Logs

```bash
# Real-time logs
kubectl logs -f job/demo-migration -n hosted-tenants

# Get logs from completed job
kubectl logs job/demo-migration -n hosted-tenants
```

### Check Pod Events

```bash
# Find migration pod
kubectl get pods -n hosted-tenants -l app.kubernetes.io/component=migration

# View pod events
kubectl describe pod demo-migration-xxxxx -n hosted-tenants
```

## Automatic Completion Tracking

**No manual action required!** The webhook automatically prevents re-runs.

### How It Works

When a migration job completes successfully:
1. Webhook detects the succeeded job
2. Sets `status.migration.complete: true` on the parent ConfigMap
3. Records completion timestamp in `status.migration.completedAt`
4. Future reconciliations skip job rendering even after TTL cleanup

### Verification

Check completion status:
```bash
kubectl get cm demo-config -n hosted-tenants -o jsonpath='{.status.migration}' | jq
```

Output:
```json
{
  "complete": true,
  "completedAt": "2025-10-25T12:00:00Z",
  "enabled": true,
  "status": "Complete",
  "job": "demo-migration",
  "instructions": "Migration complete and will not re-run (automatically tracked)."
}
```

### Manual Override (Advanced)

If you need to skip migration without running it, add this annotation:
```bash
kubectl annotate cm demo-config -n hosted-tenants \
  ns.mdn.io/migration-complete=true
```

This provides a manual override that the webhook also respects.

## Troubleshooting

### Migration Job Not Created

**Symptoms:** ConfigMap has `MIGRATION_ENABLED: "true"` but no Job appears

**Causes:**
1. MongoDB not ready yet
2. Migration already complete
3. Webhook server error

**Solutions:**
```bash
# Check MongoDB readiness
kubectl get statefulset demo-mongo -n hosted-tenants

# Check webhook logs
kubectl logs -n hosted-tenants deployment/webhook-server --tail=50

# Force reconciliation
kubectl annotate cm demo-config -n hosted-tenants force-sync="$(date +%s)" --overwrite
```

### Migration Job Failed

**Symptoms:** Job status shows `Failed` condition

**Common Causes:**

#### 1. Source URI Incorrect
```bash
# Check secret has correct URI
kubectl get secret demo-legacy-creds -n hosted-tenants -o jsonpath='{.data.uri}' | base64 -d
```

#### 2. Network Connectivity
```bash
# Test connectivity from pod
kubectl run -it --rm debug --image=mongo:6 -n hosted-tenants -- \
  mongosh "mongodb://legacy-host:27017" --eval "db.adminCommand('ping')"
```

#### 3. Authentication Failed
```bash
# Check credentials
kubectl logs job/demo-migration -n hosted-tenants | grep -i auth
```

#### 4. Insufficient Resources
```bash
# Check pod resources
kubectl describe pod -n hosted-tenants -l app.kubernetes.io/component=migration
```

### Migration Takes Too Long

**Default timeout:** 1 hour (`activeDeadlineSeconds: 3600`)

For large datasets, you may need to adjust the timeout by modifying the job timeout in `resources.js`:

```javascript
activeDeadlineSeconds: 7200,  // 2 hours
```

### Retry Failed Migration

To retry after a failure:

```bash
# 1. Delete failed job
kubectl delete job demo-migration -n hosted-tenants

# 2. Clear completion status if set
kubectl patch cm demo-config -n hosted-tenants --type=json \
  -p='[{"op": "remove", "path": "/status/migration/complete"}]' || true

# 3. Remove manual override annotation if present
kubectl annotate cm demo-config -n hosted-tenants \
  ns.mdn.io/migration-complete- || true

# 4. Force reconciliation
kubectl annotate cm demo-config -n hosted-tenants force-sync="$(date +%s)" --overwrite
```

### Skip Migration Without Running

To skip migration entirely without executing it:

```bash
# Option 1: Use manual annotation (simpler)
kubectl annotate cm demo-config -n hosted-tenants \
  ns.mdn.io/migration-complete=true

# Option 2: Disable migration
kubectl patch cm demo-config -n hosted-tenants --type=merge \
  -p '{"data":{"MIGRATION_ENABLED":"false"}}'
```

## Security Best Practices

### ✅ DO

1. **Use Secrets for Credentials**
   ```yaml
   MIGRATION_SOURCE_SECRET: "demo-legacy-creds"  # ✅ Good
   ```

2. **Use Strong Authentication**
   ```
   mongodb://user:StrongPassword123@host/db?authSource=admin
   ```

3. **Limit Secret Access**
   ```bash
   kubectl create rolebinding migration-secrets \
     --role=secret-reader \
     --serviceaccount=hosted-tenants:default
   ```

4. **Clean Up After Migration**
   ```bash
   # Delete migration secret after completion
   kubectl delete secret demo-legacy-creds -n hosted-tenants
   ```

### ❌ DON'T

1. **Don't Use Plain Text Passwords in ConfigMaps**
   ```yaml
   MIGRATION_SOURCE_URI: "mongodb://user:password@host/db"  # ❌ Bad
   ```

2. **Don't Leave Credentials Exposed**
   - Delete migration secrets after completion
   - Don't commit secrets to git

3. **Don't Run Multiple Migrations Simultaneously**
   - Migrate one tenant at a time to avoid resource contention

## Migration Job Resource Limits

Default resource allocation for migration jobs:

```yaml
resources:
  requests:
    cpu: 100m
    memory: 256Mi
  limits:
    cpu: 500m
    memory: 512Mi
```

For large databases, you may need to increase these limits in the webhook code.

## Complete Migration Example

```bash
# 1. Create namespace
kubectl create namespace hosted-tenants

# 2. Create legacy credentials secret
kubectl create secret generic legacy-creds \
  --from-literal=uri='mongodb://admin:SecurePass@legacy.default.svc:27017/tenant-demo?authSource=admin' \
  -n hosted-tenants

# 3. Create tenant with migration
kubectl apply -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: demo-config
  namespace: hosted-tenants
  labels:
    ns.mdn.io/enabled: "true"
    ns.mdn.io/tier: "basic"
data:
  TENANT_ID: "demo"
  NS_IMAGE: "nightscout/cgm-remote-monitor:latest"
  MONGO_IMAGE: "mongo:6"
  MONGO_REPLICAS: "1"
  NS_REPLICAS: "2"
  CDC_ENABLED: "true"
  MIGRATION_ENABLED: "true"
  MIGRATION_SOURCE_SECRET: "legacy-creds"
  MIGRATION_METHOD: "mongodump-restore"
EOF

# 4. Monitor migration
watch kubectl get job,pod -n hosted-tenants -l ns.mdn.io/tenant=demo

# 5. Check migration logs
kubectl logs -f job/demo-migration -n hosted-tenants

# 6. Verify data
kubectl exec demo-mongo-0 -n hosted-tenants -- mongosh --eval "
  use ns
  print('Entries:', db.entries.countDocuments())
  print('Treatments:', db.treatments.countDocuments())
"

# 7. Verify completion (automatic)
kubectl get cm demo-config -n hosted-tenants -o jsonpath='{.status.migration.complete}'
# Should output: true

# 8. Optionally disable migration to reduce status checks
kubectl patch cm demo-config -n hosted-tenants --type=merge -p '{"data":{"MIGRATION_ENABLED":"false"}}'

# 9. Clean up migration secret
kubectl delete secret legacy-creds -n hosted-tenants
```

## Integration with CDC

Migration works seamlessly with Change Data Capture:

1. **Migration runs first** - Data is copied to new MongoDB
2. **MongoDB becomes ready** - StatefulSet reports ready
3. **CDC connector created** - KafkaConnector starts capturing new changes
4. **No data loss** - All changes after migration are captured via CDC

## Limitations

1. **One-way migration** - No bidirectional sync
2. **Downtime recommended** - For data consistency, stop writes to source during migration
3. **No incremental sync** - Full dump/restore each time
4. **Same MongoDB version** - Source and target should use compatible versions

## Future Enhancements

Potential improvements for future versions:

- **Live migration** - Online migration with minimal downtime using oplog tailing
- **Incremental sync** - Resume interrupted migrations
- **Pre-flight validation** - Check connectivity and permissions before starting
- **Progress reporting** - Real-time migration progress updates
- **Rollback support** - Automatic rollback on failure

## Summary

Automated migration provides a safe, repeatable way to move tenants from legacy infrastructure to the new Metacontroller-managed platform. By leveraging Kubernetes Jobs and proper status tracking, the system ensures data is migrated reliably without manual intervention.
