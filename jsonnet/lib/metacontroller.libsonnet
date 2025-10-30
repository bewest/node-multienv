// metacontroller.libsonnet - Metacontroller resource helpers
//
// Provides functions for creating CompositeController and DecoratorController
// resources that integrate with the webhook service.
//
// Usage:
//   local metacontroller = import 'metacontroller.libsonnet';
//   
//   // Create storage composite controller
//   metacontroller.compositeController(
//     name='storage-composite',
//     webhookUrl='http://webhook-service:3000/sync-storage',
//     parentResource={ apiVersion: 'v1', resource: 'secrets' }
//   )

{
  // CompositeController constructor
  compositeController(
    name,
    webhookUrl,
    parentResource,  // { apiVersion, resource }
    childResources=[],  // Array of { apiVersion, resource }
    generateSelector=true,
    resyncPeriodSeconds=30,
  ):: {
    apiVersion: 'metacontroller.k8s.io/v1alpha1',
    kind: 'CompositeController',
    metadata: {
      name: name,
    },
    spec: {
      generateSelector: generateSelector,
      parentResource: parentResource,
      childResources: childResources,
      hooks: {
        sync: {
          webhook: {
            url: webhookUrl,
          },
        },
      },
      resyncPeriodSeconds: resyncPeriodSeconds,
    },
  },

  // DecoratorController constructor
  decoratorController(
    name,
    webhookUrl,
    resources,  // Array of { apiVersion, resource, labelSelector }
    resyncPeriodSeconds=30,
  ):: {
    apiVersion: 'metacontroller.k8s.io/v1alpha1',
    kind: 'DecoratorController',
    metadata: {
      name: name,
    },
    spec: {
      resources: resources,
      hooks: {
        sync: {
          webhook: {
            url: webhookUrl,
          },
        },
      },
      resyncPeriodSeconds: resyncPeriodSeconds,
    },
  },

  // Storage Composite Controller (Secret → MongoDB + Migration)
  storageComposite(
    webhookUrl='http://webhook-service:3000/sync-storage',
    resyncPeriodSeconds=30,
  )::
    $.compositeController(
      name='storage-composite',
      webhookUrl=webhookUrl,
      parentResource={
        apiVersion: 'v1',
        resource: 'secrets',
      },
      childResources=[
        { apiVersion: 'apps/v1', resource: 'statefulsets' },
        { apiVersion: 'v1', resource: 'services' },
        { apiVersion: 'v1', resource: 'secrets' },
        { apiVersion: 'batch/v1', resource: 'jobs' },
        { apiVersion: 'policy/v1', resource: 'poddisruptionbudgets' },
      ],
      resyncPeriodSeconds=resyncPeriodSeconds,
    ),

  // Compute Composite Controller (ConfigMap → Nightscout + CDC)
  computeComposite(
    webhookUrl='http://webhook-service:3000/sync-compute',
    resyncPeriodSeconds=30,
  )::
    $.compositeController(
      name='compute-composite',
      webhookUrl=webhookUrl,
      parentResource={
        apiVersion: 'v1',
        resource: 'configmaps',
      },
      childResources=[
        { apiVersion: 'apps/v1', resource: 'deployments' },
        { apiVersion: 'v1', resource: 'services' },
        { apiVersion: 'kafka.strimzi.io/v1beta2', resource: 'kafkatopics' },
        { apiVersion: 'kafka.strimzi.io/v1beta2', resource: 'kafkaconnectors' },
        { apiVersion: 'policy/v1', resource: 'poddisruptionbudgets' },
      ],
      resyncPeriodSeconds=resyncPeriodSeconds,
    ),

  // PVC Backup Decorator (PVC → VolumeSnapshot on delete)
  pvcBackupDecorator(
    webhookUrl='http://webhook-service:3000/sync-pvc-decorator',
    resyncPeriodSeconds=60,
  )::
    $.decoratorController(
      name='pvc-backup-decorator',
      webhookUrl=webhookUrl,
      resources=[
        {
          apiVersion: 'v1',
          resource: 'persistentvolumeclaims',
          labelSelector: {
            matchLabels: {
              'app.kubernetes.io/component': 'database',
            },
          },
        },
      ],
      resyncPeriodSeconds=resyncPeriodSeconds,
    ),

  // Complete controller set
  controllers(
    webhookServiceUrl='http://webhook-service:3000',
    storageResyncSeconds=30,
    computeResyncSeconds=30,
    pvcResyncSeconds=60,
  ):: {
    storage: $.storageComposite(
      webhookUrl=webhookServiceUrl + '/sync-storage',
      resyncPeriodSeconds=storageResyncSeconds,
    ),
    compute: $.computeComposite(
      webhookUrl=webhookServiceUrl + '/sync-compute',
      resyncPeriodSeconds=computeResyncSeconds,
    ),
    pvcBackup: $.pvcBackupDecorator(
      webhookUrl=webhookServiceUrl + '/sync-pvc-decorator',
      resyncPeriodSeconds=pvcResyncSeconds,
    ),
  },

  // Blue/green controller configuration (points to blue or green webhook)
  blueGreenControllers(
    environment='blue',  // 'blue' or 'green'
    webhookServiceUrl=null,  // Auto-generated if null
    storageResyncSeconds=30,
    computeResyncSeconds=30,
    pvcResyncSeconds=60,
  )::
    local url = if webhookServiceUrl != null then webhookServiceUrl
                else 'http://webhook-' + environment + ':3000';
    $.controllers(
      webhookServiceUrl=url,
      storageResyncSeconds=storageResyncSeconds,
      computeResyncSeconds=computeResyncSeconds,
      pvcResyncSeconds=pvcResyncSeconds,
    ),
}
