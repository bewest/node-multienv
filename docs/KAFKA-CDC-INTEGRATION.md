# Kafka CDC Integration Contract

## Overview

This document defines the integration boundary between **node-multienv** (this repository) and **external infrastructure** (e.g., sysctl) for Kafka-based Change Data Capture (CDC).

**Key Principle:** node-multienv orchestrates **per-tenant CDC resources**, while external infrastructure provides the **shared Kafka platform**.

---

## Scope Boundary

### ✅ IN SCOPE (node-multienv)

**Responsibility:** Per-tenant CDC orchestration

This repository is responsible for:

1. **Generating tenant-scoped Kafka resources** when `CDC_ENABLED: "true"`:
   - `KafkaTopic` manifests for MongoDB collections
   - `KafkaConnector` manifests for CDC connectors

2. **Reading tenant configuration** from ConfigMaps:
   - `CDC_COLLECTIONS`, `CDC_PARTITIONS_*`, `CDC_RETENTION_MS`
   - `KAFKA_CLUSTER_NAME`, `KAFKA_CONNECT_CLUSTER_NAME`

3. **Operational utilities** for tenant CDC:
   - Health checks (`wait_for_kafka_topic`, connector status)
   - Restart/pause/resume operations
   - Debugging scripts

4. **RBAC permissions** for creating/updating:
   - Tenant-owned `KafkaTopic` resources
   - Tenant-owned `KafkaConnector` resources

5. **Status reporting** when dependencies are missing:
   - Webhook returns `NotReady` if Kafka infrastructure unavailable
   - Clear error messages for operators

**Files in this repo:**
```
lib/templates/nightscout.js                     # renderKafkaTopics(), renderKafkaConnector()
cmd/webhook/handlers/compute-composite-sync.js  # Generates Kafka resources
container-images/ns-utility/scripts/lib/kafka-utils.sh  # Operational scripts
jsonnet/lib-k8s-multienv/rbac.libsonnet         # RBAC for kafkatopics/kafkaconnectors
```

---

### ❌ OUT OF SCOPE (external infrastructure)

**Responsibility:** Shared Kafka platform

External infrastructure (sysctl or similar) must provide:

1. **Strimzi Kafka Operator**:
   - Installation and upgrades
   - CRD management (`KafkaTopic`, `KafkaConnector`, etc.)

2. **Kafka Cluster**:
   - Broker deployment (Zookeeper or KRaft mode)
   - Namespaces, network policies
   - TLS/SASL security configuration
   - Persistent volume provisioning

3. **KafkaConnect Cluster**:
   - Connect worker deployment
   - MongoDB connector plugin installation
   - Connector configuration templates

4. **Connection Endpoints**:
   - Bootstrap server URLs
   - Connect REST API URLs
   - Authentication credentials (secrets)

5. **Cross-namespace operations**:
   - Cluster-admin privileges
   - Global topic/connector policies
   - Resource quotas

**Not in this repository** - must be deployed separately before enabling CDC.

---

## Integration Contract

### What External Infrastructure MUST Provide

Before enabling CDC tenants (`CDC_ENABLED: "true"`), external infrastructure must:

#### 1. Deploy Strimzi Operator

Install Strimzi in the cluster:

```bash
# Example: Helm installation
helm repo add strimzi https://strimzi.io/charts/
helm install strimzi-operator strimzi/strimzi-kafka-operator \
  --namespace kafka \
  --create-namespace
```

**Verification:**
```bash
kubectl get crd kafkatopics.kafka.strimzi.io
kubectl get crd kafkaconnectors.kafka.strimzi.io
```

#### 2. Deploy Kafka Cluster

Create a Kafka cluster accessible to tenant namespaces:

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: Kafka
metadata:
  name: kafka-cluster
  namespace: kafka
spec:
  kafka:
    version: 3.6.0
    replicas: 3
    listeners:
      - name: plain
        port: 9092
        type: internal
        tls: false
      - name: tls
        port: 9093
        type: internal
        tls: true
    storage:
      type: persistent-claim
      size: 100Gi
  zookeeper:
    replicas: 3
    storage:
      type: persistent-claim
      size: 10Gi
