# Tanka Deployment Guide

## Overview

This guide explains how to use **Grafana Tanka** with **Jsonnet** to deploy the Nightscout multi-tenant platform. Tanka provides a clean, reusable alternative to raw YAML manifests, with built-in diff/preview capabilities and strong parameterization support.

**Benefits of Tanka:**
- **DRY**: Write deployment logic once, reuse across environments
- **Type-safe**: Jsonnet catches errors before deployment
- **Diff preview**: See exactly what will change (`tk diff`)
- **Parameterized**: Easy blue/green deployments, multi-component scaling
- **GitOps-friendly**: Export to YAML for ArgoCD/Flux

---

## Prerequisites

### 1. Install Tanka and Jsonnet-Bundler

```bash
# Install Tanka
# Option 1: Using Go
go install github.com/grafana/tanka/cmd/tk@latest

# Option 2: macOS via Homebrew
brew install tanka

# Option 3: Download binary from https://github.com/grafana/tanka/releases

# Install jsonnet-bundler (dependency manager)
go install github.com/jsonnet-bundler/jsonnet-bundler/cmd/jb@latest

# Verify installation
tk --version
jb --version
```

### 2. Install k8s-libsonnet

The Kubernetes API library provides typed interfaces for all Kubernetes resources:

```bash
# Initialize jsonnet-bundler in your project
cd your-nightscout-platform
jb init

# Install k8s-libsonnet matching your cluster version
# Replace 1.29 with your Kubernetes version (1.24, 1.25, 1.26, 1.27, 1.28, 1.29, 1.30, 1.31)
jb install github.com/jsonnet-libs/k8s-libsonnet/1.29@main
```

This creates:
- `jsonnetfile.json` - Dependency manifest
- `jsonnetfile.lock.json` - Lock file (commit this)
- `vendor/` - Downloaded libraries (add to `.gitignore`)

---

## Project Structure

```
your-nightscout-platform/
├── lib/                          # Reusable Jsonnet libraries (this repo)
│   ├── k.libsonnet              # Alias to k8s-libsonnet
│   ├── rbac.libsonnet           # RBAC helpers
│   ├── webhook.libsonnet        # Webhook deployment helpers
│   └── metacontroller.libsonnet # Metacontroller resource helpers
├── examples/                     # Example configurations
│   ├── simple.jsonnet           # Single deployment
│   ├── blue-green.jsonnet       # Blue/green pattern
│   └── multi-component.jsonnet  # Three-ServiceAccount pattern
├── environments/                 # Tanka environments (you create these)
│   ├── dev/
│   │   ├── main.jsonnet         # Dev configuration
│   │   └── spec.json            # Environment metadata
│   ├── staging/
│   │   ├── main.jsonnet
│   │   └── spec.json
│   └── prod/
│       ├── main.jsonnet
│       └── spec.json
├── jsonnetfile.json             # Jsonnet dependencies
├── jsonnetfile.lock.json        # Dependency lock file
└── vendor/                      # Downloaded dependencies (gitignore)
```

---

## Quick Start

### 1. Initialize a Tanka Environment

```bash
# Create dev environment
mkdir -p environments/dev
tk env add environments/dev

# Configure environment (points to your Kubernetes cluster)
tk env set environments/dev \
  --namespace=default \
  --server-from-context=$(kubectl config current-context)

# This creates environments/dev/spec.json:
# {
#   "apiVersion": "tanka.dev/v1alpha1",
#   "kind": "Environment",
#   "metadata": { "name": "environments/dev" },
#   "spec": {
#     "apiServer": "https://your-k8s-api-server",
#     "namespace": "default"
#   }
# }
```

### 2. Create Your First Deployment

**`environments/dev/main.jsonnet`:**

