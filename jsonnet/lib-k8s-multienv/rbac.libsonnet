// rbac.libsonnet - RBAC helpers for Nightscout multi-tenant platform
//
// Provides reusable functions for creating ServiceAccounts, ClusterRoles,
// and ClusterRoleBindings with pre-defined permission sets.
//
// Usage:
//   local rbac = import 'rbac.libsonnet';
//   
//   // Create webhook ServiceAccount with full orchestration permissions
//   rbac.webhookServiceAccount('webhook-metacontroller') +
//   rbac.fullOrchestrationRole('webhook-metacontroller') +
//   rbac.clusterRoleBinding('webhook-metacontroller')

{
  // ServiceAccount constructor
  serviceAccount(name, namespace='default', imagePullSecrets=[]):: {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: {
      name: name,
      namespace: namespace,
    },
  } + (
    if std.length(imagePullSecrets) > 0 then
      { imagePullSecrets: imagePullSecrets }
    else
      {}
  ),

  // ClusterRole with full orchestration permissions (for Metacontroller webhooks)
  fullOrchestrationRole(name):: {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRole',
    metadata: {
      name: name,
    },
    rules: [
      // Core API group
      {
        apiGroups: [''],
        resources: ['configmaps', 'secrets', 'services', 'persistentvolumeclaims'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch'],
      },
      // Apps API group
      {
        apiGroups: ['apps'],
        resources: ['deployments', 'statefulsets'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch'],
      },
      // Policy API group
      {
        apiGroups: ['policy'],
        resources: ['poddisruptionbudgets'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch'],
      },
      // Kafka (Strimzi) API group
      {
        apiGroups: ['kafka.strimzi.io'],
        resources: ['kafkatopics', 'kafkaconnectors'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch'],
      },
      // Snapshot API group
      {
        apiGroups: ['snapshot.storage.k8s.io'],
        resources: ['volumesnapshots'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch'],
      },
      // Batch API group (for migration Jobs)
      {
        apiGroups: ['batch'],
        resources: ['jobs'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch'],
      },
      // Nightscout CRDs (Gen 4) - parent resources
      {
        apiGroups: ['nightscout.io'],
        resources: ['storageaccounts', 'computeinstances'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch'],
      },
      // Nightscout CRDs - status subresources
      {
        apiGroups: ['nightscout.io'],
        resources: ['storageaccounts/status', 'computeinstances/status'],
        verbs: ['update', 'patch'],
      },
    ],
  },

  // ClusterRole with provisioner permissions (REST API server)
  provisionerRole(name):: {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRole',
    metadata: {
      name: name,
    },
    rules: [
      // ConfigMaps: full CRUD (includes delete for tenant removal - Gen 3 legacy)
      {
        apiGroups: [''],
        resources: ['configmaps'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      // Secrets: full CRUD (includes delete for account removal - Gen 3 legacy)
      {
        apiGroups: [''],
        resources: ['secrets'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      // Nightscout CRDs (Gen 4): full CRUD for provisioner API
      {
        apiGroups: ['nightscout.io'],
        resources: ['storageaccounts', 'computeinstances'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      // Read-only for status queries
      {
        apiGroups: [''],
        resources: ['services', 'pods'],
        verbs: ['get', 'list', 'watch'],
      },
      {
        apiGroups: ['apps'],
        resources: ['deployments', 'statefulsets'],
        verbs: ['get', 'list', 'watch'],
      },
    ],
  },

  // ClusterRole with read-only permissions (Consul health checks, monitoring)
  readOnlyRole(name):: {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRole',
    metadata: {
      name: name,
    },
    rules: [
      {
        apiGroups: [''],
        resources: ['configmaps', 'services', 'endpoints', 'pods'],
        verbs: ['get', 'list', 'watch'],
      },
      {
        apiGroups: ['apps'],
        resources: ['deployments', 'statefulsets'],
        verbs: ['get', 'list', 'watch'],
      },
    ],
  },

  // ClusterRole for migration jobs (minimal permissions)
  // Migration jobs only need to read Secrets to get MongoDB credentials
  migrationJobRole(name):: {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRole',
    metadata: {
      name: name,
    },
    rules: [
      {
        apiGroups: [''],
        resources: ['secrets'],
        verbs: ['get', 'list'],
      },
    ],
  },

  // ClusterRoleBinding
  clusterRoleBinding(name, serviceAccountName=name, serviceAccountNamespace='default', roleName=name):: {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRoleBinding',
    metadata: {
      name: name,
    },
    subjects: [
      {
        kind: 'ServiceAccount',
        name: serviceAccountName,
        namespace: serviceAccountNamespace,
      },
    ],
    roleRef: {
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'ClusterRole',
      name: roleName,
    },
  },

  // Convenience: Full RBAC set for webhook service
  webhookServiceAccount(name, namespace='default', imagePullSecrets=[]):: {
    serviceAccount: $.serviceAccount(name, namespace, imagePullSecrets),
    clusterRole: $.fullOrchestrationRole(name),
    clusterRoleBinding: $.clusterRoleBinding(
      name,
      serviceAccountName=name,
      serviceAccountNamespace=namespace,
      roleName=name
    ),
  },

  // Convenience: Full RBAC set for provisioner service
  provisionerServiceAccount(name, namespace='default', imagePullSecrets=[]):: {
    serviceAccount: $.serviceAccount(name, namespace, imagePullSecrets),
    clusterRole: $.provisionerRole(name),
    clusterRoleBinding: $.clusterRoleBinding(
      name,
      serviceAccountName=name,
      serviceAccountNamespace=namespace,
      roleName=name
    ),
  },

  // Convenience: Full RBAC set for read-only service (Consul, monitoring)
  readOnlyServiceAccount(name, namespace='default', imagePullSecrets=[]):: {
    serviceAccount: $.serviceAccount(name, namespace, imagePullSecrets),
    clusterRole: $.readOnlyRole(name),
    clusterRoleBinding: $.clusterRoleBinding(
      name,
      serviceAccountName=name,
      serviceAccountNamespace=namespace,
      roleName=name
    ),
  },

  // Convenience: Full RBAC set for migration jobs
  migrationJobServiceAccount(name, namespace='default', imagePullSecrets=[]):: {
    serviceAccount: $.serviceAccount(name, namespace, imagePullSecrets),
    clusterRole: $.migrationJobRole(name),
    clusterRoleBinding: $.clusterRoleBinding(
      name,
      serviceAccountName=name,
      serviceAccountNamespace=namespace,
      roleName=name
    ),
  },

  // ClusterRole for deployment-controller (webhook + provisioner combined)
  // Since k8s-deployment-controller.js handles both webhook operations and provisioner API,
  // it needs combined permissions from both fullOrchestrationRole and provisionerRole
  deploymentControllerRole(name):: {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRole',
    metadata: {
      name: name,
    },
    rules: [
      // Core API group - full permissions for ConfigMaps, Secrets (Gen 3 + provisioner)
      {
        apiGroups: [''],
        resources: ['configmaps', 'secrets'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      // Core API group - Services, PVCs (webhook orchestration)
      {
        apiGroups: [''],
        resources: ['services', 'persistentvolumeclaims'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch'],
      },
      // Core API group - Pods (read-only for status queries)
      {
        apiGroups: [''],
        resources: ['pods'],
        verbs: ['get', 'list', 'watch'],
      },
      // Apps API group - full orchestration
      {
        apiGroups: ['apps'],
        resources: ['deployments', 'statefulsets'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch'],
      },
      // Policy API group
      {
        apiGroups: ['policy'],
        resources: ['poddisruptionbudgets'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch'],
      },
      // Kafka (Strimzi) API group
      {
        apiGroups: ['kafka.strimzi.io'],
        resources: ['kafkatopics', 'kafkaconnectors'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch'],
      },
      // Snapshot API group
      {
        apiGroups: ['snapshot.storage.k8s.io'],
        resources: ['volumesnapshots'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch'],
      },
      // Batch API group (for migration Jobs)
      {
        apiGroups: ['batch'],
        resources: ['jobs'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch'],
      },
      // Nightscout CRDs (Gen 4) - full CRUD for provisioner API
      {
        apiGroups: ['nightscout.io'],
        resources: ['storageaccounts', 'computeinstances'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      // Nightscout CRDs - status subresources (for webhook status updates)
      {
        apiGroups: ['nightscout.io'],
        resources: ['storageaccounts/status', 'computeinstances/status'],
        verbs: ['update', 'patch'],
      },
    ],
  },

  // Convenience: Full RBAC set for deployment-controller
  // Ergonomic export - use this for k8s-deployment-controller deployments
  // Example usage in Jsonnet:
  //   rbac.deploymentControllerRBAC('deployment-controller')
  deploymentControllerRBAC(name, namespace='default', imagePullSecrets=[]):: {
    serviceAccount: $.serviceAccount(name, namespace, imagePullSecrets),
    clusterRole: $.deploymentControllerRole(name),
    clusterRoleBinding: $.clusterRoleBinding(
      name,
      serviceAccountName=name,
      serviceAccountNamespace=namespace,
      roleName=name
    ),
  },
}
