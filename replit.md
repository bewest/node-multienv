# Nightscout Multi-Tenant Kubernetes Platform

## Overview
Production-ready Kubernetes multi-tenant Nightscout platform using Metacontroller to manage tenant deployments with MongoDB, CDC via Strimzi Kafka, and automated backup handling. All tenants run in the `hosted-tenants` namespace with tenant-prefixed resources.

**Last Updated:** 2025-10-25

## Architecture

### Multi-Tenant Design
- **Namespace:** All tenants run in a single `hosted-tenants` namespace
- **Resource Naming:** All resources prefixed with tenant ID (e.g., `demo-mongo`, `demo-nightscout`)
- **Isolation:** Tenant-aware selectors and labels prevent cross-tenant interference
- **Standard Labels:** All resources follow Kubernetes recommended labels specification

### Controllers (via Metacontroller)

#### 1. CompositeController (Tenant Orchestration)
- **Parent Resource:** ConfigMap with label `ns.mdn.io/enabled: "true"`
- **Namespace:** `hosted-tenants`
- **Manages:** Nightscout deployment, MongoDB StatefulSet, Kafka topics, Kafka connectors
- **Webhook Endpoints:**
  - `POST /composite/sync` - Renders all tenant resources (11 children per tenant)
  - `POST /composite/finalize` - Cleanup on deletion (pause connector, scale down)

#### 2. DecoratorController (PVC Backup Policy)
- **Target:** PVCs for tenant MongoDB storage (tenant-aware selector)
- **Purpose:** Enforce backup policies and protect against premature deletion
- **Webhook Endpoints:**
  - `POST /decorator/sync` - Inject backup annotations and finalizer
  - `POST /decorator/finalize` - Create VolumeSnapshots before allowing PVC deletion

### Key Technologies
- **Kubernetes:** Orchestration platform
- **Metacontroller:** Webhook-based custom controller framework
- **Strimzi:** Kafka operator for CDC
- **MongoDB:** Tenant databases (configurable replicas, default 1-replica RS per tenant)
- **Node.js + Express:** Webhook server implementation
- **@kubernetes/client-node:** Kubernetes API client

### Project Structure
```
/cmd/webhook/          # Node.js webhook server
  /handlers/           # Webhook request handlers
    composite-sync.js  # Tenant resource orchestration
    composite-finalize.js
    decorator-sync.js  # PVC backup policy
    decorator-finalize.js
    resources.js       # Resource rendering functions
/k8s/metactl/          # Metacontroller manifests
  composite-controller.yaml
  decorator-controller.yaml
  example-tenant-basic.yaml
  example-tenant-premium.yaml
/test/                 # Test fixtures and scripts
/docs/                 # Documentation and runbooks
  LABELS-AND-ANNOTATIONS.md
```

## Recent Changes
- **2025-10-25:** 
  - Added complete standard Kubernetes labels to all resources (including version)
  - Implemented tenant-prefixed naming for multi-tenant namespace deployment
  - Added 18 new ConfigMap parameters for infrastructure, resource sizing, and tenant tiers
  - Fixed finalizer prefix to `ns.mdn.io/backup-protect`
  - Made DecoratorController tenant-aware to prevent cross-tenant PVC decoration
  - Added version labels extracted from container images and API versions
- **2025-10-24:** Initial specification for CDC-enabled tenant management

## Tenant Configuration

### ConfigMap Parameters (18 total)

#### Core Configuration
- **TENANT_ID** (required): Unique tenant identifier, used as resource name prefix
- **NS_IMAGE**: Nightscout container image with version tag (default: `nightscout/cgm-remote-monitor:latest`)
- **MONGO_IMAGE**: MongoDB container image with version tag (default: `mongo:6`)
- **MONGO_STORAGE_GI**: MongoDB PVC storage size in Gi (default: `10`)
- **MONGO_SC**: StorageClass for MongoDB PVC (default: `standard`)

