// Example 2: Gen 4 Simple Deployment
//
// Enables Gen 4 webhooks with a single all-in-one deployment.
// This adds the webhook server and Metacontroller CRDs while keeping
// all your existing Gen 3 components running.
//
// Deploy with:
//   tk apply environments/production

local config = import '../../lib/config.libsonnet';
local gen4 = import '../../lib/gen4.libsonnet';

// Your existing Gen 3 deployment + Gen 4 addon
(import '../main.jsonnet.original') + config + {
  _config+:: {
    // Your existing Gen 3 overrides
    num_runners: 5,
    scaling: {
      resolvers: 10,
      backends: 10,
    },
    
    // Enable Gen 4 webhooks
    gen4+:: {
      enabled: true,
      webhook_name: 'gen4-webhooks',
      webhook_replicas: 3,
      
      // Use your existing multienv image (cloud-native startup pattern)
      // The container will start in webhook mode based on RUNTIME_MODE env var
    },
  },
} + gen4.resources($)