```jsonnet
// Import libraries
local rbac = import '../../lib/rbac.libsonnet';
local webhook = import '../../lib/webhook.libsonnet';
local metacontroller = import '../../lib/metacontroller.libsonnet';

{
  // RBAC
  rbac: {
    serviceAccount: rbac.serviceAccount('webhook-service'),
    clusterRole: rbac.fullOrchestrationRole('webhook-service'),
    clusterRoleBinding: rbac.clusterRoleBinding('webhook-service'),
  },

  // Webhook deployment
  webhook: webhook.stack(
    name='webhook-service',
    image='your-registry/webhook:latest',
    replicas=2,
  ),

  // Metacontroller
  controllers: metacontroller.controllers(),
}
```

### 3. Preview and Apply

```bash
# Preview what will be created (like git diff)
tk diff environments/dev

# Apply to cluster
tk apply environments/dev

# Verify deployment
kubectl get pods -l app=webhook-service
kubectl get compositecontrollers
```

---

## Deployment Patterns

### Pattern 1: Simple Deployment (Development)

Use `examples/simple.jsonnet` as a starting point:

```jsonnet
local rbac = import '../lib/rbac.libsonnet';
local webhook = import '../lib/webhook.libsonnet';
local metacontroller = import '../lib/metacontroller.libsonnet';

{
  rbac: {
    serviceAccount: rbac.serviceAccount('webhook-service'),
    clusterRole: rbac.fullOrchestrationRole('webhook-service'),
    clusterRoleBinding: rbac.clusterRoleBinding('webhook-service'),
  },

  webhook: webhook.stack(
    name='webhook-service',
    image='your-registry/webhook:dev',
    namespace='default',
    replicas=1,  // Single replica for dev
    runtimeMode='all',  // All endpoints in one pod
  ),

  controllers: metacontroller.controllers(),
}
```

**When to use:**
- Local development
- Testing new features
- Single-cluster deployments with low traffic

### Pattern 2: Blue/Green Deployment (Staging/Production)

Use `examples/blue-green.jsonnet` for zero-downtime upgrades:

```jsonnet
local rbac = import '../lib/rbac.libsonnet';
local webhook = import '../lib/webhook.libsonnet';
local metacontroller = import '../lib/metacontroller.libsonnet';

{
  // Shared ServiceAccount (both blue and green use same permissions)
  rbac: {
    serviceAccount: rbac.serviceAccount('webhook-service'),
    clusterRole: rbac.fullOrchestrationRole('webhook-service'),
    clusterRoleBinding: rbac.clusterRoleBinding('webhook-service'),
  },

  // Blue/green deployments
  webhook: webhook.blueGreen(
    name='webhook',
    blueImage='your-registry/webhook:v1.0',   // Current production
    greenImage='your-registry/webhook:v1.1',  // New version
    blueReplicas=3,   // Production traffic
    greenReplicas=1,  // Canary validation
  ),

  // Controllers (initially blue, change to green for cutover)
  controllers: metacontroller.blueGreenControllers(
    environment='blue',  // Change to 'green' when ready
  ),
}
```

**Gradual cutover process:**

1. **Deploy green canary:**
   ```bash
   tk apply environments/prod  # greenReplicas=1
   ```

2. **Test green manually:**
   ```bash
   kubectl port-forward svc/webhook-green 3000:3000
   curl http://localhost:3000/health
   ```

3. **Point Metacontroller to green:**
   ```jsonnet
   // Change in main.jsonnet
   controllers: metacontroller.blueGreenControllers(
     environment='green',  // Changed from 'blue'
   ),
   ```
   ```bash
   tk apply environments/prod
   ```

4. **Create test tenant on green:**
   ```bash
   kubectl apply -f test-tenant-green.yaml
   kubectl get all -l ns.mdn.io/tenant=test-green
   ```

5. **Scale green up, blue down:**
   ```jsonnet
   webhook: webhook.blueGreen(
     blueReplicas=0,   // Remove blue
     greenReplicas=3,  // Full production traffic
   ),
   ```

