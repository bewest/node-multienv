# Nightscout Multi-Tenant Kubernetes Platform

## Overview
This project establishes a production-grade, multi-tenant Nightscout platform on Kubernetes. It orchestrates tenant deployments using Metacontroller, integrating MongoDB, Change Data Capture (CDC) via Strimzi Kafka, and automated backup solutions. The platform prioritizes scalability and isolation, with all tenants residing in a dedicated `hosted-tenants` namespace and utilizing tenant-prefixed resources. The architectural evolution through a "Facade Pattern" approach allowed for progressive migration and zero-downtime upgrades across five generations (Gen 1, Gen 2, Gen 3a, Gen 3b, Gen 4), culminating in a fully declarative, Kubernetes-native system capable of hosting an unlimited number of tenants.

**Current State:**
- **Gen 3b** is the current production implementation (Deployment controller with ConfigMap/pod watches) - 1300 sites
- **Gen 4** (Metacontroller-based two-composite architecture) is implemented with annotation-driven migration support

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
- **Gen 2**: REST API operates on ConfigMaps; demuxer/tenant-availability-keeper routes internal admin change requests across StatefulSet of runners (uses cluster's nginx config)
- **Gen 3a**: ConfigMap watch triggers demuxer/tenant-availability-keeper to propagate internal admin change requests to StatefulSet runners (uses cluster's nginx config)
- **Gen 3b**: Dispatcher watches ConfigMaps → deployment-controller creates per-tenant Deployments; deployment-operator watches pods. **Kept the watches, added another watch, made work more declarative** (runners, clusters, and demuxers scaled down)
- **Gen 4**: Metacontroller watches ConfigMaps, calls webhook (fully declarative)

### 2. Resolver Interface: Routing and Serving Nightscout Traffic
**Persistent pattern across ALL generations** - resolver proxies from external service port to correct NS instance backend via Consul + nginx coupling:
- **Gen 1**: Resolver routes to tenant processes; `master.js` manually updates Consul
- **Gen 2**: Resolver routes to StatefulSet runners; `master.js` manually updates Consul
- **Gen 3a**: Resolver routes to StatefulSet runners; `master.js` manually updates Consul
- **Gen 3b**: Resolver routes to per-tenant Deployments via Consul; deployment-operator watches pods and updates Consul automatically
- **Gen 4**: Resolver routes to per-tenant Deployments via Consul

**Critical Design Choice:** The resolver interface + Consul coordination ensures workload is performed by worker nodes that can be scaled horizontally, rather than the control plane. This architectural pattern persists across all generations for efficient, scalable traffic serving.

**Consul Update Evolution:** In Gen 1-3a, `master.js` manually updated Consul based on internal process state. Starting in Gen 3b, the deployment-operator watches pods and updates Consul automatically.

**Technical Implementation (redirector-server):**
The redirector-server looks up the desired tenant SRV record in Consul. This pairing is used to resolve all Nightscout traffic across all tenants and works in mixed deployment environments. It uses a header to communicate the endpoint to nginx for an efficient proxy that keeps the load on horizontally scalable worker nodes instead of the control plane. While the workload is DNS-heavy, Consul, DNS caching in Kubernetes, and colocating some containers to share unix sockets reduces throughput to negligible amounts. Consul registers health checks which cause Consul itself to perform DNS lookups to execute the DNS check, and the health check itself will also issue a DNS request during validation. Metacontroller also produces a greater volume of API traffic than a simple single-resource watch and API pairing.

### The Critical Insight: Why Gen 3b → Gen 4

When the **second watch** (pod watch) was added to the ConfigMap watch in Gen 3b, it became clear that managing resources would need to handle an **arbitrarily large number of resources** per tenant - not just a single Deployment, but 11-12 resources:
- MongoDB StatefulSet, Service, Secret
- Nightscout Deployment, Service
- Kafka Topic, Kafka Connector
- PVCs, PodDisruptionBudgets
- Migration Jobs, VolumeSnapshots

This forced a fundamental design change: from **a single inline async callback using the k8s API** to needing to **expressively declare the set of desired resources**. This requirement tipped the design toward Metacontroller's declarative webhook pattern, where the webhook returns a complete manifest of all desired child resources for each tenant.

## External Dependencies
- **Strimzi Kafka Operator**: Manages Kafka clusters and KafkaConnect for CDC.
- **MongoDB**: The primary database, deployed as per-tenant StatefulSets.
- **CSI Driver with Snapshot Support**: Essential for creating VolumeSnapshots for PVC backups.
- **Metacontroller**: A Kubernetes add-on used for custom controller development and orchestration.
- **Consul**: Utilized for service discovery and health checking within the resolver interface for traffic serving.

## Gen 4 Implementation Details

### Two-Composite Architecture (Canonical Implementation)
Gen 4 uses a **two-composite architecture** that separates storage concerns from compute concerns. This is the shipped implementation.

- **Storage Composite**: Secret → MongoDB StatefulSet + Service + Migration Jobs
  - Annotation-driven behavior via `ns.mdn.io/storage-type` (shared/dedicated)
  - Migration support via `ns.mdn.io/migration-needed` annotation
  - Renders migration Job when annotations present
  - Credentials isolated in Secrets (not visible to environs API)
  - Discovers tenant ConfigMaps for usage auditing/reporting
  
- **Compute Composite**: ConfigMap → Nightscout Deployment + Service + CDC resources
  - Discovers storage via `storage.nightscout.org/account` label
  - Treats shared storage as ready (no StatefulSet check)
  - Uses related resources for blast radius protection
  - No credential access (security boundary)

- **PVC Decorator**: Adds backup policy to MongoDB PVCs
  - Watches PVCs by `storage.nightscout.org/account` (not tenant ID)
  - Adds finalizers and creates VolumeSnapshots on deletion
  - Works for both shared (no PVCs) and dedicated (has PVCs) storage

**Label Strategy**:
- **Storage Account ID**: ObjectID (e.g., `507f1f77bcf86cd799439011`) - identifies storage resources
- **Tenant ID**: 8-char DNS ID (e.g., `demo1234`) - identifies compute instances
- **Cardinality**: Shared storage (1:N), Dedicated storage (1:1)
- **PVCs belong to storage accounts**, not specific tenants

**Alternative Considered (Not Shipped)**: A monolithic composite approach (ConfigMap → all resources) was explored but archived due to security concerns (credentials would be in ConfigMaps, visible to environs API). See `archive/monolithic-composite/README.md` for detailed rationale.

### Annotation-Driven Migration Pattern
- Migration is a **storage-layer concern** (not deployment lifecycle)
- Annotations on Secret trigger conditional resource rendering
- Storage controller checks annotations and renders migration Job
- Migration state tracked in Secret status
- Supports shared → dedicated MongoDB migration workflow

### Provisioner API Facade
The deployment controller (`k8s-deployment-controller.js`) provides **REST API entry points** for external provisioning systems, serving as a facade over the two-composite architecture:

**Account Provisioning**:
- `POST /accounts` - Create storage account (generates Secret with `ns.mdn.io/composite: storage`)
- `POST /accounts/:account` - Update storage account (idempotent)
- Accepts tier and storageType in request body
- Environment variables: `DEFAULT_STORAGE_TYPE` (shared/dedicated), `DEFAULT_TIER` (basic/premium/enterprise)

**Site Provisioning**:
- `POST /accounts/:account/sites/:name` - Create/update tenant site (generates ConfigMap with `ns.mdn.io/composite: compute`)
- Validates `internal_name` matches URL parameter `:name`
- Validates DNS compatibility (lowercase alphanumeric + hyphens, max 63 chars)
- Accepts full Nightscout configuration in request body
- Links ConfigMap to storage account via `storage.nightscout.org/account` label

**Metadata Manipulation** (for Gen 3b → Gen 4 migration):
- `POST /configmaps/:name/metadata/labels/:field` - Add composite label to existing ConfigMaps
- `POST /secrets/:name/metadata/annotations/:field` - Add migration annotations
- `DELETE /configmaps/:name/metadata/labels/:field` - Remove old labels

**Migration Workflow**:
1. Create storage account with migration annotations (old MongoDB URI)
2. Label existing Gen 3b ConfigMap with Gen 4 labels (`ns.mdn.io/composite: compute`)
3. ConfigMap names stay the same - only labels change (label cycling)
4. Metacontroller discovers labeled resources and orchestrates migration

### Migration Tooling

The canonical operational migration tool is **`tools/gen4-migration.sh`**, which leverages the REST API and Metacontroller infrastructure:

**Commands**:
- `migrate-tenant <name>` - Complete migration workflow (all steps automated)
- `create-storage <name>` - Create storage Secret via provisioner API
- `trigger-migration <name>` - Add migration annotations to trigger Job
- `validate-migration <name>` - Check migration completion status
- `label-configmap <name>` - Add Gen 4 labels to ConfigMap
- `rollback-tenant <name>` - Rollback to shared MongoDB if needed
- `batch-migrate <file>` - Migrate multiple tenants from file
- `list-pending` - List tenants needing migration
- `migration-progress` - Show overall migration status

**Philosophy**: Leverages provisioner API facade (`POST /accounts`) for Secret creation. Uses declarative triggers (labels/annotations) to orchestrate resources via webhooks rather than direct manipulation.

**Deprecated**: `cmd/migrate-to-two-composite.js` (archived) bypassed infrastructure and directly manipulated K8s resources. See `archive/monolithic-migration/README.md` for rationale.

See `docs/TWO-COMPOSITE-ARCHITECTURE.md` for complete REST API examples and migration workflows.

## Documentation
- **[Two-Composite Architecture](docs/TWO-COMPOSITE-ARCHITECTURE.md)** - Storage/compute separation, annotation-driven behavior, migration workflow
- **[Architecture Evolution](docs/ARCHITECTURE-EVOLUTION.md)** - Complete story of the 5 generations, facade pattern benefits, migration paths
- **[Component Relationships](docs/COMPONENT-RELATIONSHIPS.md)** - How components work together across generations
- **[Container Parameters](docs/CONTAINER-PARAMETERS.md)** - Comprehensive configuration parameters
