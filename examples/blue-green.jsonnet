// blue-green.jsonnet - Blue/green deployment configuration
//
// This example shows a blue/green deployment pattern where you can
// run two versions of the webhook service side-by-side and gradually
// shift traffic from blue to green.
//
// Deploy with:
//   tk apply environments/prod

local rbac = import '../lib/rbac.libsonnet';
local webhook = import '../lib/webhook.libsonnet';
local metacontroller = import '../lib/metacontroller.libsonnet';

{
  // RBAC: Option 1 - Shared ServiceAccount (simpler)
  // Both blue and green use the same ServiceAccount
  rbacShared: {
    serviceAccount: rbac.serviceAccount('webhook-service'),
    clusterRole: rbac.fullOrchestrationRole('webhook-service'),
    clusterRoleBinding: rbac.clusterRoleBinding('webhook-service'),
  },

  // RBAC: Option 2 - Separate ServiceAccounts (better audit trail)
  // Uncomment this and comment out rbacShared to use separate accounts
  /*
  rbacSeparate: {
    blue: {
      serviceAccount: rbac.serviceAccount('webhook-blue'),
      clusterRole: rbac.fullOrchestrationRole('webhook-orchestrator'),  // Shared role
      clusterRoleBinding: rbac.clusterRoleBinding('webhook-blue', serviceAccountName='webhook-blue', roleName='webhook-orchestrator'),
    },
    green: {
      serviceAccount: rbac.serviceAccount('webhook-green'),
      clusterRoleBinding: rbac.clusterRoleBinding('webhook-green', serviceAccountName='webhook-green', roleName='webhook-orchestrator'),
    },
  },
  */

  // Webhook: Blue/green deployments
  webhook: webhook.blueGreen(
    name='webhook',
    blueImage='your-registry/webhook:v1.0',   // Current production version
    greenImage='your-registry/webhook:v1.1',  // New version being validated
    namespace='default',
    blueReplicas=3,   // Production traffic
    greenReplicas=1,  // Canary validation
    port=3000,
    runtimeMode='all',
    serviceAccountName='webhook-service',  // Use 'webhook-blue' / 'webhook-green' if using separate accounts
  ),

  // Metacontroller: Initially pointing to blue
  // To cutover to green, change 'blue' to 'green' and reapply
  controllers: metacontroller.blueGreenControllers(
    environment='blue',  // Change to 'green' for cutover
  ),

  // Gradual cutover process:
  // 1. Deploy green with greenReplicas=1 (canary)
  // 2. Test green endpoint manually: curl http://webhook-green:3000/health
  // 3. Update Metacontroller to point to green (change environment='green')
  // 4. Create test tenant, verify it works on green
  // 5. Scale green up: greenReplicas=3
  // 6. Monitor metrics, logs
  // 7. Scale blue down: blueReplicas=0 (or delete blue deployment)
}
