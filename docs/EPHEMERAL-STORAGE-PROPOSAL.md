# Ephemeral MongoDB Storage Proposal

## Status: Draft Proposal

**Date:** 2026-01-10  
**Authors:** Nightscout Platform Team  
**Target:** Gen 5 Pod-Based Architecture  
**Related Docs:** [ARCHITECTURE-EVOLUTION.md](ARCHITECTURE-EVOLUTION.md), [KAFKA-CDC-INTEGRATION.md](KAFKA-CDC-INTEGRATION.md)

---

## Executive Summary

This proposal introduces an **ephemeral storage mode** for tenant MongoDB instances as an alternative to the current PVC-based persistent storage. Instead of fighting cloud provider volume limits per node, ephemeral mode makes tenant pods stateless by using:

1. **emptyDir volumes** for local MongoDB storage (no PVC required)
2. **Object storage snapshots** (S3/GCS) as the source of truth for hydration
3. **Kafka CDC** to stream changes to a central data warehouse for durability

This approach enables unlimited tenant density per node while accepting a 1-2 minute data loss window on pod crashes.

---

## Problem Statement

### Cloud Volume Limits Per Node

Cloud Kubernetes providers impose limits on the number of block volumes that can be attached to a single worker node:

| Provider | Volume Limit Per Node |
|----------|----------------------|
| AWS (EBS) | ~28 volumes |
| Azure (Managed Disks) | ~64 volumes |
| GKE | ~128 volumes |
| DigitalOcean | ~7 volumes |

With the current 1:1 PVC model (one PersistentVolumeClaim per tenant), this creates a hard ceiling on tenant density:

- **AWS cluster with 10 nodes**: Maximum ~280 tenants (accounting for system volumes)
- **Scaling requires**: Adding more nodes, even if CPU/memory is underutilized
- **Cost inefficiency**: Paying for node capacity that can't be used

### Current Architecture Constraints

The Gen 5 architecture uses colocated MongoDB + Nightscout pods with PersistentVolumeClaims:

```yaml
# Current: Each tenant requires a PVC
volumes:
  - name: data
    persistentVolumeClaim:
      claimName: ${tenantId}-mongodb-data
```

This works well for:
- ✅ Data durability (survives pod restarts)
- ✅ Provider portability (standard Kubernetes storage)
- ✅ Operational simplicity (no external dependencies)

But limits:
- ❌ Tenant density (blocked by volume limits)
- ❌ Provider flexibility (some providers have very low limits)
- ❌ Scaling economics (nodes underutilized)

---

## Why Ephemeral Storage Works for Nightscout

Nightscout's workload characteristics make ephemeral storage viable:

### 1. Small Database Size

| Tenant Age | Typical Database Size |
|------------|----------------------|
| 6 months | ~500MB |
| 1 year | ~1GB |
| 2+ years | ~2GB |

Most tenant databases remain under 2GB even after years of use.

### 2. Low Write Frequency

CGM (Continuous Glucose Monitor) data arrives every ~5 minutes:
- **Entries collection**: ~288 documents/day
- **Treatments collection**: Variable, typically <100/day
- **DeviceStatus collection**: Every 5 minutes

This low write rate means:
- Minimal data loss in crash scenarios (1-2 minutes of data)
- Low CDC bandwidth requirements
- Predictable oplog growth

### 3. Fast Hydration

With 2GB databases and modern storage:
- **Download from S3**: ~10-20 seconds (gigabit network)
- **mongorestore**: ~10-30 seconds
- **Total cold start**: ~30-60 seconds

### 4. Tolerant Use Case

Nightscout users understand their CGM data is already stored on the pump/sensor. A brief data gap is recoverable through pump upload or sensor sync.

---

## Proposed Architecture

### High-Level Overview

```
┌────────────────────────────────────────────────────────────────────────┐
│                           POD STARTUP                                  │
│                                                                        │
│   Object Storage ──────► Hydrate Init ──────► Ephemeral MongoDB       │
│   (S3/GCS snapshot)      Container           (emptyDir volume)        │
│                          (mongorestore)                                │
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│                           RUNTIME                                      │
│                                                                        │
│   Nightscout App ◄──────► Ephemeral MongoDB                           │
│                                  │                                     │
│                                  ▼                                     │
│                          Change Streams                                │
│                          (--replSet rs0)                               │
│                                  │                                     │
│                                  ▼                                     │
│                     Debezium MongoDB Connector                         │
│                          (KafkaConnector)                              │
│                                  │                                     │
│                                  ▼                                     │
│                          Kafka CDC Topic                               │
│                    (${tenantId}-entries, etc.)                         │
│                                  │                                     │
│                                  ▼                                     │
│                       Warehouse Consumer                               │
│                    (applies CDC to central store)                      │
│                                  │                                     │
│                                  ▼                                     │
│                       Central Data Warehouse                           │
│                    (MongoDB cluster / TimescaleDB)                     │
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│                     PERIODIC SNAPSHOT (CronJob)                        │
│                                                                        │
│   Ephemeral MongoDB ──────► mongodump ──────► Object Storage          │
│                              + gzip           (S3/GCS bucket)         │
│                                                                        │
│   Schedule: Every 6-24 hours (configurable per tenant)                 │
└────────────────────────────────────────────────────────────────────────┘
```

