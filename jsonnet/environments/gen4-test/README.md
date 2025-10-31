# Gen 4 Test Environment

This Tanka environment demonstrates the simplified `gen4.stack()` function for deploying a complete Gen 4 Nightscout platform.

## Quick Test

Evaluate without a Kubernetes cluster:

```bash
tk eval jsonnet/environments/gen4-test
```

## What Gets Generated

### Simple Deployment (gen4.stack())

The `simple_deployment` section shows the **batteries-included** approach - one function call generates:

1. **ServiceAccount** (`webhook-metacontroller`)
2. **ClusterRole** with full orchestration permissions
3. **ClusterRoleBinding** 
4. **Webhook Deployment** (all-in-one: webhook + provisioner + healthcheck)
5. **Webhook Service** (ClusterIP)
6. **Storage CompositeController** CRD
7. **Compute CompositeController** CRD
8. **PVC Backup DecoratorController** CRD

**Total: 8 Kubernetes resources** from a single function call.

### Advanced Deployment

The `advanced_rbac` and `advanced_webhooks` sections show how to use low-level modules for custom configurations:

- Separate ServiceAccounts for webhook, provisioner, and healthcheck
- Custom RBAC permissions per component
- Individual webhook deployments with different scaling

## Usage Patterns

### Pattern 1: Simple (Recommended for Getting Started)

```jsonnet
local gen4 = import '../../lib-k8s-multienv/gen4.libsonnet';

{
  gen4: gen4.stack(
    webhookImage: 'your-registry/webhook:v1.0',
    webhookReplicas: 3,
  ),
}
```

### Pattern 2: Advanced (Production Multi-Component)

```jsonnet
local webhook = import '../../lib-k8s-multienv/webhook.libsonnet';
local rbac = import '../../lib-k8s-multienv/rbac.libsonnet';

{
  rbac: {
    webhook_sa: rbac.serviceAccount('webhook-metacontroller', 'default'),
    // ... custom RBAC configuration
  },
  
  webhooks: {
    webhook: webhook.stack(
      name: 'multienv-webhook',
      runtimeMode: 'webhook',
      // ... custom webhook configuration
    ),
    // ... separate provisioner and healthcheck
  },
}
```

## Output

Run `tk eval` to see the complete JSON output:

```bash
tk eval jsonnet/environments/gen4-test > output.json
```

Or show formatted YAML:

```bash
tk show jsonnet/environments/gen4-test
```

## Integration with Your Environment

To use in your Tanka environment:

1. Install the library:
   ```bash
   cd your-tanka-environment
   jb install github.com/your-org/nightscout-k8s/jsonnet
   ```

2. Import and use:
   ```jsonnet
   local nightscout = import 'github.com/your-org/nightscout-k8s/jsonnet/lib-k8s-multienv/main.libsonnet';
   
   {
     gen4: nightscout.gen4.stack(
       webhookImage: 'your-registry/webhook:v1.0',
     ),
   }
   ```

## See Also

- [Two-Composite Architecture](../../../docs/TWO-COMPOSITE-ARCHITECTURE.md)
- [RBAC Design](../../../docs/RBAC-DESIGN.md)
- [Tanka Deployment Guide](../../../docs/TANKA-DEPLOYMENT.md)
