# Ephemeral MongoDB Storage Proposal

## Status: Draft Proposal

**Date:** 2026-01-10 (Updated: Warehouse-First Hydration)  
**Authors:** Nightscout Platform Team  
**Target:** Gen 5 Pod-Based Architecture  
**Related Docs:** [ARCHITECTURE-EVOLUTION.md](ARCHITECTURE-EVOLUTION.md), [KAFKA-CDC-INTEGRATION.md](KAFKA-CDC-INTEGRATION.md)

---

## Executive Summary

This proposal introduces an **ephemeral storage mode** for tenant MongoDB instances as an alternative to the current PVC-based persistent storage. Instead of fighting cloud provider volume limits per node, ephemeral mode makes tenant pods stateless by using:

1. **emptyDir volumes** for local MongoDB storage (no PVC required)
2. **Kafka CDC** to stream changes to a central data warehouse for durability
3. **Warehouse export API** to hydrate pods on startup (no separate object storage needed)

This approach enables unlimited tenant density per node while accepting a 1-2 minute data loss window on pod crashes. The warehouse serves as both the durable store and the hydration source, eliminating the need for separate S3/GCS snapshots and CronJob infrastructure.

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

With 2GB databases and cluster-local warehouse:
- **Export from warehouse**: ~5-15 seconds (cluster network)
- **mongorestore**: ~10-30 seconds
- **Total cold start**: ~20-45 seconds

### 4. Tolerant Use Case

Nightscout users understand their CGM data is already stored on the pump/sensor. A brief data gap is recoverable through pump upload or sensor sync.

---

## Proposed Architecture

### High-Level Overview

```
┌────────────────────────────────────────────────────────────────────────┐
│                           POD STARTUP                                  │
│                                                                        │
│   Warehouse ──────────► Hydrate Init ──────► Ephemeral MongoDB        │
│   Export API           Container            (emptyDir volume)         │
│   (mongodump stream)   (mongorestore)                                 │
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
│                      (MongoDB cluster with                             │
│                       per-tenant collections)                          │
└────────────────────────────────────────────────────────────────────────┘
```

### Key Simplification: No Object Storage Required

Unlike the original proposal, this architecture uses the **warehouse as both the durability layer and the hydration source**:

| Original Approach | Warehouse-First Approach |
|-------------------|--------------------------|
| CDC → Warehouse (durability) | CDC → Warehouse (durability) |
| CronJob → S3 (snapshots) | ~~Not needed~~ |
| S3 → Init Container (hydration) | Warehouse → Init Container (hydration) |

This eliminates:
- ❌ S3/GCS bucket provisioning and IAM setup
- ❌ Per-tenant CronJob for periodic snapshots
- ❌ Snapshot retention management
- ❌ Object storage costs

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
  - name: hydrate-from-warehouse
    image: ${nsUtilityImage}
    command: ["/app/entrypoints/hydrate-from-warehouse.sh"]
    env:
      - name: WAREHOUSE_EXPORT_URL
        value: "http://warehouse-api.nightscout-system.svc.cluster.local"
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
# hydrate-from-warehouse.sh

# 1. Request export from warehouse API
log_info "Requesting database export from warehouse for tenant ${TENANT_ID}"
EXPORT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  "${WAREHOUSE_EXPORT_URL}/api/v1/tenants/${TENANT_ID}/export/status")

if [[ "$EXPORT_STATUS" == "404" ]]; then
  log_info "No data found in warehouse for tenant ${TENANT_ID}, starting with empty database"
  exit 0
fi

# 2. Stream export directly into mongorestore
log_info "Streaming database restore from warehouse"
curl -s "${WAREHOUSE_EXPORT_URL}/api/v1/tenants/${TENANT_ID}/export" | \
  mongorestore --gzip --archive --dir=/data/db

if [[ $? -ne 0 ]]; then
  log_error "Failed to restore from warehouse"
  exit 1
fi

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
    collection.include.list: "nightscout.entries,nightscout.treatments,nightscout.devicestatus"
    topic.prefix: "${tenantId}"
    snapshot.mode: "never"  # Critical: Skip snapshot, start from oplog
