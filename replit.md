# Nightscout Multi-Tenant Kubernetes Platform

## Overview
This project establishes a production-ready, multi-tenant Nightscout platform on Kubernetes. It leverages Custom Resource Definitions (CRDs) and Metacontroller to offer a declarative, Kubernetes-native API for managing tenant provisioning. The platform integrates MongoDB, Change Data Capture (CDC) via Strimzi Kafka, and automated backup solutions. Designed for scalability and isolation, all tenants are hosted within a dedicated `hosted-tenants` namespace. Key features include declarative resource management, automated database migration, and robust status reporting through CRD status subresources. The system supports Nightscout traffic across various tenant configurations and is built to host an unlimited number of tenants.

## User Preferences
- Prefer Node.js/JavaScript for webhook implementation
- Use Restify as standard web server framework
- Use existing @kubernetes/client-node library
- Follow Metacontroller webhook protocol specifications
- Follow Kubernetes recommended labels, annotations, and status patterns
- Support tenant tiers via ConfigMap parameterization
- Implement child preservation to protect external resources

## System Architecture

### Multi-Tenant Design
All tenants are deployed within a single `hosted-tenants` namespace, with resources uniquely identified and isolated using a tenant ID prefix and standard Kubernetes labels.

### Custom Resource Definitions (CRDs)
Two custom resources provide a declarative API for multi-tenant management:
- **StorageAccount CRD** (`nightscout.io/v1alpha1`): Declares MongoDB storage infrastructure requirements.
- **ComputeInstance CRD** (`nightscout.io/v1alpha1`): Declares Nightscout application deployment requirements, referencing a StorageAccount.

### Controllers (Metacontroller)
- **Storage CompositeController**: Manages MongoDB StatefulSets, Services, and Migration Jobs based on StorageAccount CRDs.
- **Compute CompositeController**: Manages Nightscout Deployments, Services, and optionally per-tenant Kafka topics/connectors based on ComputeInstance CRDs.
- **Storage-Credentials DecoratorController**: Manages per-tenant application credentials and user initialization.
- **DecoratorController (PVC Backup Policy)**: Enforces backup policies for MongoDB Persistent Volume Claims.

### Key Technologies
- **Orchestration**: Kubernetes, Metacontroller.
- **Messaging**: Strimzi Kafka for CDC.
- **Database**: MongoDB (per-tenant replica sets).
- **Webhook Implementation**: Node.js with Restify and `@kubernetes/client-node`.
- **Deployment**: Jsonnet library for generating Kubernetes manifests.
- **Traffic Serving**: Resolver + Consul coordination.

### Feature Specifications
- **Kubernetes-Idiomatic Status**: Webhooks report status using standard Kubernetes conditions.
- **Child Preservation**: Protects external resources from accidental deletion.
- **Automated Database Migration**: Secure and automated migration system.
- **Comprehensive Labeling & Annotations**: Extensive metadata for various operational needs.
- **Configurable Tenants**: Tenant configurations via ConfigMaps for parameterized resource sizing and multi-tier offerings.
- **Facade Pattern**: Consistent "tenant configuration" abstraction for progressive migration.
- **Cloud-Native Startup**: Single multi-mode container image for different architectural components.
- **Two-Interface Design**: Separate administration and resolver interfaces.

### System Design Choices
The platform employs a **CRD-based two-composite architecture** (Storage and Compute) for clear separation of concerns, providing a Kubernetes-native API with `kubectl` integration and OpenAPI v3 schema validation.
- **Status Reporting**: CRD status includes phase, conditions, connectionSecret, and endpoints.
- **Provisioner API Facade**: A REST API for external systems to provision accounts and sites.
- **Resolver Interface**: Routes Nightscout traffic using Consul for service discovery.
- **Pod Health Check Sidecar**: Lightweight sidecar for localhost-based health validation.
- **Two-Secret Architecture**: Separates root MongoDB credentials from application credentials for enhanced security.

## External Dependencies
- **Strimzi Kafka Operator**: Manages Kafka clusters and KafkaConnect for CDC.
- **Kafka Cluster**: Brokers, Zookeeper/KRaft, storage.
- **KafkaConnect Cluster**: Workers with MongoDB connector plugin.
- **MongoDB**: Primary database, deployed as per-tenant StatefulSets.
- **CSI Driver with Snapshot Support**: Used for creating VolumeSnapshots.
- **Metacontroller v4.x+**: Kubernetes add-on for custom controller development and orchestration.
- **Consul**: Utilized for service discovery and health checking within the resolver interface.
- **jsonnet-bundler (jb)**: Dependency manager for Jsonnet libraries.

