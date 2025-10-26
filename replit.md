# Nightscout Multi-Tenant Kubernetes Platform

## Overview
This project establishes a production-grade, multi-tenant Nightscout platform on Kubernetes. It orchestrates tenant deployments using Metacontroller, integrating MongoDB, Change Data Capture (CDC) via Strimzi Kafka, and automated backup solutions. The platform prioritizes scalability and isolation, with all tenants residing in a dedicated `hosted-tenants` namespace and utilizing tenant-prefixed resources. The architectural evolution through a "Facade Pattern" approach allowed for progressive migration and zero-downtime upgrades across four generations, culminating in a fully declarative, Kubernetes-native system capable of hosting an unlimited number of tenants.

## User Preferences
- Prefer Node.js/JavaScript for webhook implementation
- Use existing @kubernetes/client-node library
- Follow Metacontroller webhook protocol specifications
- Follow Kubernetes recommended labels, annotations, and status patterns
- Support tenant tiers via ConfigMap parameterization
- Implement child preservation to protect external resources

## System Architecture

### Multi-Tenant Design
All tenants are deployed within a single `hosted-tenants` namespace. Resources are uniquely identified and isolated using a tenant ID prefix (e.g., `demo-mongo`), and standard Kubernetes labels are uniformly applied.

### Controllers (Metacontroller)

#### CompositeController (Tenant Orchestration)
Manages tenant-specific resources (Nightscout deployments, MongoDB StatefulSets, Kafka topics, Kafka connectors) based on Kubernetes ConfigMaps labeled `ns.mdn.io/enabled: "true"`. Uses `/composite/sync` for resource rendering and `/composite/finalize` for cleanup.

#### DecoratorController (PVC Backup Policy)
Enforces backup policies for MongoDB PVCs by injecting annotations, finalizers, and triggering VolumeSnapshot creation upon PVC deletion. Uses `/decorator/sync` for injection and `/decorator/finalize` for snapshot creation.

### Key Technologies
- **Orchestration**: Kubernetes, Metacontroller.
- **Messaging**: Strimzi Kafka for CDC.
- **Database**: MongoDB (per-tenant replica sets).
- **Webhook Implementation**: Node.js with Express and `@kubernetes/client-node`.

### Project Structure
The project includes a `/cmd/webhook` directory for the Node.js webhook server, `/k8s/metactl` for Metacontroller manifests, and `/container-images/ns-utility` for a utility container housing database operations and health checks.

### Features & Design Choices
- **Kubernetes-Idiomatic Status**: Webhooks report status using standard Kubernetes conditions (e.g., `MongoDBReady`, `MigrationComplete`, `CDCReady`, `Ready`).
- **Child Preservation**: Ensures external resources managed by the webhook are not accidentally deleted.
- **Automated Database Migration**: Secure, automated migration system with credential handling and validation.
- **Comprehensive Labeling & Annotations**: Extensive metadata for audit, recovery, compliance, and filtering (e.g., `ns.mdn.io/created-at`, `ns.mdn.io/tenant-email`, `ns.mdn.io/backup-schedule`).
- **Configurable Tenants**: Tenant configurations via ConfigMaps allow for parameterized resource sizing (CPU, memory, storage), image versions, and support for multi-tier offerings. Each tenant generates 11-12 Kubernetes resources.
- **Facade Pattern**: The architecture evolved through four generations, maintaining a consistent "tenant configuration" abstraction while allowing the underlying implementation to change, enabling progressive migration and interface stability.
- **Cloud-Native Startup**: A single multi-mode container image (`start_container.sh`) allows running different architectural components from the same image, providing flexibility and aiding migration.

## External Dependencies

- **Strimzi Kafka Operator**: Manages Kafka clusters and KafkaConnect for CDC.
- **MongoDB**: Primary database, deployed as per-tenant StatefulSets.
- **CSI Driver with Snapshot Support**: Enables VolumeSnapshots for PVC backups.
- **Metacontroller**: A Kubernetes add-on facilitating custom controller development.