```

**Key: `snapshot.mode: never`**

Because the database was restored from the warehouse:
- Historical data is already in the warehouse (that's where hydration came from)
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
Nightscout → MongoDB (ephemeral) → Change Streams → Kafka → Warehouse Consumer → Warehouse
```

**Latency:** Near real-time (seconds)

### Read Path (Pod Startup)

```
Warehouse → Export API → Hydration Init Container → MongoDB (ephemeral)
```

**Freshness:** Real-time (warehouse contains all CDC events applied)

### Crash Recovery

When a pod crashes:

1. **Pod restarts** (Metacontroller ensures pod recreation)
2. **Hydration runs** (exports current state from warehouse)
3. **CDC connector starts** (from current oplog position)
4. **Data loss window:** Only data written between last CDC flush and crash (~1-2 minutes max)

**Key advantage over snapshot-based approach:** No staleness from snapshot age. The warehouse always has the latest CDC-applied state.

---

## Warehouse Consumer Contract

The warehouse consumer is the critical component that:
1. Applies CDC events to maintain canonical collections
2. Exposes an export API for hydration

### Required Capabilities

#### 1. CDC Event Application

The consumer must materialize **full MongoDB documents** (not just deltas) in per-tenant collections:

```javascript
// Warehouse schema: one database per tenant
// Database: nightscout_${tenantId}
// Collections: entries, treatments, devicestatus, etc.

// CDC event handling (pseudo-code)
function applyCDCEvent(event) {
  const { tenantId, collection, operation, document, documentKey } = event;
  const db = warehouse.db(`nightscout_${tenantId}`);
  
  switch (operation) {
    case 'insert':
    case 'update':
    case 'replace':
      db.collection(collection).replaceOne(
        { _id: documentKey._id },
        document,
        { upsert: true }
      );
      break;
    case 'delete':
      db.collection(collection).deleteOne({ _id: documentKey._id });
      break;
  }
}
```

#### 2. Export API

REST endpoint to stream `mongodump`-compatible archive:

```
GET /api/v1/tenants/{tenantId}/export
Content-Type: application/octet-stream

Response: gzipped mongodump archive stream
```

```
GET /api/v1/tenants/{tenantId}/export/status
Content-Type: application/json

Response: { "exists": true, "lastUpdated": "2026-01-10T12:00:00Z", "sizeBytes": 1048576 }
         or 404 if tenant has no data
```

#### 3. Implementation Options

| Option | Pros | Cons |
|--------|------|------|
| **MongoDB Warehouse + Custom API** | Native mongodump, simple export | Need separate API service |
| **Kafka Connect MongoDB Sink** | Standard connector, automatic | Need API wrapper for export |
| **Custom Kafka Streams App** | Full control | More code to maintain |

**Recommended:** MongoDB as warehouse backend with a lightweight Node.js API service that wraps `mongodump` for exports. This keeps the stack consistent (MongoDB everywhere) and uses proven tools.

### Warehouse API Service

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: warehouse-api
  namespace: nightscout-system
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: api
          image: ${warehouseApiImage}
          ports:
            - containerPort: 8080
          env:
            - name: WAREHOUSE_MONGODB_URI
              valueFrom:
                secretKeyRef:
                  name: warehouse-credentials
                  key: MONGODB_URI
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

### 2. Warehouse Consumer

**Not yet implemented.** This is the critical new component.

**Requirements:**
- Consume from `${tenantId}-*` Kafka topics
- Apply changes idempotently to warehouse MongoDB
- Handle at-least-once delivery (upsert pattern provides deduplication)
- Expose export API for hydration

**Suggested Implementation:**
- Kafka Connect MongoDB Sink connector for CDC → Warehouse
- Lightweight API service for export endpoint
- Or: Custom consumer service that does both

### 3. Warehouse MongoDB Cluster

**Required:**
- MongoDB cluster (can be small, just needs to store aggregate of all ephemeral tenants)
- Sizing: Sum of all ephemeral tenant databases + 20% overhead
- Example: 100 tenants × 1GB average = ~120GB storage

