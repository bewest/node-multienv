# Migration Guide: Legacy Controller → Metacontroller

## Overview

This guide helps you safely migrate existing tenants from your legacy controller system to the new Metacontroller-based platform without downtime.

## Migration Strategy: Shadow ConfigMaps

We use a **parallel deployment approach** where both systems run simultaneously during the migration period.

### Architecture During Migration

```
┌─────────────────────────────────────────────────────────────┐
│                    Kubernetes Cluster                        │
│                                                              │
│  ┌────────────────────┐         ┌────────────────────┐     │
│  │  default namespace │         │ hosted-tenants ns  │     │
│  │                    │         │                    │     │
│  │  ┌──────────────┐  │         │  ┌──────────────┐  │     │
│  │  │ Legacy CM    │  │         │  │  New CM      │  │     │
│  │  │ (old label)  │  │         │  │ (new label)  │  │     │
│  │  └──────┬───────┘  │         │  └──────┬───────┘  │     │
│  │         │          │         │         │          │     │
│  └─────────┼──────────┘         └─────────┼──────────┘     │
│            │                              │                │
│            ▼                              ▼                │
│  ┌─────────────────┐           ┌─────────────────┐        │
│  │ Legacy          │           │ Metacontroller  │        │
│  │ Controller      │           │ Webhooks        │        │
│  └─────────────────┘           └─────────────────┘        │
└─────────────────────────────────────────────────────────────┘
```

## Migration Phases

### Phase 1: Preparation
**Goal:** Set up Metacontroller infrastructure without affecting existing tenants

1. Deploy Metacontroller to the cluster
2. Deploy webhook server
3. Create `hosted-tenants` namespace
4. Deploy CompositeController and DecoratorController

**Validation:**
```bash
# Verify Metacontroller is running
kubectl get pods -n metacontroller-system

# Verify webhook server is running
kubectl get pods -n hosted-tenants -l app=webhook-server

# Test webhook endpoints
kubectl port-forward -n hosted-tenants svc/webhook-server 3000:3000
curl http://localhost:3000/health
```

### Phase 2: Pilot Testing
**Goal:** Test with 1-2 non-critical tenants

1. Select pilot tenants (e.g., test/staging tenants)
2. Create new ConfigMaps in `hosted-tenants` namespace
3. Let Metacontroller provision resources
4. Validate functionality

**Example Pilot ConfigMap:**
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: pilot-tenant-config
  namespace: hosted-tenants
  labels:
    ns.mdn.io/enabled: "true"
    ns.mdn.io/tier: "basic"
    ns.mdn.io/migration-pilot: "true"
data:
  TENANT_ID: "pilot-tenant"
  NS_IMAGE: "nightscout/cgm-remote-monitor:latest"
  MONGO_IMAGE: "mongo:6"
  # ... other parameters
```

**Validation:**
```bash
# Check resources were created
kubectl get all,kafkatopic,kafkaconnector -n hosted-tenants -l ns.mdn.io/tenant=pilot-tenant

# Verify MongoDB is running
kubectl exec -n hosted-tenants pilot-tenant-mongo-0 -- mongosh --eval "rs.status()"

# Test Nightscout application
kubectl port-forward -n hosted-tenants svc/pilot-tenant-nightscout 8080:1337
curl http://localhost:8080/api/v1/status
```

### Phase 3: Tenant-by-Tenant Migration
**Goal:** Migrate production tenants gradually

For each tenant:

#### Step 1: Create Shadow ConfigMap
Create new ConfigMap in `hosted-tenants` namespace:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: demo-config
  namespace: hosted-tenants
  labels:
    ns.mdn.io/enabled: "true"
    ns.mdn.io/tier: "basic"
    ns.mdn.io/migration-from: "legacy"
  annotations:
    ns.mdn.io/legacy-configmap: "default/tenant-demo-legacy"
    ns.mdn.io/migration-date: "2025-10-25"
data:
  TENANT_ID: "demo"
  # Copy all settings from legacy ConfigMap
  # Add new parameters with defaults
  MONGO_IMAGE: "mongo:6"
  MONGO_REPLICAS: "1"
  NS_REPLICAS: "2"
  KAFKA_CLUSTER_NAME: "kafka-cluster"
  # ... etc
```

