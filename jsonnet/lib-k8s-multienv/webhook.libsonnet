// webhook.libsonnet - Webhook deployment helpers for Nightscout platform
//
// Provides parameterized functions for deploying webhook services with
// support for runtime modes via start_container.sh args, blue/green
// deployments, and different scaling configurations.
//
// Runtime Modes (mapped to start_container.sh args):
//   'all' or 'webhook' -> args: ["multienv-metactl-webhooks"]
//   'provisioner' -> args: ["deployment-controller"]
//   'healthcheck' -> args: ["tenant-pod-healthcheck"]
//
// Usage:
//   local webhook = import 'webhook.libsonnet';
//   
//   // Single deployment (all-in-one webhook server)
//   webhook.deployment('webhook-service', 'myregistry/webhook:v1.0')
//
//   // Multi-component with separate deployments
//   webhook.deployment('webhook', 'myregistry/webhook:v1.0', runtimeMode='webhook') +
//   webhook.deployment('provisioner', 'myregistry/webhook:v1.0', runtimeMode='provisioner') +
//   webhook.deployment('healthcheck', 'myregistry/webhook:v1.0', runtimeMode='healthcheck', replicas=10)
//
//   // ConfigMap for environment overrides
//   webhook.configMap('webhook-config', {
//     port: 5050,
//     tenantNodepoolDefault: 'bigger-tenant-runners',
//     tenantNodepoolKey: 'doks.digitalocean.com/node-pool',
//     imagePullSecrets: ['staging-multienv-01', 'staging-multienv-02'],
//     nsUtilityImage: 'registry.digitalocean.com/staget1pal0/util:latest',
//     podHealthcheckImage: 'registry.digitalocean.com/staget1pal0/multienv',
//   })