6. **Delete blue deployment:**
   ```bash
   kubectl delete deployment webhook-blue
   kubectl delete service webhook-blue
   ```

**When to use:**
- Production environments
- Zero-downtime upgrades
- A/B testing new webhook logic
- Rollback capability (switch controllers back to blue)

### Pattern 3: Multi-Component Deployment (Production Scale)

Use `examples/multi-component.jsonnet` for independent scaling:

```jsonnet
local rbac = import '../lib/rbac.libsonnet';
local webhook = import '../lib/webhook.libsonnet';
local metacontroller = import '../lib/metacontroller.libsonnet';

{
  // Three ServiceAccounts with least-privilege permissions
  rbac: {
    webhook: {
      serviceAccount: rbac.serviceAccount('webhook-metacontroller'),
      clusterRole: rbac.fullOrchestrationRole('webhook-metacontroller'),
      clusterRoleBinding: rbac.clusterRoleBinding('webhook-metacontroller'),
    },
    provisioner: {
      serviceAccount: rbac.serviceAccount('deployment-server'),
      clusterRole: rbac.provisionerRole('deployment-server'),
      clusterRoleBinding: rbac.clusterRoleBinding('deployment-server'),
    },
    healthcheck: {
      serviceAccount: rbac.serviceAccount('consul-healthcheck'),
      clusterRole: rbac.readOnlyRole('consul-healthcheck'),
      clusterRoleBinding: rbac.clusterRoleBinding('consul-healthcheck'),
    },
  },

  // Three separate deployments
  webhook: webhook.multiComponent(
    name='webhook',
    image='your-registry/webhook:latest',
    webhookReplicas=2,        // Low traffic
    provisionerReplicas=3,    // Moderate traffic
    healthcheckReplicas=15,   // High traffic (1300 tenants)
  ),

  controllers: metacontroller.controllers(
    webhookServiceUrl='http://webhook-webhook:3000',
  ),
}
```

**Scaling example for 1300 production tenants:**

```jsonnet
webhook: webhook.multiComponent(
  webhookReplicas=3,        // Metacontroller sync calls (low volume)
  provisionerReplicas=5,    // Admin API provisioning (moderate)
  healthcheckReplicas=20,   // Consul health checks (high volume)
  
  // Tune resources per component
  resources={
    webhook: {
      requests: { cpu: '200m', memory: '256Mi' },
      limits: { cpu: '1000m', memory: '1Gi' },
    },
    healthcheck: {
      requests: { cpu: '50m', memory: '64Mi' },   // Lightweight
      limits: { cpu: '200m', memory: '256Mi' },
    },
  },
)
```

**When to use:**
- Production with 1000+ tenants
- Heavy Consul health check traffic
- Need to scale components independently
- Maximum security (least-privilege ServiceAccounts)

---

## Advanced Patterns

### Environment-Specific Overrides

Create a base configuration, then override per environment:

**`lib/base.libsonnet`:**
```jsonnet
local rbac = import 'rbac.libsonnet';
local webhook = import 'webhook.libsonnet';
local metacontroller = import 'metacontroller.libsonnet';

function(config) {
  rbac: {
    serviceAccount: rbac.serviceAccount('webhook-service'),
    clusterRole: rbac.fullOrchestrationRole('webhook-service'),
    clusterRoleBinding: rbac.clusterRoleBinding('webhook-service'),
  },

  webhook: webhook.stack(
    name='webhook-service',
    image=config.image,
    replicas=config.replicas,
    namespace=config.namespace,
  ),

  controllers: metacontroller.controllers(),
}
```

**`environments/dev/main.jsonnet`:**
```jsonnet
local base = import '../../lib/base.libsonnet';

base({
  image: 'your-registry/webhook:dev',
  replicas: 1,
  namespace: 'default',
})
```

