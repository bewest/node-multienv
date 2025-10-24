# Nightscout Multi-Tenant Kubernetes Platform

## Overview
Kubernetes-based multi-tenant Nightscout platform using Metacontroller to manage tenant deployments with MongoDB, CDC via Strimzi Kafka, and automated backup handling.

**Last Updated:** 2025-10-24

## Architecture

### Controllers (via Metacontroller)

#### 1. CompositeController (Tenant Orchestration)
- **Parent Resource:** ConfigMap with label `ns.mdn.io/enabled: "true"`
- **Manages:** Nightscout deployment, MongoDB StatefulSet, Kafka topics, Kafka connectors
- **Webhook Endpoints:**
  - `POST /composite/sync` - Renders all tenant resources
  - `POST /composite/finalize` - Cleanup on deletion (pause connector, scale down)

#### 2. DecoratorController (PVC Backup Policy)
- **Target:** PVCs for tenant MongoDB storage
- **Purpose:** Enforce backup policies and protect against premature deletion
- **Webhook Endpoints:**
  - `POST /decorator/sync` - Inject backup annotations and finalizer
  - `POST /decorator/finalize` - Create snapshots before allowing PVC deletion

### Key Technologies
- **Kubernetes:** Orchestration platform
- **Metacontroller:** Webhook-based custom controller framework
- **Strimzi:** Kafka operator for CDC
- **MongoDB:** Tenant databases (1-replica RS per tenant)
- **Node.js + Express:** Webhook server implementation
- **@kubernetes/client-node:** Kubernetes API client

### Project Structure
```
/cmd/webhook/          # Node.js webhook server
/k8s/metactl/          # Metacontroller manifests
/docs/                 # Documentation and runbooks
/lib/webhook/          # Existing webhook handlers
/metacontroller/       # Existing metacontroller resources
```

## Recent Changes
- 2025-10-24: Initial specification for CDC-enabled tenant management

## Tenant Configuration

### Parent ConfigMap Contract
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  labels:
    ns.mdn.io/enabled: "true"
  name: tenant-a-config
data:
  TENANT_ID: "tenantA"
  NS_IMAGE: "nightscout/cgm-remote-monitor:latest"
  MONGO_STORAGE_GI: "10"
  MONGO_SC: "fast-encrypted"
  CDC_ENABLED: "true"
  CDC_COLLECTIONS: "entries,treatments"
  CDC_PARTITIONS_ENTRIES: "3"
  CDC_PARTITIONS_TREATMENTS: "1"
  CDC_RETENTION_MS: "604800000"
```

### Rendered Children
1. **Secret** - MongoDB authentication
2. **Service** - MongoDB headless service
3. **StatefulSet** - MongoDB (1 replica with RS init)
4. **Deployment + Service** - Nightscout application
5. **PodDisruptionBudgets** - For both MongoDB and Nightscout
6. **KafkaTopic** (Strimzi) - CDC topics per tenant
7. **KafkaConnector** (Strimzi) - MongoDB source connector (created when Mongo ready)

## Development

### Running Locally
```bash
npm install
npm start
```

### Webhook Server
- Listens on port 3000
- Implements Metacontroller webhook protocol
- Manages Kubernetes resources via client-node API

## Integration Requirements

### Strimzi Setup (cluster-wide)
- Kafka or Redpanda cluster running
- KafkaConnect CR with `strimzi.io/use-connector-resources: "true"`
- MongoDB Source connector plugin available
- Optional: externalConfiguration for per-tenant Mongo URIs

### Storage
- StorageClass supporting VolumeSnapshots
- CSI driver with snapshot capabilities

## Backup Strategy
- **Policy Types:** snapshot, snapshot+logical, skip
- **Default TTL:** 30 days
- **Finalizer:** `mdn.io/backup-protect` prevents premature PVC deletion
- **Process:** Create VolumeSnapshot → Wait for ready → Remove finalizer

## User Preferences
- Prefer Node.js/JavaScript for webhook implementation
- Use existing @kubernetes/client-node library
- Follow Metacontroller webhook protocol specifications
