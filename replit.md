# Nightscout Multi-Tenant Kubernetes Platform

## Overview
This project provides a scalable, multi-tenant Nightscout platform on Kubernetes, utilizing Custom Resource Definitions (CRDs) and Metacontroller for declarative tenant management. It integrates MongoDB, Change Data Capture (CDC) via Strimzi Kafka, and automated backup solutions. The platform aims to offer a robust, easily manageable Nightscout hosting solution capable of supporting an unlimited number of tenants with declarative resource management, automated database migration, and comprehensive status reporting.

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
All tenants are deployed within a single `hosted-tenants` namespace, using tenant ID prefixes and standard Kubernetes labels for resource identification and isolation.

### Custom Resource Definitions (CRDs)
- **NightscoutTenant CRD** (`nightscout.io/v1alpha1`): Unified tenant resource with a two-phase provisioning model (Gen5). Older CRDs like `StorageAccount` and `ComputeInstance` are part of Gen4 architecture.
- **Out-of-Band MongoDB Provisioning**: A provisioner microservice (`/accounts/...` endpoint) manages the shared MongoDB cluster and assigns connection URIs. These URIs are stored in tenant ConfigMaps and passed to Nightscout Pods.

### Controllers (Metacontroller)
The platform uses Metacontroller with both Gen4 (Composite and Decorator) and Gen5 (Decorator-Driven) architectures.

**Gen4 Controllers:**
- **Storage CompositeController**: Manages MongoDB StatefulSets, Services, and Migration Jobs.
- **Compute CompositeController**: Manages Nightscout Deployments, Services, and migration.
- **Storage-Credentials DecoratorController**: Manages per-tenant application credentials.
- **Storage-Initialization DecoratorController**: Manages durable state on mongo-auth Secrets.
- **PVC-Backup DecoratorController**: Enforces backup policies for MongoDB PVCs.

**Gen5 Controllers (Pod-Based Decorator-Driven Architecture):**
- **Tenant CompositeController**: Directly renders tenant Pods containing MongoDB and, after user initialization, Nightscout.
- **Shared Decorators**: `Mongo-Auth Init DecoratorController` and `App-Credentials Init DecoratorController` handle MongoDB and user initialization, stamping status annotations on Secrets.
- **Tenant Migration Decorator**: Orchestrates shared to dedicated MongoDB data migration by watching tenant ConfigMaps and rendering migration Jobs.

### Key Technologies
- **Orchestration**: Kubernetes, Metacontroller.
- **Messaging**: Strimzi Kafka for CDC.
- **Database**: MongoDB (per-tenant replica sets).
- **Webhook Implementation**: Node.js with Restify and `@kubernetes/client-node`.
- **Deployment**: Jsonnet for Kubernetes manifest generation.
- **Traffic Serving**: Resolver with Consul coordination.

### Feature Specifications
- **Kubernetes-Idiomatic Status**: Webhooks report status using standard Kubernetes conditions.
- **Child Preservation**: Protects external resources.
- **Automated Database Migration**: Secure and automated data migration system.
- **Comprehensive Labeling & Annotations**: Extensive metadata for operational needs.
- **Configurable Tenants**: Tenant configurations via ConfigMaps.
- **Cloud-Native Startup**: Single multi-mode container image.
- **Two-Interface Design**: Separate administration and resolver interfaces.

