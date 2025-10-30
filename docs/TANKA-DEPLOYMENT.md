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

---

## Library Installation

The Nightscout Jsonnet library is available as a reusable package in `jsonnet/lib/`. You can install it in your Tanka environments using jsonnet-bundler.

### Option 1: Install from GitHub (Recommended for Production)

```bash
cd environments/prod
jb install github.com/your-org/nightscout-k8s/jsonnet@main
```

### Option 2: Install Locally (For Development)

```bash
cd environments/prod
jb install ../../jsonnet
```

This installs the library into `vendor/lib/` and creates appropriate import mappings.

## Project Structure

```
your-nightscout-platform/
├── jsonnet/                      # Jsonnet library (jb installable)
│   ├── lib/                     # Reusable Jsonnet modules
│   │   ├── main.libsonnet       # Entry point (exports all modules)
│   │   ├── rbac.libsonnet       # RBAC helpers (ServiceAccounts, ClusterRoles)
│   │   ├── webhook.libsonnet    # Webhook deployment helpers
│   │   ├── metacontroller.libsonnet # Metacontroller CRD helpers
│   │   ├── config.libsonnet     # Configuration templates
│   │   └── gen4.libsonnet       # Gen 4 deployment addon
│   ├── jsonnetfile.json         # Package metadata
│   ├── environments/default/
│   │   └── examples/            # Example configurations
│   │       ├── 02-gen4-simple.jsonnet
│   │       ├── 03-gen4-multicomponent.jsonnet
│   │       ├── 04-gen4-bluegreen.jsonnet
│   │       └── 05-gen4-custom-names.jsonnet
│   └── README.md                # Library documentation
├── lib/                         # Node.js/JavaScript code (webhook server)
│   ├── routes/                  # Express routes
│   └── templates/               # K8s template generators
├── environments/                # Your Tanka environments
│   ├── prod/
│   │   ├── main.jsonnet         # Production configuration
│   │   ├── spec.json            # Tanka environment metadata
│   │   ├── jsonnetfile.json     # jb dependencies
│   │   ├── jsonnetfile.lock.json # Dependency lock file
│   │   └── vendor/              # jb installed libraries (gitignored)
│   └── staging/
│       ├── main.jsonnet
│       ├── spec.json
│       └── jsonnetfile.json
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
// Import libraries (after jb install)
local rbac = import 'lib/rbac.libsonnet';
local webhook = import 'lib/webhook.libsonnet';
local metacontroller = import 'lib/metacontroller.libsonnet';

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
local rbac = import 'lib/rbac.libsonnet';
local webhook = import 'lib/webhook.libsonnet';
local metacontroller = import 'lib/metacontroller.libsonnet';

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
local rbac = import 'lib/rbac.libsonnet';
local webhook = import 'lib/webhook.libsonnet';
local metacontroller = import 'lib/metacontroller.libsonnet';

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
local rbac = import 'lib/rbac.libsonnet';
local webhook = import 'lib/webhook.libsonnet';
local metacontroller = import 'lib/metacontroller.libsonnet';

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

## Gen 3 to Gen 4 Migration

### Overview

If you have an existing Gen 3 deployment using the monolithic Jsonnet file, you can migrate to Gen 4 webhooks **without disrupting your production tenants**. The migration path preserves all Gen 3 components while optionally enabling Gen 4.

### Backward Compatibility Guarantee

**Core Principle**: Gen 4 is **opt-in**. Your existing deployments continue working unchanged.

- ✅ **All existing `_config` parameters preserved** - Your environment overrides work exactly as before
- ✅ **Gen 4 disabled by default** - No impact unless you explicitly enable it
- ✅ **Gen 3 components untouched** - Runners, dispatchers, resolvers, demuxers remain unchanged
- ✅ **Progressive migration** - Run Gen 3 and Gen 4 side-by-side during transition

### Migration Structure

**New file organization** (in `jsonnet/environments/default/`):

```
jsonnet/environments/default/
├── main.jsonnet.original      # Your existing Gen 3 file (preserved)
├── lib/
│   ├── config.libsonnet       # _config and _images extracted
│   └── gen4-addon.libsonnet   # Gen 4 webhook deployment (opt-in)
└── examples/
    ├── 01-gen3-only.jsonnet           # Existing Gen 3 (no changes)
    ├── 02-gen4-simple.jsonnet         # Add Gen 4 webhooks
    ├── 03-gen4-multicomponent.jsonnet # Separate webhook/provisioner/healthcheck
    ├── 04-gen4-bluegreen.jsonnet      # Blue/green Gen 4 deployment
    └── 05-gen4-custom-names.jsonnet   # Progressive migration pattern
