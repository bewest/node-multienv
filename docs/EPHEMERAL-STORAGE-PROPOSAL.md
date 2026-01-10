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
| CronJob → S3 (snapshots) | *Eliminated* |
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

## Warehouse Consumer: Detailed Specification

The warehouse consumer is the critical component that applies CDC events to maintain canonical collections and exposes an export API for hydration.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         WAREHOUSE SYSTEM                                    │
│                                                                             │
│  ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────────┐   │
│  │  Kafka Topics   │────►│  Warehouse      │────►│  Warehouse MongoDB  │   │
│  │  (per-tenant)   │     │  Consumer       │     │  (per-tenant DBs)   │   │
│  └─────────────────┘     └─────────────────┘     └─────────────────────┘   │
│                                                            │                │
│                                                            ▼                │
│                                                  ┌─────────────────────┐   │
│                                                  │  Warehouse Export   │   │
│                                                  │  API Service        │   │
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

### Debezium CDC Event Format

Debezium MongoDB connector produces events in the following format:

```json
{
  "schema": { ... },
  "payload": {
    "before": null,
    "after": "{\"_id\": {\"$oid\": \"...\"}, \"sgv\": 120, \"date\": 1704844800000, ...}",
    "patch": null,
    "filter": null,
    "updateDescription": null,
    "source": {
      "version": "2.4.0.Final",
      "connector": "mongodb",
      "name": "tenant123",
      "ts_ms": 1704844800000,
      "snapshot": "false",
      "db": "nightscout",
      "sequence": null,
      "rs": "rs0",
      "collection": "entries",
      "ord": 1,
      "lsid": null,
      "txnNumber": null
    },
    "op": "c",
    "ts_ms": 1704844800123,
    "transaction": null
  }
}
```

**Key fields:**
- `payload.op`: Operation type (`c`=create, `u`=update, `r`=read/snapshot, `d`=delete)
- `payload.after`: Full document as JSON string (for inserts/updates)
- `payload.source.name`: Tenant ID (Kafka topic prefix)
- `payload.source.collection`: Collection name
- `payload.source.ts_ms`: Source timestamp

### Warehouse Consumer Implementation

