# Nightscout Multi-Tenant Kubernetes Platform

## Overview
This project delivers a production-grade, multi-tenant Nightscout platform on Kubernetes, designed for scalability and isolation. It leverages Custom Resource Definitions (CRDs) and Metacontroller to provide a declarative API for managing tenant provisioning. The platform integrates MongoDB, Change Data Capture (CDC) via Strimzi Kafka, and automated backup solutions. All tenants are hosted within a dedicated `hosted-tenants` namespace. Key capabilities include declarative resource management, automated database migration, and robust status reporting. The project aims to provide a robust, scalable, and easily manageable Nightscout hosting solution capable of supporting Nightscout traffic across various tenant configurations for an unlimited number of tenants.

## Recent Changes
- **2025-11-24**: Migrated from spec.selector-based ConfigMap discovery to explicit spec.configMapRef pattern for Gen5 NightscoutTenant CR. Replaced detectComputeActivation with ensureConfigMap supporting provisioner-managed ConfigMaps (adoption with preserved name/namespace). ConfigMap presence controls compute activation - when ConfigMap exists, ReplicaSet renders; when missing or deleted, storage-only mode (no pods). Deleting ConfigMap via environs API stops tenant execution. Pattern simplifies provisioner integration with explicit reference instead of label selectors. Architect-validated as production-ready.
- **2025-11-24**: Unified Nightscout Secret architecture - aligned Gen5 with Gen4 by consolidating app-credentials Secret to contain BOTH MongoDB credentials AND Nightscout runtime configuration (API_SECRET, MONGO_CONNECTION, ENABLE, TIME_FORMAT, etc.). Eliminated redundant `{tenantId}-nightscout` Secret, reducing API object count by one Secret per tenant (~2,000-3,000 fewer objects at scale). Updated renderAppCredentialsSecret to generate complete credentials in single Secret. Renamed ensureNightscoutSecret to ensureAppCredentialsSecret in tenant-composite. Pattern matches proven Gen4 storage-credentials-decorator behavior. Architect-validated as production-ready.

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
- **StorageAccount CRD** (`nightscout.io/v1alpha1`): Declares MongoDB storage infrastructure (Gen4).
- **ComputeInstance CRD** (`nightscout.io/v1alpha1`): Declares Nightscout application deployment, referencing a StorageAccount (Gen4).
- **NightscoutTenant CRD** (`nightscout.io/v1alpha1`): Unified tenant resource with a two-phase provisioning model (Gen5).

### Controllers (Metacontroller)
The platform utilizes Metacontroller with both Gen4 (Composite and Decorator) and Gen5 (Decorator-Driven) architectures.

**Gen4 Controllers:**
- **Storage CompositeController**: Manages MongoDB StatefulSets, Services, and Migration Jobs.
- **Compute CompositeController**: Manages Nightscout Deployments, Services, and migration.
- **Storage-Credentials DecoratorController**: Manages per-tenant application credentials and user initialization.
- **Storage-Initialization DecoratorController**: Manages durable state on mongo-auth Secrets and tracks replica set initialization.
- **PVC-Backup DecoratorController**: Enforces backup policies for MongoDB PVCs.

**Gen5 Controllers (Decorator-Driven Architecture):**
- **Tenant CompositeController**: Renders infrastructure based on annotation state, managing ReplicaSets.
- **Tenant-Initialization DecoratorController**: Orchestrates jobs for NightscoutTenant CRs, including replica set and user initialization, updating parent CR annotations on completion.

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
The platform supports Gen4 (CRD-based two-composite) and Gen5 (unified NightscoutTenant CRD with two-phase provisioning) architectures, both offering a Kubernetes-native API.
- **Status Reporting**: CRD status includes phase, conditions, connectionSecret, and endpoints.
- **Provisioner API Facade**: A REST API (`POST /accounts/`) for external systems to create CRDs and mongo-auth Secrets.
- **Decorator-Based Blast Radius Protection**: `mongo-auth` Secrets persist on CRD deletion for fast recovery.
- **Resolver Interface**: Routes Nightscout traffic using Consul.
- **Pod Health Check Sidecar**: Lightweight sidecar for localhost-based health validation.
- **Single Nightscout Secret Architecture**: Each tenant uses one `app-credentials` Secret for both MongoDB credentials and Nightscout runtime configuration.
- **URI-Based Authentication**: MongoDB utility Jobs use complete connection URIs.
- **Keyfile-Based Replica Authentication**: MongoDB replica sets use shared keyfile Secrets for member authentication.
- **Shared MongoDB Configuration**: Single `mongod-config` ConfigMap for all StorageAccounts.
- **MongoDB FQDN Consistency**: Canonical hostnames used for replica sets.
- **Decorator Response Pattern**: Decorators return minimal patches or `{ attachments: [] }` for no-op.
- **Clean Desired State Pattern**: Webhooks return clean desired state manifests without Kubernetes runtime metadata.
- **Migration Job Prerequisite Pattern**: Migration Jobs verify source and target credentials before rendering.
- **Migration Job Completion Tracking**: Hybrid approach using annotations and live Job status.
- **URI-Based Migration**: Migration Jobs use symmetric MongoDB URI format for source and target.
- **Two-Phase Migration Architecture**: Gen3→Gen4 migration uses sequential phases for data and userdata.

## External Dependencies
- **Strimzi Kafka Operator**: Manages Kafka clusters and KafkaConnect.
- **Kafka Cluster**: Brokers, Zookeeper/KRaft, storage.
- **KafkaConnect Cluster**: Workers with MongoDB connector plugin.
- **MongoDB**: Primary database, deployed as per-tenant StatefulSets.
- **CSI Driver with Snapshot Support**: For creating VolumeSnapshots.
- **Metacontroller v4.x+**: Kubernetes add-on for custom controller development.
- **Consul**: Used for service discovery and health checking within the resolver interface.
- **jsonnet-bundler (jb)**: Dependency manager for Jsonnet libraries.