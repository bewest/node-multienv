# Nightscout Kubernetes Jsonnet Library

A production-ready Jsonnet library for deploying multi-tenant Nightscout platforms on Kubernetes using Metacontroller webhooks.

## Features

- 🚀 **Gen 4 Metacontroller Architecture** - Two-composite design (Storage + Compute)
- 🔐 **Two-Secret Security Model** - Separated root and application credentials
- 📦 **Modular Components** - Webhook, RBAC, Metacontroller CRDs
- 🔄 **Blue/Green Deployments** - Zero-downtime updates
- 📈 **Multi-Component Scaling** - Separate webhook/provisioner/healthcheck
- 🛠️ **jsonnet-bundler Compatible** - Install via `jb install`

## Installation

### Using jsonnet-bundler (jb)

```bash
# In your Tanka environment
jb install github.com/your-org/nightscout-k8s/jsonnet@main
```

### Local Development

```bash
# From your project root
cd jsonnet
jb install  # Install dependencies (k8s-libsonnet)
```

## Quick Start

### Simple Deployment

```jsonnet
local nightscout = import 'lib/main.libsonnet';

nightscout.webhook.stack(
  name='webhook-service',
  image='your-registry/webhook:latest',
  namespace='default',
  replicas=2,
)
```

### Gen 4 Full Stack

```jsonnet
local webhook = import 'lib/webhook.libsonnet';
local rbac = import 'lib/rbac.libsonnet';
local metacontroller = import 'lib/metacontroller.libsonnet';

{
  webhook: webhook.stack(
    name='gen4-webhooks',
    image='your-registry/webhook:v1.0',
    replicas=3,
  ),
  rbac: rbac.serviceAccount('webhook-metacontroller') +
        rbac.fullOrchestrationRole('webhook-metacontroller') +
        rbac.clusterRoleBinding('webhook-metacontroller'),
  controllers: metacontroller.controllers(
    webhookServiceUrl='http://gen4-webhooks.default.svc:3000',
  ),
}
```

## Library Modules

### webhook.libsonnet

Webhook deployment helpers:

```jsonnet
webhook.stack(name, image, namespace, replicas, resources)
webhook.blueGreen(name, blueImage, greenImage, blueReplicas, greenReplicas)
webhook.multiComponent(name, image, webhookReplicas, provisionerReplicas, healthcheckReplicas)
```

### metacontroller.libsonnet

Metacontroller CRD generators:

```jsonnet
metacontroller.storageComposite(webhookUrl, resyncSeconds)
metacontroller.computeComposite(webhookUrl, resyncSeconds)
metacontroller.pvcBackupDecorator(webhookUrl, resyncSeconds)
metacontroller.controllers(webhookServiceUrl)  // All three
metacontroller.blueGreenControllers(environment='blue')
```

### rbac.libsonnet

RBAC helpers:

```jsonnet
rbac.serviceAccount(name, namespace)
rbac.fullOrchestrationRole(name)
rbac.provisionerRole(name)
rbac.readOnlyRole(name)
rbac.clusterRoleBinding(name, serviceAccountNamespace)
```

### gen4.libsonnet

Gen 4 deployment addon (opt-in):

```jsonnet
local gen4 = import 'lib/gen4.libsonnet';

gen4.resources($)  // Add Gen 4 based on _config.gen4
gen4.blueGreen($, 'blue')
gen4.custom($, webhookName='pilot', controllerPrefix='pilot')
```

### config.libsonnet

Configuration templates:

```jsonnet
local config = import 'lib/config.libsonnet';

config + {
  _config+:: {
    gen4+:: {
      enabled: true,
      webhook_replicas: 3,
    },
  },
}
```

## Usage in Tanka

### Directory Structure

```
environments/
├── prod/
│   ├── jsonnetfile.json       # jb dependencies
│   ├── jsonnetfile.lock.json
│   ├── vendor/                # jb installed libs
│   ├── main.jsonnet
│   └── spec.json              # Tanka spec
```

### Install Library

```bash
cd environments/prod
jb init  # If not already initialized
jb install github.com/your-org/nightscout-k8s/jsonnet@main
```

### Use in main.jsonnet

```jsonnet
local webhook = import 'lib/webhook.libsonnet';
local gen4 = import 'lib/gen4.libsonnet';

(import 'gen3-legacy.jsonnet') + {
  _config+:: {
    gen4+:: { enabled: true },
  },
} + gen4.resources($)
```

### Render Manifests

```bash
tk show environments/prod
tk diff environments/prod
tk apply environments/prod
```

## Direct Jsonnet Evaluation

You can also use without Tanka:

```bash
# Evaluate library
jsonnet -J vendor jsonnet/lib/main.libsonnet

# Render a deployment
jsonnet -J vendor environments/default/examples/02-gen4-simple.jsonnet

# Output to YAML
jsonnet -J vendor -y environments/prod/main.jsonnet > manifests.yaml
```

## Examples

See `environments/default/examples/` for complete examples:

- **01-gen3-only.jsonnet** - Gen 3 deployment (backward compatible)
- **02-gen4-simple.jsonnet** - Simple Gen 4 deployment
- **03-gen4-multicomponent.jsonnet** - Production-scale multi-component
- **04-gen4-bluegreen.jsonnet** - Blue/green deployment
- **05-gen4-custom-names.jsonnet** - Progressive migration

## Documentation

- **[Tanka Deployment Guide](../docs/TANKA-DEPLOYMENT.md)** - Complete Tanka usage
- **[Two-Composite Architecture](../docs/TWO-COMPOSITE-ARCHITECTURE.md)** - Gen 4 architecture
- **[RBAC Design](../docs/RBAC-DESIGN.md)** - ServiceAccount permissions
- **[Quick Start](../docs/QUICK-START.md)** - Get running in 5 minutes

## Dependencies

- **k8s-libsonnet** - Kubernetes object definitions (installed via jb)
- **Metacontroller** - Custom controller framework (deployed separately)
- **Strimzi Kafka Operator** - For CDC (deployed separately)

## License

See LICENSE file in repository root.

## Contributing

See CONTRIBUTING.md for development guidelines.