#### Step 2: Verify New Stack
```bash
# Wait for resources to be created
kubectl get all -n hosted-tenants -l ns.mdn.io/tenant=demo

# Check MongoDB is ready
kubectl wait --for=condition=ready pod/demo-mongo-0 -n hosted-tenants --timeout=300s

# Check Nightscout is running
kubectl get deployment demo-nightscout -n hosted-tenants
```

#### Step 3: Data Migration (if needed)
If the legacy tenant has existing data that needs to be migrated:

```bash
# Export from legacy MongoDB
kubectl exec -n default legacy-mongo-0 -- mongodump --db=demo --out=/tmp/backup

# Import to new MongoDB
kubectl cp /tmp/backup demo-mongo-0:/tmp/backup -n hosted-tenants
kubectl exec -n hosted-tenants demo-mongo-0 -- mongorestore --db=ns /tmp/backup/demo
```

#### Step 4: Switch Traffic
Update DNS, Ingress, or LoadBalancer to point to new service:

```bash
# Get new service endpoint
kubectl get svc demo-nightscout -n hosted-tenants

# Update Ingress (example)
kubectl patch ingress demo-ingress -n default --type=json \
  -p='[{"op": "replace", "path": "/spec/rules/0/http/paths/0/backend/service/name", "value":"demo-nightscout"}]'
```

#### Step 5: Monitor New Stack
```bash
# Watch pods
kubectl get pods -n hosted-tenants -l ns.mdn.io/tenant=demo -w

# Check logs
kubectl logs -n hosted-tenants deployment/demo-nightscout --tail=100

# Verify CDC is working
kubectl get kafkaconnector demo-cdc-source -n hosted-tenants
```

#### Step 6: Disable Legacy ConfigMap
Mark legacy ConfigMap as migrated:

```bash
kubectl label configmap tenant-demo-legacy -n default \
  legacy.io/tenant=false \
  legacy.io/migrated=true \
  --overwrite

kubectl annotate configmap tenant-demo-legacy -n default \
  legacy.io/migrated-to="hosted-tenants/demo-config" \
  legacy.io/migration-completed="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

### Phase 4: Cleanup
**Goal:** Remove legacy infrastructure after all tenants migrated

1. Verify all tenants are on new system
2. Disable legacy controller
3. Archive legacy ConfigMaps
4. Remove legacy controller deployment

```bash
# List all legacy ConfigMaps
kubectl get cm -n default -l legacy.io/migrated=true

# Archive (export to backup)
kubectl get cm -n default -l legacy.io/migrated=true -o yaml > legacy-configmaps-backup.yaml

# Scale down legacy controller
kubectl scale deployment legacy-controller -n default --replicas=0

# After monitoring period, delete legacy resources
kubectl delete deployment legacy-controller -n default
```

## Rollback Procedure

If issues occur during migration:

### Rollback Individual Tenant
```bash
# 1. Switch traffic back to legacy service
kubectl patch ingress demo-ingress -n default --type=json \
  -p='[{"op": "replace", "path": "/spec/rules/0/http/paths/0/backend/service/name", "value":"legacy-demo-service"}]'

# 2. Re-enable legacy ConfigMap
kubectl label configmap tenant-demo-legacy -n default \
  legacy.io/tenant=true --overwrite

# 3. Delete new ConfigMap (will clean up all resources)
kubectl delete configmap demo-config -n hosted-tenants
```

### Emergency Stop of New System
```bash
# Stop Metacontroller (pauses all operations)
kubectl scale deployment metacontroller -n metacontroller-system --replicas=0

# All legacy tenants continue operating normally
```

## Migration Checklist

### Pre-Migration
- [ ] Metacontroller deployed and healthy
- [ ] Webhook server deployed and tested
- [ ] `hosted-tenants` namespace created
- [ ] Pilot tenants successfully migrated
- [ ] Monitoring/alerting configured for new namespace
- [ ] Backup strategy validated

### Per-Tenant Migration
- [ ] Create shadow ConfigMap with correct parameters
- [ ] Verify all resources created (11 resources per tenant)
- [ ] MongoDB ready and initialized
- [ ] Nightscout deployment healthy
- [ ] Kafka topics created
- [ ] KafkaConnector running (if CDC enabled)
- [ ] Data migrated (if applicable)
- [ ] Traffic switched to new service
- [ ] Monitor for 24-48 hours
- [ ] Disable legacy ConfigMap
- [ ] Document completion

### Post-Migration
- [ ] All tenants on new system
- [ ] Legacy controller scaled to 0
- [ ] Legacy ConfigMaps archived
- [ ] Documentation updated
- [ ] Team trained on new system

## Label Strategy

### Legacy System Labels
```yaml
labels:
  legacy.io/tenant: "true"         # Active tenant
  legacy.io/migrated: "false"      # Not yet migrated