## Recent Changes

### 2025-11-06: Storage-Credentials DecoratorController
- **Orthogonal Credential Management**: Implemented DecoratorController for per-tenant credential lifecycle
  - Watches ComputeInstance CRDs and creates app-credentials Secrets for dedicated storage mode
  - Discovers StorageAccount via relatedResources to determine storage type and database naming
  - Supports both `spec.storageAccountRef.name` and `storage.nightscout.org/account` label for legacy compatibility
  - Uses `storageAccount.metadata.name` for database name generation to match storage composite naming
- **First-Cycle-Only Credential Generation**: Preserves existing Secrets to prevent credential rotation
  - Checks for existing app-credentials Secret in attachments before creating
  - If exists: Preserves unchanged
  - If missing: Generates new deterministic credentials from tenant ID hash
  - Prevents accidental password regeneration on every reconciliation
- **User Initialization Jobs**: Automated MongoDB user creation
  - Renders create-user Jobs referencing admin credentials from `${storageAccountId}-mongo-auth` Secret
  - Jobs target correct mongo Service hostname: `mongo-${databaseName}`
  - Only renders when UserInitialized condition is not True in ComputeInstance status
  - Preserves completed/running/failed Jobs to prevent re-execution
- **Attachment Preservation**: Resilient to transient API failures
  - `collectExistingAttachments()` re-emits existing Secrets and Jobs when StorageAccount lookup fails
  - Prevents Metacontroller from deleting resources during temporary API issues
  - Critical for production stability with 1300+ sites
- **Shared Storage Mode**: Skips credential creation for shared storage
  - Decorator checks `storageAccount.spec.storageType`
  - Only creates credentials when storageType === 'dedicated'
  - Allows operators to switch storage modes independently
- **Pipeline Architecture**: Refactored to middleware-style pipeline pattern (similar to storage-composite)
  - **Stage 1: initializeContext** - Extract ComputeInstance, related resources, attachments
  - **Stage 2: discoverStorageAccount** - Find StorageAccount via relatedResources (supports spec ref and label)
  - **Stage 3: collectAttachments** - Index existing Secrets and Jobs for efficient lookup
  - **Stage 4: planCredentialsSecret** - Decide create/update/skip for app-credentials Secret
  - **Stage 5: planUserInitJob** - Render create-user Job if UserInitialized condition not True
  - **Stage 6: planMigrationJob** - Render migration Job if `nightscout.io/migrate-to-dedicated` annotation present
  - **Stage 7: assembleResponse** - Finalize attachments array and send to Metacontroller
  - Each stage uses req/res/next pattern for composable logic
  - Enables future extension: add new stages without touching existing logic
- **Migration Support**: Shared → Dedicated storage transition
  - Detects `nightscout.io/migrate-to-dedicated: "true"` annotation on ComputeInstance
  - Renders migration Job using `migrate-database.sh` script from ns-utility container
  - Only executes if MigrationCompleted condition is not True
  - Uses `mongodump-restore` method to transfer data
  - Source: ConfigMap-based shared storage credentials (TODO: discovery logic)
  - Target: Newly created dedicated app-credentials Secret
  - Job includes full environment variables for source/target connections
- **Integration**: 
  - Created `cmd/webhook/handlers/storage-credentials-decorator-sync.js`
  - Added DecoratorController manifest in `metacontroller.libsonnet` with relatedResources
  - Added RBAC role `storageCredentialsDecoratorRole` with permissions for CRDs, Secrets, Jobs, ConfigMaps
  - Registered webhook endpoint: POST `/decorator/storage-credentials/sync`
  - Integrated into `gen4.stack()` with ServiceAccount creation

### 2025-11-06: Selector-Based Resource Protection (Hybrid Lifecycle Pattern)
- **Problem**: Accidental CRD deletion cascades to PVCs and Secrets containing irreplaceable MongoDB data and credentials
- **Solution**: Hybrid selector-driven lifecycle with tiered resource protection
  - Protected resources tracked by labels (no ownerReferences) - survive parent deletion
  - Disposable resources keep ownerReferences - normal cascade delete
  - Finalizers (future) will orchestrate cleanup with VolumeSnapshot backup before deletion

