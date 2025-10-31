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
}
