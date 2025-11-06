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

  // ClusterRole for storage-credentials decorator
  // Decorator needs to read CRDs and create Secrets + Jobs as attachments
  storageCredentialsDecoratorRole(name):: {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRole',
    metadata: {
      name: name,
    },
    rules: [
      // Read ComputeInstances and StorageAccounts to determine storage mode
      {
        apiGroups: ['nightscout.io'],
        resources: ['storageaccounts', 'computeinstances'],
        verbs: ['get', 'list', 'watch'],
      },
      // Create/update Secrets (app-credentials attachments)
      {
        apiGroups: [''],
        resources: ['secrets'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch'],
      },
      // Create/update Jobs (user initialization, migration)
      {
        apiGroups: ['batch'],
        resources: ['jobs'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch'],
      },
      // Read ConfigMaps (for migration source detection - Gen 3 legacy)
      {
        apiGroups: [''],
        resources: ['configmaps'],
        verbs: ['get', 'list', 'watch'],
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

  // RoleBinding (namespace-scoped)
  roleBinding(name, namespace, serviceAccountName=name, serviceAccountNamespace=namespace, roleName=name):: {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: {
      name: name,
      namespace: namespace,
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
      kind: 'Role',
      name: roleName,
    },
  },

  // Namespace-scoped Role for provisioner API (Secrets/ConfigMaps only)
  // This ensures deployment-controller can only manipulate Secrets/ConfigMaps
  // in the target namespace (e.g., hosted-tenants)
  provisionerRoleNamespaced(name, namespace):: {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: {
      name: name,
      namespace: namespace,
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
      {
        apiGroups: ['apps'],
        resources: ['deployments'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
    ],
  },

  // ClusterRole for CRD-only permissions (no Secrets/ConfigMaps)
  // Used by deployment-controller for Gen 4 CRD provisioning API
  provisionerClusterRoleForCRDs(name):: {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRole',
    metadata: {
      name: name + '-crds',
    },
    rules: [
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

  // Convenience: Full RBAC set for storage-credentials decorator
  storageCredentialsDecoratorServiceAccount(name, namespace='default', imagePullSecrets=[]):: {
    serviceAccount: $.serviceAccount(name, namespace, imagePullSecrets),
    clusterRole: $.storageCredentialsDecoratorRole(name),
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
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
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

  // Convenience: Full RBAC set for deployment-controller (dual binding pattern)
  // Uses BOTH namespace-scoped Role+RoleBinding AND ClusterRole+ClusterRoleBinding
  // This ensures deployment-controller can only manipulate Secrets/ConfigMaps in targetNamespace
  // while still managing CRDs cluster-wide
  //
  // Example usage in Jsonnet:
  //   rbac.deploymentControllerRBAC('deployment-controller', 'default', 'hosted-tenants')
  //
  // Arguments:
  //   name: ServiceAccount name
  //   namespace: Namespace where ServiceAccount lives (e.g., 'default')
  //   targetNamespace: Namespace where provisioner API can manipulate Secrets/ConfigMaps (e.g., 'hosted-tenants')
  //   imagePullSecrets: Optional image pull secrets for private registries
  deploymentControllerRBAC(name, namespace='default', targetNamespace='hosted-tenants', imagePullSecrets=[]):: {
    serviceAccount: $.serviceAccount(name, namespace, imagePullSecrets),
    
    // Namespace-scoped Role for Secrets/ConfigMaps (limited to targetNamespace)
    role: $.provisionerRoleNamespaced(name, targetNamespace),
    
    // Namespace-scoped RoleBinding
    roleBinding: $.roleBinding(
      name,
      targetNamespace,
      serviceAccountName=name,
      serviceAccountNamespace=namespace,
      roleName=name
    ),
    
    // ClusterRole for CRDs only (no Secrets/ConfigMaps)
    clusterRole: $.provisionerClusterRoleForCRDs(name),
    
    // ClusterRoleBinding
    clusterRoleBinding: $.clusterRoleBinding(
      name + '-crds',
      serviceAccountName=name,
      serviceAccountNamespace=namespace,
      roleName=name + '-crds'
    ),
  },
}