### Storage Mode Flag

Tenants opt into ephemeral mode via annotation or CRD spec field:

```yaml
# Option A: Annotation on tenant ConfigMap
metadata:
  annotations:
    ns.mdn.io/storage-mode: ephemeral  # or "persistent" (default)

# Option B: Spec field on NightscoutTenant CRD
spec:
  storageMode: ephemeral
  ephemeralConfig:
    snapshotBucket: s3://nightscout-snapshots
    snapshotSchedule: "0 */6 * * *"  # Every 6 hours
```

### Pod Spec Changes

**Persistent Mode (current):**
```yaml
volumes:
  - name: data
    persistentVolumeClaim:
      claimName: ${tenantId}-mongodb-data
```

**Ephemeral Mode (proposed):**
```yaml
initContainers:
  - name: hydrate-from-snapshot
    image: ${nsUtilityImage}
    command: ["/app/entrypoints/hydrate-from-snapshot.sh"]
    env:
      - name: SNAPSHOT_BUCKET
        value: "s3://nightscout-snapshots"
      - name: TENANT_ID
        value: "${tenantId}"
      - name: MONGO_DATA_DIR
        value: "/data/db"
    volumeMounts:
      - name: data
        mountPath: /data/db

volumes:
  - name: data
    emptyDir:
      sizeLimit: 5Gi  # Configurable per tier
```

---

## Startup Sequence (Ephemeral Mode)

### Phase 1: Hydration Init Container

```bash
#!/bin/bash
# hydrate-from-snapshot.sh

# 1. Check for existing snapshot
SNAPSHOT_KEY="${TENANT_ID}/latest.gz"
if ! aws s3 ls "s3://${SNAPSHOT_BUCKET}/${SNAPSHOT_KEY}" 2>/dev/null; then
  log_info "No snapshot found, starting with empty database"
  exit 0
fi

# 2. Download snapshot
log_info "Downloading snapshot from ${SNAPSHOT_BUCKET}"
aws s3 cp "s3://${SNAPSHOT_BUCKET}/${SNAPSHOT_KEY}" /tmp/snapshot.gz

# 3. Extract and restore
log_info "Restoring database from snapshot"
mongorestore --gzip --archive=/tmp/snapshot.gz --dir=/data/db

# 4. Cleanup
rm /tmp/snapshot.gz
log_info "Hydration complete"
```

### Phase 2: MongoDB Startup

MongoDB starts with replica set mode enabled (required for change streams):

```bash
mongod --replSet rs0 --bind_ip 127.0.0.1,$(POD_IP) --dbpath /data/db
```

### Phase 3: Replica Set Initialization

The existing `init-replica-set` Job handles single-node replica set initialization:

```bash
rs.initiate({
  _id: 'rs0',
  members: [{ _id: 0, host: '${POD_IP}:27017' }]
})
```

### Phase 4: CDC Connector Activation

The Compute Composite controller renders `KafkaConnector` when CDC is enabled:

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaConnector
metadata:
  name: ${tenantId}-mongodb-source
spec:
  class: io.debezium.connector.mongodb.MongoDbConnector
  config:
    mongodb.connection.string: "mongodb://${POD_IP}:27017"
    collection.include.list: "nightscout.entries,nightscout.treatments"
    topic.prefix: "${tenantId}"
    snapshot.mode: "never"  # Critical: Skip snapshot, start from oplog
