# Database Migration Strategy: Shared → Dedicated MongoDB

## Overview

Strategy for transitioning tenants from a shared MongoDB cluster to dedicated per-tenant MongoDB instances using labels and annotations.

## Architecture Evolution

### Phase 1: Shared MongoDB (Current Simple Mode)
```
┌─────────────┐
│ Nightscout  │
│ Deployment  │
└──────┬──────┘
       │
       ▼
┌─────────────────────┐
│  Shared MongoDB     │
│  (External Cluster) │
│  - tenant_a db      │
│  - tenant_b db      │
│  - tenant_c db      │
└─────────────────────┘
```

### Phase 2: Dedicated MongoDB (Current Implementation)
```
┌─────────────┐     ┌─────────────┐
│ Nightscout  │     │  MongoDB    │
│ Deployment  │────▶│ StatefulSet │
└─────────────┘     │ (Dedicated) │
                    └─────────────┘
```

### Phase 3: Migration In-Progress
```
┌─────────────┐
│ Nightscout  │
│ Deployment  │
└──────┬──────┘
       │
       ├──────────────┐
       │              │
       ▼              ▼
┌─────────────┐  ┌─────────────┐
│   Shared    │  │  Dedicated  │
│   MongoDB   │  │  MongoDB    │
│  (source)   │  │  (target)   │
└─────────────┘  └─────────────┘
       │              ▲
       └──Migration──┘
```

## Labels for Database Topology

### `ns.mdn.io/db-topology`

Defines the database architecture for this tenant.

**Values:**
- `shared` - Uses external shared MongoDB cluster
- `dedicated` - Uses dedicated per-tenant MongoDB StatefulSet
- `hybrid` - Temporary state during migration

**Usage:**
```yaml
labels:
  ns.mdn.io/db-topology: "shared"    # or "dedicated" or "hybrid"
```

### `ns.mdn.io/db-migration-status`

Tracks migration state.

**Values:**
- `none` - No migration planned
- `pending` - Migration scheduled but not started
- `in-progress` - Actively migrating
- `complete` - Migration finished
- `failed` - Migration failed (manual intervention needed)

**Usage:**
```yaml
labels:
  ns.mdn.io/db-migration-status: "in-progress"
```

### `ns.mdn.io/db-generation`

Generation counter for database instances.

**Values:** Integer (e.g., `"1"`, `"2"`)

**Usage:**
```yaml
labels:
  ns.mdn.io/db-generation: "2"  # Second database instance
```

## Annotations for Migration Configuration

### `ns.mdn.io/db-shared-connection`

Connection string for shared MongoDB cluster (when using shared mode).

**Usage:**
```yaml
annotations:
  ns.mdn.io/db-shared-connection: "mongodb://shared-cluster.default.svc:27017/tenant-demo"
```

### `ns.mdn.io/db-shared-secret`

Secret name containing credentials for shared cluster.

**Usage:**
```yaml
annotations:
  ns.mdn.io/db-shared-secret: "shared-mongodb-credentials"
```

### `ns.mdn.io/migration-source-uri`

Source database URI during migration (for migration job).

**Usage:**
```yaml
annotations:
  ns.mdn.io/migration-source-uri: "mongodb://shared-cluster/tenant-demo"
```

### `ns.mdn.io/migration-target-uri`

Target database URI during migration (for migration job).

**Usage:**
```yaml
annotations:
  ns.mdn.io/migration-target-uri: "mongodb://ns-mongo-0.ns-mongo:27017/ns"
```

### `ns.mdn.io/migration-started-at`

Timestamp when migration started.

**Usage:**
```yaml
annotations:
  ns.mdn.io/migration-started-at: "2025-10-24T10:30:00Z"
```

### `ns.mdn.io/migration-completed-at`

Timestamp when migration completed.

**Usage:**
```yaml
annotations:
  ns.mdn.io/migration-completed-at: "2025-10-24T11:45:00Z"
```

### `ns.mdn.io/migration-method`

Migration method used.

**Values:**
- `mongodump-restore` - Traditional dump/restore
- `live-sync` - Online migration with CDC sync
- `snapshot-restore` - From backup snapshot

**Usage:**
```yaml
annotations:
  ns.mdn.io/migration-method: "live-sync"
```

## ConfigMap Examples

### Shared MongoDB Tenant

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tenant-basic-config
  labels:
    ns.mdn.io/enabled: "true"
    ns.mdn.io/db-topology: "shared"
    ns.mdn.io/db-migration-status: "none"
  annotations:
    ns.mdn.io/db-shared-connection: "mongodb://shared-mongo.default.svc:27017/basic"
    ns.mdn.io/db-shared-secret: "shared-mongodb-auth"
data:
  TENANT_ID: "basic"
  NS_IMAGE: "nightscout/cgm-remote-monitor:latest"
  # No MongoDB or CDC configuration needed
