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

## Architectural Evolution: The Facade Pattern Journey

This project represents a **textbook implementation of the Facade Pattern**, evolving through four distinct architectural generations. Each generation improved upon the previous while maintaining interface compatibility where possible, enabling the platform to progress from simple process-based hosting to fully declarative Kubernetes-native orchestration.

### The Generations

| Generation | Name | Implementation | Configuration | API | Status |
|------------|------|----------------|---------------|-----|--------|
| **Gen 1** | multienv | Process-based | `.env` files | REST | Legacy |
| **Gen 2** | Inspector | ConfigMap persistence | Kubernetes ConfigMaps | REST (compatible) | Legacy |
| **Gen 3a** | StatefulSet runners | ConfigMaps (streamed) | Demuxer load balancing | REST | Legacy |
| **Gen 3b** | Deployment Controller | ConfigMaps + Dispatcher | Deployment + operator | REST + Webhooks | Legacy |
| **Gen 4** | Metacontroller | Declarative webhooks | ConfigMaps (declarative) | Webhooks only | **Current** |

### Facade Pattern Benefits

By maintaining a consistent abstraction ("tenant configuration") across generations while evolving the underlying implementation, the platform achieved:

- **Progressive Migration**: Each generation could coexist, allowing gradual tenant migration
- **Interface Stability**: Generation 1's `/environs` API remained compatible through Generation 2
- **Component Reuse**: Utility containers and common scripts used across Gen 3 and Gen 4
- **Rollback Safety**: Issues in new generation allowed reversion to previous architecture
- **Zero Downtime Evolution**: Platform evolved from 50-tenant single-host to unlimited-scale Kubernetes without breaking existing tenants

### Generation Comparison

#### Generation 1: multienv (Process-Based)
**Files:** `server.js`, `master.js`  
**Configuration:** `.env` files in `WORKER_ENV` directory  
**Orchestration:** Node.js cluster module (one process per tenant)  
**Scaling:** Single host, ~50 tenants max  
**Use Case:** Development, small-scale production

#### Generation 2: Inspector (ConfigMap Persistence)
**Files:** `k8s-inspector.js`  
**Configuration:** Kubernetes ConfigMaps  
**Orchestration:** None (persistence layer only)  
**Scaling:** Kubernetes-native config, no workloads  
**Use Case:** Migration bridge, GitOps, testing K8s integration

#### Generation 3: Deployment Controller (Full Kubernetes)
**Files:** `k8s-deployment-controller.js`, `k8s-dispatcher.js`, `tenant-availability-keeper.js`  
**Configuration:** ConfigMaps trigger Deployments via dispatcher  
**Orchestration:** Custom controller + Consul service discovery  
**Scaling:** Multi-node, multi-cluster, high availability  
**Use Case:** Production K8s, service mesh, HA deployments

#### Generation 4: Metacontroller (Current)
**Files:** `cmd/webhook/server.js`, `handlers/composite-sync.js`, `handlers/decorator-sync.js`  
**Configuration:** ConfigMaps with label `ns.mdn.io/enabled: "true"`  
**Orchestration:** Metacontroller webhooks (fully declarative)  
**Scaling:** Kubernetes-native, GitOps friendly, unlimited scale  
**Use Case:** Production SaaS, declarative infrastructure, full automation

### Cloud-Native Startup: Multi-Mode Container

The project uses a **single container image** with multiple entry points via `start_container.sh`, enabling one image to run as any generation component:

```bash
# Generation 1
start_container.sh multienv         # Full stack (master + nginx + resolver)
start_container.sh runner           # Just process manager
start_container.sh resolver         # Just proxy/resolver

# Generation 2
start_container.sh inspector        # ConfigMap REST API

# Generation 3
start_container.sh dispatcher       # ConfigMap watcher
start_container.sh deployment-controller  # Deployment orchestration
start_container.sh demuxer          # Consul-based load balancer
start_container.sh deployment-operator    # Dispatcher for deployments

# Generation 4
# Uses separate webhook server (cmd/webhook/server.js)
```

This multi-mode design provides:
- **Flexibility**: Choose generation at deployment time, not build time
- **Testing**: Run multiple generations side-by-side
- **Migration**: Gradual evolution without image sprawl

## External Dependencies

- **Strimzi Kafka Operator**: Required for managing Kafka clusters and KafkaConnect instances, facilitating Change Data Capture (CDC).
- **MongoDB**: The primary database used by Nightscout instances, deployed as StatefulSets per tenant.
- **CSI Driver with Snapshot Support**: Essential for enabling VolumeSnapshots for PVC backups.
- **Metacontroller**: A Kubernetes add-on that makes it easy to write and deploy custom controllers.

## Documentation

### API Specifications (OpenAPI 3.0)
- **[Generation 1: multienv](docs/openapi-gen1-multienv.yaml)** - Process-based multi-tenancy REST API
- **[Generation 2: Inspector](docs/openapi-gen2-inspector.yaml)** - ConfigMap persistence REST API
- **[Generation 3: Deployment Controller](docs/openapi-gen3-deployment.yaml)** - Full Kubernetes orchestration REST API + webhooks
- **[Generation 4: Metacontroller](docs/openapi-gen4-metacontroller.yaml)** - Declarative webhook protocol

