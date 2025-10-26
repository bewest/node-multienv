# Nightscout Multi-Tenant Kubernetes Platform

## Overview
This project delivers a production-grade, multi-tenant Nightscout platform built on Kubernetes. It utilizes Metacontroller for orchestrating tenant deployments, integrating MongoDB, Change Data Capture (CDC) via Strimzi Kafka, and automated backup solutions. The platform is designed for high scalability and strong tenant isolation, with all tenants residing in a dedicated `hosted-tenants` namespace using tenant-prefixed resources. The architecture evolved through a "Facade Pattern" across five generations, culminating in a fully declarative, Kubernetes-native system capable of hosting a large number of tenants with zero-downtime upgrades and progressive migration.

## User Preferences
- Prefer Node.js/JavaScript for webhook implementation
- Use existing @kubernetes/client-node library
- Follow Metacontroller webhook protocol specifications
- Follow Kubernetes recommended labels, annotations, and status patterns
- Support tenant tiers via ConfigMap parameterization
- Implement child preservation to protect external resources

## System Architecture
The platform is built around a multi-tenant design, deploying all tenants within a single `hosted-tenants` namespace. Resources are uniquely identified and isolated using a tenant ID prefix and standard Kubernetes labels.

### Core Components
- **Controllers**: Metacontroller is central to orchestration.
    - **CompositeController**: Manages tenant-specific resources (Nightscout deployments, MongoDB StatefulSets, Kafka topics, Kafka connectors) based on Kubernetes ConfigMaps.
    - **DecoratorController**: Enforces backup policies for MongoDB PVCs, injecting annotations, finalizers, and triggering VolumeSnapshot creation.
- **Key Technologies**:
    - **Orchestration**: Kubernetes, Metacontroller.
    - **Messaging**: Strimzi Kafka for CDC.
    - **Database**: MongoDB (per-tenant replica sets).
    - **Webhook Implementation**: Node.js with Express and `@kubernetes/client-node`.
    - **Traffic Serving**: Resolver + Consul coordination for persistent traffic management across all architectural generations.
- **UI/UX Decisions**: Not directly applicable as this is a backend platform, but Kubernetes-idiomatic status conditions (e.g., `MongoDBReady`, `MigrationComplete`, `CDCReady`, `Ready`) provide clear state for operators.
- **Design Choices & Features**:
    - **Child Preservation**: Protects external resources managed by the webhook from accidental deletion.
    - **Automated Database Migration**: Secure, automated system with credential handling and validation.
    - **Comprehensive Labeling & Annotations**: Extensive metadata for audit, recovery, compliance, and filtering.
    - **Configurable Tenants**: ConfigMaps enable parameterized resource sizing, image versions, and multi-tier offerings. Each tenant generates 11-12 Kubernetes resources.
    - **Facade Pattern**: The architecture's evolution across five generations maintains a consistent "tenant configuration" abstraction, allowing underlying implementations to change for progressive migration and zero-downtime evolution.
    - **Cloud-Native Startup**: A single multi-mode container image (`start_container.sh`) allows running different architectural components from the same image, providing flexibility.
    - **Two-Interface Design**: Separate administration interface (managing configurations) and resolver interface (serving Nightscout traffic), ensuring independent scalability and evolution.

## External Dependencies
- **Strimzi Kafka Operator**: Manages Kafka clusters and Kafka Connect for Change Data Capture (CDC).
- **MongoDB**: The primary database, deployed as per-tenant StatefulSets.
- **CSI Driver with Snapshot Support**: Required for VolumeSnapshot creation to facilitate PVC backups.
- **Metacontroller**: A Kubernetes add-on used for custom controller development and tenant orchestration.
- **Consul**: Utilized for service discovery and health checking within the resolver interface for traffic serving.