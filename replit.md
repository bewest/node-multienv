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
- **Integration**: 
  - Created `cmd/webhook/handlers/storage-credentials-decorator-sync.js`
  - Added DecoratorController manifest in `metacontroller.libsonnet` with relatedResources
  - Added RBAC role `storageCredentialsDecoratorRole` with permissions for CRDs, Secrets, Jobs, ConfigMaps
  - Registered webhook endpoint: POST `/decorator/storage-credentials/sync`
  - Integrated into `gen4.stack()` with ServiceAccount creation