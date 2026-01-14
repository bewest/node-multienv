/**
 * Constants for Nightscout Gen 4 Multi-Tenant Platform
 * Defines finalizers, annotations, and labels used across controllers
 */

// Finalizers - added to CRDs to ensure proper cleanup before deletion
const FINALIZERS = {
  STORAGE_ACCOUNT: 'storage.nightscout.io/finalizer',
  COMPUTE_INSTANCE: 'compute.nightscout.io/finalizer',
};

// Annotations for resource protection and lifecycle management
const ANNOTATIONS = {
  PROTECTED_RESOURCE: 'nightscout.io/protected-resource',  // "true" = don't cascade delete
  MIGRATION_REQUESTED: 'nightscout.io/migration-requested', // "true" = trigger migration
  BACKUP_POLICY: 'nightscout.io/backup-policy',             // PVC backup configuration
  LAST_BACKUP_TIME: 'nightscout.io/last-backup-time',       // ISO 8601 timestamp
};

// Labels for resource selection and tracking
const LABELS = {
  STORAGE_ACCOUNT: 'storage.nightscout.io/account',         // Links to StorageAccount
  COMPUTE_INSTANCE: 'compute.nightscout.io/instance',       // Links to ComputeInstance
  TENANT_ID: 'nightscout.io/tenant-id',                     // Tenant identifier
  RESOURCE_TYPE: 'nightscout.io/resource-type',             // Type of resource (pvc, secret, etc)
  MANAGED_BY: 'app.kubernetes.io/managed-by',               // Standard Kubernetes label
};

// Resource types for protected resource tracking
const RESOURCE_TYPES = {
  PVC: 'persistent-volume-claim',
  MONGO_AUTH_SECRET: 'mongo-auth-secret',
  APP_CREDENTIALS_SECRET: 'app-credentials-secret',
  MIGRATION_JOB: 'migration-job',
  USER_INIT_JOB: 'user-init-job',
};

// Standard managed-by value for Gen 4 resources
const MANAGED_BY_GEN4 = 'nightscout-gen4-metacontroller';

module.exports = {
  FINALIZERS,
  ANNOTATIONS,
  LABELS,
  RESOURCE_TYPES,
  MANAGED_BY_GEN4,
};
