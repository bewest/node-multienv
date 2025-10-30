# Nightscout Multi-Tenant Kubernetes Platform

## Overview
This project delivers a production-grade, multi-tenant Nightscout platform orchestrated on Kubernetes. It utilizes Metacontroller for tenant deployment, integrating MongoDB, Change Data Capture (CDC) via Strimzi Kafka, and automated backup solutions. The platform is designed for scalability and isolation, with all tenants residing in a dedicated `hosted-tenants` namespace. Key capabilities include declarative resource management, automated database migration, and a robust system for serving Nightscout traffic across various tenant configurations. The architecture has evolved through multiple generations, culminating in a fully declarative, Kubernetes-native system capable of hosting an unlimited number of tenants.

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
All tenants are deployed within a single `hosted-tenants` namespace. Resources are uniquely identified and isolated using a tenant ID prefix and standard Kubernetes labels.

### Controllers (Metacontroller)
- **CompositeController (Tenant Orchestration)**: Manages tenant-specific resources (Nightscout deployments, MongoDB StatefulSets, Kafka topics, Kafka connectors) based on Kubernetes ConfigMaps.
- **DecoratorController (PVC Backup Policy)**: Enforces backup policies for MongoDB PVCs by injecting annotations, finalizers, and triggering VolumeSnapshot creation upon PVC deletion.

### Key Technologies
- **Orchestration**: Kubernetes, Metacontroller.
- **Messaging**: Strimzi Kafka for CDC.
- **Database**: MongoDB (per-tenant replica sets).
- **Webhook Implementation**: Node.js with Restify and `@kubernetes/client-node` (code in `lib/` directory).
- **Deployment**: Jsonnet library in `jsonnet/lib/`, installable via jsonnet-bundler.
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
- **Pod Health Check Sidecar**: Lightweight sidecar container injected into Nightscout pods to provide localhost-based health validation for Consul, eliminating DNS queries and API calls to central controllers. This design removes critical bottlenecks at scale and enables linear scaling to 10,000+ tenants.
- **Two-Secret Architecture**: Gen 4 implements credential separation for enhanced security:
  - **Storage Secret** (parent): Contains root/admin MongoDB credentials used only by webhook and orchestration Jobs (migration, user initialization). Never projected into application containers.
  - **App-Credentials Secret** (`<storage-account>-app-credentials`): Contains only the credentials Nightscout needs (MONGODB_URI, MONGO_DATABASE, connection details). Projected into Nightscout containers via `envFrom`. Generated automatically by the storage composite webhook.
  - **Security Benefits**: Principle of least privilege (apps never see root credentials), separation of concerns (orchestration vs application access), flexible RBAC (different permissions per Secret type).
  - **Database Naming**: Each dedicated MongoDB instance uses a short, deterministic database name (e.g., `ns-a3f7`) generated from the storage account hash, ensuring consistency across migration, initialization, and application access.

## Documentation

### Core Architecture
- **[Two-Composite Architecture](./docs/TWO-COMPOSITE-ARCHITECTURE.md)**: Storage and Compute separation, Gen 4 design, REST API provisioner
- **[Architecture Evolution](./docs/ARCHITECTURE-EVOLUTION.md)**: Historical progression through Gen 1-4
- **[Metacontroller Integration](./docs/METACONTROLLER-INTEGRATION.md)**: Webhook protocol, CompositeController and DecoratorController patterns
- **[Webhook Architecture](./docs/WEBHOOK-ARCHITECTURE.md)**: Node.js webhook implementation details

### Security & RBAC
- **[RBAC Design](./docs/RBAC-DESIGN.md)**: Permission breakdown, security rationale, blue/green deployment RBAC, troubleshooting

### Operations
- **[Quick Start](./docs/QUICK-START.md)**: Get up and running in 5 minutes
- **[Tanka Deployment](./docs/TANKA-DEPLOYMENT.md)**: Jsonnet/Tanka deployment patterns, blue/green, multi-component scaling
- **[Migration Playbook](./docs/MIGRATION-PLAYBOOK.md)**: Gen 3b → Gen 4 migration procedures
- **[Migration from Legacy](./docs/MIGRATION-FROM-LEGACY.md)**: Legacy system migration patterns
- **[Validation Checklist](./docs/VALIDATION-CHECKLIST.md)**: Pre-deployment validation steps

### Reference
- **[Labels and Annotations](./docs/LABELS-AND-ANNOTATIONS.md)**: Comprehensive label/annotation catalog
- **[Component Relationships](./docs/COMPONENT-RELATIONSHIPS.md)**: How system components interact
- **[Container Parameters](./docs/CONTAINER-PARAMETERS.md)**: Environment variables and configuration
- **[Pod Health Check](./docs/POD-HEALTHCHECK.md)**: Sidecar-based health validation for Consul, scaling improvements, multi-cluster support
- **[Testing Guide](./docs/testing-guide.md)**: Testing strategies and patterns

## Project Structure

```
.
├── jsonnet/                      # Jsonnet library (jb installable)
│   ├── lib/                     # Reusable Jsonnet modules
│   │   ├── main.libsonnet       # Entry point
│   │   ├── webhook.libsonnet    # Webhook deployments (plain K8s objects)
│   │   ├── metacontroller.libsonnet # Metacontroller CRDs
│   │   ├── rbac.libsonnet       # RBAC helpers (plain K8s objects)
│   │   ├── config.libsonnet     # Configuration templates
│   │   └── gen4.libsonnet       # Gen 4 deployment addon
│   ├── jsonnetfile.json         # Package metadata
│   ├── environments/default/
│   │   └── examples/            # Deployment pattern examples
│   └── README.md                # Library documentation
├── lib/                         # Node.js/JavaScript webhook server
│   ├── routes/                  # Express routes
│   ├── templates/               # K8s template generators
│   └── webhook/                 # Webhook handlers
├── cmd/webhook/                 # Webhook server entry point
├── docs/                        # Documentation
│   ├── TWO-COMPOSITE-ARCHITECTURE.md
│   ├── TANKA-DEPLOYMENT.md
│   ├── RBAC-DESIGN.md
│   └── ...
└── package.json                 # Node.js dependencies
```

## External Dependencies
- **Strimzi Kafka Operator**: Manages Kafka clusters and KafkaConnect for CDC.
- **MongoDB**: Primary database, deployed as per-tenant StatefulSets.
- **CSI Driver with Snapshot Support**: Used for creating VolumeSnapshots for PVC backups.
- **Metacontroller**: Kubernetes add-on for custom controller development and orchestration.
- **Consul**: Utilized for service discovery and health checking within the resolver interface.
- **jsonnet-bundler (jb)**: Dependency manager for Jsonnet libraries.