```

### Migration Step 1: Gen 3 Only (Current State)

Your existing environment continues working unchanged:

**`environments/prod/main.jsonnet`:**
```jsonnet
// Import your existing Gen 3 file
(import '../default/main.jsonnet.original') + {
  _config+:: {
    // Your existing overrides work exactly as before
    num_runners: 5,
    scaling: {
      resolvers: 10,
      backends: 10,
    },
    
    // Gen 4 disabled by default
    gen4+:: {
      enabled: false,
    },
  },
}
```

**Deploy:** No changes to your deployment process.

### Migration Step 2: Enable Gen 4 (Progressive)

Add Gen 4 webhooks alongside existing Gen 3 infrastructure:

**`environments/prod/main.jsonnet`:**
```jsonnet
local config = import '../default/lib/config.libsonnet';
local gen4 = import '../default/lib/gen4-addon.libsonnet';

// Gen 3 + Gen 4 running side-by-side
(import '../default/main.jsonnet.original') + config + {
  _config+:: {
    // Existing Gen 3 config
    num_runners: 5,
    scaling: {
      resolvers: 10,
      backends: 10,
    },
    
    // Enable Gen 4 webhooks
    gen4+:: {
      enabled: true,
      webhook_name: 'gen4-webhooks',
      webhook_replicas: 2,
      
      // Start with low resync period for testing
      storage_resync_seconds: 60,
      compute_resync_seconds: 60,
    },
  },
} + gen4.resources($)
```

**Deploy:**
```bash
# Preview what will be added
tk diff environments/prod

# Deploy Gen 4 alongside Gen 3
tk apply environments/prod
```

**What gets deployed:**
- ✅ All existing Gen 3 components (unchanged)
- ✅ Gen 4 webhook Deployment + Service
- ✅ Gen 4 Metacontroller CRDs (storage, compute, PVC decorator)
- ✅ Gen 4 RBAC (ServiceAccount, ClusterRole, ClusterRoleBinding)

### Migration Step 3: Test Gen 4 with Pilot Tenants

Use custom webhook names to test Gen 4 with a subset of tenants:

**`environments/prod/main.jsonnet`:**
```jsonnet
local config = import '../default/lib/config.libsonnet';
local gen4 = import '../default/lib/gen4-addon.libsonnet';

(import '../default/main.jsonnet.original') + config + {
  _config+:: {
    num_runners: 5,
    gen4+:: { enabled: true },
  },
} +
// Deploy separate "pilot" webhook for testing
gen4.custom($, webhookName='gen4-pilot', controllerPrefix='pilot')
```

**This creates:**
- `gen4-pilot` Deployment and Service
- `pilot-storage-composite` CompositeController
- `pilot-compute-composite` CompositeController
- `pilot-pvc-backup-decorator` DecoratorController

**Test with specific tenants:**
```bash
# Label a test storage account to use pilot controllers
kubectl label secret test-storage-account ns.mdn.io/controller=pilot

# Label a test tenant to use pilot controllers
kubectl label configmap test-tenant ns.mdn.io/controller=pilot

# Verify pilot controllers pick them up
kubectl get compositecontrollers pilot-storage-composite -o yaml
kubectl logs deploy/gen4-pilot
```

### Migration Step 4: Blue/Green Cutover

Once Gen 4 is validated, use blue/green deployment for zero-downtime cutover:

**`environments/prod/main.jsonnet`:**
```jsonnet
local config = import '../default/lib/config.libsonnet';
local gen4 = import '../default/lib/gen4-addon.libsonnet';

(import '../default/main.jsonnet.original') + config + {
  _config+:: { 
    gen4+:: { 
      enabled: true,
      webhook_name: 'gen4-webhooks',
    },
  },
} + 
// Deploy both blue (Gen 3 controllers) and green (Gen 4 controllers)
gen4.blueGreen($, 'blue') +
gen4.blueGreen($, 'green')
```

**Cutover process:**
1. Deploy green canary (1 replica)
2. Test green with pilot tenants
3. Scale green up, migrate controllers
4. Verify all tenants healthy on green
5. Scale blue down, remove blue deployment
6. Decommission Gen 3 runners/dispatchers

### Migration Step 5: Multi-Component (Production Scale)

For 1000+ tenants, split webhook into separate components:

**`environments/prod/main.jsonnet`:**
```jsonnet
local config = import '../default/lib/config.libsonnet';
local gen4 = import '../default/lib/gen4-addon.libsonnet';

