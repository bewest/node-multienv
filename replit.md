# Nightscout Multi-Tenant Kubernetes Platform

## Overview
This project delivers a production-ready, multi-tenant Nightscout platform orchestrated on Kubernetes. It leverages Metacontroller to manage tenant deployments, featuring integrated MongoDB, Change Data Capture (CDC) via Strimzi Kafka, and automated backup handling. The platform is designed for scalability and isolation, with all tenants operating within a dedicated `hosted-tenants` namespace and utilizing tenant-prefixed resources.

## User Preferences
- Prefer Node.js/JavaScript for webhook implementation
- Use existing @kubernetes/client-node library
- Follow Metacontroller webhook protocol specifications
- Follow Kubernetes recommended labels, annotations, and status patterns
- Support tenant tiers via ConfigMap parameterization
- Implement child preservation to protect external resources

## System Architecture

### Multi-Tenant Design
All tenants run within a single `hosted-tenants` namespace. Resource naming adheres to a tenant ID prefix (e.g., `demo-mongo`), ensuring isolation. Standard Kubernetes labels are consistently applied across all resources.

### Controllers (Metacontroller)

#### 1. CompositeController (Tenant Orchestration)
- **Parent Resource**: Kubernetes ConfigMap with label `ns.mdn.io/enabled: "true"`.
- **Manages**: Nightscout deployments, MongoDB StatefulSets, Kafka topics, and Kafka connectors for each tenant.
- **Webhook Endpoints**: `/composite/sync` for rendering resources and `/composite/finalize` for cleanup.

#### 2. DecoratorController (PVC Backup Policy)
- **Target**: PVCs associated with tenant MongoDB storage.
- **Purpose**: Enforces backup policies by injecting annotations and finalizers, and triggers VolumeSnapshot creation upon PVC deletion.
- **Webhook Endpoints**: `/decorator/sync` for annotation/finalizer injection and `/decorator/finalize` for snapshot creation.

### Key Technologies
- **Orchestration**: Kubernetes, Metacontroller.
- **Messaging**: Strimzi Kafka for CDC.
- **Database**: MongoDB (per-tenant replica sets).
- **Webhook Implementation**: Node.js with Express, using `@kubernetes/client-node`.

### Project Structure
The project is structured with a `/cmd/webhook` directory for the Node.js webhook server, `/k8s/metactl` for Metacontroller manifests, and `/container-images/ns-utility` for a utility container housing common scripts for database operations and health checks.

### Features & Design Choices
- **Kubernetes-Idiomatic Status**: Webhooks use standard Kubernetes conditions (e.g., `MongoDBReady`, `MigrationComplete`, `CDCReady`, `Ready`).
- **Child Preservation**: Metacontroller practice to echo back unmanaged children, preventing accidental deletion of external resources.
- **Automated Database Migration**: Production-ready system with automatic completion tracking, secure credential handling, and configuration validation.
- **Comprehensive Labeling & Annotations**: All resources include standard Kubernetes labels and extensive audit annotations for data recovery, compliance, and filtering (e.g., `ns.mdn.io/created-at`, `ns.mdn.io/tenant-email`, `ns.mdn.io/backup-schedule`).
- **Configurable Tenants**: Tenants are configured via ConfigMaps, allowing for parameterized resource sizing (CPU, memory, storage) and Nightscout/MongoDB image versions, enabling "basic" and "premium" tiers.
- **Dynamic Resource Generation**: Each tenant can result in 11-12 Kubernetes resources including Secrets, Services, StatefulSets, Deployments, PodDisruptionBudgets, KafkaTopics, KafkaConnectors, and Jobs.

## External Dependencies

- **Strimzi Kafka Operator**: Required for managing Kafka clusters and KafkaConnect instances, facilitating Change Data Capture (CDC).
- **MongoDB**: The primary database used by Nightscout instances, deployed as StatefulSets per tenant.
- **CSI Driver with Snapshot Support**: Essential for enabling VolumeSnapshots for PVC backups.
- **Metacontroller**: A Kubernetes add-on that makes it easy to write and deploy custom controllers.