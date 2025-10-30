// webhook.libsonnet - Webhook deployment helpers for Nightscout platform
//
// Provides parameterized functions for deploying webhook services with
// support for runtime modes (webhook, provisioner, healthcheck), blue/green
// deployments, and different scaling configurations.
//
// Usage:
//   local webhook = import 'webhook.libsonnet';
//   
//   // Single deployment (all runtime modes)
//   webhook.deployment('webhook-service', 'myregistry/webhook:v1.0')
//
//   // Blue/green with separate components
//   webhook.deployment('webhook-blue', 'myregistry/webhook:v1.0', runtimeMode='webhook') +
//   webhook.deployment('healthcheck-blue', 'myregistry/webhook:v1.0', runtimeMode='healthcheck', replicas=10)

local k = import 'k.libsonnet';

{
  // Default configuration values
  local defaults = {
    namespace: 'default',
    replicas: 2,
    port: 3000,
    image: 'webhook:latest',
    runtimeMode: 'all',  // all, webhook, provisioner, healthcheck
    serviceAccountName: 'webhook-service',
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
  },

  // Deployment constructor
  deployment(
    name,
    image=defaults.image,
    namespace=defaults.namespace,
    replicas=defaults.replicas,
    port=defaults.port,
    runtimeMode=defaults.runtimeMode,
    serviceAccountName=defaults.serviceAccountName,
    resources=defaults.resources,
    labels={},
    env=[],
  )::
    local defaultLabels = { app: name };
    local allLabels = defaultLabels + labels;
    
    local defaultEnv = [
      k.core.v1.envVar.new('PORT', std.toString(port)),
      k.core.v1.envVar.new('RUNTIME_MODE', runtimeMode),
    ];
    
    local httpGetAction = k.core.v1.httpGetAction.new() +
                          k.core.v1.httpGetAction.withPath('/health') +
                          k.core.v1.httpGetAction.withPort(port);
    
    local livenessProbe = k.core.v1.probe.new() +
                          k.core.v1.probe.withHttpGet(httpGetAction) +
                          k.core.v1.probe.withInitialDelaySeconds(10) +
                          k.core.v1.probe.withPeriodSeconds(10);
    
    local readinessProbe = k.core.v1.probe.new() +
                           k.core.v1.probe.withHttpGet(httpGetAction) +
                           k.core.v1.probe.withInitialDelaySeconds(5) +
                           k.core.v1.probe.withPeriodSeconds(5);
    
    k.apps.v1.deployment.new(
      name=name,
      replicas=replicas,
      containers=[
        k.core.v1.container.new('webhook', image) +
        k.core.v1.container.withPorts([
          k.core.v1.containerPort.new('http', port),
        ]) +
        k.core.v1.container.withEnv(defaultEnv + env) +
        k.core.v1.container.withLivenessProbe(livenessProbe) +
        k.core.v1.container.withReadinessProbe(readinessProbe) +
        k.core.v1.container.withResources({
          requests: resources.requests,
          limits: resources.limits,
        }),
      ],
    ) +
    k.apps.v1.deployment.metadata.withNamespace(namespace) +
    k.apps.v1.deployment.metadata.withLabels(allLabels) +
    k.apps.v1.deployment.spec.selector.withMatchLabels(allLabels) +
    k.apps.v1.deployment.spec.template.metadata.withLabels(allLabels) +
    k.apps.v1.deployment.spec.template.spec.withServiceAccountName(serviceAccountName),

  // Service constructor
  service(
    name,
    namespace=defaults.namespace,
    port=defaults.port,
    targetPort=defaults.port,
    selector={},
  )::
    local defaultSelector = { app: name };
    local allSelectors = defaultSelector + selector;
    
    k.core.v1.service.new(
      name=name,
      selector=allSelectors,
      ports=[
        k.core.v1.servicePort.new('http', port) +
        k.core.v1.servicePort.withTargetPort(targetPort),
      ],
    ) +
    k.core.v1.service.metadata.withNamespace(namespace) +
    k.core.v1.service.spec.withType('ClusterIP'),

  // Complete webhook stack (Deployment + Service)
  stack(
    name,
    image=defaults.image,
    namespace=defaults.namespace,
    replicas=defaults.replicas,
    port=defaults.port,
    runtimeMode=defaults.runtimeMode,
    serviceAccountName=defaults.serviceAccountName,
    resources=defaults.resources,
    labels={},
    env=[],
  ):: {
    deployment: $.deployment(
      name=name,
      image=image,
      namespace=namespace,
      replicas=replicas,
      port=port,
      runtimeMode=runtimeMode,
      serviceAccountName=serviceAccountName,
      resources=resources,
      labels=labels,
      env=env,
    ),
    service: $.service(
      name=name,
      namespace=namespace,
      port=port,
      targetPort=port,
      selector=labels + { app: name },
    ),
  },

  // Blue/green deployment helper
  blueGreen(
    name,
    blueImage,
    greenImage,
    namespace=defaults.namespace,
    blueReplicas=defaults.replicas,
    greenReplicas=defaults.replicas,
    port=defaults.port,
    runtimeMode=defaults.runtimeMode,
    serviceAccountName=defaults.serviceAccountName,
    resources=defaults.resources,
    env=[],
  ):: {
    blue: $.stack(
      name=name + '-blue',
      image=blueImage,
      namespace=namespace,
      replicas=blueReplicas,
      port=port,
      runtimeMode=runtimeMode,
      serviceAccountName=serviceAccountName,
      resources=resources,
      labels={ environment: 'blue' },
      env=env,
    ),
    green: $.stack(
      name=name + '-green',
      image=greenImage,
      namespace=namespace,
      replicas=greenReplicas,
      port=port,
      runtimeMode=runtimeMode,
      serviceAccountName=serviceAccountName,
      resources=resources,
      labels={ environment: 'green' },
      env=env,
    ),
  },

  // Multi-component deployment (separate webhook, provisioner, healthcheck)
  multiComponent(
    name,
    image,
    namespace=defaults.namespace,
    port=defaults.port,
    webhookReplicas=2,
    provisionerReplicas=3,
    healthcheckReplicas=10,
    webhookServiceAccount='webhook-metacontroller',
    provisionerServiceAccount='deployment-server',
    healthcheckServiceAccount='consul-healthcheck',
    resources=defaults.resources,
    env=[],
  ):: {
    webhook: $.stack(
      name=name + '-webhook',
      image=image,
      namespace=namespace,
      replicas=webhookReplicas,
      port=port,
      runtimeMode='webhook',
      serviceAccountName=webhookServiceAccount,
      resources=resources,
      labels={ component: 'webhook' },
      env=env,
    ),
    provisioner: $.stack(
      name=name + '-provisioner',
      image=image,
      namespace=namespace,
      replicas=provisionerReplicas,
      port=port,
      runtimeMode='provisioner',
      serviceAccountName=provisionerServiceAccount,
      resources=resources,
      labels={ component: 'provisioner' },
      env=env,
    ),
    healthcheck: $.stack(
      name=name + '-healthcheck',
      image=image,
      namespace=namespace,
      replicas=healthcheckReplicas,
      port=port,
      runtimeMode='healthcheck',
      serviceAccountName=healthcheckServiceAccount,
      resources={
        requests: { cpu: '50m', memory: '64Mi' },  // Lighter resources for read-only
        limits: { cpu: '200m', memory: '256Mi' },
      },
      labels={ component: 'healthcheck' },
      env=env,
    ),
  },
}
