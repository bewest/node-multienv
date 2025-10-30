# Jsonnet Deployment Structure

## Overview

This directory contains modular Jsonnet deployment configuration for the Nightscout multi-tenant platform, supporting both Gen 3 (legacy) and Gen 4 (Metacontroller-based) architectures.

## File Structure

```
jsonnet/
├── lib/                          # Reusable Jsonnet library (jb installable)
│   ├── main.libsonnet           # Entry point (exports all modules)
│   ├── webhook.libsonnet        # Webhook deployment helpers
│   ├── metacontroller.libsonnet # Metacontroller CRD helpers
│   ├── rbac.libsonnet           # RBAC helpers
│   ├── config.libsonnet         # Configuration templates
│   ├── gen4.libsonnet           # Gen 4 deployment addon
│   └── k.libsonnet              # k8s-libsonnet alias
├── jsonnetfile.json             # Package metadata for jb
├── environments/default/
│   ├── main.jsonnet.original   # Existing Gen 3 deployment (preserved)
│   ├── examples/
│   │   ├── 01-gen3-only.jsonnet
│   │   ├── 02-gen4-simple.jsonnet
│   │   ├── 03-gen4-multicomponent.jsonnet
│   │   ├── 04-gen4-bluegreen.jsonnet
│   │   └── 05-gen4-custom-names.jsonnet
│   └── README.md (this file)
└── README.md                    # Library documentation
```

## Key Features

### Backward Compatibility

✅ **Zero breaking changes** - Your existing Gen 3 deployments work unchanged  
✅ **Gen 4 opt-in** - Enable Gen 4 by setting `_config.gen4.enabled: true`  
✅ **Progressive migration** - Run Gen 3 and Gen 4 side-by-side  
✅ **Simple rollback** - Set `gen4.enabled: false` to remove Gen 4  

### Modular Architecture

- **`lib/config.libsonnet`** - Extract _config and _images for reusability
- **`lib/gen4-addon.libsonnet`** - Conditionally adds Gen 4 webhooks
- **Examples** - Ready-to-use deployment patterns

### Library Organization

The Jsonnet library is now in `jsonnet/lib/` and can be installed via jsonnet-bundler:

```bash
# In your Tanka environment
cd environments/prod
jb install ../../jsonnet  # Local development
# Or from GitHub:
# jb install github.com/your-org/nightscout-k8s/jsonnet@main
```

**Library modules:**
- `lib/webhook.libsonnet` - Webhook deployments with health probes
- `lib/metacontroller.libsonnet` - CompositeController/DecoratorController CRDs
- `lib/rbac.libsonnet` - ServiceAccounts and RBAC rules
- `lib/config.libsonnet` - Configuration templates
- `lib/gen4.libsonnet` - Gen 4 deployment addon
- `lib/main.libsonnet` - Entry point that exports all modules

## Quick Start

### Gen 3 Only (Current State)

Your existing environment override pattern works unchanged:

```jsonnet
// environments/prod/main.jsonnet
(import '../default/main.jsonnet.original') + {
  _config+:: {
    num_runners: 5,
    scaling: { resolvers: 10 },
  },
}
```

### Enable Gen 4

Add Gen 4 webhooks alongside Gen 3:

```jsonnet
// After running: jb install ../../jsonnet
local config = import 'lib/config.libsonnet';
local gen4 = import 'lib/gen4.libsonnet';

(import '../default/main.jsonnet.original') + config + {
  _config+:: {
    num_runners: 5,
    gen4+:: {
      enabled: true,
      webhook_name: 'gen4-webhooks',
      webhook_replicas: 2,
    },
  },
} + gen4.resources($)
```

## Deployment Patterns

### Pattern 1: Simple (Single Webhook)

```jsonnet
gen4.resources($)
```

Creates:
- `gen4-webhooks` Deployment (all-in-one)
- `gen4-webhooks` Service
- Metacontroller CRDs (storage, compute, PVC decorator)
- RBAC (ServiceAccount + ClusterRole + ClusterRoleBinding)

### Pattern 2: Multi-Component (Production Scale)

```jsonnet
_config+:: {
  gen4+:: {
    multicomponent: {
      enabled: true,
      webhook_replicas: 3,
      provisioner_replicas: 5,
      healthcheck_replicas: 20,
    },
  },
}
```