(import '../default/main.jsonnet.original') + config + {
  _config+:: {
    gen4+:: {
      enabled: true,
      webhook_name: 'gen4',
      
      multicomponent: {
        enabled: true,
        webhook_replicas: 3,        // Metacontroller sync (low volume)
        provisioner_replicas: 5,    // REST API provisioning (moderate)
        healthcheck_replicas: 20,   // Consul checks (high volume, 1300 tenants)
      },
      
      resources: {
        healthcheck: {
          requests: { cpu: '50m', memory: '64Mi' },
          limits: { cpu: '200m', memory: '256Mi' },
        },
      },
    },
  },
} + gen4.resources($)
```

**This creates:**
- `gen4-webhook` Deployment (Metacontroller endpoints only)
- `gen4-provisioner` Deployment (REST API for account/site provisioning)
- `gen4-healthcheck` Deployment (Consul health validation, scales independently)
- Three separate ServiceAccounts with least-privilege RBAC

### Configuration Reference

**`_config.gen4` parameters:**

```jsonnet
gen4: {
  // Core settings
  enabled: false,                        // Enable Gen 4 deployment
  webhook_name: 'gen4-webhooks',         // Deployment/Service name
  webhook_namespace: 'default',
  webhook_replicas: 2,
  webhook_port: 3000,
  
  // ServiceAccount names (from docs/RBAC-DESIGN.md)
  webhook_metacontroller_sa: 'webhook-metacontroller',
  webhook_provisioner_sa: 'deployment-server',
  webhook_healthcheck_sa: 'consul-healthcheck',
  
  // Metacontroller controller names
  storage_composite_name: 'storage-composite',
  compute_composite_name: 'compute-composite',
  pvc_decorator_name: 'pvc-backup-decorator',
  
  // Resync periods (seconds)
  storage_resync_seconds: 30,
  compute_resync_seconds: 30,
  pvc_resync_seconds: 60,
  
  // Multi-component deployment
  multicomponent: {
    enabled: false,
    webhook_replicas: 2,
    provisioner_replicas: 3,
    healthcheck_replicas: 10,
  },
  
  // Resource limits per component
  resources: { /* ... */ },
}
```

### Rollback Strategy

**If Gen 4 has issues, rollback is simple:**

```jsonnet
// Disable Gen 4 in _config
_config+:: {
  gen4+:: {
    enabled: false,  // This removes all Gen 4 resources
  },
}
```

```bash
tk diff environments/prod   # Verify only Gen 4 resources will be deleted
tk apply environments/prod  # Remove Gen 4, keep Gen 3
```

**Gen 3 components remain untouched** - your production tenants continue running.

### Example: Real-World Migration (1300 Production Sites)

**Phase 1: Deploy Gen 4 to staging** (Week 1)
```jsonnet
// environments/staging/main.jsonnet
gen4+:: {
  enabled: true,
  webhook_replicas: 1,
}
```

**Phase 2: Deploy Gen 4 to production** (Week 2)
```jsonnet
// environments/prod/main.jsonnet
gen4+:: {
  enabled: true,
  webhook_replicas: 2,
  storage_resync_seconds: 60,  // Conservative resync
}
```

**Phase 3: Pilot 10 tenants** (Week 3)
```bash
# Use gen4.custom() with pilot controllers
# Label 10 test tenants
# Monitor logs, metrics, tenant health
```

**Phase 4: Progressive rollout** (Week 4-6)
```bash
# Gradually label more tenants
# Monitor performance, error rates
# Scale webhook replicas as needed
```

**Phase 5: Multi-component** (Week 7)
```jsonnet
// Split into webhook/provisioner/healthcheck
gen4+:: {
  multicomponent: { enabled: true },
}
```

**Phase 6: Decommission Gen 3** (Week 8)
```bash
# All tenants on Gen 4
# Remove Gen 3 runners, dispatchers
# Clean up old deployments
```

---

## Next Steps

1. **Initialize Tanka** in your project
2. **Install k8s-libsonnet** matching your cluster version
3. **Start with simple pattern** (`examples/simple.jsonnet`)
4. **Test with `tk diff`** before applying
5. **Graduate to blue/green** for production
6. **Scale to multi-component** when Consul traffic becomes heavy
7. **For Gen 3 → Gen 4 migration:** Follow the progressive migration path above

For questions or issues, refer to the [RBAC Design Guide](./RBAC-DESIGN.md) for permission details and troubleshooting.