### 4. Utility Container Updates

**Required scripts:**
- `hydrate-from-warehouse.sh` - Stream restore from warehouse API
- Updates to `mongodb-utils.sh` for ephemeral-specific logic

**Not required (eliminated):**
- ~~`snapshot-database.sh`~~ - No periodic snapshots needed
- ~~CronJob rendering~~ - No snapshot jobs needed

---

## Comparison: Persistent vs Ephemeral Mode

| Aspect | Persistent (PVC) | Ephemeral (emptyDir + CDC) |
|--------|------------------|----------------------------|
| **Volume limits** | Constrained by provider | None (emptyDir is node-local) |
| **Data loss on crash** | None | 1-2 minutes (last CDC batch) |
| **Cold start time** | ~5 seconds | ~20-45 seconds (hydration) |
| **Infrastructure deps** | Standard K8s storage | Kafka cluster + warehouse |
| **Ops burden** | Low (just PVCs) | Medium (Kafka + warehouse consumer) |
| **Cost** | PVC storage costs | Kafka + warehouse MongoDB costs |
| **Provider portability** | High | High (no cloud-specific services) |
| **Tenant density** | Limited by node volume slots | Limited by CPU/memory only |
| **Backup strategy** | VolumeSnapshots | Inherent (warehouse is backup) |
| **Data freshness on restart** | N/A (same data) | Real-time (from warehouse) |

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
- [ ] Design and implement warehouse consumer
- [ ] Deploy warehouse MongoDB cluster
- [ ] Implement warehouse export API

### Phase 1: Warehouse Consumer

- [ ] Choose implementation (Kafka Connect sink vs custom consumer)
- [ ] Implement CDC event application logic
- [ ] Deploy to staging and validate data integrity
- [ ] Add monitoring for consumer lag and error rates

### Phase 2: Export API

- [ ] Implement `/api/v1/tenants/{tenantId}/export` endpoint
- [ ] Implement `/api/v1/tenants/{tenantId}/export/status` endpoint
- [ ] Add rate limiting for concurrent exports
- [ ] Test streaming restore with large databases

### Phase 3: Hydration Infrastructure

- [ ] Implement `hydrate-from-warehouse.sh` entrypoint
- [ ] Add hydration init container to pod spec (conditional on storage mode)
- [ ] Test cold start timing and reliability

### Phase 4: Storage Mode Flag

- [ ] Add `storageMode` annotation/spec field recognition
- [ ] Modify `renderMongoDB()` to conditionally use emptyDir vs PVC
- [ ] Add CDC auto-enable for ephemeral mode

### Phase 5: Integration Testing

- [ ] Test full lifecycle: create → hydrate → run → crash → restart
- [ ] Test concurrent restarts (rate limiting)
- [ ] Test CDC connector behavior on pod restart
- [ ] Validate Consul registration works identically
- [ ] Measure data loss window under various failure scenarios

### Phase 6: Documentation and Rollout

- [ ] Update operational runbooks
- [ ] Create tenant migration guide (persistent → ephemeral)
- [ ] Gradual rollout to test tenants

---

## Operational Considerations

### Rate Limiting for Mass Restarts

If a node fails and multiple ephemeral pods restart simultaneously, they'll all request warehouse exports at once. The export API should implement:

```javascript
// Rate limiting: max concurrent exports
const MAX_CONCURRENT_EXPORTS = 10;
const exportSemaphore = new Semaphore(MAX_CONCURRENT_EXPORTS);

app.get('/api/v1/tenants/:tenantId/export', async (req, res) => {
  if (!await exportSemaphore.tryAcquire(30000)) {  // 30s timeout
    return res.status(503).json({ error: 'Export queue full, retry later' });
  }
  try {
    await streamExport(req.params.tenantId, res);
  } finally {
    exportSemaphore.release();
  }
});
```

Init containers should retry with exponential backoff:

```bash
MAX_RETRIES=5
RETRY_DELAY=5

for i in $(seq 1 $MAX_RETRIES); do
  if curl -sf "${WAREHOUSE_EXPORT_URL}/api/v1/tenants/${TENANT_ID}/export" | \
     mongorestore --gzip --archive --dir=/data/db; then
    log_info "Hydration complete"
    exit 0
  fi
  log_warn "Hydration attempt $i failed, retrying in ${RETRY_DELAY}s"
  sleep $RETRY_DELAY
  RETRY_DELAY=$((RETRY_DELAY * 2))
done

log_error "Hydration failed after $MAX_RETRIES attempts"
exit 1
```

### Monitoring

Key metrics to track:

| Metric | Alert Threshold | Description |
|--------|-----------------|-------------|
| `warehouse_consumer_lag_seconds` | > 60s | CDC consumer falling behind |
| `warehouse_export_duration_seconds` | > 120s | Slow exports (large databases) |
| `warehouse_export_queue_size` | > 20 | Too many concurrent restart requests |
| `ephemeral_pod_hydration_failures` | > 0 | Init container failures |
| `cdc_connector_status` | != RUNNING | Debezium connector health |

### Fallback Behavior

If warehouse is unavailable during pod startup:

1. **Retry with backoff** (as shown above)
2. **After max retries**: Pod fails to start, Kubernetes restarts it
3. **Extended outage**: Operator intervention required

The warehouse should be deployed with HA (replica set + multiple API pods) to minimize this risk.

---

## Open Questions

1. **Warehouse retention policy?** How long to keep data for deleted tenants?
   - Recommendation: 30 days, then purge

2. **Per-tenant vs shared warehouse database?** 
   - Per-tenant databases: Simpler isolation, easier export (`mongodump --db=...`)
   - Shared database with tenant prefix: Single cluster, more complex queries
   - Recommendation: Per-tenant databases for simplicity

3. **Fallback to persistent?** If warehouse becomes unavailable, should we auto-migrate?
   - Recommendation: No auto-migration (too complex), rely on warehouse HA instead

4. **Graceful shutdown?** Should pods flush to warehouse on SIGTERM?
   - Recommendation: No, CDC provides this automatically with ~1-2min window

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Kafka cluster outage | Medium | High (data loss grows) | Multi-broker HA, monitor lag |
| Warehouse unavailable | Low | High (pods can't start) | HA deployment, retry with backoff |
| CDC connector lag | Medium | Low (brief gap) | Monitor lag metrics, auto-restart |
| Warehouse consumer failure | Medium | Medium (backlog grows) | Kafka retention (7 days), dead letter queue |
| Large database (>2GB) | Low | Medium (slow hydration) | Tier limits, compression |
| Concurrent mass restart | Low | Medium (export queue saturation) | Rate limiting, exponential backoff |

---

## Conclusion

The warehouse-first ephemeral storage approach offers a simpler path to overcoming cloud provider volume limits compared to the original S3-based proposal:

**Eliminated complexity:**
- No object storage (S3/GCS) provisioning
- No per-tenant CronJobs for snapshots
- No snapshot retention management
- No snapshot staleness (warehouse is always current)

**Added components:**
- Warehouse consumer (CDC → MongoDB)
- Warehouse export API (mongodump stream)

The trade-off (1-2 minute data loss window on crash) remains acceptable given Nightscout's workload characteristics.

**Recommended next steps:**
1. Validate Kafka CDC end-to-end in Gen 5 colocated pod architecture
2. Design and prototype warehouse consumer + export API
3. Test hydration timing with realistic database sizes

---

## Related Documentation

- [Architecture Evolution](ARCHITECTURE-EVOLUTION.md) - Gen 5 Pod-Based Architecture
- [Kafka CDC Integration](KAFKA-CDC-INTEGRATION.md) - CDC contract and configuration
- [Container Parameters](CONTAINER-PARAMETERS.md) - Environment variable reference
- [Two-Composite Architecture](TWO-COMPOSITE-ARCHITECTURE.md) - Storage vs Compute separation (Gen 4)