```

**Verification:**
```bash
kubectl get kafka -n kafka
kubectl get pods -n kafka -l strimzi.io/cluster=kafka-cluster
```

#### 3. Deploy KafkaConnect Cluster

Create a Connect cluster with MongoDB connector plugin:

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaConnect
metadata:
  name: connect-cluster
  namespace: kafka
  annotations:
    strimzi.io/use-connector-resources: "true"
spec:
  version: 3.6.0
  replicas: 3
  bootstrapServers: kafka-cluster-kafka-bootstrap:9092
  config:
    group.id: connect-cluster
    offset.storage.topic: connect-cluster-offsets
    config.storage.topic: connect-cluster-configs
    status.storage.topic: connect-cluster-status
  build:
    output:
      type: docker
      image: your-registry/kafka-connect:latest
    plugins:
      - name: mongodb-connector
        artifacts:
          - type: tgz
            url: https://repo1.maven.org/maven2/io/debezium/debezium-connector-mongodb/2.4.0.Final/debezium-connector-mongodb-2.4.0.Final-plugin.tar.gz
```

**Verification:**
```bash
kubectl get kafkaconnect -n kafka
kubectl get pods -n kafka -l strimzi.io/cluster=connect-cluster
```

#### 4. Export Connection Details

Create a ConfigMap/Secret accessible to tenant namespaces:

**Option A: ConfigMap (non-sensitive)**

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kafka-connection-info
  namespace: hosted-tenants  # Or tenant namespace
data:
  KAFKA_BOOTSTRAP_SERVERS: "kafka-cluster-kafka-bootstrap.kafka.svc.cluster.local:9092"
  KAFKA_CONNECT_URL: "http://connect-cluster-connect-api.kafka.svc.cluster.local:8083"
  KAFKA_CLUSTER_NAME: "kafka-cluster"
  KAFKA_CONNECT_CLUSTER_NAME: "connect-cluster"
```

**Option B: Secret (with authentication)**

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: kafka-credentials
  namespace: hosted-tenants
type: Opaque
stringData:
  bootstrap-servers: "kafka-cluster-kafka-bootstrap.kafka.svc.cluster.local:9093"
  username: "tenant-user"
  password: "..."
  sasl-mechanism: "SCRAM-SHA-512"
  security-protocol: "SASL_SSL"
```

---

## What node-multienv Orchestrates

When a tenant ConfigMap has `CDC_ENABLED: "true"`, the Compute CompositeController webhook generates:

### 1. KafkaTopic Resources

One topic per configured collection:

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: tenant123-entries
  namespace: hosted-tenants
  labels:
    strimzi.io/cluster: kafka-cluster
    ns.mdn.io/tenant: tenant123
    ns.mdn.io/storage-account: storage-abc
    app.kubernetes.io/name: nightscout
    app.kubernetes.io/component: cdc-topic
spec:
  partitions: 3
  replicas: 3
  config:
    retention.ms: "604800000"  # 7 days
    compression.type: "snappy"
```

**Generated from tenant ConfigMap:**
```yaml
CDC_ENABLED: "true"
CDC_COLLECTIONS: "entries,treatments"
CDC_PARTITIONS_ENTRIES: "3"
CDC_PARTITIONS_TREATMENTS: "1"
CDC_RETENTION_MS: "604800000"
KAFKA_CLUSTER_NAME: "kafka-cluster"
KAFKA_TOPIC_REPLICAS: "3"
```

### 2. KafkaConnector Resource

One connector per tenant:

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaConnector
metadata:
  name: tenant123-mongodb-source
  namespace: hosted-tenants
  labels:
    strimzi.io/cluster: connect-cluster
    ns.mdn.io/tenant: tenant123
spec:
  class: io.debezium.connector.mongodb.MongoDbConnector
  tasksMax: 1
  config:
    mongodb.connection.string: "mongodb://tenant123-mongodb:27017"
    mongodb.user: "${file:/opt/kafka/external-config/mongodb-credentials/username}"
    mongodb.password: "${file:/opt/kafka/external-config/mongodb-credentials/password}"
    database.include.list: "nightscout"
    collection.include.list: "nightscout.entries,nightscout.treatments"
    topic.prefix: "tenant123"
    snapshot.mode: "initial"
```

