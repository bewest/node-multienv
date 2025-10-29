// multi-component.jsonnet - Multi-component deployment with separate ServiceAccounts
//
// This example shows the production-recommended pattern: separate deployments
// for webhook, provisioner, and health check services, each with their own
// ServiceAccount and appropriate permissions.
//
// This allows scaling Consul health checks independently from webhook logic,
// which is critical when managing 1000+ tenants with high health check traffic.
//
// Deploy with:
//   tk apply environments/prod

local rbac = import '../lib/rbac.libsonnet';
local webhook = import '../lib/webhook.libsonnet';
local metacontroller = import '../lib/metacontroller.libsonnet';

{
  // RBAC: Three ServiceAccounts with least-privilege permissions
  rbac: {
    // Webhook: Full orchestration permissions (creates all tenant resources)
    webhook: {
      serviceAccount: rbac.serviceAccount('webhook-metacontroller'),
      clusterRole: rbac.fullOrchestrationRole('webhook-metacontroller'),
      clusterRoleBinding: rbac.clusterRoleBinding('webhook-metacontroller'),
    },

    // Provisioner: ConfigMap/Secret CRUD + read-only for status queries
    provisioner: {
      serviceAccount: rbac.serviceAccount('deployment-server'),
      clusterRole: rbac.provisionerRole('deployment-server'),
      clusterRoleBinding: rbac.clusterRoleBinding('deployment-server'),
    },

    // Health checks: Read-only for Consul service discovery
    healthcheck: {
      serviceAccount: rbac.serviceAccount('consul-healthcheck'),
      clusterRole: rbac.readOnlyRole('consul-healthcheck'),
      clusterRoleBinding: rbac.clusterRoleBinding('consul-healthcheck'),
    },
  },

  // Webhook: Three separate deployments with independent scaling
  webhook: webhook.multiComponent(
    name='webhook',
    image='your-registry/webhook:latest',
    namespace='default',
    port=3000,
    
    // Scaling configuration per component
    webhookReplicas=2,        // Low traffic (only Metacontroller sync calls)
    provisionerReplicas=3,    // Moderate traffic (admin API for provisioning)
    healthcheckReplicas=10,   // High traffic (Consul health checks from all worker nodes)
    
    // ServiceAccount names
    webhookServiceAccount='webhook-metacontroller',
    provisionerServiceAccount='deployment-server',
    healthcheckServiceAccount='consul-healthcheck',
  ),

  // Metacontroller: Points to webhook-specific service
  controllers: metacontroller.controllers(
    webhookServiceUrl='http://webhook-webhook:3000',  // Note: webhook-webhook (name-component)
  ),

  // Benefits of this architecture:
  // ✅ Scale health checks to 10+ replicas without scaling webhook pods
  // ✅ Health check pods are read-only (can't modify cluster state if compromised)
  // ✅ Provisioner pods can delete ConfigMaps/Secrets (REST API needs this)
  // ✅ Clear audit trail: logs show which component performed each action
  // ✅ Fault isolation: compromised health check can't create/update resources
  
  // Example scaling for 1300 tenants with heavy Consul traffic:
  // - webhookReplicas: 2-3 (stateless sync logic, low call volume)
  // - provisionerReplicas: 3-5 (admin operations, moderate volume)
  // - healthcheckReplicas: 15-20 (1300 tenants × multiple checks/min)
}
