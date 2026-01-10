# Ephemeral MongoDB Storage Proposal

## Status: Draft Proposal

**Date:** 2026-01-10 (Updated: Strimzi-Native CDC Pipeline)  
**Authors:** Nightscout Platform Team  
**Target:** Gen 5 Pod-Based Architecture  
**Related Docs:** [ARCHITECTURE-EVOLUTION.md](ARCHITECTURE-EVOLUTION.md), [KAFKA-CDC-INTEGRATION.md](KAFKA-CDC-INTEGRATION.md)

---

## Executive Summary

This proposal introduces an **ephemeral storage mode** for tenant MongoDB instances as an alternative to the current PVC-based persistent storage. Instead of fighting cloud provider volume limits per node, ephemeral mode makes tenant pods stateless by using:

1. **emptyDir volumes** for local MongoDB storage (no PVC required)
2. **Strimzi Kafka CDC pipeline** to stream changes to a central data warehouse (no custom code)
3. **Warehouse export API** to hydrate pods on startup (minimal custom code)

This approach enables unlimited tenant density per node while accepting a 1-2 minute data loss window on pod crashes. The warehouse serves as both the durable store and the hydration source, eliminating the need for separate S3/GCS snapshots and CronJob infrastructure.

### Key Simplification

The CDC pipeline uses **Strimzi-managed connectors** exclusively—no custom JavaScript consumers required:

| Component | Implementation |
|-----------|----------------|
| CDC Source | Debezium MongoDB Source Connector (KafkaConnector CR) |
| CDC Sink | MongoDB Kafka Sink Connector (KafkaConnector CR) |
| Export API | Lightweight service wrapping `mongodump` (~150 lines) |
| Hydration | Init container shell script (~150 lines) |

