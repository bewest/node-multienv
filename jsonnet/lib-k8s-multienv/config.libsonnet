// config.libsonnet - Centralized configuration for Nightscout platform
//
// This file contains all configuration parameters (_config) and image references
// (_images) extracted from the main deployment file for better maintainability.
//
// Usage in environments:
//   (import 'main.jsonnet') + {
//     _config+:: {
//       num_runners: 5,
//       scaling: { resolvers: 10 }
//     }
//   }

{
  _config+:: {
    // Namespace configuration
    namespace: 'default',
    multienv_k8s_namespace: 'hosted-tenants',
    
    // Gen 3 runner configuration
    num_runners: 3,
    cpu_request: '100m',
    memory_request: '500Mi',
    memory_limit: '3.2Gi',
    
    // Dispatcher configuration
    dispatcher_parallel_updates: '7',
    dispatchers_scale: 1,
    dispatchers_bookmark_name: 'dispatcher-bookmark-config',
    
    // Demuxer configuration
    demuxers_scale: 3,
    demuxer_search_tenant_cluster_tag: false,
    
    // Runner node pool configuration
    runners_use_select_nodepool: false,
    runners_selected_nodepool: '',
    
    // Component scaling
    scaling: {
      resolvers: 3,
      backends: 3,
      clusters: 3,
      deployment_controllers: 3,
    },
    
    // Feature flags for Gen 3
    combined_backends_resolvers: false,
    use_nodelocal_dns: false,
    use_deployment_controller: false,
    use_metacontroller_crds: false,
    use_deployment_operator: false,
    
    // Registry and image pull secrets
    registry_name: 'registry-staget1pal0',
    imagePullSecrets: [],
    
    // ServiceAccount names
    tenantManagerServiceAccountName: 'tenant-manager-sa',
    
    // Health check service
    MULTIENV_HEALTH_CHECK_SERVICE: 'http://multienv-deployment-controller:3000/',
    
    // Node pool targeting
    tenant_nodepool_target: 'bigger-tenant-runners',
    
    // IP configuration
    ips: {
      consul: '',
      nodelocal: '169.254.20.10',
      kubedns: '',
    },
    
    // Gen 4 webhook configuration (opt-in, disabled by default)
    gen4: {
      enabled: false,  // Set to true to deploy Gen 4 webhooks
      
      // Webhook deployment
      webhook_name: 'gen4-webhooks',
      webhook_namespace: 'default',
      webhook_replicas: 2,
      webhook_port: 3000,
      
      // Service account names (from docs/RBAC-DESIGN.md)
      webhook_metacontroller_sa: 'webhook-metacontroller',
      webhook_provisioner_sa: 'deployment-server',
      webhook_healthcheck_sa: 'consul-healthcheck',
      
      // Metacontroller configuration
      storage_composite_name: 'storage-composite',
      compute_composite_name: 'compute-composite',
      pvc_decorator_name: 'pvc-backup-decorator',
      
      // Webhook paths (matching cmd/webhook/server.js)
      storage_composite_path: '/composite/storage/sync',
      compute_composite_path: '/composite/compute/sync',
      decorator_sync_path: '/decorator/sync',
      decorator_finalize_path: '/decorator/finalize',
      
      // Resync periods (seconds)
      storage_resync_seconds: 30,
      compute_resync_seconds: 30,
      pvc_resync_seconds: 60,
      
      // Multi-component deployment (separate webhook, provisioner, healthcheck)
      multicomponent: {
        enabled: false,  // If true, deploy separate components
        webhook_replicas: 2,
        provisioner_replicas: 3,
        healthcheck_replicas: 10,
      },
      
      // Resource limits
      resources: {
        webhook: {
          requests: { cpu: '100m', memory: '128Mi' },
          limits: { cpu: '500m', memory: '512Mi' },
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
  
  _images+:: {
    consul: 'consul',
    nginx: 'nginx',
    multienv: 'registry.digitalocean.com/staget1pal0/multienv:latest',
    gitclone: 'alpine/git',
    
    // Gen 4 webhook image (defaults to multienv image for cloud-native startup)
    gen4_webhook: self.multienv,
  },
}