Creates:
- `gen4-webhook` Deployment (Metacontroller only)
- `gen4-provisioner` Deployment (REST API)
- `gen4-healthcheck` Deployment (Consul checks)
- Three ServiceAccounts with least-privilege permissions

### Pattern 3: Blue/Green

```jsonnet
gen4.blueGreen($, 'blue') +
gen4.blueGreen($, 'green')
```

Creates:
- `gen4-webhooks-blue` and `gen4-webhooks-green` Deployments
- Separate Services for each environment
- Separate Metacontroller CRDs with environment suffix

### Pattern 4: Custom Names (Progressive Migration)

```jsonnet
gen4.custom($, webhookName='gen4-pilot', controllerPrefix='pilot')
```

Creates:
- `gen4-pilot` Deployment
- `pilot-storage-composite`, `pilot-compute-composite` CRDs
- Use labels to route specific tenants to pilot controllers

## Configuration Reference

**Key `_config.gen4` parameters:**

```jsonnet
gen4: {
  enabled: false,                        // Enable Gen 4 deployment
  webhook_name: 'gen4-webhooks',         // Customizable webhook name
  webhook_replicas: 2,
  
  // ServiceAccount names (must match RBAC in docs/RBAC-DESIGN.md)
  webhook_metacontroller_sa: 'webhook-metacontroller',
  webhook_provisioner_sa: 'deployment-server',
  webhook_healthcheck_sa: 'consul-healthcheck',
  
  // Metacontroller controller names (customizable for blue/green)
  storage_composite_name: 'storage-composite',
  compute_composite_name: 'compute-composite',
  pvc_decorator_name: 'pvc-backup-decorator',
  
  // Resync periods (seconds)
  storage_resync_seconds: 30,
  compute_resync_seconds: 30,
  pvc_resync_seconds: 60,
  
  // Multi-component deployment
  multicomponent: { enabled: false },
  
  // Resource limits
  resources: { /* ... */ },
}
```

## Migration Path

**1. Test in Staging**
```bash
# Deploy Gen 4 to staging
tk apply environments/staging
```

**2. Deploy to Production (alongside Gen 3)**
```bash
# Gen 4 runs side-by-side with Gen 3
tk apply environments/prod
```

**3. Pilot Test**
```bash
# Use gen4.custom() to test with subset of tenants
# Label specific ConfigMaps/Secrets
```

**4. Blue/Green Cutover**
```bash
# Deploy both blue and green
# Migrate Metacontroller CRDs to green
# Remove blue when confident
```

**5. Multi-Component (Scale)**
```bash
# Split webhook into separate components
# Scale healthcheck independently for 1300+ tenants
```

## Rollback

```jsonnet
_config+:: {
  gen4+:: {
    enabled: false,  // Removes all Gen 4 resources
  },
}
```

```bash
tk apply environments/prod
```

## Examples

See `examples/` directory for complete working examples:

- **01-gen3-only.jsonnet** - Current state, no changes
- **02-gen4-simple.jsonnet** - Add Gen 4 webhooks
- **03-gen4-multicomponent.jsonnet** - Production scale deployment
- **04-gen4-bluegreen.jsonnet** - Zero-downtime updates
- **05-gen4-custom-names.jsonnet** - Progressive migration pattern

## Documentation

- **[Tanka Deployment Guide](../../../docs/TANKA-DEPLOYMENT.md)** - Complete Tanka/Jsonnet guide
- **[Two-Composite Architecture](../../../docs/TWO-COMPOSITE-ARCHITECTURE.md)** - Gen 4 architecture
- **[RBAC Design](../../../docs/RBAC-DESIGN.md)** - ServiceAccount permissions
- **[Migration Playbook](../../../docs/MIGRATION-PLAYBOOK.md)** - Gen 3b → Gen 4 migration

## Support

For questions or issues:
1. Check examples in `examples/` directory
2. Review [TANKA-DEPLOYMENT.md](../../../docs/TANKA-DEPLOYMENT.md)
3. Verify RBAC with [RBAC-DESIGN.md](../../../docs/RBAC-DESIGN.md)