**Total custom code:** ~300 lines (down from ~400 lines with custom consumer)

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
│                     Debezium MongoDB Source                            │
│                    (Strimzi KafkaConnector)                            │
│                                  │                                     │
│                                  ▼                                     │
│                          Kafka CDC Topics                              │
│                    (${tenantId}.nightscout.*)                          │
│                                  │                                     │
│                                  ▼                                     │
│                     MongoDB Kafka Sink Connector                       │
│                    (Strimzi KafkaConnector)                            │
│                                  │                                     │
│                                  ▼                                     │
│                       Central Data Warehouse                           │
│                      (MongoDB cluster with                             │
│                       per-tenant databases)                            │
└────────────────────────────────────────────────────────────────────────┘
```

### Key Design: Strimzi-Native Pipeline

The entire CDC pipeline is managed declaratively via Strimzi custom resources:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      STRIMZI-MANAGED CDC PIPELINE                           │
│                                                                             │
│  ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────────┐   │
│  │  Tenant Pods    │────►│  KafkaConnect   │────►│  Warehouse MongoDB  │   │
│  │  (Debezium Src) │     │  (MongoDB Sink) │     │  (per-tenant DBs)   │   │
│  └─────────────────┘     └─────────────────┘     └─────────────────────┘   │
│                                                            │                │
│  All managed via KafkaConnector CRs                        │                │
│  No custom consumer code required                          ▼                │
│                                                  ┌─────────────────────┐   │
│                                                  │  Warehouse Export   │   │
│                                                  │  API (custom)       │   │
│                                                  └─────────────────────┘   │
│                                                            │                │
└────────────────────────────────────────────────────────────┼────────────────┘
                                                             │
                                                             ▼
                                                  ┌─────────────────────┐
                                                  │  Tenant Pods        │
                                                  │  (hydration)        │
                                                  └─────────────────────┘
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

The init container fetches tenant data from the warehouse and restores it to the emptyDir volume.

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

### Phase 4: CDC Source Connector Activation

The Tenant Composite controller renders a `KafkaConnector` for the Debezium source:

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaConnector
metadata:
  name: ${tenantId}-mongodb-source
  labels:
    strimzi.io/cluster: cdc-connect-cluster
spec:
  class: io.debezium.connector.mongodb.MongoDbConnector
  tasksMax: 1
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
Nightscout → MongoDB (ephemeral) → Change Streams → Kafka → MongoDB Sink → Warehouse
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

## Strimzi CDC Pipeline Configuration

The CDC pipeline is entirely Strimzi-managed using KafkaConnect and KafkaConnector resources. No custom consumer code is required.

### KafkaConnect Cluster

A shared KafkaConnect cluster handles both source (Debezium) and sink (MongoDB) connectors:

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaConnect
metadata:
  name: cdc-connect-cluster
  namespace: kafka
  annotations:
    strimzi.io/use-connector-resources: "true"
spec:
  version: 3.6.1
  replicas: 3
  bootstrapServers: kafka-cluster-kafka-bootstrap:9092
  
  # Build image with both Debezium and MongoDB connectors
  build:
    output:
      type: docker
      image: registry.example.com/cdc-connect:latest
      pushSecret: registry-credentials
    plugins:
      # Debezium MongoDB Source Connector
      - name: debezium-mongodb
        artifacts:
          - type: maven
            group: io.debezium
            artifact: debezium-connector-mongodb
            version: 2.4.0.Final
      # MongoDB Kafka Sink Connector
      - name: mongodb-sink
        artifacts:
          - type: maven
            group: org.mongodb.kafka
            artifact: mongo-kafka-connect
            version: 1.13.0
  
  config:
    group.id: cdc-connect-cluster
    offset.storage.topic: cdc-connect-offsets
    offset.storage.replication.factor: 3
    config.storage.topic: cdc-connect-configs
    config.storage.replication.factor: 3
    status.storage.topic: cdc-connect-status
    status.storage.replication.factor: 3
    
    # Converters for CDC events
    key.converter: org.apache.kafka.connect.json.JsonConverter
    key.converter.schemas.enable: false
    value.converter: org.apache.kafka.connect.json.JsonConverter
    value.converter.schemas.enable: false
  
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 2000m
      memory: 2Gi
  
  jvmOptions:
    -Xms: 512m
    -Xmx: 1536m
  
  metricsConfig:
    type: jmxPrometheusExporter
    valueFrom:
      configMapKeyRef:
        name: connect-metrics-config
        key: metrics-config.yaml
```

### MongoDB Sink Connector (Warehouse Consumer)

A **single sink connector** handles all tenants using dynamic database routing:

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaConnector
metadata:
  name: warehouse-mongodb-sink
  namespace: kafka
  labels:
    strimzi.io/cluster: cdc-connect-cluster
spec:
  class: com.mongodb.kafka.connect.MongoSinkConnector
  tasksMax: 3
  config:
    # Subscribe to all tenant CDC topics
    topics.regex: ".*\\.nightscout\\.(entries|treatments|devicestatus)"
    
    # Warehouse MongoDB connection
    connection.uri: "${WAREHOUSE_MONGODB_URI}"
    
    # Dynamic database routing: extract tenant ID from topic prefix
    # Topic format: ${tenantId}.nightscout.${collection}
    # Routes to database: nightscout_${tenantId}
    namespace.mapper: com.mongodb.kafka.connect.sink.namespace.mapping.FieldPathNamespaceMapper
    namespace.mapper.value.database.field: ""
    namespace.mapper.key.database.regex: "^([^.]+)\\..*"
    namespace.mapper.key.database.replacement: "nightscout_$1"
    
    # Collection from topic suffix
    namespace.mapper.value.collection.field: ""
    namespace.mapper.key.collection.regex: ".*\\.nightscout\\.([^.]+)$"
    namespace.mapper.key.collection.replacement: "$1"
    
    # Write model: upsert based on document _id (idempotent)
    writemodel.strategy: com.mongodb.kafka.connect.sink.writemodel.strategy.ReplaceOneDefaultStrategy
    document.id.strategy: com.mongodb.kafka.connect.sink.processor.id.strategy.ProvidedInValueStrategy
    document.id.strategy.overwrite.existing: true
    
    # Handle Debezium CDC event format
    transforms: unwrap
    transforms.unwrap.type: io.debezium.transforms.ExtractNewRecordState
    transforms.unwrap.drop.tombstones: false
    transforms.unwrap.delete.handling.mode: drop
    
    # Error handling
    errors.tolerance: all
    errors.log.enable: true
    errors.log.include.messages: true
    errors.deadletterqueue.topic.name: cdc-dlq
    errors.deadletterqueue.topic.replication.factor: 3
    
    # Performance tuning
    max.num.retries: 3
    retries.defer.timeout: 5000
    max.batch.size: 100