```

### Dedicated MongoDB Tenant

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tenant-premium-config
  labels:
    ns.mdn.io/enabled: "true"
    ns.mdn.io/db-topology: "dedicated"
    ns.mdn.io/db-migration-status: "none"
    ns.mdn.io/db-generation: "1"
data:
  TENANT_ID: "premium"
  NS_IMAGE: "nightscout/cgm-remote-monitor:latest"
  MONGO_STORAGE_GI: "20"
  CDC_ENABLED: "true"
```

### Tenant During Migration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tenant-upgrading-config
  labels:
    ns.mdn.io/enabled: "true"
    ns.mdn.io/db-topology: "hybrid"
    ns.mdn.io/db-migration-status: "in-progress"
    ns.mdn.io/db-generation: "1"
  annotations:
    ns.mdn.io/db-shared-connection: "mongodb://shared-mongo/upgrading"
    ns.mdn.io/db-shared-secret: "shared-mongodb-auth"
    ns.mdn.io/migration-source-uri: "mongodb://shared-mongo/upgrading"
    ns.mdn.io/migration-target-uri: "mongodb://ns-mongo-0.ns-mongo:27017/ns"
    ns.mdn.io/migration-method: "live-sync"
    ns.mdn.io/migration-started-at: "2025-10-24T10:30:00Z"
data:
  TENANT_ID: "upgrading"
  NS_IMAGE: "nightscout/cgm-remote-monitor:latest"
  MONGO_STORAGE_GI: "10"
```

## Webhook Logic Changes

### Composite Sync Handler

```javascript
function compositeSyncHandler(request, response) {
  const parent = request.parent;
  const tenantId = parent.data?.TENANT_ID;
  const dbTopology = parent.metadata?.labels?.['ns.mdn.io/db-topology'] || 'dedicated';
  const migrationStatus = parent.metadata?.labels?.['ns.mdn.io/db-migration-status'] || 'none';
  
  // Render based on topology
  switch (dbTopology) {
    case 'shared':
      // Simple Nightscout deployment only, no MongoDB resources
      response.children.push(...renderNightscoutShared(parent));
      break;
      
    case 'dedicated':
      // Full stack: MongoDB + Nightscout + CDC
      response.children.push(...renderMongoDBDedicated(parent));
      response.children.push(...renderNightscoutDedicated(parent));
      if (parent.data?.CDC_ENABLED === 'true') {
        response.children.push(...renderKafkaResources(parent));
      }
      break;
      
    case 'hybrid':
      // Migration mode: Both databases + migration job
      response.children.push(...renderMongoDBDedicated(parent));
      response.children.push(...renderNightscoutHybrid(parent, migrationStatus));
      
      if (migrationStatus === 'pending') {
        response.children.push(renderMigrationJob(parent));
      }
      break;
  }
  
  // Status tracking
  response.status = {
    dbTopology: dbTopology,
    migrationStatus: migrationStatus,
    mongo: dbTopology === 'dedicated' || dbTopology === 'hybrid' 
      ? { ready: isMongoReady(request.children) }
      : { external: true }
  };
  
  return response;
}
```

### Resource Templates

```javascript
// Nightscout with shared MongoDB
function renderNightscoutShared(parent) {
  const sharedConnection = parent.metadata?.annotations?.['ns.mdn.io/db-shared-connection'];
  const sharedSecret = parent.metadata?.annotations?.['ns.mdn.io/db-shared-secret'];
  
  return [{
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: 'nightscout',
      labels: standardLabels(tenantId, 'nightscout', 'application')
    },
    spec: {
      template: {
        spec: {
          containers: [{
            name: 'nightscout',
            env: [{
              name: 'MONGO_CONNECTION',
              value: sharedConnection  // Direct connection to shared cluster
            }, {
              name: 'API_SECRET',
              valueFrom: {
                secretKeyRef: {
                  name: sharedSecret,
                  key: 'api-secret'
                }
              }
            }]
          }]
        }
      }
    }
  }];
}

// Nightscout during migration (dual-write or read-from-source)
function renderNightscoutHybrid(parent, migrationStatus) {
  if (migrationStatus === 'in-progress') {
    // Still reading from shared, but dedicated is being populated
    return renderNightscoutShared(parent);
  } else if (migrationStatus === 'complete') {
    // Switch to dedicated
    return renderNightscoutDedicated(parent);
  }
}

// Migration Job
function renderMigrationJob(parent) {
  const sourceUri = parent.metadata?.annotations?.['ns.mdn.io/migration-source-uri'];
  const targetUri = parent.metadata?.annotations?.['ns.mdn.io/migration-target-uri'];
  const method = parent.metadata?.annotations?.['ns.mdn.io/migration-method'] || 'mongodump-restore';
  
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: `${tenantId}-db-migration`,
      labels: {
        ...standardLabels(tenantId, 'db-migration', 'job'),
        'ns.mdn.io/migration-job': 'true'
      }
    },
    spec: {
      template: {
        spec: {
          restartPolicy: 'OnFailure',
          containers: [{
            name: 'migrate',
            image: 'mongo:6',
            command: ['/bin/bash', '-c'],
            args: [
              method === 'mongodump-restore'
                ? `mongodump --uri="${sourceUri}" --archive | mongorestore --uri="${targetUri}" --archive`
                : `# Live sync logic here`
            ],
            env: [
              { name: 'SOURCE_URI', value: sourceUri },
              { name: 'TARGET_URI', value: targetUri }
            ]
          }]
        }
      }
    }
  };
}
```

## Migration Workflow

### Step 1: Initial State (Shared)

```yaml
labels:
  ns.mdn.io/db-topology: "shared"
  ns.mdn.io/db-migration-status: "none"