#### Infrastructure References
- **KAFKA_CLUSTER_NAME**: Strimzi Kafka cluster name (default: `kafka-cluster`)
- **KAFKA_CONNECT_CLUSTER_NAME**: Strimzi KafkaConnect cluster name (default: `connect-cluster`)
- **BACKUP_SNAPSHOT_CLASS**: VolumeSnapshotClass for backups (default: `csi-snapclass`)

#### Resource Sizing (Tenant Tiers)
- **MONGO_REPLICAS**: MongoDB StatefulSet replicas (default: `1`)
- **MONGO_CPU_REQUEST**: MongoDB CPU request (default: `500m`)
- **MONGO_CPU_LIMIT**: MongoDB CPU limit (default: `1000m`)
- **MONGO_MEM_REQUEST**: MongoDB memory request (default: `512Mi`)
- **MONGO_MEM_LIMIT**: MongoDB memory limit (default: `1Gi`)
- **NS_REPLICAS**: Nightscout Deployment replicas (default: `2`)
- **NS_CPU_REQUEST**: Nightscout CPU request (default: `100m`)
- **NS_CPU_LIMIT**: Nightscout CPU limit (default: `500m`)
- **NS_MEM_REQUEST**: Nightscout memory request (default: `128Mi`)
- **NS_MEM_LIMIT**: Nightscout memory limit (default: `512Mi`)
- **NS_SERVICE_TYPE**: Nightscout Service type (default: `ClusterIP`, options: `LoadBalancer`, `NodePort`)

#### CDC Configuration
- **CDC_ENABLED**: Enable Change Data Capture (default: `true`)
- **CDC_COLLECTIONS**: Comma-separated list of collections to capture (default: `entries,treatments`)
- **CDC_PARTITIONS_ENTRIES**: Kafka topic partitions for entries (default: `3`)
- **CDC_PARTITIONS_TREATMENTS**: Kafka topic partitions for treatments (default: `1`)
- **CDC_RETENTION_MS**: Kafka topic retention in milliseconds (default: `604800000` = 7 days)
- **CDC_VERSION**: CDC/Kafka API version for labels (default: `v1beta2`)
- **CDC_TASKS_MAX**: KafkaConnector tasks.max (default: `1`)
- **CDC_URI_KEY**: Optional external configuration key for MongoDB URI
- **KAFKA_TOPIC_REPLICAS**: Kafka topic replication factor (default: `3`)

### Example: Basic Tier Tenant
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  namespace: hosted-tenants
  name: demo-config
  labels:
    ns.mdn.io/enabled: "true"
    ns.mdn.io/tier: "basic"
data:
  TENANT_ID: "demo"
  NS_IMAGE: "nightscout/cgm-remote-monitor:latest"
  MONGO_IMAGE: "mongo:6"
  MONGO_STORAGE_GI: "10"
  MONGO_REPLICAS: "1"
  NS_REPLICAS: "2"
  CDC_ENABLED: "true"
```

### Example: Premium Tier Tenant
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  namespace: hosted-tenants
  name: premium-tenant-config
  labels:
    ns.mdn.io/enabled: "true"
    ns.mdn.io/tier: "premium"
data:
  TENANT_ID: "premium-tenant"
  NS_IMAGE: "nightscout/cgm-remote-monitor:15.0.0"
  MONGO_IMAGE: "mongo:7"
  MONGO_STORAGE_GI: "50"
  MONGO_REPLICAS: "3"
  MONGO_CPU_REQUEST: "1000m"
  MONGO_CPU_LIMIT: "2000m"
  MONGO_MEM_REQUEST: "2Gi"
  MONGO_MEM_LIMIT: "4Gi"
  NS_REPLICAS: "3"
  NS_CPU_REQUEST: "250m"
  NS_CPU_LIMIT: "1000m"
  NS_MEM_REQUEST: "256Mi"
  NS_MEM_LIMIT: "1Gi"
  NS_SERVICE_TYPE: "LoadBalancer"
  CDC_PARTITIONS_ENTRIES: "6"
  KAFKA_TOPIC_REPLICAS: "3"
```

