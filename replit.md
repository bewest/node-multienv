# Nightscout Multi-Tenant Kubernetes Platform

## Overview
This project delivers a production-grade, multi-tenant Nightscout platform orchestrated on Kubernetes. It utilizes Custom Resource Definitions (CRDs) and Metacontroller to provide a declarative, Kubernetes-native API for seamless tenant provisioning and management. The platform integrates MongoDB, Change Data Capture (CDC) via Strimzi Kafka, and automated backup solutions. Designed for scalability and isolation, all tenants reside in a dedicated `hosted-tenants` namespace. Key capabilities include declarative resource management, automated database migration, and robust status reporting through CRD status subresources. The system supports serving Nightscout traffic across various tenant configurations and is built to host an unlimited number of tenants.

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
- **StorageAccount CRD** (`nightscout.io/v1alpha1`): Declares MongoDB storage infrastructure requirements (version, replicas, tier, storage size, resources, backup, migration). Its status includes phase, conditions, connectionSecret, and databaseName.
- **ComputeInstance CRD** (`nightscout.io/v1alpha1`): Declares Nightscout application deployment requirements (storageAccountRef, image, replicas, tier, resources, cdc, healthcheck). Its status includes phase, conditions, and endpoints.

### Controllers (Metacontroller)
- **Storage CompositeController**: Manages MongoDB StatefulSets, Services, Secrets, and Migration Jobs based on StorageAccount CRDs.
- **Compute CompositeController**: Manages Nightscout Deployments, Services, and optionally per-tenant Kafka topics/connectors based on ComputeInstance CRDs.
- **DecoratorController (PVC Backup Policy)**: Enforces backup policies for MongoDB PVCs through annotations, finalizers, and VolumeSnapshot creation.

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
The platform employs a **CRD-based two-composite architecture** (Storage and Compute) for clear separation of concerns.
- **Kubernetes-Native API**: CRDs offer `kubectl` integration, OpenAPI v3 schema validation, and status subresources.
- **Status Reporting**: CRD status includes phase, conditions, connectionSecret, and endpoints.
- **Provisioner API Facade**: A REST API for external systems to provision accounts and sites.
- **Resolver Interface**: Routes Nightscout traffic using Consul for service discovery.
- **Pod Health Check Sidecar**: Lightweight sidecar for localhost-based health validation, eliminating bottlenecks at scale.
- **Two-Secret Architecture**: Separates root MongoDB credentials (Storage Secret) from application credentials (App-Credentials Secret) for enhanced security and least privilege. Each MongoDB instance uses a deterministic database name generated from the storage account hash.

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

### 2025-11-01: CRD-Based Provisioner API (Gen 4)
- **Provisioner API Migration**: Refactored `/accounts/*` REST API handlers to use CRDs instead of Secret/ConfigMap
- Created `lib/templates/storage-account.js` - template function for generating StorageAccount CRD manifests
- Created `lib/templates/compute-instance.js` - template function for generating ComputeInstance CRD manifests
- Created `lib/routes/storage-accounts.js` - CRUD handlers for StorageAccount using CustomObjectsApi
- Created `lib/routes/compute-instances.js` - CRUD handlers for ComputeInstance using CustomObjectsApi
- Updated `k8s-deployment-controller.js` to route `/accounts` endpoints to new CRD-based handlers
- Fixed resourceVersion handling to ensure idempotent updates work without 409 conflicts
- Fixed label selector parameter position for proper account-scoped ComputeInstance filtering
- Backward compatibility: Legacy endpoints moved to `/accounts-legacy/*` for Gen 3 migration support
- New API creates CRDs directly, triggering Metacontroller webhooks for resource provisioning

### 2025-11-01: Gen 4 RBAC Implementation
- **RBAC Updates for CRD Support**: Added nightscout.io API group permissions to support Gen 4 CRD-based architecture
- Updated `fullOrchestrationRole()` in `rbac.libsonnet`: Added nightscout.io/storageaccounts and nightscout.io/computeinstances permissions with separate status subresource rule
- Updated `provisionerRole()` in `rbac.libsonnet`: Added full CRUD (including delete) for CRDs to support provisioner API tenant lifecycle
- Created `deploymentControllerRole()` in `rbac.libsonnet`: Combined role merging webhook and provisioner permissions for k8s-deployment-controller
- Created `deploymentControllerRBAC()` in `rbac.libsonnet`: Ergonomic export (ServiceAccount + ClusterRole + ClusterRoleBinding) for easy deployment integration
- Created `migrationJobRole()` in `rbac.libsonnet`: Minimal permissions role for database migration jobs (read Secrets only)
- Created `migrationJobServiceAccount()` convenience function for easy migration job RBAC setup
- Updated `gen4.stack()` in `gen4.libsonnet`: Now creates both deployment-controller and migration-job service accounts with imagePullSecrets
- Updated default ServiceAccount name: Changed from `multienv-metactl-webhook` to `deployment-controller` to reflect actual purpose
- Added `imagePullSecrets` parameter to all RBAC convenience functions for private registry support
- Updated `docs/RBAC-DESIGN.md`: Documented CRD permissions, status subresource pattern, cross-namespace example (default → hosted-tenants), and Gen 3/Gen 4 compatibility
- Updated `jsonnet/environments/gen4-test/README.md`: Documented new RBAC permissions and cross-namespace capabilities
- Maintained backward compatibility: Gen 3 ConfigMap/Secret permissions preserved alongside Gen 4 CRD permissions
- **Bug fix**: Fixed RBAC convenience functions to return object with separate fields instead of merging resources with `+` operator (was causing "unknown field: rules" warnings)

## Provisioner API

The platform provides a REST API facade in `k8s-deployment-controller.js` for external systems to provision accounts and sites. The API now uses CRD-based resources (Gen 4).

### Gen 4 CRD-Based Endpoints

**StorageAccount Management:**
- `POST /accounts` - Create new storage account with auto-generated ID
- `POST /accounts/:account` - Create or update specific storage account
- `GET /accounts/:account` - Get storage account details
- `GET /accounts` - List all storage accounts
- `DELETE /accounts/:account` - Delete storage account

**ComputeInstance Management:**
- `POST /accounts/:account/sites/:name` - Create or update site/tenant
- `POST /accounts/:account/sites` - Create site (name from body.internal_name)
- `GET /accounts/:account/sites/:name` - Get site details
- `GET /accounts/:account/sites` - List sites for account
- `DELETE /accounts/:account/sites/:name` - Delete site

**Example Request:**
```bash
# Create StorageAccount
curl -X POST http://localhost:2828/accounts/my-account \
  -H "Content-Type: application/json" \
  -d '{
    "tier": "premium",
    "mongodbVersion": "7.0",
    "replicas": 3,
    "storageSize": "20Gi"
  }'

# Create ComputeInstance
curl -X POST http://localhost:2828/accounts/my-account/sites/my-site \
  -H "Content-Type: application/json" \
  -d '{
    "tier": "premium",
    "nightscoutImage": "nightscout/cgm-remote-monitor:latest",
    "replicas": 2,
    "env": [
      {"name": "ENABLE", "value": "careportal basal"}
    ]
  }'
```

### Legacy Gen 3 Endpoints
For backward compatibility during migration:
- `/accounts-legacy/*` - Secret/ConfigMap-based provisioning (deprecated)

### Implementation
- Template functions: `lib/templates/storage-account.js`, `lib/templates/compute-instance.js`
- Route handlers: `lib/routes/storage-accounts.js`, `lib/routes/compute-instances.js`
- Main controller: `k8s-deployment-controller.js`