```javascript
// warehouse-consumer/src/consumer.js
'use strict';

const { Kafka } = require('kafkajs');
const { MongoClient } = require('mongodb');
const bunyan = require('bunyan');

const log = bunyan.createLogger({ name: 'warehouse-consumer' });

class WarehouseConsumer {
  constructor(config) {
    this.config = config;
    this.kafka = new Kafka({
      clientId: 'warehouse-consumer',
      brokers: config.kafkaBrokers,
    });
    this.consumer = this.kafka.consumer({ 
      groupId: 'warehouse-consumer-group',
      sessionTimeout: 30000,
      heartbeatInterval: 3000,
    });
    this.mongoClient = null;
    this.warehouseDb = null;
  }

  async connect() {
    // Connect to Kafka
    await this.consumer.connect();
    log.info('Connected to Kafka');

    // Connect to warehouse MongoDB
    this.mongoClient = await MongoClient.connect(this.config.warehouseMongoUri, {
      maxPoolSize: 50,
      writeConcern: { w: 'majority', j: true },
    });
    this.warehouseDb = this.mongoClient.db();
    log.info('Connected to warehouse MongoDB');

    // Subscribe to all tenant CDC topics using regex pattern
    await this.consumer.subscribe({
      topics: [/^[a-z0-9-]+\.(nightscout)\.(entries|treatments|devicestatus)$/],
      fromBeginning: false,
    });
    log.info('Subscribed to tenant CDC topics');
  }

  async run() {
    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        try {
          await this.processMessage(topic, message);
        } catch (err) {
          log.error({ err, topic, partition }, 'Failed to process message');
          // Don't throw - continue processing other messages
          // Failed messages will be retried on consumer restart
        }
      },
    });
  }

  async processMessage(topic, message) {
    const event = JSON.parse(message.value.toString());
    const payload = event.payload;

    // Extract tenant and collection from topic name
    // Topic format: ${tenantId}.nightscout.${collection}
    const [tenantId, , collection] = topic.split('.');
    
    // Get or create per-tenant database
    const tenantDb = this.mongoClient.db(`nightscout_${tenantId}`);
    const coll = tenantDb.collection(collection);

    const operation = payload.op;
    const sourceTs = new Date(payload.source.ts_ms);

    switch (operation) {
      case 'c': // Create (insert)
      case 'r': // Read (snapshot) - treat as upsert
      case 'u': // Update
        const doc = JSON.parse(payload.after);
        // Parse MongoDB Extended JSON
        const parsedDoc = this.parseExtendedJson(doc);
        
        await coll.replaceOne(
          { _id: parsedDoc._id },
          { ...parsedDoc, _warehouseUpdated: sourceTs },
          { upsert: true }
        );
        log.debug({ tenantId, collection, op: operation, docId: parsedDoc._id }, 'Applied CDC event');
        break;

      case 'd': // Delete
        const filter = JSON.parse(payload.filter || payload.before);
        const docId = this.parseExtendedJson(filter)._id;
        
        await coll.deleteOne({ _id: docId });
        log.debug({ tenantId, collection, op: operation, docId }, 'Applied delete');
        break;

      default:
        log.warn({ operation, topic }, 'Unknown operation type');
    }
  }

  parseExtendedJson(doc) {
    // Convert MongoDB Extended JSON to native types
    // Example: {"$oid": "..."} -> ObjectId("...")
    const EJSON = require('bson').EJSON;
    return EJSON.parse(JSON.stringify(doc), { relaxed: false });
  }

  async disconnect() {
    await this.consumer.disconnect();
    await this.mongoClient.close();
    log.info('Disconnected');
  }
}

// Main entry point
async function main() {
  const config = {
    kafkaBrokers: (process.env.KAFKA_BROKERS || 'kafka-cluster-kafka-bootstrap:9092').split(','),
    warehouseMongoUri: process.env.WAREHOUSE_MONGODB_URI || 'mongodb://localhost:27017',
  };

  const consumer = new WarehouseConsumer(config);
  
  // Graceful shutdown
  process.on('SIGTERM', async () => {
    log.info('Received SIGTERM, shutting down...');
    await consumer.disconnect();
    process.exit(0);
  });

  await consumer.connect();
  await consumer.run();
}

main().catch((err) => {
  log.fatal({ err }, 'Consumer failed');
  process.exit(1);
});
```

### Consumer Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: warehouse-consumer
  namespace: nightscout-system
  labels:
    app: warehouse-consumer
spec:
  replicas: 3  # Multiple replicas for HA, Kafka handles partition assignment
  selector:
    matchLabels:
      app: warehouse-consumer
  template:
    metadata:
      labels:
        app: warehouse-consumer
    spec:
      containers:
        - name: consumer
          image: ${warehouseConsumerImage}
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: 500m
              memory: 512Mi
          env:
            - name: KAFKA_BROKERS
              value: "kafka-cluster-kafka-bootstrap.kafka.svc.cluster.local:9092"
            - name: WAREHOUSE_MONGODB_URI
              valueFrom:
                secretKeyRef:
                  name: warehouse-credentials
                  key: MONGODB_URI
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5
```

### Consumer Metrics

The consumer should expose Prometheus metrics:

```javascript
// Metrics endpoint
const promClient = require('prom-client');

const messagesProcessed = new promClient.Counter({
  name: 'warehouse_consumer_messages_processed_total',
  help: 'Total CDC messages processed',
  labelNames: ['tenant', 'collection', 'operation'],
});

const messageLatency = new promClient.Histogram({
  name: 'warehouse_consumer_message_latency_seconds',
  help: 'Latency from source to warehouse apply',
  labelNames: ['tenant', 'collection'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60],
});

const consumerLag = new promClient.Gauge({
  name: 'warehouse_consumer_lag_messages',
  help: 'Consumer lag in messages',
  labelNames: ['topic', 'partition'],
});
```

---

## Warehouse Export API: Detailed Specification

The export API streams tenant data as mongodump-compatible archives for pod hydration.

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

**Request:**
```http
GET /api/v1/tenants/demo-tenant/export/status HTTP/1.1
Host: warehouse-api.nightscout-system.svc.cluster.local
Accept: application/json
```

**Response (exists):**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "exists": true,
  "tenantId": "demo-tenant",
  "database": "nightscout_demo-tenant",
  "collections": {
    "entries": {
      "count": 52560,
      "sizeBytes": 15728640,
      "lastUpdated": "2026-01-10T12:00:00.000Z"
    },
    "treatments": {
      "count": 1250,
      "sizeBytes": 524288,
      "lastUpdated": "2026-01-10T11:55:00.000Z"
    },
    "devicestatus": {
      "count": 8760,
      "sizeBytes": 3145728,
      "lastUpdated": "2026-01-10T12:00:00.000Z"
    }
  },
  "totalSizeBytes": 19398656,
  "estimatedExportDuration": "15s"
}
```