```

**Resources:** Nightscout Deployment only

### Step 2: Schedule Migration

```bash
kubectl label cm tenant-basic-config ns.mdn.io/db-migration-status=pending
kubectl annotate cm tenant-basic-config ns.mdn.io/migration-method=live-sync
```

**Resources:** Nightscout + MongoDB StatefulSet (empty) + Migration Job

### Step 3: Start Migration

```bash
kubectl label cm tenant-basic-config ns.mdn.io/db-topology=hybrid
kubectl label cm tenant-basic-config ns.mdn.io/db-migration-status=in-progress
kubectl annotate cm tenant-basic-config ns.mdn.io/migration-started-at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
```

**Resources:** Nightscout (shared) + MongoDB (being populated) + Migration Job running

### Step 4: Complete Migration

```bash
# Automated by webhook after migration job succeeds
kubectl label cm tenant-basic-config ns.mdn.io/db-topology=dedicated
kubectl label cm tenant-basic-config ns.mdn.io/db-migration-status=complete
kubectl annotate cm tenant-basic-config ns.mdn.io/migration-completed-at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
```

**Resources:** Nightscout (dedicated) + MongoDB StatefulSet

### Step 5: Cleanup (Optional)

Remove migration annotations:
```bash
kubectl annotate cm tenant-basic-config \
  ns.mdn.io/db-shared-connection- \
  ns.mdn.io/db-shared-secret- \
  ns.mdn.io/migration-source-uri- \
  ns.mdn.io/migration-target-uri-
```

## Status Tracking

```yaml
status:
  dbTopology: "hybrid"
  migrationStatus: "in-progress"
  migration:
    started: "2025-10-24T10:30:00Z"
    method: "live-sync"
    progress: "75%"
    documentsTransferred: 1250000
    estimatedCompletion: "2025-10-24T11:00:00Z"
  mongo:
    shared:
      connected: true
      host: "shared-mongo.default.svc"
    dedicated:
      ready: true
      readyReplicas: 1
```

## Query Examples

```bash
# All shared MongoDB tenants
kubectl get cm -l ns.mdn.io/db-topology=shared

# All dedicated MongoDB tenants
kubectl get cm -l ns.mdn.io/db-topology=dedicated

# Tenants currently migrating
kubectl get cm -l ns.mdn.io/db-migration-status=in-progress

# Find migration jobs
kubectl get jobs -l ns.mdn.io/migration-job=true

# All hybrid (migration) state tenants
kubectl get cm -l ns.mdn.io/db-topology=hybrid
```

## Rollback Strategy

If migration fails:

```bash
# Rollback to shared
kubectl label cm tenant-basic-config ns.mdn.io/db-topology=shared --overwrite
kubectl label cm tenant-basic-config ns.mdn.io/db-migration-status=failed --overwrite

# Delete dedicated MongoDB (cascade delete)
kubectl delete sts ns-mongo
```

## Benefits

✅ **Gradual Migration**: Migrate tenants one at a time  
✅ **Zero Downtime**: Nightscout stays running during migration  
✅ **Rollback Safety**: Can revert to shared if issues occur  
✅ **Clear State**: Labels make current state visible  
✅ **Audit Trail**: Annotations track migration timeline  
✅ **Query Flexibility**: Easy to find tenants in any state  

## Advanced: Live Migration with CDC

For zero-downtime migrations:

1. **Phase 1**: Start CDC from shared → dedicated
2. **Phase 2**: Let dedicated catch up (tail oplog)
3. **Phase 3**: Brief cutover (pause writes, sync final changes)
4. **Phase 4**: Switch Nightscout connection to dedicated
5. **Phase 5**: Stop CDC, mark complete

**Additional annotations:**
```yaml
annotations:
  ns.mdn.io/migration-cdc-lag: "2.5s"
  ns.mdn.io/migration-ready-for-cutover: "true"
```

## Implementation Priority

**Phase 1** (Immediate):
- Add `ns.mdn.io/db-topology` label support
- Webhook renders different resources based on topology
- Support `shared` and `dedicated` modes

**Phase 2** (Next):
- Add migration status tracking
- Implement migration job rendering
- Add `hybrid` topology support

**Phase 3** (Future):
- Live migration with CDC
- Automated cutover detection
- Migration progress monitoring

---

**Next Step:** Implement topology-aware resource rendering in `handlers/composite-sync.js`