```

### Alternative: Per-Tenant Sink Connectors

For finer control, render one sink connector per tenant:

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaConnector
metadata:
  name: ${tenantId}-warehouse-sink
  namespace: kafka
  labels:
    strimzi.io/cluster: cdc-connect-cluster
    ns.mdn.io/tenant-id: ${tenantId}
spec:
  class: com.mongodb.kafka.connect.MongoSinkConnector
  tasksMax: 1
  config:
    # Subscribe to this tenant's CDC topics only
    topics: "${tenantId}.nightscout.entries,${tenantId}.nightscout.treatments,${tenantId}.nightscout.devicestatus"
    
    # Fixed database for this tenant
    connection.uri: "${WAREHOUSE_MONGODB_URI}"
    database: "nightscout_${tenantId}"
    
    # Collection from topic suffix
    namespace.mapper.value.collection.field: ""
    namespace.mapper.key.collection.regex: ".*\\.([^.]+)$"
    namespace.mapper.key.collection.replacement: "$1"
    
    # Same write model and transforms as shared connector
    writemodel.strategy: com.mongodb.kafka.connect.sink.writemodel.strategy.ReplaceOneDefaultStrategy
    transforms: unwrap
    transforms.unwrap.type: io.debezium.transforms.ExtractNewRecordState
```

**Trade-offs:**

| Approach | Pros | Cons |
|----------|------|------|
| **Single shared sink** | One connector to manage, simpler ops | Regex routing complexity, harder to debug per-tenant |
| **Per-tenant sinks** | Easier debugging, isolated failures | Many connectors (1 per tenant), more resource overhead |

**Recommendation:** Start with shared sink, consider per-tenant if isolation needed.

### Debezium CDC Event Format

Debezium MongoDB connector produces events in this format:

```json
{
  "schema": { ... },
  "payload": {
    "before": null,
    "after": "{\"_id\": {\"$oid\": \"...\"}, \"sgv\": 120, \"date\": 1704844800000, ...}",
    "source": {
      "version": "2.4.0.Final",
      "connector": "mongodb",
      "name": "tenant123",
      "ts_ms": 1704844800000,
      "db": "nightscout",
      "collection": "entries"
    },
    "op": "c",
    "ts_ms": 1704844800123
  }
}
```

The `ExtractNewRecordState` transform unwraps this to just the document for the sink connector.

---

## Warehouse Export API

The export API streams tenant data as mongodump-compatible archives for pod hydration. This is the only custom code required.

### API Endpoints

#### GET /api/v1/tenants/{tenantId}/export

Stream a gzipped mongodump archive of the tenant's database.

**Request:**
```http
GET /api/v1/tenants/demo-tenant/export HTTP/1.1
Host: warehouse-api.nightscout-system.svc.cluster.local
Accept: application/octet-stream
```

**Response (success):**
```http
HTTP/1.1 200 OK
Content-Type: application/octet-stream
Content-Disposition: attachment; filename="demo-tenant.archive.gz"
X-Warehouse-Export-Size: 1048576
X-Warehouse-Export-Collections: entries,treatments,devicestatus
Transfer-Encoding: chunked

<binary mongodump archive data>
```

