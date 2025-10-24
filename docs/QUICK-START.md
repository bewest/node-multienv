# Quick Start Guide

Get up and running with the Nightscout multi-tenant platform in under 5 minutes.

## Prerequisites

- Kubernetes cluster (1.24+)
- `kubectl` configured
- [Metacontroller](https://metacontroller.github.io/metacontroller/guide/install.html) installed

## Step 1: Deploy Webhook Server

```bash
# Option A: Local development
npm install
npm run webhook
# Webhook server running on http://localhost:3000

# Option B: Deploy to Kubernetes
docker build -t your-registry/webhook:latest .
docker push your-registry/webhook:latest

# Edit k8s/metactl/webhook-deployment.yaml to use your image
kubectl apply -f k8s/metactl/webhook-deployment.yaml

# Verify deployment
kubectl get pods -l app=webhook-service
kubectl logs -l app=webhook-service
```

## Step 2: Install Controllers

```bash
# Install CompositeController (tenant orchestration)
kubectl apply -f k8s/metactl/composite-controller.yaml

# Install DecoratorController (PVC backup protection)
kubectl apply -f k8s/metactl/decorator-controller.yaml

# Verify controllers are registered
kubectl get compositecontrollers
kubectl get decoratorcontrollers
```

## Step 3: Create Your First Tenant

```bash
# Apply example tenant
kubectl apply -f k8s/metactl/example-tenant.yaml

# Watch resources get created
kubectl get all,pvc -l ns.mdn.io/tenant=demo -w
```

Expected resources:
- Secret: `ns-mongo-auth`
- Service: `ns-mongo` (headless), `nightscout`
- StatefulSet: `ns-mongo`
- Deployment: `nightscout`
- PVC: `data-ns-mongo-0` (with backup finalizer)
- PodDisruptionBudgets: 2x

If CDC is enabled, you'll also see:
- KafkaTopics: `ns.demo.entries`, `ns.demo.treatments`, `dlq.ns.demo`
- KafkaConnector: `ns-demo-source` (appears after MongoDB is ready)

## Step 4: Verify Tenant Health

```bash
# Check tenant status
kubectl get cm tenant-demo-config -o jsonpath='{.status}' | jq

# Expected status:
# {
#   "mongo": { "ready": true },
#   "connector": { "name": "ns-demo-source", "state": "RUNNING" }
# }

# Check MongoDB is ready
kubectl get sts ns-mongo
kubectl logs ns-mongo-0

# Check Nightscout is running
kubectl get deploy nightscout
kubectl logs -l app.kubernetes.io/name=nightscout
```

## Step 5: Access Nightscout

```bash
# Port-forward to access locally
kubectl port-forward svc/nightscout 8080:80

# Open browser to http://localhost:8080
```

## Creating Additional Tenants

```yaml
# Create tenant-acme.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tenant-acme-config
  namespace: default
  labels:
    ns.mdn.io/enabled: "true"
data:
  TENANT_ID: "acme"
  MONGO_STORAGE_GI: "20"
  CDC_ENABLED: "true"
```

```bash
kubectl apply -f tenant-acme.yaml
kubectl get all -l ns.mdn.io/tenant=acme
```

## Deleting a Tenant

```bash
# Delete ConfigMap (triggers graceful cleanup)
kubectl delete cm tenant-demo-config

# What happens:
# 1. Connector is paused
# 2. Connector tasks stop
# 3. Nightscout scales to 0
# 4. VolumeSnapshot created for MongoDB PVC
# 5. All resources cleaned up
```

## Troubleshooting

### Webhook not receiving requests
```bash
# Check webhook service
kubectl get svc webhook-service
kubectl get endpoints webhook-service

# Check webhook logs
kubectl logs -l app=webhook-service -f

# Check Metacontroller logs
kubectl logs -n metacontroller -l app=metacontroller -f
```

### MongoDB not starting
```bash
# Check StatefulSet
kubectl describe sts ns-mongo

# Check PVC
kubectl get pvc data-ns-mongo-0
kubectl describe pvc data-ns-mongo-0

# Check pod logs
kubectl logs ns-mongo-0
kubectl logs ns-mongo-0 -c init-replica-set
```

### Connector not created
```bash
# Verify MongoDB is ready
kubectl get sts ns-mongo

# Check tenant status
kubectl get cm tenant-demo-config -o jsonpath='{.status.mongo.ready}'

# If MongoDB is ready but no connector, check webhook logs
kubectl logs -l app=webhook-service | grep -i connector
```

## Next Steps

- [Testing Guide](testing-guide.md) - Run full test suite
- [Webhook Setup Guide](webhook-setup.md) - Advanced configuration
- [VALIDATION-CHECKLIST.md](VALIDATION-CHECKLIST.md) - Verify deployment

## Configuration Examples

### Basic Tenant (No CDC)
```yaml
data:
  TENANT_ID: "basic"
  MONGO_STORAGE_GI: "5"
  CDC_ENABLED: "false"
```

### CDC-Enabled Tenant
```yaml
data:
  TENANT_ID: "analytics"
  CDC_ENABLED: "true"
  CDC_COLLECTIONS: "entries,treatments,devicestatus"
  CDC_PARTITIONS_ENTRIES: "6"
```

### Custom Storage Class
```yaml
data:
  TENANT_ID: "premium"
  MONGO_SC: "fast-ssd"
  MONGO_STORAGE_GI: "100"
```

### External Connector Authentication
```yaml
data:
  TENANT_ID: "secure"
  CDC_ENABLED: "true"
  CDC_URI_KEY: "secure.uri"  # References external config
```

For external config, ensure your KafkaConnect has:
```yaml
spec:
  externalConfiguration:
    volumes:
      - name: mongo-credentials
        secret:
          secretName: mongo-connection-strings
```

## Help & Support

- 📚 [Full Documentation](../README.md)
- 🔍 [Validation Checklist](VALIDATION-CHECKLIST.md)
- 🧪 [Testing Guide](testing-guide.md)
- 🔧 [Metacontroller Integration](METACONTROLLER-INTEGRATION.md)
