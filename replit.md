# Nightscout Multi-Tenant Kubernetes Platform

## Overview
This project delivers a production-grade, multi-tenant Nightscout platform on Kubernetes, designed for scalability and isolation. It leverages Custom Resource Definitions (CRDs) and Metacontroller to provide a declarative API for managing tenant provisioning. The platform integrates MongoDB, Change Data Capture (CDC) via Strimzi Kafka, and automated backup solutions. All tenants are hosted within a dedicated `hosted-tenants` namespace. Key capabilities include declarative resource management, automated database migration, and robust status reporting. The project aims to provide a robust, scalable, and easily manageable Nightscout hosting solution capable of supporting Nightscout traffic across various tenant configurations for an unlimited number of tenants.

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

**Gen5 Controllers (Pod-Based Decorator-Driven Architecture):**
- **Tenant CompositeController**: Renders tenant Pods directly for minimal control plane load. Pod contains MongoDB initially; adds Nightscout after user initialization. ConfigMap presence via `spec.configMapRef` controls compute activation.
- **Tenant-Initialization DecoratorController**: Orchestrates MongoDB initialization Jobs, connecting via Pod IP. Gates on Pod readiness, sets `ns.mdn.io/user-initialized` annotation on completion.

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
The platform supports Gen4 and Gen5 architectures, both offering a Kubernetes-native API.
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
- **Gen5 Pod-Based Architecture**: Uses direct Pod management instead of ReplicaSets to minimize control plane load. Metacontroller watches children immediately (not waiting for resync), so Pod recovery is effectively immediate. Pods render via composite, Jobs attach via decorator.
- **Two-Phase Container Gating**: Tenant Pod initially renders with MongoDB container only. After initialization Jobs complete and set `ns.mdn.io/user-initialized` annotation, composite re-renders Pod with both MongoDB and Nightscout containers, ensuring MongoDB is fully initialized.
- **Pod IP Connectivity for Jobs**: Initialization Jobs run in separate Pods and connect to MongoDB via Pod IP (extracted from status.podIP). Decorator gates on Pod readiness before rendering Jobs.
- **Empty Array Normalization**: Optional array fields (like `imagePullSecrets`) are conditionally included only when non-empty. Kubernetes normalizes empty arrays differently than the webhook renders them, causing Metacontroller to detect drift and trigger RollingRecreate on every sync. Using spread operator pattern `...(arr.length > 0 ? { field: arr } : {})` ensures idempotent desired state.
- **Spec-Hash Pod Preservation Pattern**: For Pod children with RollingRecreate strategy, use a spec-hash annotation (`ns.mdn.io/spec-hash`) to track significant Pod inputs. On sync, compare the existing Pod's hash with the desired hash. If hashes match, preserve the existing Pod (via `cleanResource()`) to prevent Metacontroller from detecting drift on server-managed fields like `controller-uid`. If hashes differ or no Pod exists, render a fresh Pod with the new hash. The hash captures: container images, secret references, PVC name, userInitialized state, resource limits, imagePullSecrets, and all metadata (labels, annotations) via shared `buildTenantPodMetadata()` helper. This approach sidesteps K8s normalization issues (K8s adds default values that differ from webhook-rendered state) and ensures ConfigMap/Secret changes trigger Pod recreation while identical inputs preserve the Pod.
- **statusChecks with Conditions**: Pod children use `statusChecks: { conditions: [{ type: Ready, status: True }] }` to gate rolling updates. Metacontroller waits for each updated Pod to become Ready before proceeding to the next. This provides StatefulSet-like ordered rollout behavior and prevents cascading failures during intentional updates. Combined with spec-hash pattern: spec-hash prevents false drift detection, statusChecks ensures orderly rollouts when real changes occur.

## External Dependencies
- **Strimzi Kafka Operator**: Manages Kafka clusters and KafkaConnect.
- **Kafka Cluster**: Brokers, Zookeeper/KRaft, storage.
- **KafkaConnect Cluster**: Workers with MongoDB connector plugin.
- **MongoDB**: Primary database, deployed as per-tenant StatefulSets.
- **CSI Driver with Snapshot Support**: For creating VolumeSnapshots.
- **Metacontroller v4.x+**: Kubernetes add-on for custom controller development.
- **Consul**: Used for service discovery and health checking within the resolver interface.
- **jsonnet-bundler (jb)**: Dependency manager for Jsonnet libraries.