**Response (no data):**
```http
HTTP/1.1 404 Not Found
Content-Type: application/json

{
  "error": "tenant_not_found",
  "message": "No data exists for tenant demo-tenant"
}
```

**Response (rate limited):**
```http
HTTP/1.1 503 Service Unavailable
Content-Type: application/json
Retry-After: 30

{
  "error": "rate_limited",
  "message": "Export queue full, retry after 30 seconds"
}
```

#### GET /api/v1/tenants/{tenantId}/export/status

Check if tenant data exists and get metadata.

**Response (exists):**
```json
{
  "exists": true,
  "tenantId": "demo-tenant",
  "database": "nightscout_demo-tenant",
  "collections": {
    "entries": { "count": 52560, "sizeBytes": 15728640 },
    "treatments": { "count": 1250, "sizeBytes": 524288 },
    "devicestatus": { "count": 8760, "sizeBytes": 3145728 }
  },
  "totalSizeBytes": 19398656,
  "estimatedExportDuration": "15s"
}
```

### Export API Implementation

```javascript
// warehouse-api/src/server.js
'use strict';

const restify = require('restify');
const { MongoClient } = require('mongodb');
const { spawn } = require('child_process');
const bunyan = require('bunyan');

const log = bunyan.createLogger({ name: 'warehouse-api' });

const MAX_CONCURRENT_EXPORTS = parseInt(process.env.MAX_CONCURRENT_EXPORTS || '10', 10);
const EXPORT_TIMEOUT_MS = parseInt(process.env.EXPORT_TIMEOUT_MS || '300000', 10);

let mongoClient = null;
let activeExports = 0;

async function connectMongo() {
  const uri = process.env.WAREHOUSE_MONGODB_URI;
  mongoClient = await MongoClient.connect(uri, {
    maxPoolSize: 20,
    serverSelectionTimeoutMS: 5000,
  });
  log.info('Connected to warehouse MongoDB');
}

async function getTenantStats(tenantId) {
  const dbName = `nightscout_${tenantId}`;
  const db = mongoClient.db(dbName);
  
  const collections = await db.listCollections().toArray();
  if (collections.length === 0) {
    return null;
  }

  const stats = {
    exists: true,
    tenantId,
    database: dbName,
    collections: {},
    totalSizeBytes: 0,
  };

  for (const coll of collections) {
    const collStats = await db.command({ collStats: coll.name });
    stats.collections[coll.name] = {
      count: collStats.count,
      sizeBytes: collStats.size,
    };
    stats.totalSizeBytes += collStats.size;
  }

  const estimatedSeconds = Math.ceil(stats.totalSizeBytes / (1024 * 1024));
  stats.estimatedExportDuration = `${Math.max(5, estimatedSeconds)}s`;

  return stats;
}

async function streamExport(tenantId, res) {
  const dbName = `nightscout_${tenantId}`;
  const mongoUri = process.env.WAREHOUSE_MONGODB_URI;

  const mongodump = spawn('mongodump', [
    `--uri=${mongoUri}`,
    `--db=${dbName}`,
    '--archive',
    '--gzip',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let bytesWritten = 0;

  mongodump.stdout.on('data', (chunk) => {
    bytesWritten += chunk.length;
    res.write(chunk);
  });

  mongodump.stderr.on('data', (data) => {
    log.debug({ tenantId, stderr: data.toString() }, 'mongodump stderr');
  });

  return new Promise((resolve, reject) => {
    mongodump.on('close', (code) => {
      if (code === 0) {
        log.info({ tenantId, bytesWritten }, 'Export completed');
        res.end();
        resolve();
      } else {
        reject(new Error(`mongodump exited with code ${code}`));
      }
    });
    mongodump.on('error', reject);
  });
}

function createServer() {
  const server = restify.createServer({ name: 'warehouse-api', log });

  server.use(restify.plugins.queryParser());

  server.get('/healthz', async (req, res, next) => {
    try {
      await mongoClient.db().admin().ping();
      res.json({ status: 'healthy', activeExports, maxConcurrentExports: MAX_CONCURRENT_EXPORTS });
    } catch (err) {
      res.status(503);
      res.json({ status: 'unhealthy', error: err.message });
    }
    next();
  });

  server.get('/api/v1/tenants/:tenantId/export/status', async (req, res, next) => {
    try {
      const stats = await getTenantStats(req.params.tenantId);
      if (stats) {
        res.json(stats);
      } else {
        res.status(404);
        res.json({ exists: false, tenantId: req.params.tenantId });
      }
    } catch (err) {
      log.error({ err }, 'Failed to get tenant stats');
      res.status(500);
      res.json({ error: 'internal_error', message: err.message });
    }
    next();
  });

  server.get('/api/v1/tenants/:tenantId/export', async (req, res, next) => {
    const tenantId = req.params.tenantId;
    
    const stats = await getTenantStats(tenantId);
    if (!stats) {
      res.status(404);
      res.json({ error: 'tenant_not_found', message: `No data for tenant ${tenantId}` });
      return next();
    }

    if (activeExports >= MAX_CONCURRENT_EXPORTS) {
      res.status(503);
      res.header('Retry-After', '30');
      res.json({ error: 'rate_limited', message: 'Export queue full' });
      return next();
    }

    activeExports++;
    try {
      res.header('Content-Type', 'application/octet-stream');
      res.header('Content-Disposition', `attachment; filename="${tenantId}.archive.gz"`);
      res.header('Transfer-Encoding', 'chunked');
      await streamExport(tenantId, res);
    } catch (err) {
      log.error({ err, tenantId }, 'Export failed');
      res.end();
    } finally {
      activeExports--;
    }
    next();
  });

  return server;
}

async function main() {
  await connectMongo();
  const server = createServer();
  const port = parseInt(process.env.PORT || '8080', 10);
  server.listen(port, () => log.info({ port }, 'Warehouse API listening'));
}

main().catch((err) => {
  log.fatal({ err }, 'Server failed');
  process.exit(1);
});
```