```

### New System Labels
```yaml
labels:
  ns.mdn.io/enabled: "true"        # Active in new system
  ns.mdn.io/tenant: "demo"         # Tenant ID
  ns.mdn.io/tier: "basic"          # Service tier
  ns.mdn.io/migration-from: "legacy"  # Migrated tenant
```

### During Migration
**Legacy ConfigMap** (after cutover):
```yaml
labels:
  legacy.io/tenant: "false"        # Disabled
  legacy.io/migrated: "true"       # Migration complete
annotations:
  legacy.io/migrated-to: "hosted-tenants/demo-config"
  legacy.io/migration-completed: "2025-10-25T12:00:00Z"
```

**New ConfigMap** (active):
```yaml
labels:
  ns.mdn.io/enabled: "true"
annotations:
  ns.mdn.io/legacy-configmap: "default/tenant-demo-legacy"
  ns.mdn.io/migration-date: "2025-10-25"
```

## Monitoring Migration Progress

### Query All Tenants by Status

```bash
# Legacy tenants (not yet migrated)
kubectl get cm -n default -l legacy.io/tenant=true,legacy.io/migrated!=true

# Migrated tenants (legacy)
kubectl get cm -n default -l legacy.io/migrated=true

# New system tenants
kubectl get cm -n hosted-tenants -l ns.mdn.io/enabled=true

# Tenants migrated from legacy
kubectl get cm -n hosted-tenants -l ns.mdn.io/migration-from=legacy
```

## Troubleshooting

### New Stack Not Creating Resources
```bash
# Check webhook server logs
kubectl logs -n hosted-tenants deployment/webhook-server --tail=100

# Check Metacontroller logs
kubectl logs -n metacontroller-system deployment/metacontroller --tail=100

# Verify ConfigMap has correct label
kubectl get cm demo-config -n hosted-tenants -o yaml | grep ns.mdn.io/enabled
```

### MongoDB Not Ready
```bash
# Check StatefulSet
kubectl describe statefulset demo-mongo -n hosted-tenants

# Check PVC
kubectl get pvc -n hosted-tenants -l ns.mdn.io/tenant=demo

# Check pod logs
kubectl logs demo-mongo-0 -n hosted-tenants
```

### KafkaConnector Not Created
```bash
# Verify MongoDB readiness (connector waits for MongoDB)
kubectl get statefulset demo-mongo -n hosted-tenants -o jsonpath='{.status.readyReplicas}'

# Check Strimzi KafkaConnect cluster
kubectl get kafkaconnect -n hosted-tenants

# Force reconciliation (patch ConfigMap to trigger webhook)
kubectl annotate cm demo-config -n hosted-tenants force-sync="$(date +%s)" --overwrite
```

## Best Practices

1. **Migrate During Low-Traffic Periods** - Schedule cutover during maintenance windows
2. **Start with Non-Critical Tenants** - Build confidence before production
3. **Monitor for 24-48 Hours** - Don't immediately delete legacy resources
4. **Document Each Migration** - Track dates, issues, resolutions
5. **Keep Legacy Controller Running** - Easy rollback if needed
6. **Batch Similar Tenants** - Group by tier/complexity
7. **Automate Where Possible** - Script the repetitive steps

## Timeline Example

### Week 1: Infrastructure Setup
- Deploy Metacontroller
- Deploy webhook server
- Test with synthetic tenants

### Week 2: Pilot Migration
- Migrate 2-3 test tenants
- Validate functionality
- Fix any issues

### Week 3-6: Production Migration
- Migrate 5-10 tenants per week
- Monitor and iterate
- Document lessons learned

### Week 7: Cleanup
- All tenants migrated
- Legacy controller disabled
- Documentation updated