**`environments/prod/main.jsonnet`:**
```jsonnet
local base = import '../../lib/base.libsonnet';

base({
  image: 'your-registry/webhook:v1.0',
  replicas: 5,
  namespace: 'default',
}) {
  // Override for production
  webhook+: {
    deployment+: {
      spec+: {
        template+: {
          spec+: {
            affinity: {
              podAntiAffinity: {
                requiredDuringSchedulingIgnoredDuringExecution: [{
                  labelSelector: {
                    matchLabels: { app: 'webhook-service' },
                  },
                  topologyKey: 'kubernetes.io/hostname',
                }],
              },
            },
          },
        },
      },
    },
  },
}
```

### Custom Resource Sizing

```jsonnet
local webhook = import '../lib/webhook.libsonnet';

{
  webhook: webhook.stack(
    name='webhook-service',
    image='your-registry/webhook:latest',
    replicas=3,
    resources={
      requests: {
        cpu: '500m',      // Higher CPU for production
        memory: '512Mi',
      },
      limits: {
        cpu: '2000m',
        memory: '2Gi',
      },
    },
  ),
}
```

### Adding Custom Environment Variables

```jsonnet
local k = import '../lib/k.libsonnet';
local webhook = import '../lib/webhook.libsonnet';

{
  webhook: webhook.stack(
    name='webhook-service',
    image='your-registry/webhook:latest',
    env=[
      k.core.v1.envVar.new('LOG_LEVEL', 'debug'),
      k.core.v1.envVar.new('TENANT_NAMESPACE', 'hosted-tenants'),
      k.core.v1.envVar.fromSecretRef('MONGODB_URI', 'shared-mongo', 'uri'),
    ],
  ),
}
```

---

## GitOps Integration

### Export to YAML for ArgoCD/Flux

```bash
# Export all resources to YAML
tk export ./manifests environments/prod

# This creates:
# manifests/
#   rbac/
#     webhook-service-serviceaccount.yaml
#     webhook-service-clusterrole.yaml
#     webhook-service-clusterrolebinding.yaml
#   webhook/
#     webhook-service-deployment.yaml
#     webhook-service-service.yaml
#   controllers/
#     storage-composite-compositecontroller.yaml
#     compute-composite-compositecontroller.yaml
#     pvc-backup-decorator-decoratorcontroller.yaml

# Commit to git
git add manifests/
git commit -m "Export Tanka manifests for ArgoCD"
```

### ArgoCD Application

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: nightscout-platform
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/your-org/nightscout-platform
    targetRevision: main
    path: manifests  # Generated by tk export
  destination:
    server: https://kubernetes.default.svc
    namespace: default
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

---

## Troubleshooting

### Error: `unable to find package`

**Cause:** Missing k8s-libsonnet dependency.

**Fix:**
```bash
jb install github.com/jsonnet-libs/k8s-libsonnet/1.29@main
```

### Error: `field does not exist: core`

**Cause:** Wrong k8s-libsonnet version or import path.

**Fix:** Verify `lib/k.libsonnet` imports correctly:
```jsonnet
(import 'github.com/jsonnet-libs/k8s-libsonnet/1.29/main.libsonnet')
```

### Preview changes without applying

```bash
# Show diff against cluster
tk diff environments/prod

# Show generated YAML (doesn't apply)
tk show environments/prod

# Validate Jsonnet syntax
jsonnet environments/prod/main.jsonnet
```

### Update Kubernetes library version

```bash
# Update to match your cluster version
export K8S_VERSION=1.30
jb update github.com/jsonnet-libs/k8s-libsonnet/${K8S_VERSION}@main
```

---

## Best Practices

### 1. Version Control

**Commit:**
- `lib/` - Your reusable libraries
- `environments/` - Environment configurations
- `jsonnetfile.json` - Dependency manifest
- `jsonnetfile.lock.json` - Lock file (ensures reproducible builds)

**Gitignore:**
- `vendor/` - Downloaded dependencies (regenerate with `jb install`)