### Rendered Children (11 resources per tenant)
1. **Secret** (`{tenantId}-mongo-auth`) - MongoDB authentication
2. **Service** (`{tenantId}-mongo`) - MongoDB headless service
3. **StatefulSet** (`{tenantId}-mongo`) - MongoDB with configurable replicas
4. **PodDisruptionBudget** (`{tenantId}-mongo-pdb`) - MongoDB availability
5. **Deployment** (`{tenantId}-nightscout`) - Nightscout application
6. **Service** (`{tenantId}-nightscout`) - Nightscout service
7. **PodDisruptionBudget** (`{tenantId}-nightscout-pdb`) - Nightscout availability
8. **KafkaTopic** (`ns.{tenantId}.entries`) - CDC entries topic
9. **KafkaTopic** (`ns.{tenantId}.treatments`) - CDC treatments topic
10. **KafkaTopic** (`dlq.ns.{tenantId}`) - Dead letter queue
11. **KafkaConnector** (`{tenantId}-cdc-source`) - MongoDB CDC connector (created only when MongoDB ready)

### Standard Kubernetes Labels
All resources include the recommended Kubernetes labels:
- `app.kubernetes.io/name`: Component name (e.g., `mongodb`, `nightscout`, `kafka-topic`)
- `app.kubernetes.io/component`: Component type (e.g., `database`, `application`, `messaging`)
- `app.kubernetes.io/part-of`: `nightscout-tenant`
- `app.kubernetes.io/instance`: Tenant ID
- `app.kubernetes.io/version`: Extracted from container image tags or API version
- `app.kubernetes.io/managed-by`: `metacontroller`
- `ns.mdn.io/tenant`: Tenant ID (custom label)

## Development

### Running Locally
```bash
npm install
npm run webhook
```

### Webhook Server
- Listens on port 3000
- Implements Metacontroller webhook protocol
- Manages Kubernetes resources via client-node API
- Health check: `GET /health`

### Testing
```bash
# Run all webhook tests
./test/test-webhooks.sh

# Test individual endpoints
curl -X POST http://localhost:3000/composite/sync -H "Content-Type: application/json" -d @test/fixtures/composite-sync-mongo-ready.json
curl -X POST http://localhost:3000/decorator/finalize -H "Content-Type: application/json" -d @test/fixtures/decorator-finalize-request.json
```

## Integration Requirements

### Strimzi Setup (cluster-wide)
- Kafka or Redpanda cluster running
- KafkaConnect CR with `strimzi.io/use-connector-resources: "true"`
- MongoDB Source connector plugin available
- Optional: externalConfiguration for per-tenant Mongo URIs

### Storage
- StorageClass supporting VolumeSnapshots
- CSI driver with snapshot capabilities
- Configured VolumeSnapshotClass

## Backup Strategy
- **Policy Types:** `snapshot`, `snapshot+logical`, `skip`
- **Default TTL:** 30 days
- **Finalizer:** `ns.mdn.io/backup-protect` prevents premature PVC deletion
- **Process:** Create VolumeSnapshot → Wait for ready → Remove finalizer
- **VolumeSnapshots:** Include complete standard labels with version extracted from PVC

## Production Deployment

### Prerequisites
1. Kubernetes cluster with Metacontroller installed
2. Strimzi Kafka operator deployed
3. CSI driver with snapshot support
4. `hosted-tenants` namespace created

### Deploy Webhook Server
```bash
# Build and deploy webhook server
kubectl apply -f k8s/metactl/webhook-deployment.yaml

# Deploy Metacontroller resources
kubectl apply -f k8s/metactl/composite-controller.yaml
kubectl apply -f k8s/metactl/decorator-controller.yaml
```

### Create Tenant
```bash
# Apply tenant ConfigMap
kubectl apply -f k8s/metactl/example-tenant-basic.yaml

# Verify resources created
kubectl get all,kafkatopic,kafkaconnector -n hosted-tenants -l ns.mdn.io/tenant=demo
```

## User Preferences
- Prefer Node.js/JavaScript for webhook implementation
- Use existing @kubernetes/client-node library
- Follow Metacontroller webhook protocol specifications
- Follow Kubernetes recommended labels and annotations
- Support tenant tiers via ConfigMap parameterization
