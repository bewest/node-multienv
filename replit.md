# Nightscout Multi-Tenant Kubernetes Platform

## Overview
This project delivers a production-grade, multi-tenant Nightscout platform on Kubernetes. It uses Custom Resource Definitions (CRDs) and Metacontroller to provide a declarative API for managing tenant provisioning. The platform integrates MongoDB, Change Data Capture (CDC) via Strimzi Kafka, and automated backup solutions. It's designed for scalability and isolation, with all tenants hosted within a dedicated `hosted-tenants` namespace. Key features include declarative resource management, automated database migration, and robust status reporting, supporting Nightscout traffic across various tenant configurations for an unlimited number of tenants. The project aims to provide a robust, scalable, and easily manageable Nightscout hosting solution.

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
All tenants are deployed within a single `hosted-tenants` namespace, with resources identified and isolated using a tenant ID prefix and standard Kubernetes labels.

### Custom Resource Definitions (CRDs)
- **StorageAccount CRD** (`nightscout.io/v1alpha1`): Declares MongoDB storage infrastructure.
- **ComputeInstance CRD** (`nightscout.io/v1alpha1`): Declares Nightscout application deployment, referencing a StorageAccount.

### Controllers (Metacontroller)
- **Storage CompositeController**: Manages MongoDB StatefulSets, Services, and Migration Jobs.
- **Compute CompositeController**: Manages Nightscout Deployments, Services, and optional Kafka components.
- **Storage-Credentials DecoratorController**: Manages per-tenant application credentials and user initialization.
- **Storage-Initialization DecoratorController**: Manages durable state on mongo-auth Secrets using clean pipeline pattern with patch-based responses. Sets `ns.mdn.io/runtime-required` (shared/dedicated) based on StorageAccount spec and migration requests. Tracks replica set initialization by observing init-mongo-cluster Jobs and setting `ns.mdn.io/replica-set-initialized` timestamp marker on completion.
- **Instance-Userdata DecoratorController**: Manages Gen 3 to Gen 4 ConfigMap migration and cutover orchestration.
- **PVC-Backup DecoratorController**: Enforces backup policies for MongoDB Persistent Volume Claims.

### Key Technologies
- **Orchestration**: Kubernetes, Metacontroller.
- **Messaging**: Strimzi Kafka for CDC.
- **Database**: MongoDB (per-tenant replica sets).
- **Webhook Implementation**: Node.js with Restify and `@kubernetes/client-node`.
- **Deployment**: Jsonnet for Kubernetes manifest generation.
- **Traffic Serving**: Resolver with Consul coordination.

### Feature Specifications
- **Kubernetes-Idiomatic Status**: Webhooks report status using standard Kubernetes conditions.
- **Child Preservation**: Protects external resources from accidental deletion.
- **Automated Database Migration**: Secure and automated migration system.
- **Comprehensive Labeling & Annotations**: Extensive metadata for operational needs.
- **Configurable Tenants**: Tenant configurations via ConfigMaps for parameterized resource sizing.
- **Facade Pattern**: Consistent "tenant configuration" abstraction.
- **Cloud-Native Startup**: Single multi-mode container image.
- **Two-Interface Design**: Separate administration and resolver interfaces.

