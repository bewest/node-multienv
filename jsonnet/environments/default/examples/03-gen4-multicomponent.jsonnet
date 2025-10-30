// Example 3: Gen 4 Multi-Component Deployment
//
// Deploys separate components for webhook, provisioner, and healthcheck.
// This provides better scaling and RBAC isolation.
//
// Deploy with:
//   tk apply environments/production-multicomponent

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
      webhook_name: 'gen4',
      
      // Multi-component deployment
      multicomponent: {
        enabled: true,
        webhook_replicas: 2,        // Metacontroller sync endpoints
        provisioner_replicas: 3,    // REST API for provisioning
        healthcheck_replicas: 10,   // Consul health checks (read-only)
      },
      
      // Resource limits per component
      resources: {
        webhook: {
          requests: { cpu: '200m', memory: '256Mi' },
          limits: { cpu: '1000m', memory: '1Gi' },
        },
        provisioner: {
          requests: { cpu: '200m', memory: '256Mi' },
          limits: { cpu: '1000m', memory: '1Gi' },
        },
        healthcheck: {
          requests: { cpu: '50m', memory: '64Mi' },
          limits: { cpu: '200m', memory: '256Mi' },
        },
      },
    },
  },
} + gen4.resources($)