```

**Key: `snapshot.mode: never`**

Because the database was restored from a snapshot:
- Historical data is already in the warehouse (that's where the snapshot came from)
- Connector should only capture new changes going forward
- No need for Debezium initial snapshot

### Phase 5: Consul Registration

Once MongoDB and Nightscout are ready, the pod registers with Consul:

```
${tenantId}.backends.service.consul
```

This matches the existing Gen 5 behavior.

---

## Data Durability Strategy

### Write Path (Runtime)

```
Nightscout → MongoDB (ephemeral) → Change Streams → Kafka → Warehouse Consumer → Central Store
```

**Latency:** Near real-time (seconds)

### Read Path (Pod Startup)

```
Central Store → Snapshot Export (periodic) → Object Storage → Hydration Init Container → MongoDB
```

**Staleness:** Up to snapshot interval (e.g., 6 hours of data from CDC would be missing)

### Crash Recovery

When a pod crashes:

1. **Pod restarts** (Metacontroller ensures pod recreation)
2. **Hydration runs** (restores from latest snapshot)
3. **CDC connector starts** (from current oplog position)
4. **Missing window:** Data between last snapshot and crash (max: snapshot interval)

**Mitigation:** Kafka topics retain CDC events. A recovery process could replay events from Kafka to backfill the missing window.

---

## Snapshot Strategy

### CronJob Approach (Recommended)

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ${tenantId}-snapshot
spec:
  schedule: "0 */6 * * *"  # Every 6 hours
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: snapshot
              image: ${nsUtilityImage}
              command: ["/app/entrypoints/snapshot-database.sh"]
              env:
                - name: TENANT_ID
                  value: "${tenantId}"
                - name: SNAPSHOT_BUCKET
                  value: "s3://nightscout-snapshots"
                - name: MONGODB_URI
                  valueFrom:
                    secretKeyRef:
                      name: ${tenantId}-app-credentials
                      key: MONGODB_URI
```

### Snapshot Script

```bash
#!/bin/bash
# snapshot-database.sh

# 1. Create mongodump
log_info "Creating database snapshot"
mongodump --uri="${MONGODB_URI}" --gzip --archive=/tmp/snapshot.gz

# 2. Upload to object storage with timestamp
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
aws s3 cp /tmp/snapshot.gz "s3://${SNAPSHOT_BUCKET}/${TENANT_ID}/${TIMESTAMP}.gz"

# 3. Update "latest" pointer
aws s3 cp /tmp/snapshot.gz "s3://${SNAPSHOT_BUCKET}/${TENANT_ID}/latest.gz"

# 4. Prune old snapshots (keep last 7 days)
aws s3 ls "s3://${SNAPSHOT_BUCKET}/${TENANT_ID}/" | while read -r line; do
  SNAPSHOT_DATE=$(echo "$line" | awk '{print $1}')
  if [[ $(date -d "$SNAPSHOT_DATE" +%s) -lt $(date -d "7 days ago" +%s) ]]; then
    KEY=$(echo "$line" | awk '{print $4}')
    aws s3 rm "s3://${SNAPSHOT_BUCKET}/${TENANT_ID}/${KEY}"
  fi
done

log_info "Snapshot complete: ${TIMESTAMP}.gz"
```

---

## Prerequisites and Dependencies

### 1. Kafka CDC Infrastructure

**Status:** Documented in [KAFKA-CDC-INTEGRATION.md](KAFKA-CDC-INTEGRATION.md), not fully tested in Gen 5

**Required:**
- Strimzi Operator installed
- Kafka cluster running
- KafkaConnect cluster with Debezium MongoDB connector
- Network connectivity from tenant namespace to Kafka

**Validation Needed:**
- [ ] Debezium MongoDB connector works with single-node replica set
- [ ] Change streams activate correctly after `rs.initiate()`
- [ ] `snapshot.mode: never` behaves as expected
- [ ] CDC events flow to Kafka topics
- [ ] Connector handles pod IP changes gracefully

### 2. Object Storage Integration

**Required:**
- S3-compatible bucket (AWS S3, MinIO, GCS with interop)
- IAM credentials for read/write access
- Pod service account with access (or injected credentials)

**Configuration:**
```yaml
# Platform-level Secret
apiVersion: v1
kind: Secret
metadata:
  name: snapshot-storage-credentials
data:
  AWS_ACCESS_KEY_ID: ...
  AWS_SECRET_ACCESS_KEY: ...
  AWS_REGION: ...
  SNAPSHOT_BUCKET: ...
```

### 3. Warehouse Consumer

**Not yet implemented.** Required to apply CDC events to central store.

**Design options:**
- Kafka Streams application
- Kafka Connect sink connector (to MongoDB/TimescaleDB)
- Custom consumer service

**Responsibilities:**
- Consume from `${tenantId}-*` topics
- Apply changes idempotently to warehouse
- Handle at-least-once delivery (deduplication)
- Export periodic snapshots to object storage

### 4. Utility Container Updates

**Required scripts:**
- `hydrate-from-snapshot.sh` - Download and restore from S3
- `snapshot-database.sh` - Dump and upload to S3
- Updates to `mongodb-utils.sh` for ephemeral-specific logic

---

## Comparison: Persistent vs Ephemeral Mode

| Aspect | Persistent (PVC) | Ephemeral (emptyDir + CDC) |
|--------|------------------|----------------------------|
| **Volume limits** | Constrained by provider | None (emptyDir is node-local) |
| **Data loss on crash** | None | 1-2 minutes (last CDC batch) |
| **Cold start time** | ~5 seconds | ~30-60 seconds (hydration) |
| **Infrastructure deps** | Standard K8s storage | Kafka cluster + object storage |
| **Ops burden** | Low (just PVCs) | Medium (Kafka + snapshots + warehouse) |
| **Cost** | PVC storage costs | Kafka + S3 costs |
| **Provider portability** | High | Medium (need S3-compatible storage) |
| **Tenant density** | Limited by node volume slots | Limited by CPU/memory only |
| **Backup strategy** | VolumeSnapshots | Inherent (warehouse is backup) |

