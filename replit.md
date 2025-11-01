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