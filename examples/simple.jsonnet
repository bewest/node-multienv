// simple.jsonnet - Simple single-deployment webhook configuration
//
// This example shows the simplest deployment: a single webhook service
// running all runtime modes (webhook, provisioner, healthcheck) with
// a single ServiceAccount.
//
// Deploy with:
//   tk apply environments/dev

local rbac = import '../lib/rbac.libsonnet';
local webhook = import '../lib/webhook.libsonnet';
local metacontroller = import '../lib/metacontroller.libsonnet';

{
  // RBAC: Single ServiceAccount with full orchestration permissions
  rbac: {
    serviceAccount: rbac.serviceAccount('webhook-service'),
    clusterRole: rbac.fullOrchestrationRole('webhook-service'),
    clusterRoleBinding: rbac.clusterRoleBinding('webhook-service'),
  },

  // Webhook: Single deployment running all modes
  webhook: webhook.stack(
    name='webhook-service',
    image='your-registry/webhook:latest',
    namespace='default',
    replicas=2,
    port=3000,
    runtimeMode='all',  // Runs all endpoints
    serviceAccountName='webhook-service',
  ),

  // Metacontroller: Controllers pointing to webhook service
  controllers: metacontroller.controllers(
    webhookServiceUrl='http://webhook-service:3000',
  ),
}