**Response (not found):**
```http
HTTP/1.1 404 Not Found
Content-Type: application/json

{
  "exists": false,
  "tenantId": "demo-tenant"
}
```

#### GET /healthz

Health check endpoint.

**Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "status": "healthy",
  "mongoConnected": true,
  "activeExports": 3,
  "maxConcurrentExports": 10
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
const Semaphore = require('semaphore-async-await').default;

const log = bunyan.createLogger({ name: 'warehouse-api' });

const MAX_CONCURRENT_EXPORTS = parseInt(process.env.MAX_CONCURRENT_EXPORTS || '10', 10);
const EXPORT_TIMEOUT_MS = parseInt(process.env.EXPORT_TIMEOUT_MS || '300000', 10); // 5 minutes
const exportSemaphore = new Semaphore(MAX_CONCURRENT_EXPORTS);

let mongoClient = null;

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
  
  // Check if database exists by listing collections
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
    const lastDoc = await db.collection(coll.name)
      .findOne({}, { sort: { _warehouseUpdated: -1 }, projection: { _warehouseUpdated: 1 } });
    
    stats.collections[coll.name] = {
      count: collStats.count,
      sizeBytes: collStats.size,
      lastUpdated: lastDoc?._warehouseUpdated || null,
    };
    stats.totalSizeBytes += collStats.size;
  }

  // Estimate export duration: ~1MB/s for mongodump + compression
  const estimatedSeconds = Math.ceil(stats.totalSizeBytes / (1024 * 1024));
  stats.estimatedExportDuration = `${Math.max(5, estimatedSeconds)}s`;

  return stats;
}

async function streamExport(tenantId, res) {
  const dbName = `nightscout_${tenantId}`;
  const mongoUri = process.env.WAREHOUSE_MONGODB_URI;

  // Spawn mongodump process
  const mongodump = spawn('mongodump', [
    `--uri=${mongoUri}`,
    `--db=${dbName}`,
    '--archive',
    '--gzip',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let exportComplete = false;
  let bytesWritten = 0;

  // Set timeout
  const timeout = setTimeout(() => {
    if (!exportComplete) {
      log.warn({ tenantId }, 'Export timeout, killing mongodump');
      mongodump.kill('SIGTERM');
    }
  }, EXPORT_TIMEOUT_MS);

  // Pipe stdout to response
  mongodump.stdout.on('data', (chunk) => {
    bytesWritten += chunk.length;
    res.write(chunk);
  });

  // Log stderr
  mongodump.stderr.on('data', (data) => {
    log.debug({ tenantId, stderr: data.toString() }, 'mongodump stderr');
  });

  return new Promise((resolve, reject) => {
    mongodump.on('close', (code) => {
      clearTimeout(timeout);
      exportComplete = true;

      if (code === 0) {
        log.info({ tenantId, bytesWritten }, 'Export completed successfully');
        res.end();
        resolve();
      } else {
        log.error({ tenantId, exitCode: code }, 'mongodump failed');
        reject(new Error(`mongodump exited with code ${code}`));
      }
    });

    mongodump.on('error', (err) => {
      clearTimeout(timeout);
      exportComplete = true;
      log.error({ tenantId, err }, 'mongodump error');
      reject(err);
    });
  });
}

function createServer() {
  const server = restify.createServer({
    name: 'warehouse-api',
    log,
  });

  server.use(restify.plugins.queryParser());
  server.use(restify.plugins.requestLogger());

  // Health check
  server.get('/healthz', async (req, res, next) => {
    try {
      await mongoClient.db().admin().ping();
      res.json({
        status: 'healthy',
        mongoConnected: true,
        activeExports: MAX_CONCURRENT_EXPORTS - exportSemaphore.getPermits(),
        maxConcurrentExports: MAX_CONCURRENT_EXPORTS,
      });
    } catch (err) {
      res.status(503);
      res.json({ status: 'unhealthy', error: err.message });
    }
    next();
  });

  // Ready check
  server.get('/ready', async (req, res, next) => {
    try {
      await mongoClient.db().admin().ping();
      res.json({ ready: true });
    } catch (err) {
      res.status(503);
      res.json({ ready: false, error: err.message });
    }
    next();
  });

  // Export status
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
      log.error({ err, tenantId: req.params.tenantId }, 'Failed to get tenant stats');
      res.status(500);
      res.json({ error: 'internal_error', message: err.message });
    }
    next();
  });

  // Export stream
  server.get('/api/v1/tenants/:tenantId/export', async (req, res, next) => {
    const tenantId = req.params.tenantId;
    
    // Check if tenant exists
    const stats = await getTenantStats(tenantId);
    if (!stats) {
      res.status(404);
      res.json({ error: 'tenant_not_found', message: `No data exists for tenant ${tenantId}` });
      return next();
    }

    // Try to acquire semaphore with timeout
    const acquired = await exportSemaphore.tryAcquire(30000); // 30s wait
    if (!acquired) {
      res.status(503);
      res.header('Retry-After', '30');
      res.json({ error: 'rate_limited', message: 'Export queue full, retry after 30 seconds' });
      return next();
    }

    try {
      // Set response headers for streaming
      res.header('Content-Type', 'application/octet-stream');
      res.header('Content-Disposition', `attachment; filename="${tenantId}.archive.gz"`);
      res.header('X-Warehouse-Export-Size', stats.totalSizeBytes);
      res.header('X-Warehouse-Export-Collections', Object.keys(stats.collections).join(','));
      res.header('Transfer-Encoding', 'chunked');

      await streamExport(tenantId, res);
    } catch (err) {
      log.error({ err, tenantId }, 'Export failed');
      // Response may be partially written, can't change status
      res.end();
    } finally {
      exportSemaphore.release();
    }
    next();
  });

  return server;
}