**Generated from:**
- Tenant ConfigMap: `CDC_COLLECTIONS`, `CDC_TASKS_MAX`
- Storage Secret: MongoDB connection details
- Connect cluster: `KAFKA_CONNECT_CLUSTER_NAME`

---

## Configuration Reference

### Tenant ConfigMap Parameters

**Required when CDC enabled:**

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tenant-config
data:
  # CDC Feature Toggle
  CDC_ENABLED: "true"  # Set to "false" to disable CDC
  
  # Collections to Stream
  CDC_COLLECTIONS: "entries,treatments"  # Comma-separated list
  
  # Topic Configuration
  CDC_PARTITIONS_ENTRIES: "3"      # Partitions for entries topic
  CDC_PARTITIONS_TREATMENTS: "1"   # Partitions for treatments topic
  CDC_RETENTION_MS: "604800000"    # Retention: 7 days
  CDC_TASKS_MAX: "1"               # Connector parallelism
  
  # Cluster References
  KAFKA_CLUSTER_NAME: "kafka-cluster"
  KAFKA_CONNECT_CLUSTER_NAME: "connect-cluster"
  KAFKA_TOPIC_REPLICAS: "3"
```

**Optional parameters:**

```yaml
  # Advanced Connector Settings
  CDC_SNAPSHOT_MODE: "initial"     # initial, never, when_needed
  CDC_COMPRESSION_TYPE: "snappy"   # none, gzip, snappy, lz4, zstd
  CDC_MIN_INSYNC_REPLICAS: "2"     # Min in-sync replicas
  
  # Connector Behavior
  CDC_HEARTBEAT_INTERVAL_MS: "5000"
  CDC_POLL_INTERVAL_MS: "1000"
  CDC_MAX_BATCH_SIZE: "2048"
```

### Expected ConfigMap/Secret Injection

External infrastructure should ensure these are available:

```yaml
# Either injected into tenant ConfigMap or referenced
KAFKA_BOOTSTRAP_SERVERS: "kafka-cluster-kafka-bootstrap.kafka.svc:9092"
KAFKA_CONNECT_URL: "http://connect-cluster-connect-api.kafka.svc:8083"
```

---

## Validation and Health Checks

### Pre-flight Validation

Before generating CDC resources, webhooks should validate:

1. **Kafka connection reachable:**
   ```bash
   curl -f http://connect-cluster-connect-api.kafka.svc:8083/
   ```

2. **Strimzi CRDs installed:**
   ```bash
   kubectl get crd kafkatopics.kafka.strimzi.io
   kubectl get crd kafkaconnectors.kafka.strimzi.io
   ```

3. **Target cluster exists:**
   ```bash
   kubectl get kafka kafka-cluster -n kafka
   ```

4. **MongoDB credentials available:**
   ```bash
   kubectl get secret <storage-account>-app-credentials -n hosted-tenants
   ```

### Runtime Health Checks

Operational utilities in `container-images/ns-utility/scripts/lib/kafka-utils.sh`:

```bash
# Wait for topic creation
wait_for_kafka_topic "kafka-cluster-kafka-bootstrap:9092" "tenant123-entries"

# Check connector status
get_kafka_connector_status "http://connect-cluster-connect-api:8083" "tenant123-mongodb-source"

