# Nightscout Multi-Tenant Kubernetes Platform

## Overview
This project establishes a production-grade, multi-tenant Nightscout platform on Kubernetes. It orchestrates tenant deployments using Metacontroller, integrating MongoDB, Change Data Capture (CDC) via Strimzi Kafka, and automated backup solutions. The platform prioritizes scalability and isolation, with all tenants residing in a dedicated `hosted-tenants` namespace and utilizing tenant-prefixed resources. The architectural evolution through a "Facade Pattern" approach allowed for progressive migration and zero-downtime upgrades across five generations (Gen 1, Gen 2, Gen 3a, Gen 3b, Gen 4), culminating in a fully declarative, Kubernetes-native system capable of hosting an unlimited number of tenants.

## User Preferences
- Prefer Node.js/JavaScript for webhook implementation
- Use existing @kubernetes/client-node library
- Follow Metacontroller webhook protocol specifications
- Follow Kubernetes recommended labels, annotations, and status patterns
- Support tenant tiers via ConfigMap parameterization
- Implement child preservation to protect external resources

## System Architecture

### Multi-Tenant Design
All tenants are deployed within a single `hosted-tenants` namespace, with resources uniquely identified and isolated using a tenant ID prefix and standard Kubernetes labels.

### Controllers (Metacontroller)
- **CompositeController (Tenant Orchestration)**: Manages tenant-specific resources (Nightscout deployments, MongoDB StatefulSets, Kafka topics, Kafka connectors) based on Kubernetes ConfigMaps.
- **DecoratorController (PVC Backup Policy)**: Enforces backup policies for MongoDB PVCs by injecting annotations, finalizers, and triggering VolumeSnapshot creation upon PVC deletion.

### Key Technologies
- **Orchestration**: Kubernetes, Metacontroller.
- **Messaging**: Strimzi Kafka for CDC.
- **Database**: MongoDB (per-tenant replica sets).
- **Webhook Implementation**: Node.js with Express and `@kubernetes/client-node`.
- **Traffic Serving**: Resolver + Consul coordination (persistent across all generations).

### Features & Design Choices
- **Kubernetes-Idiomatic Status**: Webhooks report status using standard Kubernetes conditions (`MongoDBReady`, `MigrationComplete`, `CDCReady`, `Ready`).
- **Child Preservation**: Protects external resources managed by the webhook from accidental deletion.
- **Automated Database Migration**: Secure, automated migration system with credential handling and validation.
- **Comprehensive Labeling & Annotations**: Extensive metadata for audit, recovery, compliance, and filtering.
- **Configurable Tenants**: Tenant configurations via ConfigMaps allow for parameterized resource sizing, image versions, and multi-tier offerings.
- **Facade Pattern**: The architecture evolved through five generations, maintaining a consistent "tenant configuration" abstraction while allowing the underlying implementation to change, enabling progressive migration and interface stability.
- **Cloud-Native Startup**: A single multi-mode container image (`start_container.sh`) allows running different architectural components from the same image.
- **Two-Interface Design**: Separate administration interface (managing configurations) and resolver interface (serving Nightscout traffic).

## Architectural Evolution: Two-Interface Design

The platform provides two distinct, independent interfaces that evolved across generations:

### 1. Administration Interface: Managing Tenant Configurations
- **Gen 1**: REST API (`/environs`) operates on `.env` files
- **Gen 2**: REST API operates on ConfigMaps; demuxer globally routes internal admin change requests across StatefulSet of runners
- **Gen 3a**: ConfigMap watch triggers demuxer to propagate ConfigMap changes to StatefulSet runners
- **Gen 3b**: Dispatcher watches ConfigMaps → deployment-controller creates per-tenant Deployments (demuxer and runners scaled down)
- **Gen 4**: Metacontroller watches ConfigMaps, calls webhook (fully declarative)

### 2. Resolver Interface: Routing and Serving Nightscout Traffic
**Persistent pattern across ALL generations** - resolver + Consul coordination:
- **Gen 1, Gen 2, Gen 3a**: `master.js` manually updates Consul based on internal process state
- **Gen 3a**: `tenant-availability-keeper.js` (demuxer) routes to StatefulSet members via Consul
- **Gen 3b**: Resolver routes to per-tenant Deployments via Consul; deployment-operator watches pods and updates Consul automatically
- **Gen 4**: Resolver routes to Deployments via Consul

**Critical Design Choice:** The resolver interface + Consul coordination ensures workload is performed by worker nodes that can be scaled horizontally, rather than the control plane. This architectural pattern persists across all generations for efficient, scalable traffic serving.

**Consul Update Evolution:** In Gen 1-3a, `master.js` manually updated Consul based on internal process state. Starting in Gen 3b, the deployment-operator watches pods and updates Consul automatically.

## External Dependencies
- **Strimzi Kafka Operator**: Manages Kafka clusters and KafkaConnect for CDC.
- **MongoDB**: The primary database, deployed as per-tenant StatefulSets.
- **CSI Driver with Snapshot Support**: Essential for creating VolumeSnapshots for PVC backups.
- **Metacontroller**: A Kubernetes add-on used for custom controller development and orchestration.
- **Consul**: Utilized for service discovery and health checking within the resolver interface for traffic serving.

## Documentation
- **[Architecture Evolution](docs/ARCHITECTURE-EVOLUTION.md)** - Complete story of the 5 generations, facade pattern benefits, migration paths
- **[Component Relationships](docs/COMPONENT-RELATIONSHIPS.md)** - How components work together across generations
- **[Container Parameters](docs/CONTAINER-PARAMETERS.md)** - Comprehensive configuration parameters