### System Design Choices
The platform uses Gen5 as the production architecture, with Gen3→Gen5 as the migration path. Gen4 (two-composite architecture) served as an educational implementation for learning Kubernetes and Metacontroller patterns.
- **Status Reporting**: CRD status includes phase, conditions, connectionSecret, and endpoints.
- **Provisioner API Facade**: A REST API (`POST /accounts/`) for external systems to create CRDs and mongo-auth Secrets.
- **Decorator-Based Blast Radius Protection**: `mongo-auth` Secrets persist on CRD deletion for fast recovery.
- **Resolver Interface**: Routes Nightscout traffic using Consul.
- **Pod Health Check Sidecar**: Lightweight sidecar replacing DNS-based health checks with IP-based validation, reducing cluster DNS workload. Performs simple Boolean memory match against localhost health endpoint.
- **Single Nightscout Secret Architecture**: Each tenant uses one `app-credentials` Secret.
- **URI-Based Authentication**: MongoDB utility Jobs use complete connection URIs.
- **Keyfile-Based Replica Authentication**: MongoDB replica sets use shared keyfile Secrets.
- **Shared MongoDB Configuration**: Single `mongod-config` ConfigMap.
- **MongoDB FQDN Consistency**: Canonical hostnames used for replica sets.
- **Decorator Response Pattern**: Decorators return minimal patches or `{ attachments: [] }` for no-op.
- **Clean Desired State Pattern**: Webhooks return clean desired state manifests without Kubernetes runtime metadata.
- **Migration Job Prerequisite Pattern**: Migration Jobs verify source and target credentials.
- **Migration Job Completion Tracking**: Hybrid approach using annotations and live Job status.
- **URI-Based Migration**: Migration Jobs use symmetric MongoDB URI format.
- **Production Migration Path**: Gen3→Gen5 migration uses shared→dedicated storage mode transition with annotation-gated migration Jobs.
- **Gen5 Pod-Based Architecture**: Uses direct Pod management for minimal control plane load, with Pod recovery effectively immediate.
- **Two-Phase Container Gating**: Tenant Pod initially renders with only MongoDB; Nightscout container is added after initialization.
- **Pod IP Connectivity for Jobs**: Initialization Jobs connect to MongoDB via Pod IP.
- **Empty Array Normalization**: Optional array fields are conditionally included only when non-empty to prevent drift detection.
- **Dual Pod Management Modes**: Gen5 supports `ReplicaSet Mode` (via `USE_REPLICASET=true`) and `Direct Pod Mode` (via `USE_REPLICASET=false`) for managing Pods.
- **`generateSelector=false` Pattern**: Prevents Metacontroller from injecting `controller-uid` labels, enabling idempotent Pod rendering with a spec-hash annotation.
- **Spec-Hash Change Detection**: The `ns.mdn.io/spec-hash` annotation triggers Pod recreation when significant inputs change.
- **`statusChecks` with Conditions**: Used for rolling updates to gate updates until each updated Pod is Ready.
- **Deep-Merge Pattern for K8s Defaults**: Preserves Kubernetes-added defaults in Pod/ReplicaSet children to prevent drift.
- **Pod Update Strategy: Recreate vs RollingRecreate**: Gen5 tenant composite uses `Recreate` strategy for single-Pod scenarios to avoid ControllerRevision complexities and race conditions.
- **Morphing Children Pattern**: Tenant composite children change based on lifecycle phase, requiring the `Recreate` strategy.
- **Shared vs Dedicated Storage Mode**: Gen5 supports `shared` (Nightscout-only Pod connecting to external MongoDB) and `dedicated` (co-located MongoDB + Nightscout Pod) modes, with migration between them handled by the migration decorator.
- **Consul Compatibility**: Both storage modes render `role: config-as-deploy` label for resolver/Consul registration.

## External Dependencies
- **Strimzi Kafka Operator**: Manages Kafka clusters and KafkaConnect.
- **Kafka Cluster**: Brokers, Zookeeper/KRaft, storage.
- **KafkaConnect Cluster**: Workers with MongoDB connector plugin.
- **MongoDB**: Primary database, deployed as per-tenant StatefulSets.
- **CSI Driver with Snapshot Support**: For creating VolumeSnapshots.
- **Metacontroller v4.x+**: Kubernetes add-on for custom controller development.
- **Consul**: Used for service discovery and health checking within the resolver interface.
- **jsonnet-bundler (jb)**: Dependency manager for Jsonnet libraries.