# Restart failed connector
restart_kafka_connector "http://connect-cluster-connect-api:8083" "tenant123-mongodb-source"
```

### Webhook Status Reporting

When CDC infrastructure is missing, webhooks return:

```json
{
  "status": {
    "conditions": [
      {
        "type": "Ready",
        "status": "False",
        "reason": "CDCInfrastructureMissing",
        "message": "KafkaTopic CRD not found. Ensure Strimzi Operator is installed."
      }
    ]
  }
}
```

**Common status reasons:**
- `CDCInfrastructureMissing` - Strimzi not installed
- `KafkaClusterNotFound` - Referenced cluster doesn't exist
- `ConnectClusterNotFound` - Connect cluster unavailable
- `MongoDBCredentialsMissing` - Can't find storage credentials

---

## Troubleshooting

### CDC Not Working for New Tenant

**Symptom:** Tenant ConfigMap has `CDC_ENABLED: "true"` but no topics/connectors created.

**Check:**

1. **Strimzi installed?**
   ```bash
   kubectl get crd kafkatopics.kafka.strimzi.io
   ```
   ❌ **If missing:** Install Strimzi Operator in external infrastructure

2. **Kafka cluster running?**
   ```bash
   kubectl get kafka -n kafka
   kubectl get pods -n kafka -l strimzi.io/cluster=kafka-cluster
   ```
   ❌ **If missing:** Deploy Kafka cluster in external infrastructure

3. **Webhook has RBAC?**
   ```bash
   kubectl auth can-i create kafkatopics --as=system:serviceaccount:default:webhook-metacontroller
   ```
   ❌ **If no:** Check `jsonnet/lib-k8s-multienv/rbac.libsonnet` includes Kafka permissions

4. **Webhook logs:**
   ```bash
   kubectl logs -n default deploy/gen4-webhooks | grep -i kafka
   ```

### Topics Created but Connector Fails

**Symptom:** `KafkaTopic` exists but `KafkaConnector` is `FAILED`.

**Check connector status:**
```bash
kubectl get kafkaconnector tenant123-mongodb-source -o yaml
```

**Common issues:**

1. **MongoDB not reachable:**
   ```yaml
   status:
     connectorStatus:
       connector:
         state: FAILED
       tasks: []
   ```
   ✅ **Fix:** Ensure MongoDB Service exists and is ready

2. **Credentials invalid:**
   ```
   connector.state: FAILED
   message: "Authentication failed"
   ```
   ✅ **Fix:** Check `<storage-account>-app-credentials` Secret has correct username/password

3. **Collections don't exist:**
   ```
   message: "Collection nightscout.entries not found"
   ```
   ✅ **Fix:** Collections are created on first write; insert test data into MongoDB

### No Data Flowing to Topics

**Symptom:** Connector is `RUNNING` but no messages in topics.

**Check:**

1. **Connector actually running?**
   ```bash
   kubectl get kafkaconnector tenant123-mongodb-source -o jsonpath='{.status.connectorStatus.connector.state}'
   # Should output: RUNNING
   ```

2. **Messages in topic?**
   ```bash
   # From inside Kafka pod:
   kafka-console-consumer.sh \
     --bootstrap-server kafka-cluster-kafka-bootstrap:9092 \
     --topic tenant123-entries \
     --from-beginning \
     --max-messages 10
   ```

3. **MongoDB oplog enabled?**
   ```bash
   # Connect to MongoDB:
   rs.status()  # Should show replica set
   ```
   ❌ **If not replica set:** CDC requires MongoDB replica set for oplog

---

## Migration Checklist

### For New Deployments (Greenfield)

**External Infrastructure Team (sysctl):**
- [ ] Install Strimzi Operator
- [ ] Deploy Kafka cluster
- [ ] Deploy KafkaConnect cluster with MongoDB plugin
- [ ] Create `kafka-connection-info` ConfigMap in tenant namespace
- [ ] Verify connectivity from tenant namespace to Kafka

**node-multienv Team:**
- [ ] Ensure RBAC includes `kafkatopics` and `kafkaconnectors` permissions
- [ ] Test CDC-enabled tenant ConfigMap
- [ ] Verify topics and connectors are created
- [ ] Validate data flows to topics

### For Existing Deployments (Adding CDC)

**External Infrastructure Team:**
- [ ] Install Strimzi alongside existing infrastructure
- [ ] Deploy Kafka cluster in separate namespace
- [ ] Export connection details to tenant namespaces
- [ ] Document migration plan for existing tenants

**node-multienv Team:**
- [ ] Update webhook to validate Kafka availability
- [ ] Add status conditions for missing infrastructure
- [ ] Roll out CDC enablement gradually (per tenant)
- [ ] Monitor connector health

---

## Security Considerations

### Credentials

**MongoDB Credentials:**
- Stored in `<storage-account>-app-credentials` Secret
- Referenced by KafkaConnector via external config
- Never exposed in KafkaConnector manifest

**Kafka Authentication (if enabled):**
- Bootstrap server credentials in Secret
- SASL/SCRAM or mTLS authentication
- Managed by external infrastructure

### Network Policies

**Recommended policies:**

1. **Kafka → MongoDB:** Allow Connect pods to reach MongoDB Services
2. **Webhook → Kafka API:** Allow webhook to query Connect REST API for health checks
3. **Cross-namespace:** Restrict tenant workloads from accessing Kafka directly

### RBAC Boundaries

**node-multienv webhook can:**
- ✅ Create/update `KafkaTopic` in tenant namespace
- ✅ Create/update `KafkaConnector` in tenant namespace
- ✅ Read Kafka connection ConfigMaps

**node-multienv webhook cannot:**
- ❌ Delete Kafka cluster resources
- ❌ Modify Connect cluster configuration
- ❌ Access other tenants' topics/connectors
- ❌ Perform cluster-admin operations

---

## Reference Implementation

### Example Tenant with CDC

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: example-tenant
  namespace: hosted-tenants
  labels:
    ns.mdn.io/tenant: example-tenant
    ns.mdn.io/storage-account: storage-abc
data:
  # Nightscout configuration
  DISPLAY_UNITS: "mg/dl"
  ENABLE: "careportal basal"
  
  # CDC Configuration
  CDC_ENABLED: "true"
  CDC_COLLECTIONS: "entries,treatments,devicestatus"
  CDC_PARTITIONS_ENTRIES: "6"
  CDC_PARTITIONS_TREATMENTS: "2"
  CDC_PARTITIONS_DEVICESTATUS: "2"
  CDC_RETENTION_MS: "2592000000"  # 30 days
  CDC_TASKS_MAX: "2"
  
  # Cluster references (injected by infrastructure)
  KAFKA_CLUSTER_NAME: "kafka-cluster"
  KAFKA_CONNECT_CLUSTER_NAME: "connect-cluster"
  KAFKA_BOOTSTRAP_SERVERS: "kafka-cluster-kafka-bootstrap.kafka.svc:9092"
  KAFKA_CONNECT_URL: "http://connect-cluster-connect-api.kafka.svc:8083"
```

