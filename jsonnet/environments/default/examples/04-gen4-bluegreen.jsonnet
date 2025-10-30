// Example 4: Gen 4 Blue/Green Deployment
//
// Deploys both blue and green webhook environments simultaneously.
// Use this for zero-downtime webhook updates and progressive migration.
//
// Workflow:
//   1. Deploy blue (current production)
//   2. Deploy green (new version)
//   3. Test green with a few tenants
//   4. Migrate Metacontroller CRDs to point to green
//   5. Remove blue when confident
//
// Deploy with:
//   tk apply environments/production-bluegreen

local config = import '../lib/config.libsonnet';
local gen4 = import '../lib/gen4-addon.libsonnet';

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
// Deploy both blue and green environments
gen4.blueGreen($, 'blue') +
gen4.blueGreen($, 'green')
