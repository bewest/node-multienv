# Webhook Server Setup Guide

## Overview
The webhook server implements Metacontroller hooks for managing Nightscout tenants with CDC capabilities.

## Architecture

### Endpoints

#### Composite Controller Endpoints
- `POST /composite/sync` - Synchronization hook for tenant resources
- `POST /composite/finalize` - Cleanup hook for tenant deletion

#### Decorator Controller Endpoints
- `POST /decorator/sync` - PVC annotation and finalizer injection
- `POST /decorator/finalize` - Backup creation before PVC deletion

### Resource Flow

#### Tenant Creation (Composite Sync)
1. Parent ConfigMap created with `ns.mdn.io/enabled: "true"` label
2. Webhook receives sync request
3. Renders MongoDB resources:
   - Secret for authentication
   - Headless Service
   - StatefulSet with replica set initialization
   - PodDisruptionBudget
4. Renders Nightscout resources:
   - Deployment
   - Service
   - PodDisruptionBudget
5. If CDC enabled:
   - Renders KafkaTopic resources
   - After MongoDB ready: renders KafkaConnector

#### Tenant Deletion (Composite Finalize)
1. Webhook receives finalize request
2. Pauses KafkaConnector (`spec.pause: true`)
3. Waits for connector tasks to idle
4. Deletes KafkaConnector
5. Scales Nightscout to 0 replicas
6. Returns finalized status

#### PVC Protection (Decorator)
1. PVC created by MongoDB StatefulSet
2. Decorator sync adds:
   - `mdn.io/backup-protect` finalizer
   - `ns.mdn.io/backup-policy` annotation (default: "snapshot")
   - `ns.mdn.io/backup-ttl` annotation (default: "30d")
3. On deletion:
   - Decorator finalize creates VolumeSnapshot
   - Waits for snapshot ready
   - Removes finalizer to allow PVC deletion

## Local Development

### Prerequisites
- Node.js 18+
- Access to Kubernetes cluster (for testing)
- Metacontroller installed in cluster

### Running Locally
```bash
# Install dependencies
npm install

# Start webhook server
npm run webhook

# Server listens on port 3000
```

### Environment Variables
- `PORT` - Server port (default: 3000)

## Deployment

### Building Container
```bash
docker build -t your-registry/webhook:latest .
kubectl apply -f k8s/metactl/webhook-deployment.yaml
```

### Installing Controllers
```bash
# Apply Metacontroller CRDs
kubectl apply -f k8s/metactl/composite-controller.yaml
kubectl apply -f k8s/metactl/decorator-controller.yaml
```

### Testing with Example Tenant
```bash
kubectl apply -f k8s/metactl/example-tenant.yaml
kubectl get all -l ns.mdn.io/tenant=demo
```

## Troubleshooting

### Webhook Not Receiving Requests
- Check webhook service is running: `kubectl get pods -l app=webhook-service`
- Check service endpoint: `kubectl get svc webhook-service`
- Review Metacontroller logs: `kubectl logs -n metacontroller -l app=metacontroller`

### MongoDB Not Ready
- Check StatefulSet status: `kubectl get sts ns-mongo`
- Check pod logs: `kubectl logs ns-mongo-0`
- Verify PVC is bound: `kubectl get pvc`

### Connector Not Created
- Verify MongoDB is ready (check status on parent ConfigMap)
- Check Strimzi operator logs
- Verify KafkaConnect cluster is ready

### Snapshot Creation Fails
- Verify VolumeSnapshotClass exists: `kubectl get volumesnapshotclass`
- Check CSI driver supports snapshots
- Review storage class capabilities

## Configuration

### Parent ConfigMap Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| TENANT_ID | Yes | - | Unique tenant identifier |
| NS_IMAGE | No | nightscout/cgm-remote-monitor:latest | Nightscout container image |
| MONGO_STORAGE_GI | No | 10 | MongoDB storage size in GiB |
| MONGO_SC | No | standard | StorageClass for MongoDB PVC |
| CDC_ENABLED | No | false | Enable Kafka CDC |
| CDC_COLLECTIONS | No | entries,treatments | Collections to capture |
| CDC_PARTITIONS_ENTRIES | No | 3 | Partitions for entries topic |
| CDC_PARTITIONS_TREATMENTS | No | 1 | Partitions for treatments topic |
| CDC_RETENTION_MS | No | 604800000 | Topic retention (7 days) |

### Backup Policies

- `snapshot` - Create VolumeSnapshot only (default)
- `snapshot+logical` - Create snapshot + mongodump
- `skip` - No backup, allow immediate deletion

## Monitoring

### Health Check
```bash
curl http://webhook-service:3000/health
```

### Metrics
Check parent ConfigMap status:
```bash
kubectl get cm tenant-demo-config -o jsonpath='{.status}'
```

Expected status fields:
- `.status.mongo.ready` - MongoDB readiness
- `.status.connector.name` - Connector name
- `.status.connector.state` - Connector state (RUNNING, PAUSED, etc.)