### Architecture Documentation
- **[Architecture Evolution](docs/ARCHITECTURE-EVOLUTION.md)** - Complete story of the 4 generations, facade pattern benefits, migration paths
- **[Cloud-Native Startup](docs/CLOUD-NATIVE-STARTUP.md)** - Multi-mode container architecture, entry points, deployment examples
- **[Component Relationships (Gen 3)](docs/COMPONENT-RELATIONSHIPS.md)** - How dispatcher, demuxer, Consul, and deployment-controller work together
- **[Container Parameters](docs/CONTAINER-PARAMETERS.md)** - Comprehensive list of all configuration parameters
- **[Container Parameterization Summary](docs/CONTAINER-PARAMETERIZATION-SUMMARY.md)** - Summary of 9 new container configuration parameters

### Container & Migration
- **[Utility Container Summary](UTILITY-CONTAINER-SUMMARY.md)** - ns-utility container architecture and migration system
- **[Migration Documentation](docs/DATABASE-MIGRATION.md)** - Database migration system architecture

## Key Design Decisions

### 1. Facade Pattern Implementation
Each generation maintained the core abstraction ("tenant configuration") while evolving the implementation:
- **Gen 1 → Gen 2**: `.env` files → ConfigMaps (same REST API)
- **Gen 2 → Gen 3**: ConfigMaps remain, add orchestration layer
- **Gen 3 → Gen 4**: ConfigMaps remain, replace custom controller with Metacontroller

### 2. Progressive Refinement
Rather than "big bang" rewrites, each generation built incrementally:
- Gen 1: Prove the concept (process-based)
- Gen 2: Kubernetes-native persistence (bridge generation)
- Gen 3: Production orchestration (custom controller)
- Gen 4: Industry-standard patterns (Metacontroller)

### 3. Component Extraction
Common functionality extracted to reusable components:
- **ns-utility container**: Database initialization, migration, health checks
- **start_container.sh**: Multi-mode entrypoint for all generations
- **Template libraries**: Reusable Kubernetes manifest generators

### 4. Status-Driven Design (Gen 4)
Kubernetes-idiomatic status conditions provide clear tenant state:
- `MongoDBReady`: MongoDB StatefulSet operational
- `MigrationComplete`: Database migration finished
- `CDCReady`: Kafka connector running
- `Ready`: Overall tenant health

## Migration Paths

### From Generation 1 to Generation 2
1. Convert `.env` files to ConfigMaps
2. Deploy inspector service
3. Test API compatibility
4. Cutover traffic to inspector

### From Generation 2 to Generation 3
1. Deploy dispatcher (watches ConfigMaps)
2. Deploy deployment-controller
3. Deploy Consul (optional, for multi-cluster)
4. Deploy demuxer (for load balancing)
5. ConfigMaps automatically trigger Deployments

### From Generation 3 to Generation 4
1. Install Metacontroller
2. Deploy webhook server
3. Create CompositeController and DecoratorController CRDs
4. Add `ns.mdn.io/enabled: "true"` label to ConfigMaps
5. Decomission dispatcher and deployment-controller

## Container Configuration

The platform supports extensive parameterization via ConfigMaps, enabling tenant tiers (basic, premium) and flexible resource allocation:

- **Image Configuration**: MongoDB image, Nightscout image, utility image versions
- **Resource Sizing**: CPU, memory, storage per tenant
- **Replication**: MongoDB replica count, Nightscout replica count
- **Features**: CDC enabled, migration enabled, backup policies
- **Image Pull**: Private registry support, pull secrets, pull policies
- **Container Resources**: Utility container CPU/memory configuration

See [CONTAINER-PARAMETERS.md](docs/CONTAINER-PARAMETERS.md) for complete list of 60+ parameters.

## Current Status (Generation 4)

The platform currently operates using **Generation 4 (Metacontroller)** architecture with:

✅ Fully declarative tenant provisioning  
✅ Kubernetes-native control loops  
✅ Automatic reconciliation and healing  
✅ GitOps ready (ConfigMaps in Git)  
✅ Standard status conditions  
✅ PVC backup automation via decorator  
✅ Comprehensive audit trail  
✅ Multi-tier tenant support  

**Deployment Model:** ConfigMaps with label `ns.mdn.io/enabled: "true"` trigger webhook-based orchestration, creating 11-12 Kubernetes resources per tenant automatically.

## Contributing

When contributing to this project, please:
- Understand the architectural evolution (read [ARCHITECTURE-EVOLUTION.md](docs/ARCHITECTURE-EVOLUTION.md))
- Follow Kubernetes best practices for labels, annotations, and status
- Maintain backward compatibility in ConfigMap schemas
- Document new parameters in [CONTAINER-PARAMETERS.md](docs/CONTAINER-PARAMETERS.md)
- Use standard Kubernetes conditions for status updates
- Test migrations between generations before proposing changes