### Export API Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: warehouse-api
  namespace: nightscout-system
spec:
  replicas: 2
  selector:
    matchLabels:
      app: warehouse-api
  template:
    metadata:
      labels:
        app: warehouse-api
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
            - name: MAX_CONCURRENT_EXPORTS
              value: "10"
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: warehouse-api
  namespace: nightscout-system
spec:
  selector:
    app: warehouse-api
  ports:
    - port: 80
      targetPort: 8080
```

---

## Hydration Init Container

### Full Script with Error Handling

```bash
#!/bin/bash
# hydrate-from-warehouse.sh

set -euo pipefail

log_info() { echo "[$(date -Iseconds)] INFO: $*"; }
log_warn() { echo "[$(date -Iseconds)] WARN: $*" >&2; }
log_error() { echo "[$(date -Iseconds)] ERROR: $*" >&2; }

WAREHOUSE_EXPORT_URL="${WAREHOUSE_EXPORT_URL:?required}"
TENANT_ID="${TENANT_ID:?required}"
MONGO_DATA_DIR="${MONGO_DATA_DIR:-/data/db}"
MAX_RETRIES="${MAX_RETRIES:-5}"
INITIAL_RETRY_DELAY="${INITIAL_RETRY_DELAY:-5}"
MAX_RETRY_DELAY="${MAX_RETRY_DELAY:-60}"
HYDRATION_TIMEOUT="${HYDRATION_TIMEOUT:-300}"

STATUS_URL="${WAREHOUSE_EXPORT_URL}/api/v1/tenants/${TENANT_ID}/export/status"
EXPORT_URL="${WAREHOUSE_EXPORT_URL}/api/v1/tenants/${TENANT_ID}/export"

log_info "Starting hydration for tenant: ${TENANT_ID}"

