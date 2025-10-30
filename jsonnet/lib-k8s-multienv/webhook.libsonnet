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
      { name: 'PORT', value: std.toString(port) },
      { name: 'RUNTIME_MODE', value: runtimeMode },
    ];
    
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: name,
        namespace: namespace,
        labels: allLabels,
      },
      spec: {
        replicas: replicas,
        selector: {
          matchLabels: allLabels,
        },
        template: {
          metadata: {
            labels: allLabels,
          },
          spec: {
            serviceAccountName: serviceAccountName,
            containers: [
              {
                name: 'webhook',
                image: image,
                ports: [
                  {
                    name: 'http',
                    containerPort: port,
                  },
                ],
                env: defaultEnv + env,
                livenessProbe: {
                  httpGet: {
                    path: '/health',
                    port: port,
                  },
                  initialDelaySeconds: 10,
                  periodSeconds: 10,
                },
                readinessProbe: {
                  httpGet: {
                    path: '/health',
                    port: port,
                  },
                  initialDelaySeconds: 5,
                  periodSeconds: 5,
                },
                resources: resources,
              },
            ],
          },
        },
      },
    },

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
    
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: name,
        namespace: namespace,
      },
      spec: {
        type: 'ClusterIP',
        selector: allSelectors,
        ports: [
          {
            name: 'http',
            port: port,
            targetPort: targetPort,
          },
        ],
      },
    },

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