{
  // Default configuration values
  local defaults = {
    namespace: 'default',
    replicas: 2,
    port: 3000,
    image: 'webhook:latest',
    runtimeMode: 'all',  // all, webhook, provisioner, healthcheck
    serviceAccountName: 'webhook-service',
    imagePullSecrets: [],  // [{name: 'registry-credentials'}]
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

  // ConfigMap constructor for webhook environment overrides
  // Creates a ConfigMap that can be mounted as envFrom in the deployment
  //
  // Parameters:
  //   name: ConfigMap name
  //   namespace: Kubernetes namespace (default: 'default')
  //   config: Object with environment configuration:
  //     - port: Webhook server port (default: 3000)
  //     - tenantNodepoolEnabled: Enable node affinity (default: false)
  //     - tenantNodepoolDefault: Default node pool name for tenant scheduling
  //     - tenantNodepoolKey: Provider-specific node pool label key
  //     - imagePullSecrets: Array of pull secret names (comma-joined in env var)
  //     - nsUtilityImage: MongoDB utility container image
  //     - podHealthcheckImage: Pod healthcheck sidecar image
  //     - tenantNamespace: Namespace for tenant resources
  //     - useReplicaSet: Whether to use ReplicaSet mode (default: true)
  //     - extra: Additional key-value pairs to include
  configMap(
    name,
    namespace=defaults.namespace,
    config={},
  )::
    local cfg = {
      port: 3000,
      tenantNodepoolEnabled: false,
      tenantNodepoolDefault: '',
      tenantNodepoolKey: 'cloud.google.com/gke-nodepool',
      imagePullSecrets: [],
      nsUtilityImage: '',
      podHealthcheckImage: '',
      tenantNamespace: 'hosted-tenants',
      useReplicaSet: true,
      extra: {},
    } + config;

    local data = {
      PORT: std.toString(cfg.port),
    } + (
      if cfg.tenantNodepoolEnabled then {
        TENANT_NODEPOOL_ENABLED: 'true',
      } else {}
    ) + (
      if cfg.tenantNodepoolDefault != '' then {
        TENANT_NODEPOOL_DEFAULT: cfg.tenantNodepoolDefault,
      } else {}
    ) + (
      if cfg.tenantNodepoolKey != '' then {
        TENANT_NODEPOOL_KEY: cfg.tenantNodepoolKey,
      } else {}
    ) + (
      if std.length(cfg.imagePullSecrets) > 0 then {
        MULTIENV_IMAGE_PULLSECRETS: std.join(',', cfg.imagePullSecrets),
      } else {}
    ) + (
      if cfg.nsUtilityImage != '' then {
        NS_UTILITY_IMAGE: cfg.nsUtilityImage,
      } else {}
    ) + (
      if cfg.podHealthcheckImage != '' then {
        POD_HEALTHCHECK_IMAGE: cfg.podHealthcheckImage,
      } else {}
    ) + (
      if cfg.tenantNamespace != '' then {
        TENANT_NAMESPACE: cfg.tenantNamespace,
      } else {}
    ) + (
      if !cfg.useReplicaSet then {
        USE_REPLICASET: 'false',
      } else {}
    ) + cfg.extra;

    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: name,
        namespace: namespace,
        labels: {
          app: name,
          'app.kubernetes.io/component': 'webhook-config',
        },
      },
      data: data,
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
    imagePullSecrets=defaults.imagePullSecrets,
    resources=defaults.resources,
    labels={},
    env=[],
    envFromConfigMaps=[],  // Array of ConfigMap names to load as env vars
  )::
    local defaultLabels = { app: name };
    local allLabels = defaultLabels + labels;
    
    local defaultEnv = [
      { name: 'PORT', value: std.toString(port) },
    ];
    
    // Build envFrom array from ConfigMap names
    local envFrom = [
      { configMapRef: { name: cm } }
      for cm in envFromConfigMaps
    ];
    
    // Map runtimeMode to start_container.sh args
    local containerArgs =
      if runtimeMode == 'all' then ['multienv-metactl-webhooks']
      else if runtimeMode == 'webhook' then ['multienv-metactl-webhooks']
      else if runtimeMode == 'provisioner' then ['deployment-controller']
      else if runtimeMode == 'healthcheck' then ['tenant-pod-healthcheck']
      else error 'Unknown runtimeMode: %s (valid: all, webhook, provisioner, healthcheck)' % runtimeMode;
    
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
            imagePullSecrets: imagePullSecrets,
            containers: [
              {
                name: 'webhook',
                image: image,
                args: containerArgs,
                ports: [
                  {
                    name: 'http',
                    containerPort: port,
                  },
                ],
                env: defaultEnv + env,
              } + (
                if std.length(envFrom) > 0 then { envFrom: envFrom } else {}
              ) + {
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
    imagePullSecrets=defaults.imagePullSecrets,
    resources=defaults.resources,
    labels={},
    env=[],
    envFromConfigMaps=[],
  ):: {
    deployment: $.deployment(
      name=name,
      image=image,
      namespace=namespace,
      replicas=replicas,
      port=port,
      runtimeMode=runtimeMode,
      serviceAccountName=serviceAccountName,
      imagePullSecrets=imagePullSecrets,
      resources=resources,
      labels=labels,
      env=env,
      envFromConfigMaps=envFromConfigMaps,
    ),
    service: $.service(
      name=name,
      namespace=namespace,
      port=port,
      targetPort=port,
      selector=labels + { app: name },
    ),
  },

  // Complete webhook stack with ConfigMap (ConfigMap + Deployment + Service)
  // Convenience function that creates the ConfigMap and wires it to the deployment
  stackWithConfig(
    name,
    image=defaults.image,
    namespace=defaults.namespace,
    replicas=defaults.replicas,
    port=defaults.port,
    runtimeMode=defaults.runtimeMode,
    serviceAccountName=defaults.serviceAccountName,
    imagePullSecrets=defaults.imagePullSecrets,
    resources=defaults.resources,
    labels={},
    env=[],
    config={},  // Config object for configMap() function
  )::
    local configMapName = name + '-config';
    {
      configMap: $.configMap(
        name=configMapName,
        namespace=namespace,
        config=config,
      ),
      deployment: $.deployment(
        name=name,
        image=image,
        namespace=namespace,
        replicas=replicas,
        port=port,
        runtimeMode=runtimeMode,
        serviceAccountName=serviceAccountName,
        imagePullSecrets=imagePullSecrets,
        resources=resources,
        labels=labels,
        env=env,
        envFromConfigMaps=[configMapName],
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
    imagePullSecrets=defaults.imagePullSecrets,
    resources=defaults.resources,
    env=[],
    envFromConfigMaps=[],
  ):: {
    blue: $.stack(
      name=name + '-blue',
      image=blueImage,
      namespace=namespace,
      replicas=blueReplicas,
      port=port,
      runtimeMode=runtimeMode,
      serviceAccountName=serviceAccountName,
      imagePullSecrets=imagePullSecrets,
      resources=resources,
      labels={ environment: 'blue' },
      env=env,
      envFromConfigMaps=envFromConfigMaps,
    ),
    green: $.stack(
      name=name + '-green',
      image=greenImage,
      namespace=namespace,
      replicas=greenReplicas,
      port=port,
      runtimeMode=runtimeMode,
      serviceAccountName=serviceAccountName,
      imagePullSecrets=imagePullSecrets,
      resources=resources,
      labels={ environment: 'green' },
      env=env,
      envFromConfigMaps=envFromConfigMaps,
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
    imagePullSecrets=defaults.imagePullSecrets,
    resources=defaults.resources,
    env=[],
    envFromConfigMaps=[],
  ):: {
    webhook: $.stack(
      name=name + '-webhook',
      image=image,
      namespace=namespace,
      replicas=webhookReplicas,
      port=port,
      runtimeMode='webhook',
      serviceAccountName=webhookServiceAccount,
      imagePullSecrets=imagePullSecrets,
      resources=resources,
      labels={ component: 'webhook' },
      env=env,
      envFromConfigMaps=envFromConfigMaps,
    ),
    provisioner: $.stack(
      name=name + '-provisioner',
      image=image,
      namespace=namespace,
      replicas=provisionerReplicas,
      port=port,
      runtimeMode='provisioner',
      serviceAccountName=provisionerServiceAccount,
      imagePullSecrets=imagePullSecrets,
      resources=resources,
      labels={ component: 'provisioner' },
      env=env,
      envFromConfigMaps=envFromConfigMaps,
    ),
    healthcheck: $.stack(
      name=name + '-healthcheck',
      image=image,
      namespace=namespace,
      replicas=healthcheckReplicas,
      port=port,
      runtimeMode='healthcheck',
      serviceAccountName=healthcheckServiceAccount,
      imagePullSecrets=imagePullSecrets,
      resources={
        requests: { cpu: '50m', memory: '64Mi' },  // Lighter resources for read-only
        limits: { cpu: '200m', memory: '256Mi' },
      },
      labels={ component: 'healthcheck' },
      env=env,
      envFromConfigMaps=envFromConfigMaps,
    ),
  },
}