mkdir -p "${MONGO_DATA_DIR}"
rm -rf "${MONGO_DATA_DIR:?}"/*

check_tenant_exists() {
  curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 30 "${STATUS_URL}"
}

do_hydration() {
  log_info "Streaming database restore from warehouse..."
  curl -sf --connect-timeout 30 --max-time "${HYDRATION_TIMEOUT}" "${EXPORT_URL}" | \
    mongorestore --gzip --archive --drop --dir="${MONGO_DATA_DIR}" --quiet
}

main() {
  local retry_delay="${INITIAL_RETRY_DELAY}"
  local attempt=1
  
  while [ "${attempt}" -le "${MAX_RETRIES}" ]; do
    log_info "Hydration attempt ${attempt}/${MAX_RETRIES}"
    
    local status_code
    status_code=$(check_tenant_exists)
    
    case "${status_code}" in
      200)
        log_info "Tenant data found, hydrating..."
        if do_hydration && [ "$(ls -A ${MONGO_DATA_DIR})" ]; then
          log_info "Hydration completed successfully"
          exit 0
        fi
        log_warn "Hydration failed, retrying..."
        ;;
      404)
        log_info "No data in warehouse for tenant ${TENANT_ID}, starting empty"
        exit 0
        ;;
      503)
        log_warn "Warehouse rate limited, retrying..."
        ;;
      *)
        log_warn "Unexpected status: ${status_code}, retrying..."
        ;;
    esac
    
    if [ "${attempt}" -lt "${MAX_RETRIES}" ]; then
      log_info "Waiting ${retry_delay}s..."
      sleep "${retry_delay}"
      retry_delay=$((retry_delay * 2 > MAX_RETRY_DELAY ? MAX_RETRY_DELAY : retry_delay * 2))
    fi
    
    attempt=$((attempt + 1))
  done
  
  log_error "Hydration failed after ${MAX_RETRIES} attempts"
  exit 1
}

main
```

### Init Container Manifest

```yaml
initContainers:
  - name: hydrate-from-warehouse
    image: ${nsUtilityImage}
    command: ["/bin/bash", "/app/entrypoints/hydrate-from-warehouse.sh"]
    env:
      - name: WAREHOUSE_EXPORT_URL
        value: "http://warehouse-api.nightscout-system.svc.cluster.local"
      - name: TENANT_ID
        valueFrom:
          fieldRef:
            fieldPath: metadata.labels['ns.mdn.io/tenant-id']
      - name: MONGO_DATA_DIR
        value: "/data/db"
    resources:
      requests:
        cpu: 100m
        memory: 256Mi
      limits:
        cpu: 500m
        memory: 512Mi
    volumeMounts:
      - name: data
        mountPath: /data/db
```

---

## Prerequisites and Dependencies

### 1. Kafka CDC Infrastructure

**Required:**
- Strimzi Operator installed
- Kafka cluster running (3+ brokers recommended)
- KafkaConnect cluster with Debezium + MongoDB connectors

**Validation Needed:**
- [ ] Debezium MongoDB connector works with single-node replica set
- [ ] MongoDB Sink Connector routes to correct tenant databases
- [ ] `ExtractNewRecordState` transform works correctly
- [ ] CDC events flow end-to-end

### 2. Warehouse MongoDB Cluster

**Required:**
- MongoDB cluster for warehouse storage
- Sizing: Sum of all ephemeral tenant databases + 20% overhead
- Example: 100 tenants × 1GB average = ~120GB storage

### 3. Warehouse Export API

**Required:**
- Simple Node.js service wrapping `mongodump`
- Deployed in `nightscout-system` namespace

### 4. Utility Container Updates

**Required scripts:**
- `hydrate-from-warehouse.sh` - Stream restore from warehouse API

---

## Comparison: Persistent vs Ephemeral Mode

| Aspect | Persistent (PVC) | Ephemeral (emptyDir + CDC) |
|--------|------------------|----------------------------|
| **Volume limits** | Constrained by provider | None (emptyDir is node-local) |
| **Data loss on crash** | None | 1-2 minutes (last CDC batch) |
| **Cold start time** | ~5 seconds | ~20-45 seconds (hydration) |
| **Infrastructure deps** | Standard K8s storage | Kafka + Strimzi + warehouse |
| **Custom code** | None | ~300 lines (export API + script) |
| **Tenant density** | Limited by node volume slots | Limited by CPU/memory only |

---

## Implementation Phases

### Phase 0: Prerequisites

- [ ] Deploy Strimzi Operator and Kafka cluster
- [ ] Deploy KafkaConnect with Debezium + MongoDB connectors
- [ ] Deploy warehouse MongoDB cluster
- [ ] Validate CDC pipeline end-to-end with test tenant

### Phase 1: Sink Connector

- [ ] Configure MongoDB Sink Connector for warehouse
- [ ] Test dynamic database routing (per-tenant databases)
- [ ] Validate idempotent upsert behavior
- [ ] Add monitoring for connector lag

### Phase 2: Export API

- [ ] Implement `/api/v1/tenants/{tenantId}/export` endpoint
- [ ] Implement rate limiting
- [ ] Deploy to `nightscout-system` namespace
- [ ] Test streaming restore with realistic databases

### Phase 3: Hydration Infrastructure

- [ ] Implement `hydrate-from-warehouse.sh`
- [ ] Add init container to pod spec (conditional on storage mode)
- [ ] Test cold start timing and reliability

### Phase 4: Storage Mode Integration

- [ ] Add `storageMode` annotation recognition
- [ ] Modify `renderMongoDB()` to use emptyDir vs PVC
- [ ] Auto-render source connector for ephemeral tenants

### Phase 5: Testing

- [ ] Full lifecycle: create → hydrate → run → crash → restart
- [ ] Concurrent restarts with rate limiting
- [ ] CDC connector behavior on pod IP changes
- [ ] Data loss window measurement

---

## Operational Runbook

### Monitoring

| Metric | Alert Threshold | Description |
|--------|-----------------|-------------|
| `kafka_connect_sink_task_offset_commit_completion_rate` | < 0.9 | Sink connector falling behind |
| `warehouse_api_active_exports` | = MAX | Export queue saturated |
| `pod_init_container_restarts` | > 0 | Hydration failures |

### Troubleshooting

**Pod stuck in Init:**
```bash
kubectl logs ${POD} -c hydrate-from-warehouse
kubectl exec -n nightscout-system deploy/warehouse-api -- curl localhost:8080/healthz
```

**Sink connector lag:**
```bash
kubectl get kafkaconnector warehouse-mongodb-sink -o yaml
kubectl logs -n kafka deploy/cdc-connect-cluster-connect | grep -i error
```

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Kafka outage | Medium | High | Multi-broker HA, 7-day retention |
| Warehouse unavailable | Low | High | HA deployment, retry backoff |
| Sink connector failure | Medium | Medium | Error tolerance, DLQ |
| Mass pod restart | Low | Medium | Export rate limiting |

---

## Conclusion

The Strimzi-native ephemeral storage approach minimizes custom code by leveraging Kafka Connect's MongoDB Sink Connector:

**No custom code needed:**
- Warehouse consumer (MongoDB Sink Connector handles this)

**Custom code required (~300 lines total):**
- Export API (~150 lines) - wraps `mongodump` for streaming
- Hydration script (~80 lines) - calls export API + `mongorestore`

**Recommended next steps:**
1. Validate Kafka CDC end-to-end with Strimzi connectors
2. Test MongoDB Sink Connector dynamic routing
3. Implement and deploy export API

---

## Related Documentation

- [Architecture Evolution](ARCHITECTURE-EVOLUTION.md) - Gen 5 Pod-Based Architecture
- [Kafka CDC Integration](KAFKA-CDC-INTEGRATION.md) - CDC contract and configuration
- [Container Parameters](CONTAINER-PARAMETERS.md) - Environment variable reference