### Generated Resources

**Topics:**
```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: example-tenant-entries
  labels:
    strimzi.io/cluster: kafka-cluster
    ns.mdn.io/tenant: example-tenant
spec:
  partitions: 6
  replicas: 3
---
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: example-tenant-treatments
  labels:
    strimzi.io/cluster: kafka-cluster
    ns.mdn.io/tenant: example-tenant
spec:
  partitions: 2
  replicas: 3
```

**Connector:**
```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaConnector
metadata:
  name: example-tenant-mongodb-source
  labels:
    strimzi.io/cluster: connect-cluster
    ns.mdn.io/tenant: example-tenant
spec:
  class: io.debezium.connector.mongodb.MongoDbConnector
  tasksMax: 2
  config:
    topic.prefix: "example-tenant"
    mongodb.connection.string: "mongodb://storage-abc-mongodb:27017"
    collection.include.list: "nightscout.entries,nightscout.treatments,nightscout.devicestatus"
```

---

## Summary

**Clear Scope Boundary:**

| Responsibility | Owner | Details |
|----------------|-------|---------|
| Strimzi Operator | External Infra | Installation, upgrades, CRD management |
| Kafka Cluster | External Infra | Brokers, Zookeeper, storage, networking |
| KafkaConnect Cluster | External Infra | Workers, plugins, global config |
| Connection Endpoints | External Infra | ConfigMaps/Secrets with URLs, credentials |
| Per-Tenant Topics | **node-multienv** | Generate `KafkaTopic` based on ConfigMap |
| Per-Tenant Connectors | **node-multienv** | Generate `KafkaConnector` with MongoDB config |
| Operational Scripts | **node-multienv** | Health checks, connector restart utilities |
| Status Reporting | **node-multienv** | Webhook conditions when infra missing |

**Integration succeeds when:**
- External infrastructure provides running Kafka + Connect clusters
- Connection details exported to tenant namespaces
- node-multienv generates tenant resources against that platform
- Both teams validate against this contract

---

## See Also

- [Two-Composite Architecture](TWO-COMPOSITE-ARCHITECTURE.md) - Overall system design
- [RBAC Design](RBAC-DESIGN.md) - Permissions model
- [Metacontroller Integration](METACONTROLLER-INTEGRATION.md) - Webhook patterns
- [Container Parameters](CONTAINER-PARAMETERS.md) - Environment variables
