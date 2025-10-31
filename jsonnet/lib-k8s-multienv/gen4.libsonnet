// gen4-addon.libsonnet - Optional Gen 4 webhook deployment addon
//
// This file provides Gen 4 webhook deployment resources that can be optionally
// enabled in any environment. It uses the existing lib/ libsonnet helpers.
//
// Usage:
//   local gen4 = import 'lib/gen4-addon.libsonnet';
//   
//   // In your main.jsonnet:
//   (import 'main.jsonnet') + {
//     _config+:: {
//       gen4+:: { enabled: true }
//     }
//   } + gen4.resources($)

local webhook = import 'webhook.libsonnet';
local metacontroller = import 'metacontroller.libsonnet';
local rbac = import 'rbac.libsonnet';

{
  // Generate webhook service URL for Metacontroller
  webhookServiceUrl(config)::
    'http://%s.%s.svc.cluster.local:%d' % [
      config.gen4.webhook_name,
      config.gen4.webhook_namespace,
      config.gen4.webhook_port,
    ],

  // Generate all Gen 4 resources (conditional on _config.gen4.enabled)
  resources(parent)::
    if !parent._config.gen4.enabled then
      {}  // Return empty object if Gen 4 is disabled
    else
      local cfg = parent._config.gen4;
      local webhookUrl = $.webhookServiceUrl(parent._config);
      
      if cfg.multicomponent.enabled then
        // Multi-component deployment (separate webhook, provisioner, healthcheck)
        {
          gen4_webhook_rbac:
            rbac.serviceAccount(cfg.webhook_metacontroller_sa, cfg.webhook_namespace) +
            rbac.fullOrchestrationRole(cfg.webhook_metacontroller_sa) +
            rbac.clusterRoleBinding(cfg.webhook_metacontroller_sa,
                                    serviceAccountNamespace=cfg.webhook_namespace),
          
          gen4_provisioner_rbac:
            rbac.serviceAccount(cfg.webhook_provisioner_sa, cfg.webhook_namespace) +
            rbac.provisionerRole(cfg.webhook_provisioner_sa) +
            rbac.clusterRoleBinding(cfg.webhook_provisioner_sa,
                                    serviceAccountNamespace=cfg.webhook_namespace),
          
          gen4_healthcheck_rbac:
            rbac.serviceAccount(cfg.webhook_healthcheck_sa, cfg.webhook_namespace) +
            rbac.readOnlyRole(cfg.webhook_healthcheck_sa) +
            rbac.clusterRoleBinding(cfg.webhook_healthcheck_sa,
                                    serviceAccountNamespace=cfg.webhook_namespace),
          
          // Build individual stacks to support custom resources per component
          gen4_webhook: webhook.stack(
            name=cfg.webhook_name + '-webhook',
            image=parent._images.gen4_webhook,
            namespace=cfg.webhook_namespace,
            replicas=cfg.multicomponent.webhook_replicas,
            port=cfg.webhook_port,
            runtimeMode='webhook',
            serviceAccountName=cfg.webhook_metacontroller_sa,
            resources=cfg.resources.webhook,
            labels={ component: 'webhook' },
          ),
          
          gen4_provisioner: webhook.stack(
            name=cfg.webhook_name + '-provisioner',
            image=parent._images.gen4_webhook,
            namespace=cfg.webhook_namespace,
            replicas=cfg.multicomponent.provisioner_replicas,
            port=cfg.webhook_port,
            runtimeMode='provisioner',
            serviceAccountName=cfg.webhook_provisioner_sa,
            resources=cfg.resources.provisioner,
            labels={ component: 'provisioner' },
          ),
          
          gen4_healthcheck: webhook.stack(
            name=cfg.webhook_name + '-healthcheck',
            image=parent._images.gen4_webhook,
            namespace=cfg.webhook_namespace,
            replicas=cfg.multicomponent.healthcheck_replicas,
            port=cfg.webhook_port,
            runtimeMode='healthcheck',
            serviceAccountName=cfg.webhook_healthcheck_sa,
            resources=cfg.resources.healthcheck,
            labels={ component: 'healthcheck' },
          ),
          
          gen4_metacontroller: metacontroller.controllers(
            webhookServiceUrl=webhookUrl,
            storageResyncSeconds=cfg.storage_resync_seconds,
            computeResyncSeconds=cfg.compute_resync_seconds,
            pvcResyncSeconds=cfg.pvc_resync_seconds,
          ),
        }
      else
        // Single deployment (all-in-one webhook server)
        {
          gen4_webhook_rbac:
            rbac.serviceAccount(cfg.webhook_metacontroller_sa, cfg.webhook_namespace) +
            rbac.fullOrchestrationRole(cfg.webhook_metacontroller_sa) +
            rbac.clusterRoleBinding(cfg.webhook_metacontroller_sa,
                                    serviceAccountNamespace=cfg.webhook_namespace),
          
          gen4_deployment: webhook.stack(
            name=cfg.webhook_name,
            image=parent._images.gen4_webhook,
            namespace=cfg.webhook_namespace,
            replicas=cfg.webhook_replicas,
            port=cfg.webhook_port,
            runtimeMode='all',
            serviceAccountName=cfg.webhook_metacontroller_sa,
            resources=cfg.resources.webhook,
          ),
          
          gen4_metacontroller: metacontroller.controllers(
            webhookServiceUrl=webhookUrl,
            storageResyncSeconds=cfg.storage_resync_seconds,
            computeResyncSeconds=cfg.compute_resync_seconds,
            pvcResyncSeconds=cfg.pvc_resync_seconds,
          ),
        },

  // Blue/green deployment helper
  blueGreen(parent, environment)::
    if !parent._config.gen4.enabled then
      error 'Gen 4 must be enabled to use blue/green deployment'
    else
      local cfg = parent._config.gen4;
      local deploymentName = '%s-%s' % [cfg.webhook_name, environment];
      local webhookUrl = 'http://%s.%s.svc.cluster.local:%d' % [
        deploymentName,
        cfg.webhook_namespace,
        cfg.webhook_port,
      ];
      
      {
        ['gen4_webhook_' + environment]:
          webhook.stack(
            name=deploymentName,
            image=parent._images.gen4_webhook,
            namespace=cfg.webhook_namespace,
            replicas=cfg.webhook_replicas,
            port=cfg.webhook_port,
            runtimeMode='all',
            serviceAccountName=cfg.webhook_metacontroller_sa,
            resources=cfg.resources.webhook,
            labels={ environment: environment },
          ),
        
        ['gen4_metacontroller_' + environment]:
          metacontroller.controllers(
            webhookServiceUrl=webhookUrl,
            storageResyncSeconds=cfg.storage_resync_seconds,
            computeResyncSeconds=cfg.compute_resync_seconds,
            pvcResyncSeconds=cfg.pvc_resync_seconds,
          ) + {
            // Update controller names to include environment
            storage+: { metadata+: { name: '%s-%s' % [cfg.storage_composite_name, environment] } },
            compute+: { metadata+: { name: '%s-%s' % [cfg.compute_composite_name, environment] } },
            pvcBackup+: { metadata+: { name: '%s-%s' % [cfg.pvc_decorator_name, environment] } },
          },
      },

  // Custom webhook name deployment (for progressive migration)
  custom(parent, webhookName, controllerPrefix='')::
    if !parent._config.gen4.enabled then
      error 'Gen 4 must be enabled to use custom webhook deployment'
    else
      local cfg = parent._config.gen4;
      local webhookUrl = 'http://%s.%s.svc.cluster.local:%d' % [
        webhookName,
        cfg.webhook_namespace,
        cfg.webhook_port,
      ];
      local prefix = if controllerPrefix == '' then '' else controllerPrefix + '-';
      
      {
        gen4_webhook_custom:
          webhook.stack(
            name=webhookName,
            image=parent._images.gen4_webhook,
            namespace=cfg.webhook_namespace,
            replicas=cfg.webhook_replicas,
            port=cfg.webhook_port,
            runtimeMode='all',
            serviceAccountName=cfg.webhook_metacontroller_sa,
            resources=cfg.resources.webhook,
          ),
        
        gen4_metacontroller_custom:
          metacontroller.controllers(
            webhookServiceUrl=webhookUrl,
            storageResyncSeconds=cfg.storage_resync_seconds,
            computeResyncSeconds=cfg.compute_resync_seconds,
            pvcResyncSeconds=cfg.pvc_resync_seconds,
          ) + {
            storage+: { metadata+: { name: prefix + cfg.storage_composite_name } },
            compute+: { metadata+: { name: prefix + cfg.compute_composite_name } },
            pvcBackup+: { metadata+: { name: prefix + cfg.pvc_decorator_name } },
          },
      },

  // Simple stack() function - batteries-included Gen 4 deployment
  // Returns everything you need: CRDs + Webhook + Service + RBAC
  //
  // Usage:
  //   local gen4 = import 'gen4.libsonnet';
  //   gen4.stack(
  //     webhookImage: 'registry/webhook:v1.0',
  //     webhookReplicas: 3,
  //   )
  stack(
    webhookImage='webhook:latest',
    webhookName='gen4-webhooks',
    webhookNamespace='default',
    webhookReplicas=2,
    webhookPort=3000,
    webhookServiceAccount='webhook-metacontroller',
    storageResyncSeconds=30,
    computeResyncSeconds=30,
    pvcResyncSeconds=60,
    webhookResources={
      requests: { cpu: '100m', memory: '128Mi' },
      limits: { cpu: '500m', memory: '512Mi' },
    },
  )::
    local webhookUrl = 'http://%s.%s.svc.cluster.local:%d' % [
      webhookName,
      webhookNamespace,
      webhookPort,
    ];
    
    {
      // ServiceAccount and RBAC for webhook
      serviceAccount: rbac.serviceAccount(webhookServiceAccount, webhookNamespace),
      clusterRole: rbac.fullOrchestrationRole(webhookServiceAccount),
      clusterRoleBinding: rbac.clusterRoleBinding(
        webhookServiceAccount,
        serviceAccountName=webhookServiceAccount,
        serviceAccountNamespace=webhookNamespace,
        roleName=webhookServiceAccount
      ),
      
      // Webhook Deployment and Service
      webhook: webhook.stack(
        name=webhookName,
        image=webhookImage,
        namespace=webhookNamespace,
        replicas=webhookReplicas,
        port=webhookPort,
        runtimeMode='all',
        serviceAccountName=webhookServiceAccount,
        resources=webhookResources,
      ),
      
      // Metacontroller CRDs (CompositeControllers + DecoratorController)
      metacontroller: metacontroller.controllers(
        webhookServiceUrl=webhookUrl,
        storageResyncSeconds=storageResyncSeconds,
        computeResyncSeconds=computeResyncSeconds,
        pvcResyncSeconds=pvcResyncSeconds,
      ),
    },
}
