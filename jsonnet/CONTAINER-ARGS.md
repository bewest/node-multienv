# Container Args Mapping in Jsonnet

This document explains how the Jsonnet library maps `runtimeMode` parameters to `start_container.sh` args.

## Overview

The `webhook.libsonnet` library uses the `runtimeMode` parameter to determine which `start_container.sh` entry point to use. This allows deploying different components from the same multi-mode container image.

## Runtime Mode Mapping

| runtimeMode | Container Args | start_container.sh Mode | Component |
|-------------|----------------|------------------------|-----------|
| `'all'` | `["multienv-metactl-webhooks"]` | multienv-metactl-webhooks | Gen 4 webhook server (all-in-one) |
| `'webhook'` | `["multienv-metactl-webhooks"]` | multienv-metactl-webhooks | Gen 4 webhook server |
| `'provisioner'` | `["deployment-controller"]` | deployment-controller | /environs/ API server |
| `'healthcheck'` | `["tenant-pod-healthcheck"]` | tenant-pod-healthcheck | Health check sidecar |

## Generated Kubernetes Manifest

When you use `gen4.stack()`, it generates:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gen4-webhooks
spec:
  template:
    spec:
      containers:
      - name: webhook
        image: nightscout-multienv:v1.0
        command: ["./start_container.sh"]
        args: ["multienv-metactl-webhooks"]  # ← Correct entry point
        ports:
        - containerPort: 3000
          name: http
        env:
        - name: PORT
          value: "3000"
```

## imagePullSecrets Support

When using a private container registry (DigitalOcean, ECR, GCR, etc.), you need to provide authentication credentials via imagePullSecrets:

```jsonnet
local gen4 = import 'lib-k8s-multienv/gen4.libsonnet';

gen4.stack(
  webhookImage='registry.digitalocean.com/myregistry/multienv:latest',
  webhookReplicas=3,
  imagePullSecrets=[{name: 'registry-credentials'}],  // Registry auth Secret
)
```

This generates a pod spec with:

```yaml
spec:
  template:
    spec:
      imagePullSecrets:
      - name: registry-credentials
      containers: [...]
```

**Creating the Secret:**

```bash
# DigitalOcean Container Registry
kubectl create secret docker-registry registry-credentials \
  --docker-server=registry.digitalocean.com \
  --docker-username=<token> \
  --docker-password=<token>

# AWS ECR
kubectl create secret docker-registry registry-credentials \
  --docker-server=<account-id>.dkr.ecr.<region>.amazonaws.com \
  --docker-username=AWS \
  --docker-password=$(aws ecr get-login-password)
```

## Usage Examples

### Simple All-in-One Webhook (Public Registry)

```jsonnet
local gen4 = import 'lib-k8s-multienv/gen4.libsonnet';

gen4.stack(
  webhookImage='nightscout-multienv:v1.0',
  webhookReplicas=3,
)
```

**Generates:**
- Deployment with `args: ["multienv-metactl-webhooks"]`
- Handles all Metacontroller endpoints in one process

### Simple All-in-One Webhook (Private Registry)

```jsonnet
local gen4 = import 'lib-k8s-multienv/gen4.libsonnet';

gen4.stack(
  webhookImage='registry.digitalocean.com/staget1pal0/multienv:latest',
  webhookReplicas=3,
  imagePullSecrets=[{name: 'registry-staget1pal0'}],  // DO registry auth
)
```

### Multi-Component Deployment (Private Registry)

```jsonnet
local webhook = import 'lib-k8s-multienv/webhook.libsonnet';

local pullSecrets = [{name: 'registry-credentials'}];

{
  webhook: webhook.stack(
    name='gen4-webhook',
    image='registry.example.com/nightscout-multienv:v1.0',
    runtimeMode='webhook',  // args: ["multienv-metactl-webhooks"]
    imagePullSecrets=pullSecrets,
    replicas=3,
  ),
  
  provisioner: webhook.stack(
    name='provisioner',
    image='registry.example.com/nightscout-multienv:v1.0',
    runtimeMode='provisioner',  // args: ["deployment-controller"]
    imagePullSecrets=pullSecrets,
    replicas=2,
  ),
  
  healthcheck: webhook.stack(
    name='healthcheck',
    image='registry.example.com/nightscout-multienv:v1.0',
    runtimeMode='healthcheck',  // args: ["tenant-pod-healthcheck"]
    imagePullSecrets=pullSecrets,
    replicas=10,
  ),
}
```

**Generates three separate deployments with imagePullSecrets:**
1. **gen4-webhook**: `args: ["multienv-metactl-webhooks"]` + registry auth
2. **provisioner**: `args: ["deployment-controller"]` + registry auth
3. **healthcheck**: `args: ["tenant-pod-healthcheck"]` + registry auth

## Verification

You can verify the generated args with:

```bash
# Using Tanka
cd jsonnet/environments/gen4-test
tk eval . | grep -B 5 -A 5 '"args"'

# Expected output:
# "args": [
#   "multienv-metactl-webhooks"
# ],
# "command": [
#   "./start_container.sh"
# ],
```

## See Also

- [Container Parameters](../docs/CONTAINER-PARAMETERS.md) - Full documentation of all entry points
- [start_container.sh](../start_container.sh) - Entry point script with all available modes
- [webhook.libsonnet](lib-k8s-multienv/webhook.libsonnet) - Deployment helper library
- [gen4.libsonnet](lib-k8s-multienv/gen4.libsonnet) - Batteries-included Gen 4 stack
