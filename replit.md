# Nightscout Multi-Tenant Kubernetes Platform

## Overview
This project delivers a production-grade, multi-tenant Nightscout platform orchestrated on Kubernetes. It utilizes Metacontroller for tenant deployment, integrating MongoDB, Change Data Capture (CDC) via Strimzi Kafka, and automated backup solutions. The platform is designed for scalability and isolation, with all tenants residing in a dedicated `hosted-tenants` namespace. Key capabilities include declarative resource management, automated database migration, and a robust system for serving Nightscout traffic across various tenant configurations. The architecture has evolved through multiple generations, culminating in a fully declarative, Kubernetes-native system capable of hosting an unlimited number of tenants.

## User Preferences
- Prefer Node.js/JavaScript for webhook implementation
- Use existing @kubernetes/client-node library
- Follow Metacontroller webhook protocol specifications
- Follow Kubernetes recommended labels, annotations, and status patterns
- Support tenant tiers via ConfigMap parameterization
- Implement child preservation to protect external resources

## System Architecture

### Multi-Tenant Design
All tenants are deployed within a single `hosted-tenants` namespace. Resources are uniquely identified and isolated using a tenant ID prefix and standard Kubernetes labels.

### Controllers (Metacontroller)
- **CompositeController (Tenant Orchestration)**: Manages tenant-specific resources (Nightscout deployments, MongoDB StatefulSets, Kafka topics, Kafka connectors) based on Kubernetes ConfigMaps.
- **DecoratorController (PVC Backup Policy)**: Enforces backup policies for MongoDB PVCs by injecting annotations, finalizers, and triggering VolumeSnapshot creation upon PVC deletion.

### Key Technologies
- **Orchestration**: Kubernetes, Metacontroller.
- **Messaging**: Strimzi Kafka for CDC.
- **Database**: MongoDB (per-tenant replica sets).
- **Webhook Implementation**: Node.js with Express and `@kubernetes/client-node`.
- **Traffic Serving**: Resolver + Consul coordination.

### Feature Specifications
- **Kubernetes-Idiomatic Status**: Webhooks report status using standard Kubernetes conditions.
- **Child Preservation**: Protects external resources from accidental deletion.
- **Automated Database Migration**: Secure, automated migration system with credential handling.
- **Comprehensive Labeling & Annotations**: Extensive metadata for audit, recovery, compliance, and filtering.
- **Configurable Tenants**: Tenant configurations via ConfigMaps allow for parameterized resource sizing and multi-tier offerings.
- **Facade Pattern**: The architecture evolved through multiple generations, maintaining a consistent "tenant configuration" abstraction for progressive migration and interface stability.
- **Cloud-Native Startup**: A single multi-mode container image allows running different architectural components from the same image.
- **Two-Interface Design**: Separate administration interface (managing configurations) and resolver interface (serving Nightscout traffic).

### System Design Choices
The platform employs a **two-composite architecture** (Storage and Compute) to separate concerns:
- **Storage Composite**: Manages MongoDB StatefulSets, Services, Secrets, and Migration Jobs, with annotation-driven behavior for storage type and migration.
- **Compute Composite**: Manages Nightscout Deployments, Services, and CDC resources, linking to storage via labels without direct credential access.
- **PVC Decorator**: Adds backup policies to MongoDB PVCs.
- **Annotation-Driven Migration**: A robust pattern for orchestrating migrations, particularly from shared to dedicated MongoDB instances.
- **Provisioner API Facade**: A REST API provides external systems with endpoints for account and site provisioning, abstracting the underlying two-composite architecture.
- **Resolver Interface**: Routes Nightscout traffic using Consul for service discovery, ensuring efficient and scalable traffic serving on worker nodes.

## External Dependencies
- **Strimzi Kafka Operator**: Manages Kafka clusters and KafkaConnect for CDC.
- **MongoDB**: Primary database, deployed as per-tenant StatefulSets.
- **CSI Driver with Snapshot Support**: Used for creating VolumeSnapshots for PVC backups.
- **Metacontroller**: Kubernetes add-on for custom controller development and orchestration.
- **Consul**: Utilized for service discovery and health checking within the resolver interface.