**CRD Schema Updates** (storageaccount.yaml, computeinstance.yaml, crds.libsonnet):
- Added `spec.selector` field with matchLabels and matchExpressions support (optional for backward compatibility)
- Added `status.orphanedResources` field for tracking resources matching selector but unmanaged
- Selector enables label-based resource discovery and adoption
- Legacy 1300+ tenants without selector continue working unchanged
- **2025-11-06 Update**: Updated crds.libsonnet to include spec.selector field in both CRD definitions
  - Ensures jsonnet-generated CRDs match hand-maintained YAML versions
  - StorageAccount and ComputeInstance both support selector-based resource protection
  - Schema includes matchLabels (object) and matchExpressions (array) with proper validation

**Protected Resources** (no ownerReferences, labeled for tracking):
- **PVCs**: MongoDB data volumes - must survive StorageAccount deletion
- **mongo-auth Secrets**: Root MongoDB credentials - singleton, no backup exists
- **app-credentials Secrets**: Per-tenant application credentials - managed by decorator
- All marked with `nightscout.io/protected-resource: "true"` annotation
- Tracked via `storage.nightscout.org/account` and resource-type labels

**Disposable Resources** (keep ownerReferences, cascade delete normally):
- Services (can recreate from specs)
- Jobs (completed migration/init jobs)
- ConfigMaps (metadata only)

**Storage Composite Pipeline Refactoring** (storage-composite-sync.js):
- Added `resolveSelectorContext` stage - extracts selector labels, handles legacy parents without selector
- Added `collectAttachments` stage - indexes children (owned) and related (label-selected) resources
- Added `planProtectedAssets` stage - handles PVCs and mongo-auth Secret WITHOUT ownerReferences
- Backward compatible - parents without selector use unchanged legacy behavior
- Protected resources receive correct labels and annotations on creation
- **2025-11-06 Update**: Enhanced mongo-auth Secret protection
  - New secrets created with `ownerReferences: null` in metadata (template_initial_storage_secret)
  - Existing secrets cloned and stripped of ownerReferences/managedFields (planProtectedAssets)
  - Matches decorator protection pattern for consistency across all credential secrets

**Decorator Protection Enhancement** (storage-credentials-decorator-sync.js):
- Now protects EXISTING app-credentials Secrets (not just new ones)
- Clones existing Secret, strips ownerReferences (sets to null), adds protected-resource annotation
- Gradual protection - all existing Secrets protected on next reconciliation cycle
- No credential rotation - data/credentials preserved, only metadata updated

**Metacontroller Configuration** (metacontroller.libsonnet):
- Updated compositeController helper to support relatedResources parameter
- Added selector-based discovery of PVCs, ConfigMaps, and ComputeInstances to storageComposite
- Webhook receives existing protected resources via `related` field for adoption/tracking
- **2025-11-06 Update**: Moved mongo-auth Secrets from childResources to relatedResources
  - Removed `{ apiVersion: 'v1', resource: 'secrets' }` from childResources
  - Added Secrets to relatedResources with label selector `storage.nightscout.org/account`
  - Enables selector-based adoption and orphaning pattern for mongo-auth Secrets

**Constants & Conventions** (constants.js):
- Defined finalizers: `storage.nightscout.io/finalizer`, `compute.nightscout.io/finalizer`
- Defined annotations: `nightscout.io/protected-resource`, migration triggers, backup policy
- Defined labels: storage/compute account links, tenant ID, resource types
- Resource type constants for tracking (PVC, secrets, jobs)

**Rollout Strategy**:
1. Deploy new CRDs (selector optional) - no breaking changes
2. Deploy updated webhooks
3. Existing 1300+ tenants continue operating (no selector required)
4. Decorator automatically protects existing Secrets through normal reconciliation
5. Operators can add selectors to tenants gradually over time
6. New tenants can use selector pattern immediately

**Remaining Work** (future enhancements):
- Finalizer webhook handlers for cleanup orchestration (VolumeSnapshot + Secret backup before deletion)
- Orphan detection in status reporting (surfaces resources matching selector but unmanaged)
- RBAC permissions for finalizer operations
- Operator runbook for recovery scenarios and manual cleanup procedures