### 2. Separate Environments

```
environments/
├── dev/       # Local/development cluster
├── staging/   # Pre-production testing
└── prod/      # Production cluster
```

Each environment has:
- Different `spec.json` (points to different cluster)
- Different `main.jsonnet` (different image tags, replicas)

### 3. Test Before Applying

```bash
# Always diff first
tk diff environments/prod

# Check for unexpected changes
# Look for deletions, permission changes, image updates

# Apply only when diff looks correct
tk apply environments/prod
```

### 4. Use Functions for Reusability

```jsonnet
// lib/nightscout.libsonnet
local webhook = import 'webhook.libsonnet';
local rbac = import 'rbac.libsonnet';

{
  new(config):: {
    rbac: rbac.webhookServiceAccount(config.name),
    webhook: webhook.stack(
      name=config.name,
      image=config.image,
      replicas=config.replicas,
    ),
  },
}

// environments/prod/main.jsonnet
local nightscout = import '../../lib/nightscout.libsonnet';

nightscout.new({
  name: 'webhook-service',
  image: 'your-registry/webhook:v1.0',
  replicas: 5,
})
```

### 5. Keep Libraries Simple

- One function per file when possible
- Clear parameter names and defaults
- Add usage examples in comments
- Avoid deep nesting (makes debugging hard)

---

## Reference

### Library Functions

#### rbac.libsonnet

```jsonnet
rbac.serviceAccount(name, namespace='default')
rbac.fullOrchestrationRole(name)
rbac.provisionerRole(name)
rbac.readOnlyRole(name)
rbac.clusterRoleBinding(name, serviceAccountName=name, roleName=name)
rbac.webhookServiceAccount(name, namespace='default')  // Convenience
rbac.provisionerServiceAccount(name, namespace='default')
rbac.readOnlyServiceAccount(name, namespace='default')
```

#### webhook.libsonnet

```jsonnet
webhook.deployment(name, image, replicas, runtimeMode, serviceAccountName, ...)
webhook.service(name, port, targetPort, selector)
webhook.stack(name, image, replicas, runtimeMode, ...)  // Deployment + Service
webhook.blueGreen(name, blueImage, greenImage, ...)
webhook.multiComponent(name, image, webhookReplicas, provisionerReplicas, healthcheckReplicas, ...)
```

#### metacontroller.libsonnet

```jsonnet
metacontroller.compositeController(name, webhookUrl, parentResource, childResources)
metacontroller.decoratorController(name, webhookUrl, resources)
metacontroller.storageComposite(webhookUrl)
metacontroller.computeComposite(webhookUrl)
metacontroller.pvcBackupDecorator(webhookUrl)
metacontroller.controllers(webhookServiceUrl)  // All three controllers
metacontroller.blueGreenControllers(environment='blue')
```

---

## Additional Resources

- **Tanka Documentation**: https://tanka.dev
- **Jsonnet Tutorial**: https://jsonnet.org/learning/tutorial.html
- **k8s-libsonnet**: https://github.com/jsonnet-libs/k8s-libsonnet
- **Grafana Jsonnet Libraries**: https://github.com/grafana/jsonnet-libs
- **RBAC Design Guide**: [./RBAC-DESIGN.md](./RBAC-DESIGN.md)
- **Two-Composite Architecture**: [./TWO-COMPOSITE-ARCHITECTURE.md](./TWO-COMPOSITE-ARCHITECTURE.md)

---

## Next Steps

1. **Initialize Tanka** in your project
2. **Install k8s-libsonnet** matching your cluster version
3. **Start with simple pattern** (`examples/simple.jsonnet`)
4. **Test with `tk diff`** before applying
5. **Graduate to blue/green** for production
6. **Scale to multi-component** when Consul traffic becomes heavy

For questions or issues, refer to the [RBAC Design Guide](./RBAC-DESIGN.md) for permission details and troubleshooting.
