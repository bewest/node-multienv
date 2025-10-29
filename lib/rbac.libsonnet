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

local k = import 'k.libsonnet';

{
  // ServiceAccount constructor
  serviceAccount(name, namespace='default')::
    k.core.v1.serviceAccount.new(name) +
    k.core.v1.serviceAccount.metadata.withNamespace(namespace),

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
      // ConfigMaps: full CRUD (includes delete for tenant removal)
      {
        apiGroups: [''],
        resources: ['configmaps'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      // Secrets: full CRUD (includes delete for account removal)
      {
        apiGroups: [''],
        resources: ['secrets'],
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
  webhookServiceAccount(name, namespace='default')::
    $.serviceAccount(name, namespace) +
    $.fullOrchestrationRole(name) +
    $.clusterRoleBinding(name),

  // Convenience: Full RBAC set for provisioner service
  provisionerServiceAccount(name, namespace='default')::
    $.serviceAccount(name, namespace) +
    $.provisionerRole(name) +
    $.clusterRoleBinding(name),

  // Convenience: Full RBAC set for read-only service (Consul, monitoring)
  readOnlyServiceAccount(name, namespace='default')::
    $.serviceAccount(name, namespace) +
    $.readOnlyRole(name) +
    $.clusterRoleBinding(name),
}
