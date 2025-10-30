// Example 5: Gen 4 Custom Webhook Names
//
// Use custom webhook and controller names for progressive migration.
// This lets you deploy Gen 4 webhooks targeting specific tenant subsets.
//
// Use case: Migrate 100 tenants to Gen 4 while keeping 1200 on Gen 3
//
// Deploy with:
//   tk apply environments/production-progressive

local config = import '../../lib/config.libsonnet';
local gen4 = import '../../lib/gen4.libsonnet';

(import '../main.jsonnet.original') + config + {
  _config+:: {
    num_runners: 5,
    scaling: {
      resolvers: 10,
      backends: 10,
    },
    
    gen4+:: {
      enabled: true,
      webhook_name: 'gen4-webhooks',
      webhook_replicas: 3,
    },
  },
} +
// Deploy webhook with custom name and controller prefix
gen4.custom($, webhookName='gen4-pilot', controllerPrefix='pilot')
// This creates:
//   - Deployment: gen4-pilot
//   - Service: gen4-pilot
//   - CompositeControllers: pilot-storage-composite, pilot-compute-composite
//   - DecoratorController: pilot-pvc-backup-decorator
//
// You can then manually label specific tenant ConfigMaps/Secrets to be
// managed by the pilot controllers while the rest use Gen 3.
