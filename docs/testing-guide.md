# Testing Guide

## Local Testing

### Unit Testing Webhooks

Test webhook handlers locally without Kubernetes:

```bash
# Start webhook server
npm run webhook

# Test composite sync
curl -X POST http://localhost:3000/composite/sync \
  -H "Content-Type: application/json" \
  -d @test/fixtures/composite-sync-request.json

# Test decorator sync
curl -X POST http://localhost:3000/decorator/sync \
  -H "Content-Type: application/json" \
  -d @test/fixtures/decorator-sync-request.json
```

### Integration Testing

1. **Deploy webhook to cluster:**
```bash
kubectl apply -f k8s/metactl/webhook-deployment.yaml
```

2. **Install Metacontroller CRDs:**
```bash
kubectl apply -f k8s/metactl/composite-controller.yaml
kubectl apply -f k8s/metactl/decorator-controller.yaml
```

3. **Create test tenant:**
```bash
kubectl apply -f k8s/metactl/example-tenant.yaml
```

4. **Verify resources created:**
```bash
# Check all resources for tenant
kubectl get all,pvc,kafkatopic,kafkaconnector -l ns.mdn.io/tenant=demo

# Expected output:
# - Secret: ns-mongo-auth
# - Service: ns-mongo (headless), nightscout
# - StatefulSet: ns-mongo
# - Deployment: nightscout
# - PodDisruptionBudget: ns-mongo-pdb, nightscout-pdb
# - KafkaTopic: ns.demo.entries, ns.demo.treatments, dlq.ns.demo
# - KafkaConnector: ns-demo-source (after MongoDB ready)
```

5. **Check tenant status:**
```bash
kubectl get cm tenant-demo-config -o yaml
```

## Test Scenarios

### Scenario 1: Basic Tenant Creation
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: test-basic
  labels:
    ns.mdn.io/enabled: "true"
data:
  TENANT_ID: "basic"
  NS_IMAGE: "nightscout/cgm-remote-monitor:latest"
  MONGO_STORAGE_GI: "5"
  CDC_ENABLED: "false"
```

**Expected:**
- MongoDB resources created
- Nightscout resources created
- No Kafka resources
- Status shows mongo.ready after ~30s

### Scenario 2: CDC-Enabled Tenant
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: test-cdc
  labels:
    ns.mdn.io/enabled: "true"
data:
  TENANT_ID: "cdc"
  CDC_ENABLED: "true"
  CDC_COLLECTIONS: "entries"
  CDC_PARTITIONS_ENTRIES: "1"
```

**Expected:**
- All basic resources created
- KafkaTopic created immediately
- KafkaConnector created after MongoDB ready
- Status shows connector state

### Scenario 3: Tenant Deletion
```bash
kubectl delete cm test-basic
```

**Expected:**
1. Finalize webhook called
2. KafkaConnector paused (if exists)
3. Nightscout scaled to 0
4. Decorator finalizes PVC (creates snapshot)
5. All resources deleted

### Scenario 4: PVC Backup Protection
```bash
# Manually delete PVC
kubectl delete pvc data-ns-mongo-0
```

**Expected:**
1. Decorator finalize webhook called
2. VolumeSnapshot created
3. Wait for snapshot ready
4. Finalizer removed
5. PVC deletes

## Validation Checklist

### Composite Controller
- [ ] MongoDB StatefulSet created
- [ ] MongoDB service is headless (ClusterIP: None)
- [ ] MongoDB replica set initialized
- [ ] Nightscout deployment created
- [ ] PodDisruptionBudgets created
- [ ] KafkaTopics created (if CDC enabled)
- [ ] KafkaConnector created after MongoDB ready
- [ ] Status updated correctly

### Decorator Controller
- [ ] PVC gets backup annotations
- [ ] Finalizer `mdn.io/backup-protect` added
- [ ] VolumeSnapshot created on deletion
- [ ] Finalizer removed after snapshot ready
- [ ] PVC deletion completes

## Debugging

### View Webhook Logs
```bash
kubectl logs -l app=webhook-service -f
```

### View Metacontroller Logs
```bash
kubectl logs -n metacontroller -l app=metacontroller -f
```

### Check Resource Events
```bash
kubectl get events --sort-by='.lastTimestamp'
```

### Describe Resources
```bash
kubectl describe cm tenant-demo-config
kubectl describe sts ns-mongo
kubectl describe kafkaconnector ns-demo-source
```

## Performance Testing

### Load Test: Multiple Tenants
```bash
for i in {1..10}; do
  cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: tenant-load-$i
  labels:
    ns.mdn.io/enabled: "true"
data:
  TENANT_ID: "load$i"
  MONGO_STORAGE_GI: "5"
  CDC_ENABLED: "true"
EOF
done
```

**Monitor:**
- Webhook response times
- Resource creation latency
- MongoDB readiness time
- Connector creation time

### Cleanup
```bash
kubectl delete cm -l ns.mdn.io/enabled=true
```

## SLOs

| Metric | Target | Description |
|--------|--------|-------------|
| Webhook Response Time | < 1s | Time to process sync request |
| MongoDB Ready Time | < 60s | Time for MongoDB to be ready |
| Connector Creation | < 30s | Time to create connector after MongoDB ready |
| Snapshot Creation | < 120s | Time to create and ready VolumeSnapshot |
| Finalization | < 180s | Time to complete tenant deletion |
