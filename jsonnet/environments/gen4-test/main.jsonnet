// Gen 4 Stack Test Environment
//
// This demonstrates the simplified gen4.stack() function for
// batteries-included Gen 4 deployment.
//
// Test with:
//   tk eval jsonnet/environments/gen4-test
//   tk show jsonnet/environments/gen4-test

local gen4 = import '../../lib-k8s-multienv/gen4.libsonnet';
local webhook = import '../../lib-k8s-multienv/webhook.libsonnet';
local rbac = import '../../lib-k8s-multienv/rbac.libsonnet';

{
  // ============================================================================
  // SIMPLE USAGE - One function call for complete Gen 4 deployment
  // ============================================================================
  
  // This creates everything you need:
  // - ServiceAccount with full orchestration permissions
  // - ClusterRole and ClusterRoleBinding
  // - Webhook Deployment (all-in-one: webhook + provisioner + healthcheck)
  // - Webhook Service
  // - Storage CompositeController CRD
  // - Compute CompositeController CRD
  // - PVC Backup DecoratorController CRD
  
  simple_deployment: gen4.stack(
    webhookImage='registry.digitalocean.com/staget1pal0/multienv:latest',
    webhookName='gen4-webhooks',
    webhookNamespace='default',
    targetNamespace='hosted-tenants',  // Provisioner API can only manipulate Secrets/ConfigMaps here
    webhookReplicas=3,
    imagePullSecrets=[{name: 'registry-staget1pal0'}],  // DigitalOcean registry credentials
    storageResyncSeconds=60,
    computeResyncSeconds=60,
    pvcResyncSeconds=120,
  ),
  
  // ============================================================================
  // ADVANCED USAGE - Custom multi-component deployment
  // ============================================================================
  
  // For production deployments with separate webhook, provisioner, and healthcheck
  // you can still use the low-level modules directly for full control:
  
  advanced_rbac: {
    webhook_sa: rbac.serviceAccount('webhook-metacontroller', 'default'),
    webhook_role: rbac.fullOrchestrationRole('webhook-metacontroller'),
    webhook_binding: rbac.clusterRoleBinding('webhook-metacontroller'),
    
    provisioner_sa: rbac.serviceAccount('deployment-server', 'default'),
    provisioner_role: rbac.provisionerRole('deployment-server'),
    provisioner_binding: rbac.clusterRoleBinding('deployment-server'),
    
    healthcheck_sa: rbac.serviceAccount('consul-healthcheck', 'default'),
    healthcheck_role: rbac.readOnlyRole('consul-healthcheck'),
    healthcheck_binding: rbac.clusterRoleBinding('consul-healthcheck'),
  },
  
  advanced_webhooks: {
    webhook: webhook.stack(
      name='multienv-webhook',
      image='registry.digitalocean.com/staget1pal0/multienv:latest',
      namespace='default',
      replicas=2,
      port=3000,
      runtimeMode='webhook',
      serviceAccountName='webhook-metacontroller',
      imagePullSecrets=[{name: 'registry-staget1pal0'}],
      resources={
        requests: { cpu: '100m', memory: '128Mi' },
        limits: { cpu: '500m', memory: '512Mi' },
      },
    ),
    
    provisioner: webhook.stack(
      name='multienv-provisioner',
      image='registry.digitalocean.com/staget1pal0/multienv:latest',
      namespace='default',
      replicas=3,
      port=3000,
      runtimeMode='provisioner',
      serviceAccountName='deployment-server',
      imagePullSecrets=[{name: 'registry-staget1pal0'}],
      resources={
        requests: { cpu: '200m', memory: '256Mi' },
        limits: { cpu: '1000m', memory: '1Gi' },
      },
    ),
    
    healthcheck: webhook.stack(
      name='multienv-healthcheck',
      image='registry.digitalocean.com/staget1pal0/multienv:latest',
      namespace='default',
      replicas=10,
      port=3000,
      runtimeMode='healthcheck',
      serviceAccountName='consul-healthcheck',
      imagePullSecrets=[{name: 'registry-staget1pal0'}],
      resources={
        requests: { cpu: '50m', memory: '64Mi' },
        limits: { cpu: '200m', memory: '256Mi' },
      },
    ),
  },
  
  // ============================================================================
  // EXAMPLE TENANT RESOURCES - StorageAccount and ComputeInstance CRDs
  // ============================================================================
  
  // Example StorageAccount - Manages MongoDB infrastructure for a tenant
  example_storage_basic: {
    apiVersion: 'nightscout.io/v1alpha1',
    kind: 'StorageAccount',
    metadata: {
      name: 'tenant-abc-storage',
      namespace: 'hosted-tenants',
    },
    spec: {
      mongodbVersion: '7.0',
      replicas: 3,
      tier: 'basic',
      storageSize: '10Gi',
      resources: {
        requests: {
          cpu: '100m',
          memory: '256Mi',
        },
        limits: {
          cpu: '500m',
          memory: '512Mi',
        },
      },
      backup: {
        enabled: true,
        retentionPolicy: 'Retain',
      },
    },
  },
  
  // Example StorageAccount - Premium tier with migration
  example_storage_premium: {
    apiVersion: 'nightscout.io/v1alpha1',
    kind: 'StorageAccount',
    metadata: {
      name: 'tenant-xyz-storage',
      namespace: 'hosted-tenants',
    },
    spec: {
      mongodbVersion: '7.0',
      replicas: 5,
      tier: 'premium',
      storageSize: '100Gi',
      storageClass: 'fast-ssd',
      resources: {
        requests: {
          cpu: '500m',
          memory: '1Gi',
        },
        limits: {
          cpu: '2000m',
          memory: '4Gi',
        },
      },
      backup: {
        enabled: true,
        retentionPolicy: 'Retain',
      },
      migration: {
        enabled: true,
        sourceType: 'shared',
        sourceConnectionSecret: 'legacy-mongodb-credentials',
      },
    },
  },
  
  // Example ComputeInstance - Basic Nightscout deployment
  example_compute_basic: {
    apiVersion: 'nightscout.io/v1alpha1',
    kind: 'ComputeInstance',
    metadata: {
      name: 'tenant-abc-app',
      namespace: 'hosted-tenants',
      labels: {
        'storage.nightscout.org/account': 'tenant-abc-storage',
      },
    },
    spec: {
      storageAccountRef: {
        name: 'tenant-abc-storage',
      },
      nightscoutImage: 'nightscout/cgm-remote-monitor:latest',
      replicas: 2,
      tier: 'basic',
      resources: {
        requests: {
          cpu: '100m',
          memory: '128Mi',
        },
        limits: {
          cpu: '500m',
          memory: '512Mi',
        },
      },
      env: [
        {
          name: 'ENABLE',
          value: 'careportal basal',
        },
        {
          name: 'TIME_FORMAT',
          value: '12',
        },
      ],
      healthcheck: {
        enabled: true,
      },
    },
  },
  
  // Example ComputeInstance - Premium with CDC
  example_compute_premium: {
    apiVersion: 'nightscout.io/v1alpha1',
    kind: 'ComputeInstance',
    metadata: {
      name: 'tenant-xyz-app',
      namespace: 'hosted-tenants',
      labels: {
        'storage.nightscout.org/account': 'tenant-xyz-storage',
      },
    },
    spec: {
      storageAccountRef: {
        name: 'tenant-xyz-storage',
      },
      nightscoutImage: 'nightscout/cgm-remote-monitor:15.0.0',
      replicas: 4,
      tier: 'premium',
      resources: {
        requests: {
          cpu: '200m',
          memory: '256Mi',
        },
        limits: {
          cpu: '1000m',
          memory: '1Gi',
        },
      },
      cdc: {
        enabled: true,
        kafkaCluster: 'main-kafka',
        kafkaConnectCluster: 'connect-cluster',
      },
      healthcheck: {
        enabled: true,
        image: 'custom-healthcheck:latest',
      },
    },
  },
}
