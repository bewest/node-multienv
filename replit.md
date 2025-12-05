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
- **Tenant-Initialization DecoratorController** (DEPRECATED): Orchestrates MongoDB initialization Jobs on NightscoutTenant CRs. Consider using mongo-auth-init + app-credentials-init decorators instead.

**Shared Decorators (Gen4/Gen5):**
Secret-watching decorators that stamp annotations on Secrets rather than CRs, avoiding drift with composite controllers:
- **Mongo-Auth Init DecoratorController**: Watches mongo-auth Secrets, creates init-replica-set Job (if `ns.mdn.io/replicaset-required` != "false"), stamps `ns.mdn.io/replica-set-initialized` on Secret. Preserves existing Jobs to prevent premature deletion.
- **App-Credentials Init DecoratorController**: Watches app-credentials Secrets, gates on replica-set-initialized (unless not required), creates create-user Job, stamps `ns.mdn.io/user-initialized` on Secret. Preserves existing Jobs to prevent premature deletion.

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
- **Empty Array Normalization**: Optional array fields (like `imagePullSecrets`) are conditionally included only when non-empty. Kubernetes normalizes empty arrays differently than the webhook renders them, causing Metacontroller to detect drift and trigger recreation on every sync. Using spread operator pattern `...(arr.length > 0 ? { field: arr } : {})` ensures idempotent desired state.
- **Dual Pod Management Modes**: Gen5 supports two modes via `USE_REPLICASET` feature flag:
  - **ReplicaSet Mode** (`USE_REPLICASET=true`): ReplicaSet provides buffer layer between Metacontroller and Pods. InPlace update strategy allows K8s ReplicaSet controller to manage Pod lifecycle. Slightly higher resource overhead (ReplicaSet + Pod objects per tenant).
  - **Direct Pod Mode** (`USE_REPLICASET=false`): Pods managed directly by Metacontroller with `generateSelector=false`. This prevents Metacontroller from injecting `controller-uid` into labels, eliminating drift detection on server-managed fields. Spec-hash annotation in Pod triggers recreation (via Recreate strategy) when inputs change. Lower resource overhead (Pod only per tenant).
- **generateSelector=false Pattern**: When set on CompositeController, Metacontroller skips injecting `controller-uid` labels into child resources. Combined with spec-hash annotation, this enables idempotent Pod rendering without preservation logic. The webhook always renders fresh Pods; Metacontroller compares against existing state and only recreates when spec-hash differs.
- **Spec-Hash Change Detection**: The `ns.mdn.io/spec-hash` annotation captures all significant Pod inputs (container images, secret refs, PVC name, userInitialized state, resource limits, labels, annotations). When inputs change, hash changes, triggering Pod recreation. With Recreate strategy (Gen5 tenant composite), this causes immediate delete+recreate. With RollingRecreate strategy (multi-replica scenarios only), this enables gradual rollout.
- **statusChecks with Conditions**: When using rolling update strategies (RollingRecreate/RollingInPlace), Pod children use `statusChecks: { conditions: [{ type: Ready, status: True }] }` to gate updates. Metacontroller waits for each updated Pod to become Ready before proceeding to the next. This provides StatefulSet-like ordered rollout behavior. Note: statusChecks are ignored with Recreate strategy since there's no rollout sequence.
- **Deep-Merge Pattern for K8s Defaults**: When rendering Pod/ReplicaSet children, the webhook passes the observed child to render functions. The render function deep-merges the desired spec with the observed spec, preserving Kubernetes-added defaults (like `terminationMessagePath`, `protocol: TCP`, `successThreshold: 1`) while applying our managed fields. This prevents Metacontroller from detecting drift on fields we don't explicitly manage, eliminating unnecessary InPlace updates. Functions use `mergePodSpecWithObserved()` helper which preserves observed container defaults while overriding our managed fields (image, env, resources, probes, etc.).
- **Pod Update Strategy: Recreate vs RollingRecreate**: Gen5 tenant composite uses `Recreate` strategy for Pod children, not `RollingRecreate`. RollingRecreate activates ControllerRevision machinery designed for multi-replica StatefulSet-like workloads. For single-Pod-per-tenant architectures with morphing children (lifecycle phases where child count/structure changes), Recreate is simpler and avoids race conditions. Key insight: ControllerRevision machinery activates based on CompositeController configuration, not actual children returned.
- **Morphing Children Pattern**: Tenant composite children change based on lifecycle phase (storage-only → MongoDB-only Pod → full Pod with Nightscout). This requires Recreate strategy because there's no meaningful "rollout" between fundamentally different configurations. RollingRecreate assumes stable child count and gradual updates, which conflicts with phase-based structural changes.
- **ControllerRevision Race Condition Avoidance**: RollingRecreate creates ControllerRevision objects to track parent spec changes. Race condition occurs when multiple syncs start before informer cache updates: Sync 1 creates revision → Sync 2 reads stale cache → Sync 2 tries to create same revision → "already exists" error. Using Recreate strategy eliminates this entirely for single-Pod scenarios.
- **Shared vs Dedicated Storage Mode**: Gen5 supports two storage modes for tenant scalability:
  - **Shared Mode** (`storageType=shared`, default): Nightscout-only Pod connects to external MongoDB via ConfigMap URI. No co-located MongoDB container, no keyfile Secret, no PVC required. Ideal for new tenants starting with shared infrastructure (Atlas, shared cluster). Uses envFrom ConfigMap pattern.
  - **Dedicated Mode** (`storageType=dedicated`): Full co-located MongoDB + Nightscout Pod. Two-phase container gating (MongoDB-only → MongoDB+Nightscout). Requires keyfile Secret, mongo-auth Secret, and PVC. Explicit `MONGO_CONNECTION` env overrides any ConfigMap mongo variable (Kubernetes env precedence pattern).
  - **Storage Type Detection Priority**: 1) `ns.mdn.io/runtime-required` annotation (migration override), 2) `spec.initStorageType` (initial intent), 3) default 'shared'.
  - **Migration Flow**: Migration decorator stamps `ns.mdn.io/runtime-required=dedicated` annotation → composite re-syncs with dedicated mode → Pod recreates with MongoDB container → initialization Jobs run → status.storageType updates.
  - **Consul Compatibility**: Both modes render `role: config-as-deploy` label for resolver/Consul registration compatibility with Gen3 deployment-operator.

## External Dependencies
- **Strimzi Kafka Operator**: Manages Kafka clusters and KafkaConnect.
- **Kafka Cluster**: Brokers, Zookeeper/KRaft, storage.
- **KafkaConnect Cluster**: Workers with MongoDB connector plugin.
- **MongoDB**: Primary database, deployed as per-tenant StatefulSets.
- **CSI Driver with Snapshot Support**: For creating VolumeSnapshots.
- **Metacontroller v4.x+**: Kubernetes add-on for custom controller development.
- **Consul**: Used for service discovery and health checking within the resolver interface.
- **jsonnet-bundler (jb)**: Dependency manager for Jsonnet libraries.