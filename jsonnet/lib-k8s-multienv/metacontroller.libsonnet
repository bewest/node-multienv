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
//     webhookUrl='http://webhook-service:3000/storage/sync',
//     parentResource={ apiVersion: 'v1', resource: 'secrets' }
//   )

{
  // CompositeController constructor
  compositeController(
    name,
    syncUrl,
    parentResource,  // { apiVersion, resource }
    childResources=[],  // Array of { apiVersion, resource }
    relatedResources=[],  // Optional related resources for selector-based discovery
    customizeUrl=null,  // Optional customize hook URL
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
      [if std.length(relatedResources) > 0 then 'relatedResources']: relatedResources,
      hooks: {
        [if customizeUrl != null then 'customize']: {
          webhook: {
            url: customizeUrl,
          },
        },
        sync: {
          webhook: {
            url: syncUrl,
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
    attachments=[],  // Array of { apiVersion, resource, updateStrategy }
    relatedResources=[],  // Optional related resources for discovery
    customizeUrl=null,  // Optional customize hook URL
    resyncPeriodSeconds=30,
  ):: {
    apiVersion: 'metacontroller.k8s.io/v1alpha1',
    kind: 'DecoratorController',
    metadata: {
      name: name,
    },
    spec: {
      resources: resources,
      [if std.length(relatedResources) > 0 then 'relatedResources']: relatedResources,
      [if std.length(attachments) > 0 then 'attachments']: attachments,
      hooks: {
        [if customizeUrl != null then 'customize']: {
          webhook: {
            url: customizeUrl,
          },
        },
        sync: {
          webhook: {
            url: webhookUrl,
          },
        },
      },
      resyncPeriodSeconds: resyncPeriodSeconds,
    },
  },

  // Storage Composite Controller (StorageAccount CRD → MongoDB + Migration)
  storageComposite(
    webhookServiceUrl='http://webhook-service:3000',
    crdGroup='nightscout.io',
    crdVersion='v1alpha1',
    resyncPeriodSeconds=30,
  )::
    $.compositeController(
      name='storage-composite',
      syncUrl=webhookServiceUrl + '/composite/storage/sync',
      customizeUrl=webhookServiceUrl + '/composite/storage/customize',
      generateSelector=false,
      parentResource={
        apiVersion: crdGroup + '/' + crdVersion,
        resource: 'storageaccounts',
        revisionHistory: {
          fieldPaths: ['spec']
        }
      },
      childResources=[
        { apiVersion: 'apps/v1', resource: 'statefulsets',
          updateStrategy: {
            method: 'InPlace'
          }
        },
        { apiVersion: 'v1', resource: 'services',
          updateStrategy: {
            method: 'InPlace'
          }
        },
        { apiVersion: 'v1', resource: 'secrets' },
        { apiVersion: 'batch/v1', resource: 'jobs' },
        { apiVersion: 'policy/v1', resource: 'poddisruptionbudgets',
          updateStrategy: {
            method: 'InPlace'
          }
        },
      ],
      /*
      relatedResources=[
        // Protected resources discovered via selector labels (not owned)
        // PVCs with MongoDB data - must survive parent deletion
        {
          apiVersion: 'v1',
          resource: 'persistentvolumeclaims',
          labelSelector: {
            matchExpressions: [
              {
                key: 'storage.nightscout.org/account',
                operator: 'In',
                values: ['${parent.metadata.name}'],
              },
            ],
          },
        },
        // mongo-auth Secrets (protected, label-based discovery)
        {
          apiVersion: 'v1',
          resource: 'secrets',
          labelSelector: {
            matchExpressions: [
              {
                key: 'storage.nightscout.org/account',
                operator: 'In',
                values: ['${parent.metadata.name}'],
              },
            ],
          },
        },
        // Legacy Gen 3 ConfigMaps for migration support (adopted, not created)
        {
          apiVersion: 'v1',
          resource: 'configmaps',
          labelSelector: {
            matchExpressions: [
              {
                key: 'storage.nightscout.org/account',
                operator: 'In',
                values: ['${parent.metadata.name}'],
              },
            ],
          },
        },
        // ComputeInstances using this storage (for usage tracking)
        {
          apiVersion: crdGroup + '/' + crdVersion,
          resource: 'computeinstances',
          labelSelector: {
            matchExpressions: [
              {
                key: 'storage.nightscout.org/account',
                operator: 'In',
                values: ['${parent.metadata.name}'],
              },
            ],
          },
        },
      ],
      */
      resyncPeriodSeconds=resyncPeriodSeconds,
    ),

  // Compute Composite Controller (ComputeInstance CRD → Nightscout + CDC)
  computeComposite(
    webhookServiceUrl='http://webhook-service:3000',
    crdGroup='nightscout.io',
    crdVersion='v1alpha1',
    resyncPeriodSeconds=30,
  )::
    $.compositeController(
      name='compute-composite',
      syncUrl=webhookServiceUrl + '/composite/compute/sync',
      customizeUrl=webhookServiceUrl + '/composite/compute/customize',
      parentResource={
        apiVersion: crdGroup + '/' + crdVersion,
        resource: 'computeinstances',
        revisionHistory: {
          fieldPaths: ['spec']
        }
      },
      childResources=[
        { apiVersion: 'apps/v1', resource: 'deployments',
          updateStrategy: {
            method: 'InPlace'
          }
        },
        // { apiVersion: 'v1', resource: 'services' },
        // { apiVersion: 'kafka.strimzi.io/v1beta2', resource: 'kafkatopics' },
        // { apiVersion: 'kafka.strimzi.io/v1beta2', resource: 'kafkaconnectors' },
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

  // Storage Credentials Decorator (ComputeInstance → App Credentials + User Init)
  storageCredentialsDecorator(
    webhookServiceUrl='http://webhook-service:3000',
    crdGroup='nightscout.io',
    crdVersion='v1alpha1',
    resyncPeriodSeconds=30,
  )::
    $.decoratorController(
      name='storage-credentials-decorator',
      webhookUrl=webhookServiceUrl + '/decorator/storage-credentials/sync',
      customizeUrl=webhookServiceUrl + '/decorator/storage-credentials/customize',
      resources=[
        {
          apiVersion: crdGroup + '/' + crdVersion,
          resource: 'computeinstances',
          labelSelector: {
            matchExpressions: [
              {
                key: 'storage.nightscout.org/account',
                operator: 'Exists',
              },
            ],
          },
        },
      ],
      attachments=[
        {
          apiVersion: 'v1',
          resource: 'secrets',
          updateStrategy: {
            method: 'InPlace',
          }
        }
      ],
      /*
      relatedResources=[
        // Discover StorageAccount to determine storage mode (shared/dedicated)
        {
          apiVersion: crdGroup + '/' + crdVersion,
          resource: 'storageaccounts',
        },
        // Discover legacy Gen 3 ConfigMaps for migration detection
        {
          apiVersion: 'v1',
          resource: 'configmaps',
          labelSelector: {
            matchLabels: {
              'role': 'config-as-deploy',
            },
          },
        },
      ],
      */
      resyncPeriodSeconds=resyncPeriodSeconds,
    ),

  // Storage Initialization Decorator (mongo-auth Secret → Replica Set Init State)
  storageInitializationDecorator(
    webhookServiceUrl='http://webhook-service:3000',
    crdGroup='nightscout.io',
    crdVersion='v1alpha1',
    resyncPeriodSeconds=30,
  )::
    $.decoratorController(
      name='storage-initialization-decorator',
      webhookUrl=webhookServiceUrl + '/decorator/storage-initialization/sync',
      customizeUrl=webhookServiceUrl + '/decorator/storage-initialization/customize',
      resources=[
        {
          apiVersion: 'v1',
          resource: 'secrets',
          labelSelector: {
            matchExpressions: [
              {
                key: 'storage.nightscout.org/account',
                operator: 'Exists',
              },
              {
                key: 'ns.mdn.io/composite',
                operator: 'In',
                values: ['key', 'mongodb-auth'],
              },
            ],
          },
        },
      ],
      resyncPeriodSeconds=resyncPeriodSeconds,
    ),

  // Instance Userdata Decorator (ConfigMap Migration → Gen 3 to Gen 4 Cutover)
  instanceUserdataDecorator(
    webhookServiceUrl='http://webhook-service:3000',
    crdGroup='nightscout.io',
    crdVersion='v1alpha1',
    resyncPeriodSeconds=30,
  )::
    $.decoratorController(
      name='instance-userdata-decorator',
      webhookUrl=webhookServiceUrl + '/decorator/instance-userdata/sync',
      customizeUrl=webhookServiceUrl + '/decorator/instance-userdata/customize',
      resources=[
        {
          apiVersion: 'v1',
          resource: 'configmaps',
          labelSelector: {
            matchLabels: {
              role: 'config-as-deploy',  // Gen 3 ConfigMaps only
            },
          },
        },
      ],
      resyncPeriodSeconds=resyncPeriodSeconds,
    ),

  // Tenant Initialization Decorator (Gen 5: Job Orchestration for NightscoutTenant)
  // Watches NightscoutTenant CRs, renders init-replica-set and create-user Jobs as attachments
  // Sets annotations for replica-set-initialized and user-initialized on parent CR
  // NOTE: Consider deprecating in favor of mongo-auth-init + app-credentials-init decorators
  tenantInitializationDecorator(
    webhookServiceUrl='http://webhook-service:3000',
    crdGroup='nightscout.io',
    crdVersion='v1alpha1',
    resyncPeriodSeconds=30,
  )::
    $.decoratorController(
      name='tenant-initialization-decorator',
      webhookUrl=webhookServiceUrl + '/decorator/tenant-initialization/sync',
      customizeUrl=webhookServiceUrl + '/decorator/tenant-initialization/customize',
      resources=[
        {
          apiVersion: crdGroup + '/' + crdVersion,
          resource: 'nightscouttenants',
          labelSelector: {
            matchExpressions: [
              // Match tenants with ns.mdn.io/storage label (set by provisioner)
              {
                key: 'ns.mdn.io/storage',
                operator: 'Exists',
              },
            ],
          },
        },
      ],
      // Jobs are rendered as attachments by the decorator (init-rs, create-user)
      attachments=[
        {
          apiVersion: 'batch/v1',
          resource: 'jobs',
          updateStrategy: {
            method: 'InPlace',
          },
        },
      ],
      resyncPeriodSeconds=resyncPeriodSeconds,
    ),

  // Mongo-Auth Init Decorator (Shared Gen4/Gen5)
  // Watches mongo-auth Secrets, orchestrates replica set initialization
  // Stamps ns.mdn.io/replica-set-initialized annotation on Secret when init Job succeeds
  mongoAuthInitDecorator(
    webhookServiceUrl='http://webhook-service:3000',
    resyncPeriodSeconds=30,
  )::
    $.decoratorController(
      name='mongo-auth-init-decorator',
      webhookUrl=webhookServiceUrl + '/decorator/mongo-auth-init/sync',
      customizeUrl=webhookServiceUrl + '/decorator/mongo-auth-init/customize',
      resources=[
        {
          apiVersion: 'v1',
          resource: 'secrets',
          labelSelector: {
            matchExpressions: [
              // Match secrets with storage identity label
              {
                key: 'ns.mdn.io/storage',
                operator: 'Exists',
              },
              // Match mongo-auth secrets specifically
              {
                key: 'ns.mdn.io/composite',
                operator: 'In',
                values: ['mongodb-auth'],
              },
            ],
          },
        },
      ],
      attachments=[
        {
          apiVersion: 'batch/v1',
          resource: 'jobs',
          updateStrategy: {
            method: 'InPlace',
          },
        },
      ],
      resyncPeriodSeconds=resyncPeriodSeconds,
    ),

  // App-Credentials Init Decorator (Shared Gen4/Gen5)
  // Watches app-credentials Secrets, orchestrates MongoDB user creation
  // Stamps ns.mdn.io/user-initialized annotation on Secret when create-user Job succeeds
  appCredentialsInitDecorator(
    webhookServiceUrl='http://webhook-service:3000',
    resyncPeriodSeconds=30,
  )::
    $.decoratorController(
      name='app-credentials-init-decorator',
      webhookUrl=webhookServiceUrl + '/decorator/app-credentials-init/sync',
      customizeUrl=webhookServiceUrl + '/decorator/app-credentials-init/customize',
      resources=[
        {
          apiVersion: 'v1',
          resource: 'secrets',
          labelSelector: {
            matchExpressions: [
              // Match secrets with storage identity label
              {
                key: 'ns.mdn.io/storage',
                operator: 'Exists',
              },
              // Match app-credentials secrets specifically
              {
                key: 'ns.mdn.io/credential-type',
                operator: 'In',
                values: ['application'],
              },
            ],
          },
        },
      ],
      attachments=[
        {
          apiVersion: 'batch/v1',
          resource: 'jobs',
          updateStrategy: {
            method: 'InPlace',
          },
        },
      ],
      resyncPeriodSeconds=resyncPeriodSeconds,
    ),

  // Tenant Composite Controller (NightscoutTenant CRD → ReplicaSet + Secrets)
  // Gen 5 architecture: Two-phase provisioning with ConfigMap-based compute activation
  // Storage: Provisioner creates PVC + mongo-auth secret (outside Metacontroller)
  // Compute: Controller renders ReplicaSet when ConfigMap exists
  tenantComposite(
    webhookServiceUrl='http://webhook-service:3000',
    crdGroup='nightscout.io',
    crdVersion='v1alpha1',
    resyncPeriodSeconds=30,
  )::
    $.compositeController(
      name='tenant-composite',
      syncUrl=webhookServiceUrl + '/composite/tenant/sync',
      customizeUrl=webhookServiceUrl + '/composite/tenant/customize',
      // generateSelector=false prevents Metacontroller from injecting controller-uid
      // into child labels. This avoids drift detection on server-managed Pod fields
      // because the webhook controls all labels via spec-hash pattern.
      generateSelector=false,
      parentResource={
        apiVersion: crdGroup + '/' + crdVersion,
        resource: 'nightscouttenants',
        revisionHistory: {
          fieldPaths: ['spec']
        }
      },
      childResources=[
        // ReplicaSet mode: InPlace updates - ReplicaSet controller handles Pod lifecycle
        // This provides a buffer layer that isolates Metacontroller from Pod-level drift
        { apiVersion: 'apps/v1', resource: 'replicasets',
          updateStrategy: {
            method: 'InPlace'
          }
        },
        // Direct Pod mode: generateSelector=false prevents Metacontroller from injecting
        // controller-uid into Pod labels, avoiding drift on server-managed fields.
        // The webhook renders Pods with stable spec-hash annotation for change detection.
        // RollingRecreate with statusChecks ensures orderly rollouts when hash changes.
        { apiVersion: 'v1', resource: 'pods',
          updateStrategy: {
            method: 'RollingRecreate',
            /*
            statusChecks: {
              conditions: [
                { type: 'Ready', status: 'True' }
              ]
            }
            */
          }
        },
        // Secrets for MongoDB keyfile and Nightscout config
        { apiVersion: 'v1', resource: 'secrets',
          updateStrategy: {
            method: 'InPlace',
          },
        },
        // ConfigMaps for tenant settings (adopted from provisioner via spec.configMapRef)
        // { apiVersion: 'v1', resource: 'configmaps' },
        // Note: Jobs managed by tenant-initialization-decorator (not this composite)
      ],
      /*
      relatedResources=[
        // PVCs created by provisioner (not owned, discovered via customize hook)
        {
          apiVersion: 'v1',
          resource: 'persistentvolumeclaims',
        },
        // ConfigMaps signal compute activation (fetched via customize hook using spec.configMapRef)
        {
          apiVersion: 'v1',
          resource: 'configmaps',
        },
      ],
      */
      resyncPeriodSeconds=resyncPeriodSeconds,
    ),

  // Complete controller set
  controllers(
    webhookServiceUrl='http://webhook-service:3000',
    crdGroup='nightscout.io',
    crdVersion='v1alpha1',
    storageResyncSeconds=30,
    computeResyncSeconds=30,
    tenantResyncSeconds=30,
    pvcResyncSeconds=60,
    credentialsResyncSeconds=30,
    initializationResyncSeconds=30,
    userdataResyncSeconds=30,
  ):: {
    storage:: $.storageComposite(
      webhookServiceUrl=webhookServiceUrl,
      crdGroup=crdGroup,
      crdVersion=crdVersion,
      resyncPeriodSeconds=storageResyncSeconds,
    ),
    compute:: $.computeComposite(
      webhookServiceUrl=webhookServiceUrl,
      crdGroup=crdGroup,
      crdVersion=crdVersion,
      resyncPeriodSeconds=computeResyncSeconds,
    ),
    tenant: $.tenantComposite(
      webhookServiceUrl=webhookServiceUrl,
      crdGroup=crdGroup,
      crdVersion=crdVersion,
      resyncPeriodSeconds=tenantResyncSeconds,
    ),
    pvcBackup:: $.pvcBackupDecorator(
      webhookUrl=webhookServiceUrl + '/decorator/sync',
      resyncPeriodSeconds=pvcResyncSeconds,
    ),
    storageCredentials:: $.storageCredentialsDecorator(
      webhookServiceUrl=webhookServiceUrl,
      crdGroup=crdGroup,
      crdVersion=crdVersion,
      resyncPeriodSeconds=credentialsResyncSeconds,
    ),
    storageInitialization:: $.storageInitializationDecorator(
      webhookServiceUrl=webhookServiceUrl,
      crdGroup=crdGroup,
      crdVersion=crdVersion,
      resyncPeriodSeconds=initializationResyncSeconds,
    ),
    instanceUserdata:: $.instanceUserdataDecorator(
      webhookServiceUrl=webhookServiceUrl,
      crdGroup=crdGroup,
      crdVersion=crdVersion,
      resyncPeriodSeconds=userdataResyncSeconds,
    ),
    // NOTE: tenantInitialization decorator targets CRs; consider deprecating
    // in favor of mongoAuthInit + appCredentialsInit which target Secrets
    tenantInitialization: $.tenantInitializationDecorator(
      webhookServiceUrl=webhookServiceUrl,
      crdGroup=crdGroup,
      crdVersion=crdVersion,
      resyncPeriodSeconds=initializationResyncSeconds,
    ),
    // Shared Gen4/Gen5 decorators - watch Secrets instead of CRs
    mongoAuthInit: $.mongoAuthInitDecorator(
      webhookServiceUrl=webhookServiceUrl,
      resyncPeriodSeconds=initializationResyncSeconds,
    ),
    appCredentialsInit: $.appCredentialsInitDecorator(
      webhookServiceUrl=webhookServiceUrl,
      resyncPeriodSeconds=initializationResyncSeconds,
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