### System Design Choices
The platform utilizes a **CRD-based two-composite architecture** (Storage and Compute) for separation of concerns, offering a Kubernetes-native API with `kubectl` integration.
- **Status Reporting**: CRD status includes phase, conditions, connectionSecret, and endpoints.
- **Provisioner API Facade**: A REST API (`POST /accounts/`) for external systems to create StorageAccount + ComputeInstance CRDs and mongo-auth Secrets. Provides abstraction layer over Kubernetes API for tenant provisioning.
- **Decorator-Based Blast Radius Protection**: Storage-Initialization Decorator watches mongo-auth Secret independently using label selectors, not ownership. When StorageAccount CRD is deleted, mongo-auth Secret survives cascade deletion, enabling fast recovery via CRD recreation. app-credentials Secret is regenerated on-demand by Storage-Credentials Decorator from preserved mongo-auth. Operators must explicitly delete mongo-auth Secrets and PVCs to permanently remove tenant data.
- **Resolver Interface**: Routes Nightscout traffic using Consul.
- **Pod Health Check Sidecar**: Lightweight sidecar for localhost-based health validation.
- **Two-Secret Architecture**: Separates root MongoDB credentials (mongo-auth Secret, decorator-protected) from application credentials (app-credentials Secret, owned by compute, regenerable from mongo-auth) for enhanced security and blast radius protection.
- **URI-Based Authentication**: MongoDB utility Jobs (init-replica-set, create-user) use complete connection URIs with admin authentication, ensuring retry reliability and proper credential isolation with `authSource=admin`.
- **Keyfile-Based Replica Authentication**: MongoDB replica sets use shared keyfile Secrets (per StorageAccount) for member authentication. Keyfiles are child resources (deleted with parent CR, regenerable from webhook). Init containers prepare keyfile permissions (chmod 400, chown 999:999) before MongoDB startup. Protection mechanism for keyfiles is deferred to future implementation.
- **Shared MongoDB Configuration**: Single `mongod-config` ConfigMap for all StorageAccounts (1,300+ tenants), generated via jsonnet and deployed to `hosted-tenants` namespace. Provides replication, security, and logging configuration. StatefulSet CLI args override `net.bindIp` to bind only to `127.0.0.1,$(POD_IP)` for DigitalOcean private networking.
- **MongoDB FQDN Consistency**: Helper function `getMongoDBHostnames()` provides canonical hostnames for replica sets. Init Jobs use pod FQDN (e.g., `myaccount-mongo-0.mongo-dbname.namespace.svc.cluster.local`) for both connection and rs.initiate() member configuration to ensure MongoDB stores stable network identities.
- **Decorator Response Pattern**: Decorators follow clean ergonomics - set `res.labels` and `res.annotations` only when patches are needed, return `{ attachments: [] }` for no-op. All handlers flow through to final formatter, no early exits with full object copies.
- **Clean Desired State Pattern**: Webhooks must return clean desired state manifests (metadata.name, namespace, labels, annotations only) without Kubernetes runtime metadata (resourceVersion, uid, managedFields, creationTimestamp). When preserving existing resources, extract their data/spec and re-render as clean manifests to prevent Metacontroller reconciliation loops.
- **Migration Job Prerequisite Pattern**: Gen3→Gen4 migration Jobs verify both source (ConfigMap) and target (Secret) credentials exist before rendering. Guards prevent crashloop failures from missing resources. First reconciliation cycle creates credentials Secret; second cycle (after Secret exists) renders migration Job. ConfigMaps fetched via customize hook for validation. Explicit env var mapping (secretKeyRef/configMapKeyRef) preferred over envFrom for critical operations.
- **Migration Job Completion Tracking**: Storage-Credentials Decorator uses hybrid approach to prevent duplicate migrations: (1) checks durable annotation `ns.mdn.io/migration-completed` on app-credentials Secret for long-term completion tracking, (2) if annotation absent, inspects live migration Job's `status.succeeded` field, (3) when Job succeeds, stamps completion annotation on Secret so state persists after TTL garbage collection. Manual migration reruns require deleting the completion annotation.
- **URI-Based Migration**: Migration Jobs use symmetric MongoDB URI format for both source and target (MIGRATION_SOURCE_URI and MIGRATION_TARGET_URI). The migrate-database.sh script parses database names directly from the URI path segments (e.g., `mongodb://user:pass@host:port/database`), eliminating the need for separate database name parameters. This simplifies the interface (2 URIs vs 6+ separate parameters), enables retry reliability with embedded credentials, and reduces configuration errors.

## External Dependencies
- **Strimzi Kafka Operator**: Manages Kafka clusters and KafkaConnect.
- **Kafka Cluster**: Brokers, Zookeeper/KRaft, storage.
- **KafkaConnect Cluster**: Workers with MongoDB connector plugin.
- **MongoDB**: Primary database, deployed as per-tenant StatefulSets.
- **CSI Driver with Snapshot Support**: For creating VolumeSnapshots.
- **Metacontroller v4.x+**: Kubernetes add-on for custom controller development.
- **Consul**: Used for service discovery and health checking within the resolver interface.
- **jsonnet-bundler (jb)**: Dependency manager for Jsonnet libraries.