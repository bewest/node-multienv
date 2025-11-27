// crds.libsonnet - Custom Resource Definitions for Nightscout Multi-Tenant Platform
//
// Provides CRD definitions for:
// - StorageAccount: Represents MongoDB storage infrastructure for a tenant
// - ComputeInstance: Represents Nightscout application deployment for a tenant
//
// Usage:
//   local crds = import 'crds.libsonnet';
//   
//   {
//     storageAccountCRD: crds.storageAccountCRD(),
//     computeInstanceCRD: crds.computeInstanceCRD(),
//   }

{
  // StorageAccount CRD - Manages MongoDB storage infrastructure
  storageAccountCRD(
    group='nightscout.io',
    version='v1alpha1',
  ):: {
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: {
      name: 'storageaccounts.' + group,
    },
    spec: {
      group: group,
      names: {
        kind: 'StorageAccount',
        listKind: 'StorageAccountList',
        plural: 'storageaccounts',
        singular: 'storageaccount',
        shortNames: ['sa', 'storage'],
        categories: ['nightscout'],
      },
      scope: 'Namespaced',
      versions: [
        {
          name: version,
          served: true,
          storage: true,
          subresources: {
            status: {},
          },
          additionalPrinterColumns: [
            {
              name: 'Phase',
              type: 'string',
              jsonPath: '.status.phase',
              description: 'Current phase of the storage account',
            },
            {
              name: 'MongoDB Version',
              type: 'string',
              jsonPath: '.spec.mongodbVersion',
              description: 'MongoDB version',
            },
            {
              name: 'Replicas',
              type: 'integer',
              jsonPath: '.spec.replicas',
              description: 'Number of MongoDB replicas',
            },
            {
              name: 'Age',
              type: 'date',
              jsonPath: '.metadata.creationTimestamp',
            },
          ],
          schema: {
            openAPIV3Schema: {
              type: 'object',
              required: ['spec'],
              properties: {
                spec: {
                  type: 'object',
                  required: ['mongodbVersion'],
                  properties: {
                    selector: {
                      type: 'object',
                      description: 'Label selector for resources managed by this StorageAccount',
                      properties: {
                        matchLabels: {
                          type: 'object',
                          additionalProperties: {
                            type: 'string',
                          },
                          description: 'Map of label key-value pairs that must match',
                        },
                        matchExpressions: {
                          type: 'array',
                          description: 'List of label selector requirements',
                          items: {
                            type: 'object',
                            required: ['key', 'operator'],
                            properties: {
                              key: {
                                type: 'string',
                              },
                              operator: {
                                type: 'string',
                                enum: ['In', 'NotIn', 'Exists', 'DoesNotExist'],
                              },
                              values: {
                                type: 'array',
                                items: {
                                  type: 'string',
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                    storageType: {
                      type: 'string',
                      description: 'Storage type (dedicated creates new MongoDB, shared uses existing)',
                      enum: ['dedicated', 'shared'],
                      default: 'dedicated',
                    },
                    mongodbVersion: {
                      type: 'string',
                      description: 'MongoDB version to deploy (e.g., "7.0", "6.0")',
                      pattern: '^[0-9]+\\.[0-9]+$',
                    },
                    replicas: {
                      type: 'integer',
                      description: 'Number of MongoDB replica set members',
                      minimum: 1,
                      maximum: 7,
                      default: 3,
                    },
                    tier: {
                      type: 'string',
                      description: 'Service tier (free, basic, premium, enterprise)',
                      enum: ['free', 'basic', 'premium', 'enterprise'],
                      default: 'basic',
                    },
                    resources: {
                      type: 'object',
                      description: 'Resource requirements for MongoDB pods',
                      properties: {
                        requests: {
                          type: 'object',
                          properties: {
                            cpu: { type: 'string' },
                            memory: { type: 'string' },
                          },
                        },
                        limits: {
                          type: 'object',
                          properties: {
                            cpu: { type: 'string' },
                            memory: { type: 'string' },
                          },
                        },
                      },
                    },
                    storageClass: {
                      type: 'string',
                      description: 'StorageClass for MongoDB PVCs',
                    },
                    storageSize: {
                      type: 'string',
                      description: 'Storage size per replica (e.g., "10Gi", "100Gi")',
                      default: '10Gi',
                    },
                    backup: {
                      type: 'object',
                      description: 'Backup configuration',
                      properties: {
                        enabled: {
                          type: 'boolean',
                          description: 'Enable VolumeSnapshot backup on PVC deletion',
                          default: true,
                        },
                        retentionPolicy: {
                          type: 'string',
                          description: 'Backup retention policy',
                          enum: ['Retain', 'Delete'],
                          default: 'Retain',
                        },
                      },
                    },
                    sharedConnection: {
                      type: 'string',
                      description: 'Shared MongoDB connection uri (required when storageType=shared)',
                    },
                    migration: {
                      type: 'object',
                      description: 'Migration configuration',
                      properties: {
                        enabled: {
                          type: 'boolean',
                          description: 'Enable migration from external MongoDB',
                          default: false,
                        },
                        sourceType: {
                          type: 'string',
                          description: 'Source storage type',
                          enum: ['shared', 'dedicated'],
                        },
                        sourceConnectionSecret: {
                          type: 'string',
                          description: 'Secret containing source MongoDB connection URI',
                        },
                      },
                    },
                  },
                },
                status: {
                  type: 'object',
                  properties: {
                    phase: {
                      type: 'string',
                      description: 'Current phase (Pending, Migrating, Ready, Failed)',
                      enum: ['Pending', 'Migrating', 'Ready', 'Failed'],
                    },
                    conditions: {
                      type: 'array',
                      description: 'Status conditions',
                      items: {
                        type: 'object',
                        required: ['type', 'status'],
                        properties: {
                          type: {
                            type: 'string',
                            description: 'Condition type (Ready, MongoDBReady, MigrationComplete)',
                          },
                          status: {
                            type: 'string',
                            description: 'Condition status (True, False, Unknown)',
                            enum: ['True', 'False', 'Unknown'],
                          },
                          lastTransitionTime: {
                            type: 'string',
                            format: 'date-time',
                            description: 'Last time the condition transitioned',
                          },
                          reason: {
                            type: 'string',
                            description: 'Machine-readable reason for the condition',
                          },
                          message: {
                            type: 'string',
                            description: 'Human-readable message',
                          },
                        },
                      },
                    },
                    connectionSecret: {
                      type: 'string',
                      description: 'Name of Secret containing MongoDB connection credentials',
                    },
                    databaseName: {
                      type: 'string',
                      description: 'MongoDB database name',
                    },
                    observedGeneration: {
                      type: 'integer',
                      description: 'Generation of the spec that was last processed',
                    },
                  },
                },
              },
            },
          },
        },
      ],
    },
  },

  // ComputeInstance CRD - Manages Nightscout application deployment
  computeInstanceCRD(
    group='nightscout.io',
    version='v1alpha1',
  ):: {
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: {
      name: 'computeinstances.' + group,
    },
    spec: {
      group: group,
      names: {
        kind: 'ComputeInstance',
        listKind: 'ComputeInstanceList',
        plural: 'computeinstances',
        singular: 'computeinstance',
        shortNames: ['ci', 'compute'],
        categories: ['nightscout'],
      },
      scope: 'Namespaced',
      versions: [
        {
          name: version,
          served: true,
          storage: true,
          subresources: {
            status: {},
          },
          additionalPrinterColumns: [
            {
              name: 'Phase',
              type: 'string',
              jsonPath: '.status.phase',
              description: 'Current phase of the compute instance',
            },
            {
              name: 'Storage Account',
              type: 'string',
              jsonPath: '.spec.storageAccountRef.name',
              description: 'Referenced storage account',
            },
            {
              name: 'Replicas',
              type: 'integer',
              jsonPath: '.spec.replicas',
              description: 'Number of Nightscout replicas',
            },
            {
              name: 'Age',
              type: 'date',
              jsonPath: '.metadata.creationTimestamp',
            },
          ],
          schema: {
            openAPIV3Schema: {
              type: 'object',
              required: ['spec'],
              properties: {
                spec: {
                  type: 'object',
                  required: ['storageAccountRef'],
                  properties: {
                    selector: {
                      type: 'object',
                      description: 'Label selector for resources managed by this ComputeInstance',
                      properties: {
                        matchLabels: {
                          type: 'object',
                          additionalProperties: {
                            type: 'string',
                          },
                          description: 'Map of label key-value pairs that must match',
                        },
                        matchExpressions: {
                          type: 'array',
                          description: 'List of label selector requirements',
                          items: {
                            type: 'object',
                            required: ['key', 'operator'],
                            properties: {
                              key: {
                                type: 'string',
                              },
                              operator: {
                                type: 'string',
                                enum: ['In', 'NotIn', 'Exists', 'DoesNotExist'],
                              },
                              values: {
                                type: 'array',
                                items: {
                                  type: 'string',
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                    storageAccountRef: {
                      type: 'object',
                      description: 'Reference to StorageAccount providing MongoDB',
                      required: ['name'],
                      properties: {
                        name: {
                          type: 'string',
                          description: 'Name of the StorageAccount in the same namespace',
                        },
                      },
                    },
                    nightscoutImage: {
                      type: 'string',
                      description: 'Nightscout container image',
                      default: 'nightscout/cgm-remote-monitor:latest',
                    },
                    replicas: {
                      type: 'integer',
                      description: 'Number of Nightscout replicas',
                      minimum: 1,
                      maximum: 10,
                      default: 1,
                    },
                    tier: {
                      type: 'string',
                      description: 'Service tier (free, basic, premium, enterprise)',
                      enum: ['free', 'basic', 'premium', 'enterprise'],
                      default: 'basic',
                    },
                    resources: {
                      type: 'object',
                      description: 'Resource requirements for Nightscout pods',
                      properties: {
                        requests: {
                          type: 'object',
                          properties: {
                            cpu: { type: 'string' },
                            memory: { type: 'string' },
                          },
                        },
                        limits: {
                          type: 'object',
                          properties: {
                            cpu: { type: 'string' },
                            memory: { type: 'string' },
                          },
                        },
                      },
                    },
                    env: {
                      type: 'array',
                      description: 'Additional environment variables for Nightscout',
                      items: {
                        type: 'object',
                        required: ['name'],
                        properties: {
                          name: { type: 'string' },
                          value: { type: 'string' },
                          valueFrom: {
                            type: 'object',
                            properties: {
                              secretKeyRef: {
                                type: 'object',
                                properties: {
                                  name: { type: 'string' },
                                  key: { type: 'string' },
                                },
                              },
                              configMapKeyRef: {
                                type: 'object',
                                properties: {
                                  name: { type: 'string' },
                                  key: { type: 'string' },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                    cdc: {
                      type: 'object',
                      description: 'Change Data Capture configuration',
                      properties: {
                        enabled: {
                          type: 'boolean',
                          description: 'Enable CDC via Kafka Connect',
                          default: false,
                        },
                        kafkaCluster: {
                          type: 'string',
                          description: 'Name of the Kafka cluster',
                        },
                        kafkaConnectCluster: {
                          type: 'string',
                          description: 'Name of the KafkaConnect cluster',
                        },
                      },
                    },
                    healthcheck: {
                      type: 'object',
                      description: 'Health check sidecar configuration',
                      properties: {
                        enabled: {
                          type: 'boolean',
                          description: 'Enable health check sidecar for Consul',
                          default: true,
                        },
                        image: {
                          type: 'string',
                          description: 'Health check sidecar image',
                        },
                      },
                    },
                  },
                },
                status: {
                  type: 'object',
                  properties: {
                    phase: {
                      type: 'string',
                      description: 'Current phase (Pending, Ready, Failed)',
                      enum: ['Pending', 'Ready', 'Failed'],
                    },
                    conditions: {
                      type: 'array',
                      description: 'Status conditions',
                      items: {
                        type: 'object',
                        required: ['type', 'status'],
                        properties: {
                          type: {
                            type: 'string',
                            description: 'Condition type (Ready, DeploymentReady, StorageReady)',
                          },
                          status: {
                            type: 'string',
                            description: 'Condition status (True, False, Unknown)',
                            enum: ['True', 'False', 'Unknown'],
                          },
                          lastTransitionTime: {
                            type: 'string',
                            format: 'date-time',
                            description: 'Last time the condition transitioned',
                          },
                          reason: {
                            type: 'string',
                            description: 'Machine-readable reason for the condition',
                          },
                          message: {
                            type: 'string',
                            description: 'Human-readable message',
                          },
                        },
                      },
                    },
                    endpoints: {
                      type: 'array',
                      description: 'Service endpoints',
                      items: {
                        type: 'string',
                      },
                    },
                    observedGeneration: {
                      type: 'integer',
                      description: 'Generation of the spec that was last processed',
                    },
                  },
                },
              },
            },
          },
        },
      ],
    },
  },

  // NightscoutTenant CRD - Unified tenant resource (Gen 5 architecture)
  // Two-phase provisioning model with ConfigMap-based compute activation
  // Storage (PVC, mongo-auth secret) created by provisioner facade
  // Compute activated when ConfigMap exists, deactivated when ConfigMap deleted
  nightscoutTenantCRD(
    group='nightscout.io',
    version='v1alpha1',
  ):: {
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: {
      name: 'nightscouttenants.' + group,
    },
    spec: {
      group: group,
      names: {
        kind: 'NightscoutTenant',
        listKind: 'NightscoutTenantList',
        plural: 'nightscouttenants',
        singular: 'nightscouttenant',
        shortNames: ['nst', 'tenant'],
        categories: ['nightscout'],
      },
      scope: 'Namespaced',
      versions: [
        {
          name: version,
          served: true,
          storage: true,
          subresources: {
            status: {},
          },
          additionalPrinterColumns: [
            {
              name: 'Storage',
              type: 'string',
              jsonPath: '.spec.storage',
              description: 'Storage account ID',
            },
            {
              name: 'Tenant',
              type: 'string',
              jsonPath: '.spec.tenant',
              description: 'Tenant ID (set on site creation)',
            },
            {
              name: 'Phase',
              type: 'string',
              jsonPath: '.status.phase',
              description: 'Current lifecycle phase',
            },
            {
              name: 'MongoDB',
              type: 'string',
              jsonPath: '.spec.mongodbVersion',
              description: 'MongoDB version',
            },
            {
              name: 'Nightscout',
              type: 'string',
              jsonPath: '.spec.nightscoutImage',
              description: 'Nightscout image',
            },
            {
              name: 'Age',
              type: 'date',
              jsonPath: '.metadata.creationTimestamp',
            },
          ],
          schema: {
            openAPIV3Schema: {
              type: 'object',
              required: ['spec'],
              properties: {
                spec: {
                  type: 'object',
                  required: ['storage', 'pvcName', 'mongoAuthSecretRef', 'selector', 'initialStorageType', 'mongodbVersion'],
                  properties: {
                    // Identity fields (set by provisioner facade)
                    storage: {
                      type: 'string',
                      description: 'Storage account ID from provisioner facade (POST /accounts/:storageAccountId). Required on initial CR creation.',
                    },
                    tenant: {
                      type: 'string',
                      description: 'Tenant ID from provisioner facade (POST /accounts/:storageAccountId/sites/:tenantId). Set when site is created, enables /environs/ API access.',
                    },
                    
                    // Provisioner-managed resources (created externally)
                    pvcName: {
                      type: 'string',
                      description: 'Name of the PVC created by provisioner for MongoDB data',
                    },
                    mongoAuthSecretRef: {
                      type: 'string',
                      description: 'Name of the Secret containing MongoDB authentication credentials',
                    },
                    selector: {
                      type: 'object',
                      description: 'Label selector for Metacontroller child resource matching. Required for generateSelectors: false pattern (controller coordination, offline migration, versioned controllers).',
                      properties: {
                        matchLabels: {
                          type: 'object',
                          additionalProperties: {
                            type: 'string',
                          },
                          description: 'Map of label key-value pairs that must match',
                        },
                        matchExpressions: {
                          type: 'array',
                          description: 'List of label selector requirements',
                          items: {
                            type: 'object',
                            required: ['key', 'operator'],
                            properties: {
                              key: {
                                type: 'string',
                              },
                              operator: {
                                type: 'string',
                                enum: ['In', 'NotIn', 'Exists', 'DoesNotExist'],
                              },
                              values: {
                                type: 'array',
                                items: {
                                  type: 'string',
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                    configMapRef: {
                      type: 'object',
                      description: 'Optional reference to provisioner-managed ConfigMap for tenant userdata. ConfigMap presence enables compute layer (ReplicaSet renders). Missing/deleted ConfigMap = storage-only mode (no pods). Deleting ConfigMap via environs API stops tenant execution.',
                      properties: {
                        name: {
                          type: 'string',
                          description: 'Name of ConfigMap (for migration/adoption)',
                        },
                        namespace: {
                          type: 'string',
                          description: 'Namespace of ConfigMap (default to CR namespace)',
                        },
                      },
                    },
                    initialStorageType: {
                      type: 'string',
                      description: 'Initial storage architecture (shared or dedicated MongoDB)',
                      enum: ['shared', 'dedicated'],
                      default: 'dedicated',
                    },
                    
                    // MongoDB Configuration
                    mongodbVersion: {
                      type: 'string',
                      description: 'MongoDB version (e.g., "7.0", "6.0")',
                      pattern: '^[0-9]+\\.[0-9]+$',
                    },
                    mongodbImage: {
                      type: 'string',
                      description: 'Override MongoDB container image',
                    },
                    mongoResources: {
                      type: 'object',
                      description: 'MongoDB container resource requirements',
                      properties: {
                        requests: {
                          type: 'object',
                          properties: {
                            cpu: { type: 'string', default: '100m' },
                            memory: { type: 'string', default: '256Mi' },
                          },
                        },
                        limits: {
                          type: 'object',
                          properties: {
                            cpu: { type: 'string', default: '500m' },
                            memory: { type: 'string', default: '512Mi' },
                          },
                        },
                      },
                    },
                    
                    // Storage Configuration
                    storageClass: {
                      type: 'string',
                      description: 'StorageClass for MongoDB PVC',
                    },
                    storageSize: {
                      type: 'string',
                      description: 'PVC storage size (e.g., "10Gi")',
                      default: '10Gi',
                    },
                    
                    // Nightscout Configuration
                    nightscoutImage: {
                      type: 'string',
                      description: 'Nightscout container image',
                      default: 'nightscout/cgm-remote-monitor:latest',
                    },
                    nightscoutResources: {
                      type: 'object',
                      description: 'Nightscout container resource requirements',
                      properties: {
                        requests: {
                          type: 'object',
                          properties: {
                            cpu: { type: 'string', default: '100m' },
                            memory: { type: 'string', default: '256Mi' },
                          },
                        },
                        limits: {
                          type: 'object',
                          properties: {
                            cpu: { type: 'string', default: '1000m' },
                            memory: { type: 'string', default: '1Gi' },
                          },
                        },
                      },
                    },
                    env: {
                      type: 'array',
                      description: 'Additional environment variables for Nightscout',
                      items: {
                        type: 'object',
                        required: ['name'],
                        properties: {
                          name: { type: 'string' },
                          value: { type: 'string' },
                          valueFrom: {
                            type: 'object',
                            properties: {
                              secretKeyRef: {
                                type: 'object',
                                properties: {
                                  name: { type: 'string' },
                                  key: { type: 'string' },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                    
                    // Tier & Features
                    tier: {
                      type: 'string',
                      description: 'Service tier',
                      enum: ['free', 'basic', 'premium', 'enterprise'],
                      default: 'basic',
                    },
                    cdc: {
                      type: 'object',
                      description: 'Change Data Capture via Kafka',
                      properties: {
                        enabled: {
                          type: 'boolean',
                          default: false,
                        },
                        kafkaCluster: {
                          type: 'string',
                        },
                        kafkaConnectCluster: {
                          type: 'string',
                        },
                      },
                    },
                    healthcheck: {
                      type: 'object',
                      description: 'Health check sidecar for Consul',
                      properties: {
                        enabled: {
                          type: 'boolean',
                          default: true,
                        },
                        image: {
                          type: 'string',
                        },
                      },
                    },
                    
                    // Backup Configuration
                    backup: {
                      type: 'object',
                      description: 'PVC backup configuration',
                      properties: {
                        enabled: {
                          type: 'boolean',
                          default: true,
                        },
                        policy: {
                          type: 'string',
                          enum: ['snapshot', 'skip'],
                          default: 'snapshot',
                        },
                      },
                    },
                    
                    // Migration from Gen 3/4
                    migration: {
                      type: 'object',
                      description: 'Migration from existing deployment',
                      properties: {
                        enabled: {
                          type: 'boolean',
                          default: false,
                        },
                        sourceConnectionSecret: {
                          type: 'string',
                          description: 'Secret with source MongoDB URI',
                        },
                      },
                    },
                  },
                },
                status: {
                  type: 'object',
                  properties: {
                    phase: {
                      type: 'string',
                      description: 'Lifecycle phase',
                      enum: ['Pending', 'Initializing', 'Ready', 'Failed', 'Error'],
                    },
                    conditions: {
                      type: 'array',
                      description: 'Status conditions',
                      items: {
                        type: 'object',
                        required: ['type', 'status'],
                        properties: {
                          type: {
                            type: 'string',
                            description: 'Condition type (Ready, ReplicaSetReady, PVCReady, MigrationComplete)',
                          },
                          status: {
                            type: 'string',
                            enum: ['True', 'False', 'Unknown'],
                          },
                          lastTransitionTime: {
                            type: 'string',
                            format: 'date-time',
                          },
                          reason: {
                            type: 'string',
                          },
                          message: {
                            type: 'string',
                          },
                        },
                      },
                    },
                    connectionSecret: {
                      type: 'string',
                      description: 'Name of MongoDB connection Secret',
                    },
                    databaseName: {
                      type: 'string',
                      description: 'MongoDB database name',
                    },
                    pvcName: {
                      type: 'string',
                      description: 'Name of persistent volume claim',
                    },
                    specHash: {
                      type: 'string',
                      description: 'Hash of inputs',
                    },
                    podName: {
                      type: 'string',
                      description: 'Name of the running pod',
                    },
                    observedGeneration: {
                      type: 'integer',
                    },
                  },
                },
              },
            },
          },
        },
      ],
    },
  },

  // Helper: Generate both CRDs
  all(
    group='nightscout.io',
    version='v1alpha1',
  ):: {
    storageAccount: $.storageAccountCRD(group, version),
    computeInstance: $.computeInstanceCRD(group, version),
    nightscoutTenant: $.nightscoutTenantCRD(group, version),
  },
}