### When to Use Each Mode

**Use Persistent (PVC) when:**
- Provider offers sufficient volume limits (e.g., GKE with 128/node)
- Zero data loss is required
- Simpler infrastructure is preferred
- Kafka cluster is not available

**Use Ephemeral when:**
- Volume limits are a scaling bottleneck
- Brief data loss is acceptable
- Kafka CDC is operational
- Maximum tenant density is needed
- Faster horizontal scaling is desired

---

## Implementation Phases

### Phase 0: Prerequisites (Current Blockers)

- [ ] Validate Kafka CDC works end-to-end in Gen 5
- [ ] Implement and deploy warehouse consumer
- [ ] Set up object storage bucket and IAM credentials
- [ ] Create utility container scripts for hydration/snapshot

### Phase 1: Hydration Infrastructure

- [ ] Implement `hydrate-from-snapshot.sh` entrypoint
- [ ] Add hydration init container to pod spec (conditional on storage mode)
- [ ] Test cold start with sample snapshot

### Phase 2: Snapshot CronJob

- [ ] Implement `snapshot-database.sh` entrypoint
- [ ] Add `renderSnapshotCronJob()` to resources.js
- [ ] Configure retention policy and pruning

### Phase 3: Storage Mode Flag

- [ ] Add `storageMode` annotation/spec field recognition
- [ ] Modify `renderMongoDB()` to conditionally use emptyDir vs PVC
- [ ] Add CDC auto-enable for ephemeral mode

### Phase 4: Integration Testing

- [ ] Test full lifecycle: create → hydrate → run → snapshot → delete → recreate
- [ ] Test crash recovery and data loss window
- [ ] Test CDC connector behavior on pod restart
- [ ] Validate Consul registration works identically

### Phase 5: Documentation and Rollout

- [ ] Update operational runbooks
- [ ] Create tenant migration guide (persistent → ephemeral)
- [ ] Gradual rollout to test tenants

---

## Open Questions

1. **Graceful shutdown snapshot?** Should we attempt a snapshot on pod termination (SIGTERM handler)?
   - Pro: Reduces data loss window
   - Con: Adds complexity, may timeout, node drain won't wait

2. **Snapshot trigger on low activity?** Trigger snapshot when write rate drops below threshold?
   - Pro: Captures more data before potential crash
   - Con: Additional complexity, may not help for sudden crashes

3. **Per-tenant vs shared warehouse?** Should each tenant have its own warehouse collection, or aggregate?
   - Per-tenant: Simpler isolation, matches current model
   - Shared: Easier cross-tenant analytics, single cluster to manage

4. **Fallback to persistent?** If Kafka/S3 becomes unavailable, should we auto-migrate tenants back to PVC?
   - Pro: Graceful degradation
   - Con: Complex, may create oscillation

5. **Hydration source preference?** Should hydration prefer Kafka replay over S3 snapshot when available?
   - Pro: Potentially faster, more up-to-date
   - Con: Kafka retention limits, more complex implementation

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Kafka cluster outage | Medium | High (data loss grows) | Multi-broker HA, monitor lag |
| S3 unavailable at startup | Low | High (pod can't start) | Retry with backoff, alert on failures |
| Snapshot corruption | Low | Medium (stale data) | Checksum validation, keep multiple snapshots |
| CDC connector lag | Medium | Low (brief gap) | Monitor lag metrics, auto-restart |
| Warehouse consumer failure | Medium | Medium (backlog grows) | Kafka retention, dead letter queue |
| Large database (>2GB) | Low | Medium (slow hydration) | Tier limits, compression, incremental restore |

---

## Conclusion

Ephemeral storage mode offers a viable path to overcoming cloud provider volume limits for Nightscout multitenancy. The trade-off (1-2 minute data loss window on crash) is acceptable given the workload characteristics and the recoverable nature of CGM data.

**Recommended next step:** Validate Kafka CDC end-to-end in Gen 5 colocated pod architecture before proceeding with implementation.

---

## Related Documentation

- [Architecture Evolution](ARCHITECTURE-EVOLUTION.md) - Gen 5 Pod-Based Architecture
- [Kafka CDC Integration](KAFKA-CDC-INTEGRATION.md) - CDC contract and configuration
- [Container Parameters](CONTAINER-PARAMETERS.md) - Environment variable reference
- [Two-Composite Architecture](TWO-COMPOSITE-ARCHITECTURE.md) - Storage vs Compute separation (Gen 4)