async function main() {
  await connectMongo();
  
  const server = createServer();
  const port = parseInt(process.env.PORT || '8080', 10);
  
  server.listen(port, () => {
    log.info({ port }, 'Warehouse API listening');
  });

  process.on('SIGTERM', async () => {
    log.info('Received SIGTERM, shutting down...');
    server.close();
    await mongoClient.close();
    process.exit(0);
  });
}

main().catch((err) => {
  log.fatal({ err }, 'Server failed to start');
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
  labels:
    app: warehouse-api
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
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 512Mi
          env:
            - name: WAREHOUSE_MONGODB_URI
              valueFrom:
                secretKeyRef:
                  name: warehouse-credentials
                  key: MONGODB_URI
            - name: MAX_CONCURRENT_EXPORTS
              value: "10"
            - name: EXPORT_TIMEOUT_MS
              value: "300000"
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5
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
  type: ClusterIP
```

---

## Hydration Init Container: Detailed Implementation

### Full Script with Error Handling

```bash
#!/bin/bash
# hydrate-from-warehouse.sh
#
# Init container script that hydrates ephemeral MongoDB from the warehouse.
# Streams mongodump archive from warehouse API and restores to local emptyDir.
#
# Environment Variables:
#   WAREHOUSE_EXPORT_URL - Base URL of warehouse API (required)
#   TENANT_ID           - Tenant identifier (required)
#   MONGO_DATA_DIR      - MongoDB data directory (default: /data/db)
#   MAX_RETRIES         - Maximum retry attempts (default: 5)
#   INITIAL_RETRY_DELAY - Initial retry delay in seconds (default: 5)
#   MAX_RETRY_DELAY     - Maximum retry delay in seconds (default: 60)
#   HYDRATION_TIMEOUT   - Curl timeout in seconds (default: 300)

set -euo pipefail

# Logging functions
log_info() {
  echo "[$(date -Iseconds)] INFO: $*"
}

log_warn() {
  echo "[$(date -Iseconds)] WARN: $*" >&2
}

log_error() {
  echo "[$(date -Iseconds)] ERROR: $*" >&2
}

# Configuration with defaults
WAREHOUSE_EXPORT_URL="${WAREHOUSE_EXPORT_URL:?WAREHOUSE_EXPORT_URL is required}"
TENANT_ID="${TENANT_ID:?TENANT_ID is required}"
MONGO_DATA_DIR="${MONGO_DATA_DIR:-/data/db}"
MAX_RETRIES="${MAX_RETRIES:-5}"
INITIAL_RETRY_DELAY="${INITIAL_RETRY_DELAY:-5}"
MAX_RETRY_DELAY="${MAX_RETRY_DELAY:-60}"
HYDRATION_TIMEOUT="${HYDRATION_TIMEOUT:-300}"

# Derived values
STATUS_URL="${WAREHOUSE_EXPORT_URL}/api/v1/tenants/${TENANT_ID}/export/status"
EXPORT_URL="${WAREHOUSE_EXPORT_URL}/api/v1/tenants/${TENANT_ID}/export"

log_info "Starting hydration for tenant: ${TENANT_ID}"
log_info "Warehouse API: ${WAREHOUSE_EXPORT_URL}"
log_info "Data directory: ${MONGO_DATA_DIR}"

# Ensure data directory exists and is empty
mkdir -p "${MONGO_DATA_DIR}"
if [ "$(ls -A ${MONGO_DATA_DIR})" ]; then
  log_warn "Data directory not empty, cleaning..."
  rm -rf "${MONGO_DATA_DIR:?}"/*
fi

# Check if tenant data exists in warehouse
check_tenant_exists() {
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    --connect-timeout 10 \
    --max-time 30 \
    "${STATUS_URL}")
  echo "${http_code}"
}

# Perform hydration with streaming restore
do_hydration() {
  log_info "Streaming database restore from warehouse..."
  
  # Create a temporary file for mongorestore stderr
  local restore_log
  restore_log=$(mktemp)
  
  # Stream download through mongorestore
  # Using process substitution to capture exit codes properly
  local curl_exit=0
  local restore_exit=0
  
  {
    curl -sf \
      --connect-timeout 30 \
      --max-time "${HYDRATION_TIMEOUT}" \
      --retry 0 \
      "${EXPORT_URL}" || curl_exit=$?
  } | {
    mongorestore \
      --gzip \
      --archive \
      --drop \
      --dir="${MONGO_DATA_DIR}" \
      --quiet \
      2>"${restore_log}" || restore_exit=$?
  }
  
  # Check for errors
  if [ "${curl_exit}" -ne 0 ]; then
    log_error "Curl failed with exit code: ${curl_exit}"
    rm -f "${restore_log}"
    return 1
  fi
  
  if [ "${restore_exit}" -ne 0 ]; then
    log_error "mongorestore failed with exit code: ${restore_exit}"
    log_error "mongorestore output: $(cat ${restore_log})"
    rm -f "${restore_log}"
    return 1
  fi
  
  # Log restore summary
  if [ -s "${restore_log}" ]; then
    log_info "mongorestore output: $(cat ${restore_log})"
  fi
  
  rm -f "${restore_log}"
  return 0
}

# Main execution with retry logic
main() {
  local retry_delay="${INITIAL_RETRY_DELAY}"
  local attempt=1
  
  while [ "${attempt}" -le "${MAX_RETRIES}" ]; do
    log_info "Hydration attempt ${attempt}/${MAX_RETRIES}"
    
    # Check if tenant exists
    local status_code
    status_code=$(check_tenant_exists)
    
    case "${status_code}" in
      200)
        log_info "Tenant data found in warehouse, proceeding with hydration..."
        ;;
      404)
        log_info "No data found in warehouse for tenant ${TENANT_ID}"
        log_info "Starting with empty database"
        exit 0
        ;;
      503)
        log_warn "Warehouse API rate limited (503), will retry..."
        ;;
      000)
        log_warn "Failed to connect to warehouse API, will retry..."
        ;;
      *)
        log_warn "Unexpected status code: ${status_code}, will retry..."
        ;;
    esac
    
    # Attempt hydration if we got 200
    if [ "${status_code}" = "200" ]; then
      if do_hydration; then
        log_info "Hydration completed successfully"
        
        # Verify data directory has content
        if [ "$(ls -A ${MONGO_DATA_DIR})" ]; then
          log_info "Data directory populated, hydration verified"
          exit 0
        else
          log_warn "Data directory empty after hydration, will retry..."
        fi
      else
        log_warn "Hydration failed, will retry..."
      fi
    fi
    
    # Retry logic
    if [ "${attempt}" -lt "${MAX_RETRIES}" ]; then
      log_info "Waiting ${retry_delay}s before retry..."
      sleep "${retry_delay}"
      
      # Exponential backoff with cap
      retry_delay=$((retry_delay * 2))
      if [ "${retry_delay}" -gt "${MAX_RETRY_DELAY}" ]; then
        retry_delay="${MAX_RETRY_DELAY}"
      fi
    fi
    
    attempt=$((attempt + 1))
  done
  
  log_error "Hydration failed after ${MAX_RETRIES} attempts"
  exit 1
}

# Run main
main
```

### Init Container Manifest

```yaml
initContainers:
  - name: hydrate-from-warehouse
    image: ${nsUtilityImage}
    imagePullPolicy: IfNotPresent
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
      - name: MAX_RETRIES
        value: "5"
      - name: INITIAL_RETRY_DELAY
        value: "5"
      - name: HYDRATION_TIMEOUT
        value: "300"
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
    securityContext:
      runAsUser: 999  # mongodb user
      runAsGroup: 999
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

**Requirements:**
- Consume from `${tenantId}-*` Kafka topics
- Apply changes idempotently to warehouse MongoDB
- Handle at-least-once delivery (upsert pattern provides deduplication)
- Expose health/metrics endpoints

### 3. Warehouse Export API

**Requirements:**
- Stream mongodump archives for tenant databases
- Rate limiting for concurrent exports
- Health and readiness endpoints

### 4. Warehouse MongoDB Cluster

**Required:**
- MongoDB cluster (can be small, just needs to store aggregate of all ephemeral tenants)
- Sizing: Sum of all ephemeral tenant databases + 20% overhead
- Example: 100 tenants × 1GB average = ~120GB storage

### 5. Utility Container Updates

**Required scripts:**
- `hydrate-from-warehouse.sh` - Stream restore from warehouse API

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

## Operational Runbook

### Monitoring Dashboard

Key metrics to display:

| Panel | Metric | Description |
|-------|--------|-------------|
| Consumer Lag | `warehouse_consumer_lag_messages` | CDC messages waiting to be processed |
| Processing Rate | `rate(warehouse_consumer_messages_processed_total[5m])` | Messages processed per second |
| Export Queue | `warehouse_api_active_exports` | Currently running exports |
| Export Duration | `warehouse_api_export_duration_seconds` | Time to complete exports |
| Hydration Failures | `ephemeral_pod_init_container_restarts` | Init container restart count |
| Tenant Data Size | `warehouse_tenant_size_bytes` | Per-tenant database size |

### Alerting Rules

```yaml
groups:
  - name: ephemeral-storage
    rules:
      - alert: WarehouseConsumerLagHigh
        expr: warehouse_consumer_lag_messages > 10000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Warehouse consumer lag is high"
          description: "Consumer lag is {{ $value }} messages, CDC events are backing up"

      - alert: WarehouseConsumerLagCritical
        expr: warehouse_consumer_lag_messages > 100000
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Warehouse consumer lag is critical"
          description: "Consumer lag is {{ $value }} messages, data loss risk increasing"

      - alert: WarehouseExportQueueFull
        expr: warehouse_api_active_exports >= 10
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Warehouse export queue is full"
          description: "All export slots in use, new hydrations may be delayed"

      - alert: HydrationFailureRate
        expr: rate(ephemeral_pod_init_container_restarts[15m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High hydration failure rate"
          description: "Ephemeral pods are failing to hydrate"

      - alert: WarehouseAPIDown
        expr: up{job="warehouse-api"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Warehouse API is down"
          description: "Ephemeral pods cannot hydrate"
```

### Troubleshooting Guide

#### Problem: Pod stuck in Init state

**Symptoms:**
- Pod shows `Init:0/1` status
- Init container logs show repeated failures

**Diagnosis:**
```bash
# Check init container logs
kubectl logs ${POD_NAME} -c hydrate-from-warehouse

# Check warehouse API health
kubectl exec -n nightscout-system deploy/warehouse-api -- curl -s localhost:8080/healthz

# Check if tenant exists in warehouse
curl http://warehouse-api.nightscout-system.svc.cluster.local/api/v1/tenants/${TENANT_ID}/export/status
```

**Resolution:**
1. If warehouse API is down → Restart warehouse-api deployment
2. If rate limited → Wait for queue to clear, or scale up warehouse-api
3. If tenant not found (404) → This is expected for new tenants, check if pod eventually starts

#### Problem: CDC consumer lag growing

**Symptoms:**
- `warehouse_consumer_lag_messages` increasing
- Tenant data in warehouse is stale

**Diagnosis:**
```bash
# Check consumer logs
kubectl logs -n nightscout-system deploy/warehouse-consumer --tail=100

# Check consumer group status
kubectl exec -n kafka kafka-cluster-kafka-0 -- bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --describe --group warehouse-consumer-group
```

**Resolution:**
1. If consumer is crashed → Check logs for errors, fix and restart
2. If consumer is slow → Scale up consumer replicas or increase resources
3. If Kafka is slow → Check Kafka cluster health

#### Problem: Export taking too long

**Symptoms:**
- Hydration times exceeding 60 seconds
- `warehouse_api_export_duration_seconds` high

**Diagnosis:**
```bash
# Check tenant database size
kubectl exec -n nightscout-system deploy/warehouse-api -- \
  mongosh "${WAREHOUSE_MONGODB_URI}" --eval "db.getSiblingDB('nightscout_${TENANT_ID}').stats()"
```

**Resolution:**
1. If database is large (>2GB) → Consider data retention policy
2. If many concurrent exports → Scale up warehouse-api replicas
3. If network is slow → Check network policies and bandwidth

### Recovery Procedures

#### Recovering from warehouse MongoDB failure

If the warehouse MongoDB cluster fails:

1. **Kafka retains CDC events** - Default 7-day retention
2. **Restore warehouse MongoDB** from backup or rebuild
3. **Reset consumer offset** to replay from Kafka:
   ```bash
   kubectl exec -n kafka kafka-cluster-kafka-0 -- bin/kafka-consumer-groups.sh \
     --bootstrap-server localhost:9092 \
     --group warehouse-consumer-group \
     --reset-offsets --to-earliest --execute --all-topics
   ```
4. **Consumer will replay** all retained events to rebuild warehouse

#### Recovering from Kafka failure

If Kafka cluster fails with data loss:

1. **Ephemeral pods continue running** - No immediate impact
2. **New CDC events are lost** until Kafka recovers
3. **Data loss window expands** beyond normal 1-2 minutes
4. **After Kafka recovery**, connectors will resume from last committed offset
5. **Gap in warehouse** - Data between Kafka failure and recovery may be missing

**Mitigation:** Run Kafka with replication factor ≥3 and multiple brokers

---

## Tenant Lifecycle Management

### Creating a New Ephemeral Tenant

1. **Create ConfigMap** with `ns.mdn.io/storage-mode: ephemeral` annotation
2. **Metacontroller** renders pod with hydration init container + emptyDir
3. **Init container** queries warehouse API, gets 404 (no data)
4. **MongoDB starts** with empty database
5. **Nightscout starts** and begins receiving CGM data
6. **CDC connector** starts capturing changes to Kafka
7. **Warehouse consumer** applies events, creating tenant database in warehouse

### Migrating Persistent → Ephemeral

1. **Ensure CDC is enabled** on persistent tenant and data is flowing to warehouse
2. **Wait for consumer lag = 0** (warehouse is fully synced)
3. **Update ConfigMap** annotation to `storage-mode: ephemeral`
4. **Pod recreates** with emptyDir volume
5. **Init container** hydrates from warehouse (should have all data)
6. **Verify tenant** works correctly
7. **Delete old PVC** (optional, after validation period)

### Migrating Ephemeral → Persistent

1. **Create PVC** for tenant
2. **Update ConfigMap** annotation to `storage-mode: persistent`
3. **Pod recreates** with PVC volume
4. **Init container** still hydrates from warehouse (populates PVC)
5. **CDC continues** (optional, can disable if no longer needed)
6. **Warehouse data** can be retained or purged after migration

### Deleting an Ephemeral Tenant

1. **Delete tenant ConfigMap/CRD**
2. **Pod terminates** (emptyDir is automatically cleaned up)
3. **Debezium connector** is deleted (no more CDC events)
4. **Warehouse data remains** for retention period (default: 30 days)
5. **Purge job** (optional) deletes warehouse database after retention

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
