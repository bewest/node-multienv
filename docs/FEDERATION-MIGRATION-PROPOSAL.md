# Federation-Based Cloud Migration Proposal

## Status: Draft Proposal

**Date:** 2026-01-12  
**Authors:** Nightscout Platform Team  
**Target:** Gen 3b → Gen 5 Migration to GKE  
**Related Docs:** [EPHEMERAL-STORAGE-PROPOSAL.md](EPHEMERAL-STORAGE-PROPOSAL.md), [ARCHITECTURE-EVOLUTION.md](ARCHITECTURE-EVOLUTION.md), [MIGRATION-PLAYBOOK.md](MIGRATION-PLAYBOOK.md)

---

## Executive Summary

This proposal describes a **federation-based migration strategy** to move the Nightscout platform from Digital Ocean Kubernetes (DOKS) to Google Kubernetes Engine (GKE). This migration involves a **storage paradigm shift**: Gen3b tenants currently connect to a central shared MongoDB cluster running on DigitalOcean droplets (accessed via private IPs), while Gen5 on GKE uses per-tenant dedicated MongoDB instances backed by PVCs.

### Storage Architecture Transition

| Aspect | Source (DOKS Gen3b) | Destination (GKE Gen5) |
|--------|---------------------|------------------------|
| **MongoDB Location** | Central shared cluster on droplets | Per-tenant container in pod |
| **Storage Type** | External (private IP network) | PVC per tenant |
| **Data Isolation** | Database-level (shared cluster) | Infrastructure-level (dedicated pod) |
| **Scalability** | Limited by shared cluster | Limited by PVC count (128/node) |

### Key Benefits

| Benefit | Description |
|---------|-------------|
| **Adopt PVC Model** | Move to per-tenant dedicated storage with full isolation |
| **Zero Data Loss** | Migration via mongodump/mongorestore preserves all data |
| **No CDC Infrastructure** | Avoid Kafka/Strimzi/Debezium complexity |
| **18x Volume Capacity** | 128 volumes/node on GKE vs 7 on DOKS |
| **Gradual Migration** | Run both clusters in parallel during transition |
| **Rollback Capability** | Source data remains intact until validated |

### Trade-offs vs Ephemeral Storage

| Aspect | Federation Migration | Ephemeral Storage |
|--------|---------------------|-------------------|
| **Tenant Density** | 128/node (GKE limit) | Unlimited (no PVC) |
| **Data Durability** | Full (PVC-based) | 1-2 min loss window |
| **Infrastructure** | Consul WAN + migration jobs | Kafka + Strimzi + CDC |
| **Custom Code** | ~50 lines (migration scripts) | ~300 lines (hydration + export) |
| **Provider Lock-in** | GKE-dependent | Provider-agnostic |
| **Operational Complexity** | Lower (proven patterns) | Higher (CDC pipeline) |

### Migration Approach Summary

The migration is a **pure data migration**, not a PVC copy:

1. **Create Gen5 tenant on GKE** - Provisions new pod with dedicated MongoDB + fresh PVC
2. **Run migration job on DOKS** - mongodump from shared MongoDB, mongorestore to GKE pod via Consul WAN DNS
3. **Verify and cutover** - Validate document counts, update DNS, deregister from DOKS

No source PVCs exist to migrate - the shared MongoDB on droplets is accessed via private IP only.

### Recommendation

For the current scale and growth projections, **federation migration to GKE is recommended** over ephemeral storage. The 128 volume limit aligns well with the default 110 pod/node limit, enabling optimal tenant density without requiring limit overrides. Beyond immediate capacity gains, this migration proves multi-cluster federation patterns that can be reused for future capacity expansion across additional clusters—without requiring another migration.

**When to reconsider ephemeral storage:**
- If tenant count exceeds 10,000+ (approaching GKE limits at scale)
- If multi-cloud redundancy becomes a requirement
- If GKE pricing becomes unfavorable

---

## Problem Statement

### Current Cloud Volume Limits

The existing hosting provider imposes strict limits on block volumes per node:

| Provider | Volume Limit Per Node | Default Pod Limit | Density Match |
|----------|----------------------|-------------------|---------------|
| **Current (DOKS)** | 7 volumes | 110 pods/node | Poor (7 << 110) |
| Azure (Managed Disks) | ~64 volumes | 110 pods/node | Moderate |
| **GKE (Persistent Disk)** | 128 volumes | 110 pods/node | Excellent (128 ≈ 110) |
| AWS EBS | ~28 volumes | 110 pods/node | Poor |

### Density Analysis

Based on production experience with Gen3b (shared MongoDB model):

```
Node Spec:           16GB RAM nodes
Comfortable Density: ~100 tenants/node at 80% RAM utilization
Default Pod Limit:   110 pods/node (Kubernetes default)
```

**DOKS Volume Constraint:**
```
Volume Limit:        7 volumes/node
Effective Density:   7 tenants/node (volume-bound, not RAM-bound)
Utilization:         ~7% of available RAM capacity
Waste Factor:        ~14x (could host 100 tenants, limited to 7)
```

**GKE Density Alignment:**
```
Volume Limit:        128 volumes/node
Pod Limit:           110 pods/node (default, no override needed)
Effective Density:   ~100 tenants/node (RAM-bound, as designed)
Utilization:         80% RAM at comfortable density
```

The 128 volume limit on GKE is a sweet spot—it exceeds the default 110 pod limit, meaning tenant density is determined by resource utilization (RAM, CPU) rather than artificial volume constraints.

### Strategic Value: Proven Federation

Beyond immediate density improvements, this migration establishes **production-proven multi-cluster federation patterns**:

- Consul WAN federation for cross-cluster service discovery
- Cross-cluster migration jobs via decorator controllers
- DNS-based traffic management between clusters

Once proven, these patterns can be reused to **expand capacity by adding clusters** rather than migrating again. Future growth can be addressed by federating additional GKE clusters (or other providers) using the same infrastructure.

---

## Federation Architecture Overview

### Cluster Topology

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           FEDERATION CONTROL PLANE                           │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                      HOST CLUSTER (GKE)                                │  │
│  │                                                                        │  │
│  │   ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐  │  │
│  │   │   KubeFed       │    │   Federation    │    │   Velero        │  │  │
│  │   │   Controller    │───►│   Resources     │◄───│   Controller    │  │  │
│  │   │   Manager       │    │   (CRDs)        │    │   (Backup)      │  │  │
│  │   └─────────────────┘    └─────────────────┘    └─────────────────┘  │  │
│  │           │                       │                      │            │  │
│  └───────────┼───────────────────────┼──────────────────────┼────────────┘  │
│              │                       │                      │               │
└──────────────┼───────────────────────┼──────────────────────┼───────────────┘
               │                       │                      │
               ▼                       ▼                      ▼
┌──────────────────────────┐  ┌──────────────────────────┐
│   SOURCE CLUSTER (DOKS)  │  │   TARGET CLUSTER (GKE)   │
│   (Member Cluster)       │  │   (Member Cluster)       │
│                          │  │                          │
│  ┌────────────────────┐  │  │  ┌────────────────────┐  │
│  │   Gen 3b Pods      │  │  │  │   Gen 5 Pods       │  │
│  │   - Nightscout     │  │  │  │   - MongoDB + NS   │  │
│  │   - No PVC (shared │  │  │  │   - PVC Storage    │  │
│  │     MongoDB)       │  │  │  │   - Consul Agent   │  │
│  └────────────────────┘  │  │  └────────────────────┘  │
│                          │  │                          │
│  ┌────────────────────┐  │  │  ┌────────────────────┐  │
│  │   Metacontroller   │  │  │  │   Metacontroller   │  │
│  │   (Tenant CRD)     │  │  │  │   (Tenant CRD)     │  │
│  └────────────────────┘  │  │  └────────────────────┘  │
│                          │  │                          │
│  Volume Limit: 7/node    │  │  Volume Limit: 128/node  │
│  Status: Draining        │  │  Status: Active          │
│                          │  │                          │
└──────────────────────────┘  └──────────────────────────┘
```

### Federation Components

| Component | Purpose | Location |
|-----------|---------|----------|
| **KubeFed Controller** | Manages federated resources across clusters | Host Cluster (GKE) |
| **Migration Decorator** | Renders mongodump/mongorestore Jobs | DOKS (source) |
| **Consul WAN Federation** | Cross-cluster service discovery for migration targets | Both Clusters |
| **ExternalDNS** | DNS-based traffic management | Both Clusters |
| **Metacontroller** | Tenant CRD management | Both Clusters |
| **Velero** | Post-migration backup for GKE PVCs (not used for migration) | GKE only |

### High-Level Migration Flow

```
Phase 1: Setup
─────────────────────────────────────────────────────────────
  1. Provision GKE cluster with federation-ready configuration
  2. Install KubeFed control plane on GKE (host cluster)
  3. Register both DOKS and GKE as member clusters
  4. Configure Consul WAN federation between datacenters
  5. Deploy migration decorator on DOKS for cross-cluster jobs
  6. Optionally deploy Velero on GKE for post-migration backups

Phase 2: Parallel Operation
─────────────────────────────────────────────────────────────
  1. Deploy Gen 5 infrastructure to GKE
  2. New tenants provision directly on GKE (with fresh PVCs)
  3. Existing tenants continue on DOKS (gen3b, shared MongoDB)
  4. Validate GKE operations with new tenant load

Phase 3: Tenant Migration (Data Migration, NOT PVC Copy)
─────────────────────────────────────────────────────────────
  1. Select tenant batch for migration
  2. Create Gen5 tenant on GKE (provisions fresh PVC + MongoDB pod)
  3. Run migration job on DOKS: mongodump from shared DB → mongorestore to GKE
  4. Verify document counts match
  5. Update DNS/Consul to point to GKE pod
  6. Repeat for all tenants in batches

Phase 4: Decommission
─────────────────────────────────────────────────────────────
  1. Verify all tenants on GKE (7-day validation period)
  2. Remove DOKS cluster from federation
  3. Decommission shared MongoDB cluster on droplets
  4. Terminate DOKS infrastructure
```

---

## Federation Requirements

### Prerequisites

#### Cluster Requirements

| Requirement | DOKS (Source) | GKE (Target) | Notes |
|-------------|--------------|--------------|-------|
| Kubernetes Version | 1.28+ | 1.28+ | Must be compatible |
| Container Runtime | containerd | containerd | Standard for both |
| CNI | Cilium/DOKS CNI | GKE VPC-native | Different CNIs OK |
| Storage Class | N/A (shared MongoDB) | pd-balanced | Fresh PVCs created on GKE |
| Load Balancer | DO Load Balancer | GKE L7 ILB | Different implementations |

#### Networking Requirements

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CROSS-CLUSTER NETWORKING                              │
│                                                                              │
│  DOKS VPC (10.0.0.0/16)                   GCP VPC (10.1.0.0/16)            │
│  ┌─────────────────────┐                  ┌─────────────────────┐           │
│  │ Pod CIDR:           │                  │ Pod CIDR:           │           │
│  │ 10.0.0.0/16         │◄────VPN/────────►│ 10.1.0.0/16         │           │
│  │                     │   Interconnect   │                     │           │
│  │ Service CIDR:       │                  │ Service CIDR:       │           │
│  │ 172.20.0.0/16       │                  │ 172.21.0.0/16       │           │
│  └─────────────────────┘                  └─────────────────────┘           │
│                                                                              │
│  Required Connectivity:                                                      │
│  • Kubernetes API (6443) - Federation control plane                         │
│  • Consul WAN (8302/tcp+udp) - Service mesh federation                     │
│  • MongoDB (27017) - Migration jobs from DOKS to GKE pods (via Consul WAN) │
│  • Pod-to-Pod (optional) - Only if using VPN for direct migration          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Networking Options:**

| Option | Latency | Cost | Complexity | Recommendation |
|--------|---------|------|------------|----------------|
| **Cloud VPN** | 50-100ms | Low | Low | Development/Staging |
| **Dedicated Interconnect** | 5-10ms | High | Medium | Production |
| **Public Internet + mTLS** | Variable | Lowest | Medium | Budget option |

**Recommendation:** Use Cloud VPN for initial migration, upgrade to Dedicated Interconnect if latency issues arise.

#### Legacy Shared MongoDB Network Topology

The existing Gen3b architecture uses a **shared central MongoDB cluster** running on private IPs within the DigitalOcean datacenter. This has critical implications for migration job placement:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    LEGACY MONGODB NETWORK TOPOLOGY                           │
│                                                                              │
│  DigitalOcean Datacenter (Private Network: 10.0.0.0/16)                     │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                                                                          ││
│  │  ┌──────────────────────┐         ┌──────────────────────────────────┐  ││
│  │  │  Legacy Shared       │         │  DOKS Cluster                    │  ││
│  │  │  MongoDB Cluster     │◄───────►│                                  │  ││
│  │  │                      │ Private │  ┌────────────┐ ┌────────────┐   │  ││
│  │  │  • 10.0.50.10:27017  │   IPs   │  │ Gen3b Pod  │ │ Gen3b Pod  │   │  ││
│  │  │  • 10.0.50.11:27017  │         │  │ tenant-a   │ │ tenant-b   │   │  ││
│  │  │  • 10.0.50.12:27017  │         │  └────────────┘ └────────────┘   │  ││
│  │  │                      │         │                                  │  ││
│  │  │  (Replica Set)       │         │  ┌────────────────────────────┐  │  ││
│  │  └──────────────────────┘         │  │ Migration Job              │  │  ││
│  │           ▲                       │  │ (MUST run here)            │  │  ││
│  │           │ ✓ Accessible          │  │ • Can reach legacy MongoDB │  │  ││
│  │           │                       │  │ • Reaches GKE via VPN/     │  │  ││
│  │           │                       │  │   Consul WAN               │  │  ││
│  │           │                       │  └────────────────────────────┘  │  ││
│  │           │                       └──────────────────────────────────┘  ││
│  │           │                                                              ││
│  └───────────┼──────────────────────────────────────────────────────────────┘│
│              │                                                               │
│              │ ✗ NOT Accessible (Private IPs only routable within DO)       │
│              │                                                               │
│  ┌───────────┼──────────────────────────────────────────────────────────────┐│
│  │           ▼                                                              ││
│  │  Google Cloud VPC (10.1.0.0/16)                                         ││
│  │  ┌──────────────────────────────────────────────────────────────────┐   ││
│  │  │  GKE Cluster                                                      │   ││
│  │  │                                                                   │   ││
│  │  │  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐      │   ││
│  │  │  │ Gen5 Pod       │  │ Gen5 Pod       │  │ Gen5 Pod       │      │   ││
│  │  │  │ tenant-a       │  │ tenant-b       │  │ tenant-c (new) │      │   ││
│  │  │  │ (MongoDB +     │  │ (MongoDB +     │  │ (MongoDB +     │      │   ││
│  │  │  │  Nightscout)   │  │  Nightscout)   │  │  Nightscout)   │      │   ││
│  │  │  └───────▲────────┘  └────────────────┘  └────────────────┘      │   ││
│  │  │          │                                                        │   ││
│  │  │          │ mongorestore target                                    │   ││
│  │  │          │ (via VPN or Consul WAN)                                │   ││
│  │  └──────────┼────────────────────────────────────────────────────────┘   ││
│  └─────────────┼────────────────────────────────────────────────────────────┘│
│                │                                                              │
└────────────────┼──────────────────────────────────────────────────────────────┘
                 │
    Migration data flow: DOKS Job → mongodump (legacy) → mongorestore (GKE pod)
```

**Key Constraints:**
- Legacy shared MongoDB runs on **private IPs** (10.0.50.x) within DigitalOcean
- These IPs are **NOT routable** from Google Cloud
- Migration jobs **MUST run in DOKS** to access the legacy database
- GKE pods are reachable from DOKS via VPN or Consul WAN federation

#### Permissions Requirements

**DOKS API Token (Source Cluster):**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "eks:DescribeCluster",
        "eks:ListClusters",
        "ec2:DescribeVolumes",
        "ec2:CreateSnapshot",
        "ec2:DeleteSnapshot",
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject"
      ],
      "Resource": "*"
    }
  ]
}
```

**GCP IAM (Target Cluster):**
```yaml
roles:
  - roles/container.admin           # GKE cluster management
  - roles/compute.storageAdmin      # Persistent disk management
  - roles/storage.objectAdmin       # GCS backup bucket access
  - roles/iam.serviceAccountUser    # Workload identity
```

### KubeFed Installation

#### Install KubeFed on Host Cluster (GKE)

```bash
# Add Helm repository
helm repo add kubefed-charts https://raw.githubusercontent.com/kubernetes-sigs/kubefed/master/charts
helm repo update

# Create namespace
kubectl create namespace kube-federation-system

# Install KubeFed
helm install kubefed kubefed-charts/kubefed \
  --namespace kube-federation-system \
  --set controllermanager.replicaCount=2 \
  --set controllermanager.resources.requests.memory=256Mi \
  --set controllermanager.resources.limits.memory=512Mi

# Verify installation
kubectl -n kube-federation-system get pods
```

#### Install kubefedctl CLI

```bash
# Download kubefedctl
VERSION=0.10.0
OS=linux
ARCH=amd64
curl -LO "https://github.com/kubernetes-sigs/kubefed/releases/download/v${VERSION}/kubefedctl-${VERSION}-${OS}-${ARCH}.tgz"
tar -xzf kubefedctl-${VERSION}-${OS}-${ARCH}.tgz
sudo mv kubefedctl /usr/local/bin/

# Verify
kubefedctl version
```

#### Register Member Clusters

```bash
# Context names in kubeconfig
AWS_CONTEXT="arn:aws:eks:us-east-1:123456789:cluster/nightscout-prod"
GKE_CONTEXT="gke_nightscout-prod_us-central1_nightscout-gke"

# Join AWS cluster (source)
kubefedctl join doks-cluster \
  --host-cluster-context=${GKE_CONTEXT} \
  --cluster-context=${AWS_CONTEXT} \
  --v=2

# Join GKE cluster (target, also host)
kubefedctl join gke-cluster \
  --host-cluster-context=${GKE_CONTEXT} \
  --cluster-context=${GKE_CONTEXT} \
  --v=2

# Verify cluster status
kubectl -n kube-federation-system get kubefedclusters
```

**Expected Output:**
```
NAME          AGE   READY
doks-cluster   1m    True
gke-cluster   30s   True
```

### Velero Installation (Optional - GKE Post-Migration Backups)

**Note:** Velero is NOT used for the migration itself (Gen3b has no PVCs to backup). Instead, Velero can be deployed on GKE to backup the newly created per-tenant PVCs after migration. This is optional but recommended for disaster recovery.

#### Why Velero is NOT Used for Migration

| Aspect | Gen3b (Source) | Gen5 (Target) |
|--------|---------------|---------------|
| **Storage Type** | Shared MongoDB on droplets | Per-tenant PVC |
| **PVC Count** | 0 (no PVCs) | 1 per tenant |
| **Backup Method** | N/A | Velero with GCS |
| **Migration Method** | mongodump (via migration job) | mongorestore |

#### Install Velero on GKE for Post-Migration Backups

```bash
# Install Velero with GCP plugin on GKE
velero install \
  --provider gcp \
  --plugins velero/velero-plugin-for-gcp:v1.8.0 \
  --bucket nightscout-gke-backups \
  --secret-file ./credentials-velero-gcp \
  --use-node-agent \
  --wait

# Verify
velero backup-location get
```

#### GKE Backup Architecture (Post-Migration)

After tenants are migrated to GKE, Velero provides PVC-level backups for disaster recovery:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     GKE POST-MIGRATION BACKUP FLOW                           │
│                                                                              │
│  GKE Cluster (Gen5)                                                         │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Tenant Pods with PVCs                                                 │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐       │  │
│  │  │ tenant-a        │  │ tenant-b        │  │ tenant-c        │       │  │
│  │  │ PVC: 10Gi       │  │ PVC: 10Gi       │  │ PVC: 10Gi       │       │  │
│  │  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘       │  │
│  │           │                    │                    │                 │  │
│  │           └────────────────────┼────────────────────┘                 │  │
│  │                                ▼                                      │  │
│  │                    ┌─────────────────────┐                           │  │
│  │                    │  Velero + Node Agent│                           │  │
│  │                    │  (GCP Plugin)       │                           │  │
│  │                    └──────────┬──────────┘                           │  │
│  └───────────────────────────────┼──────────────────────────────────────┘  │
│                                  │                                         │
│                                  ▼                                         │
│              ┌───────────────────────────────────────┐                     │
│              │  GCS: nightscout-gke-backups          │                     │
│              │  /backups/          │  Backup metadata                     │
│              │  /kopia/            │  PVC snapshots                       │
│              └───────────────────────────────────────┘                     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Important:** This backup flow only applies AFTER migration is complete. The migration itself uses mongodump/mongorestore via the migration decorator, not Velero.

#### Create GCP Service Account for Velero

```bash
# Create service account for Velero
gcloud iam service-accounts create velero-gke \
  --display-name "Velero for GKE backups"

# Grant storage permissions
gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member "serviceAccount:velero-gke@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role "roles/storage.admin"

# Create key file
gcloud iam service-accounts keys create credentials-velero-gcp \
  --iam-account velero-gke@${PROJECT_ID}.iam.gserviceaccount.com

# Create GCS bucket for backups
gsutil mb -p ${PROJECT_ID} -l us-central1 gs://nightscout-gke-backups
```

#### Test Velero Backup on GKE

```bash
# Create test backup of tenant PVCs
velero backup create gke-backup-test \
  --include-namespaces nightscout-tenants \
  --selector ns.mdn.io/tenant-id=test-tenant \
  --wait

# Verify backup completed
velero backup describe gke-backup-test

# Test restore (to verify backup integrity)
velero restore create gke-restore-test \
  --from-backup gke-backup-test \
  --namespace-mappings nightscout-tenants:restore-test \
  --wait
```

---

## GKE Cluster Provisioning

### Cluster Specification

```yaml
# gke-cluster-config.yaml
apiVersion: container.google.com/v1
kind: Cluster
metadata:
  name: nightscout-gke
  region: us-central1
spec:
  # Use regional cluster for HA
  location: us-central1
  
  # Node pool configuration
  nodePools:
  - name: nightscout-pool
    initialNodeCount: 3
    autoscaling:
      enabled: true
      minNodeCount: 3
      maxNodeCount: 20
    config:
      machineType: e2-standard-8  # 8 vCPU, 32GB RAM
      diskType: pd-balanced
      diskSizeGb: 100
      
      # Enable workload identity
      workloadMetadataConfig:
        mode: GKE_METADATA
      
      # Labels for node affinity
      labels:
        workload: nightscout
        generation: gen5
      
      # Taints (optional, for dedicated workloads)
      # taints:
      # - key: dedicated
      #   value: nightscout
      #   effect: NoSchedule
  
  # Networking
  networkConfig:
    network: projects/nightscout-prod/global/networks/nightscout-vpc
    subnetwork: projects/nightscout-prod/regions/us-central1/subnetworks/nightscout-pods
    
    # VPC-native cluster (required for high volume limits)
    enableIntraNodeVisibility: true
  
  ipAllocationPolicy:
    useIpAliases: true
    clusterSecondaryRangeName: pods
    servicesSecondaryRangeName: services
  
  # Addons
  addonsConfig:
    httpLoadBalancing:
      disabled: false
    horizontalPodAutoscaling:
      disabled: false
    gcePersistentDiskCsiDriverConfig:
      enabled: true  # Required for PVC operations
  
  # Security
  workloadIdentityConfig:
    workloadPool: nightscout-prod.svc.id.goog
  
  # Maintenance
  maintenancePolicy:
    window:
      dailyMaintenanceWindow:
        startTime: "03:00"  # UTC
```

### Provision with Terraform

```hcl
# gke.tf
resource "google_container_cluster" "nightscout" {
  name     = "nightscout-gke"
  location = "us-central1"
  
  # Remove default node pool
  remove_default_node_pool = true
  initial_node_count       = 1
  
  # Networking
  network    = google_compute_network.nightscout.name
  subnetwork = google_compute_subnetwork.nightscout.name
  
  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }
  
  # Workload Identity
  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }
  
  # Addons
  addons_config {
    gce_persistent_disk_csi_driver_config {
      enabled = true
    }
  }
}

resource "google_container_node_pool" "nightscout" {
  name       = "nightscout-pool"
  location   = "us-central1"
  cluster    = google_container_cluster.nightscout.name
  
  initial_node_count = 3
  
  autoscaling {
    min_node_count = 3
    max_node_count = 20
  }
  
  node_config {
    machine_type = "e2-standard-8"
    disk_type    = "pd-balanced"
    disk_size_gb = 100
    
    workload_metadata_config {
      mode = "GKE_METADATA"
    }
    
    labels = {
      workload   = "nightscout"
      generation = "gen5"
    }
    
    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform"
    ]
  }
}
```

### Storage Class Configuration

```yaml
# storage-class.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: nightscout-mongodb
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: pd.csi.storage.gke.io
parameters:
  type: pd-balanced
  replication-type: regional-pd  # For HA (optional)
reclaimPolicy: Retain
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

---

## Migration Strategy

### Phase Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         MIGRATION TIMELINE                                   │
│                                                                              │
│  Week 1-2          Week 3-4          Week 5-8          Week 9-10            │
│  ┌─────────┐       ┌─────────┐       ┌─────────┐       ┌─────────┐          │
│  │ Phase 1 │──────►│ Phase 2 │──────►│ Phase 3 │──────►│ Phase 4 │          │
│  │ Setup   │       │ Parallel│       │ Migrate │       │ Cleanup │          │
│  └─────────┘       └─────────┘       └─────────┘       └─────────┘          │
│                                                                              │
│  • GKE Cluster     • Gen 5 on GKE    • Batch migrate   • Decommission DOKS │
│  • Federation      • New tenants     • 50 tenants/week • Remove federation │
│  • Networking      • Monitoring      • Validate each   • Consolidate       │
│  • Velero          • Runbooks        • Rollback ready  • Cost optimization │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Phase 1: Infrastructure Setup (Week 1-2)

#### Day 1-3: GKE Cluster Provisioning

```bash
# 1. Create GKE cluster
gcloud container clusters create nightscout-gke \
  --region us-central1 \
  --num-nodes 3 \
  --machine-type e2-standard-8 \
  --enable-ip-alias \
  --workload-pool=nightscout-prod.svc.id.goog

# 2. Get credentials
gcloud container clusters get-credentials nightscout-gke \
  --region us-central1

# 3. Verify volume limits
kubectl describe nodes | grep "attachable-volumes-gce-pd"
# Expected: attachable-volumes-gce-pd: 128
```

#### Day 4-5: Federation Setup

```bash
# 1. Install KubeFed on GKE
helm install kubefed kubefed-charts/kubefed \
  --namespace kube-federation-system \
  --create-namespace

# 2. Register clusters
kubefedctl join doks-cluster --host-cluster-context=gke --cluster-context=aws
kubefedctl join gke-cluster --host-cluster-context=gke --cluster-context=gke

# 3. Verify
kubectl get kubefedclusters -n kube-federation-system
```

#### Day 6-7: Cross-Cluster Networking

```bash
# 1. Create Cloud VPN between AWS and GCP
# (Terraform or console - detailed steps in NETWORKING.md)

# 2. Verify connectivity
# From AWS cluster pod:
kubectl run test --rm -it --image=busybox -- wget -qO- http://10.1.0.1:8500/v1/status/leader

# 3. Configure Consul WAN federation
consul join -wan <gke-consul-server-ip>
```

#### Day 8-10: Velero and Backup Configuration

```bash
# 1. Install Velero on both clusters (see above)

# 2. Test backup/restore cycle
# On AWS:
velero backup create test-backup --include-namespaces nightscout-tenants

# On GKE:
velero restore create test-restore --from-backup test-backup

# 3. Verify restored resources
kubectl get pvc -n nightscout-tenants
```

### Phase 2: Parallel Operation (Week 3-4)

#### Deploy Gen 5 Stack to GKE

```bash
# 1. Deploy shared infrastructure
kubectl apply -f manifests/metacontroller/
kubectl apply -f manifests/consul/
kubectl apply -f manifests/ingress/

# 2. Deploy tenant composite controller
kubectl apply -f manifests/tenant-composite/

# 3. Verify readiness
kubectl get pods -n nightscout-system
```

#### Route New Tenants to GKE

Update tenant provisioning to target GKE:

```yaml
# federation/new-tenant-placement.yaml
apiVersion: types.kubefed.io/v1beta1
kind: FederatedConfigMap
metadata:
  name: tenant-provisioning-config
  namespace: nightscout-system
spec:
  template:
    data:
      default-cluster: gke-cluster
      fallback-cluster: doks-cluster
  placement:
    clusters:
    - name: gke-cluster
```

#### Monitoring Setup

```yaml
# prometheus/federation-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: federation-migration-alerts
spec:
  groups:
  - name: migration
    rules:
    - alert: TenantMigrationFailed
      expr: |
        increase(velero_restore_failed_total[1h]) > 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Tenant migration restore failed"
        
    - alert: CrossClusterLatencyHigh
      expr: |
        histogram_quantile(0.99, consul_rpc_request_seconds_bucket{datacenter=~"aws|gke"}) > 0.5
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Cross-cluster latency exceeds 500ms"
```

### Phase 3: Tenant Migration (Week 5-8)

#### Tenant Selection Criteria

Prioritize tenants for migration based on:

| Priority | Criteria | Rationale |
|----------|----------|-----------|
| 1 | Inactive tenants (no writes in 30 days) | Low risk, validate process |
| 2 | Low-activity tenants (<100 writes/day) | Quick migration, minimal data |
| 3 | Standard tenants | Bulk of migrations |
| 4 | High-activity tenants (>1000 writes/day) | Careful scheduling needed |
| 5 | Premium/SLA tenants | Final batch, proven process |

#### Migration Batch Script

```bash
#!/bin/bash
# migrate-tenant-batch.sh
# Cross-cluster migration from DOKS (Gen3b) to GKE (Gen5)
# Migration jobs run in DOKS to access legacy shared MongoDB

TENANTS="$1"  # Comma-separated tenant IDs
BATCH_ID=$(date +%Y%m%d-%H%M%S)

for TENANT_ID in ${TENANTS//,/ }; do
  echo "=== Migrating tenant: ${TENANT_ID} ==="
  
  # ------------------------------------------------------------------
  # PHASE 1: Prepare GKE target (runs on GKE)
  # ------------------------------------------------------------------
  kubectx gke-cluster
  
  # 1a. Create NightscoutTenant CRD on GKE (Gen5 architecture)
  kubectl apply -f - <<EOF
apiVersion: nightscout.io/v1alpha1
kind: NightscoutTenant
metadata:
  name: ${TENANT_ID}
  namespace: nightscout-tenants
spec:
  storageType: dedicated
  tier: standard
EOF
  
  # 1b. Wait for Gen5 pod to be ready (MongoDB container up)
  echo "Waiting for GKE Gen5 pod to be ready..."
  kubectl wait --for=condition=ready pod \
    -l ns.mdn.io/tenant-id=${TENANT_ID} \
    -n nightscout-tenants \
    --timeout=300s
  
  # 1c. Get GKE pod's Consul name for migration target
  # Default: Use Consul WAN DNS (works via mesh gateways, no VPN required)
  GKE_POD_CONSUL="${TENANT_ID}.backends.gke-dc.consul"
  
  echo "GKE target: Consul=${GKE_POD_CONSUL}"
  
  # Optional: If using VPN mode, also capture pod IP
  # Uncomment these lines if MIGRATION_USE_DIRECT_IP=true
  # GKE_POD_IP=$(kubectl get pod \
  #   -l ns.mdn.io/tenant-id=${TENANT_ID} \
  #   -n nightscout-tenants \
  #   -o jsonpath='{.items[0].status.podIP}')
  # echo "VPN mode - direct IP: ${GKE_POD_IP}"
  
  # ------------------------------------------------------------------
  # PHASE 2: Configure and run migration job (runs on DOKS)
  # ------------------------------------------------------------------
  kubectx doks-cluster
  
  # 2a. Update tenant ConfigMap with cross-cluster migration settings
  # Default: Consul WAN DNS mode (recommended, no VPN required)
  kubectl patch configmap ${TENANT_ID}-config \
    -n nightscout-tenants \
    --type=merge \
    -p '{
      "data": {
        "MIGRATION_ENABLED": "true",
        "MIGRATION_TARGET_CLUSTER": "gke-dc",
        "MIGRATION_TARGET_CONSUL_NAME": "'${GKE_POD_CONSUL}'",
        "MIGRATION_USE_DIRECT_IP": "false"
      },
      "metadata": {
        "annotations": {
          "ns.mdn.io/migration-policy": "cross-cluster",
          "ns.mdn.io/migration-phase": "pending"
        }
      }
    }'
  
  # Alternative: VPN mode (uncomment if using VPN with direct pod IP)
  # kubectl patch configmap ${TENANT_ID}-config \
  #   -n nightscout-tenants \
  #   --type=merge \
  #   -p '{
  #     "data": {
  #       "MIGRATION_ENABLED": "true",
  #       "MIGRATION_TARGET_CLUSTER": "gke-dc",
  #       "MIGRATION_USE_DIRECT_IP": "true",
  #       "MIGRATION_TARGET_POD_IP": "'${GKE_POD_IP}'"
  #     },
  #     "metadata": {
  #       "annotations": {
  #         "ns.mdn.io/migration-policy": "cross-cluster",
  #         "ns.mdn.io/migration-phase": "pending"
  #       }
  #     }
  #   }'
  
  # 2b. Trigger migration by setting migration-needed annotation
  # (The migration decorator will render the job automatically)
  kubectl annotate secret ${TENANT_ID}-mongo-auth \
    ns.mdn.io/migration-needed=true \
    --overwrite
  
  # 2c. Wait for migration job to complete
  echo "Waiting for migration job to complete..."
  kubectl wait --for=condition=complete job \
    -l ns.mdn.io/tenant-id=${TENANT_ID},ns.mdn.io/migration-type=cross-cluster \
    -n nightscout-tenants \
    --timeout=600s
  
  # 2d. Check migration job status
  MIGRATION_STATUS=$(kubectl get job \
    -l ns.mdn.io/tenant-id=${TENANT_ID},ns.mdn.io/migration-type=cross-cluster \
    -n nightscout-tenants \
    -o jsonpath='{.items[0].status.succeeded}')
  
  if [ "$MIGRATION_STATUS" != "1" ]; then
    echo "ERROR: Migration job failed for ${TENANT_ID}"
    kubectl logs job/migrate-${TENANT_ID}-to-gke-dc -n nightscout-tenants
    continue
  fi
  
  echo "Migration job completed successfully"
  
  # ------------------------------------------------------------------
  # PHASE 3: Verify and cutover (cross-cluster)
  # ------------------------------------------------------------------
  
  # 3a. Verify document counts match
  SOURCE_COUNT=$(kubectl exec -n nightscout-tenants \
    $(kubectl get pod -l ns.mdn.io/tenant-id=${TENANT_ID} -o name) \
    -c nightscout -- mongo nightscout --quiet --eval "db.entries.count()" 2>/dev/null || echo "0")
  
  kubectx gke-cluster
  TARGET_COUNT=$(kubectl exec -n nightscout-tenants \
    $(kubectl get pod -l ns.mdn.io/tenant-id=${TENANT_ID} -o name) \
    -c mongodb -- mongo nightscout --quiet --eval "db.entries.count()")
  
  echo "Document counts: source=${SOURCE_COUNT}, target=${TARGET_COUNT}"
  
  # 3b. Update DNS to point to GKE (see DNS TTL Playbook)
  ./update-tenant-dns.sh ${TENANT_ID} gke
  
  # 3c. Consul routing will update automatically via deployment controller
  # GKE pod is already registered; DOKS pod will be deregistered when deleted
  
  # 3d. Mark migration complete
  kubectx doks-cluster
  kubectl annotate configmap ${TENANT_ID}-config \
    ns.mdn.io/migration-phase=completed \
    ns.mdn.io/migrated-to=gke-dc \
    ns.mdn.io/migration-timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
    --overwrite
  
  # 3e. Delete DOKS resources (AFTER 7-day validation period!)
  # Uncomment after validation:
  # kubectl delete nightscouttenant ${TENANT_ID} -n nightscout-tenants
  # kubectl delete configmap ${TENANT_ID}-config -n nightscout-tenants
  # kubectl delete secret ${TENANT_ID}-mongo-auth -n nightscout-tenants
  # Note: Drop shared MongoDB database after all tenants migrated
  
  echo "=== Completed: ${TENANT_ID} (validate for 7 days before cleanup) ==="
done
```

#### Pre-Migration Validation Checklist

Before migrating each tenant:

- [ ] Tenant is not in maintenance window (`kubectl get configmap ${TENANT_ID}-config -o jsonpath='{.metadata.annotations.maintenance}'`)
- [ ] Source pod healthy (`kubectl get pod -l ns.mdn.io/tenant-id=${TENANT_ID} -o jsonpath='{.status.phase}'`)
- [ ] Shared MongoDB accessible (`mongo mongodb://shared-user:pass@10.0.50.10:27017/${TENANT_ID} --eval "db.entries.count()"`)
- [ ] MongoDB document count recorded for verification
- [ ] Current DNS TTL lowered to 60s (see DNS TTL Playbook below)
- [ ] Consul WAN federation healthy (`consul members -wan`)

#### Migration Execution Checklist

During migration:

- [ ] GKE Gen5 tenant created and pod ready (`kubectl --context=gke get pod -l ns.mdn.io/tenant-id=${TENANT_ID}`)
- [ ] GKE PVC provisioned and bound (`kubectl --context=gke get pvc | grep ${TENANT_ID}`)
- [ ] Migration job triggered on DOKS (`kubectl --context=doks get job -l ns.mdn.io/tenant-id=${TENANT_ID},ns.mdn.io/migration-type=cross-cluster`)
- [ ] Migration job completed successfully (`kubectl --context=doks get job ... -o jsonpath='{.status.succeeded}'` = 1)
- [ ] MongoDB document count matches source (within 100 documents for active tenants)

#### Post-Migration Validation Checklist

After migration (wait for DNS TTL to expire):

- [ ] Nightscout API responding on GKE (`curl -s https://${TENANT_ID}.nightscout.example.com/api/v1/status`)
- [ ] Consul registration shows GKE datacenter (`consul catalog service nightscout -datacenter=gke-dc | grep ${TENANT_ID}`)
- [ ] DOKS pod deregistered from Consul (`consul catalog service nightscout -datacenter=doks-dc | grep -v ${TENANT_ID}`)
- [ ] Recent CGM entries visible in UI (manual check or API call)
- [ ] No error logs in last hour (`kubectl --context=gke logs ... --since=1h | grep -i error`)
- [ ] Response latency acceptable (<500ms p99)

#### Source Resource Cleanup (Day +7)

Only after 7-day validation period:

- [ ] No traffic to DOKS pod for 24h (check Consul metrics)
- [ ] User confirmed no issues (or no support tickets)
- [ ] Tenant data archived from shared MongoDB (optional: mongodump to GCS)
- [ ] DOKS resources deleted:
  ```bash
  kubectl --context=doks delete nightscouttenant ${TENANT_ID} -n nightscout-tenants
  kubectl --context=doks delete configmap ${TENANT_ID}-config -n nightscout-tenants
  kubectl --context=doks delete secret ${TENANT_ID}-mongo-auth -n nightscout-tenants
  ```
- [ ] Tenant database dropped from shared MongoDB (after all tenants migrated):
  ```bash
  mongo mongodb://admin:pass@10.0.50.10:27017/admin --eval "db.getSiblingDB('${TENANT_ID}').dropDatabase()"
  ```

#### Automated Validation Script

```bash
#!/bin/bash
# validate-migration.sh

TENANT_ID=$1
BACKUP_NAME=$2

echo "=== Validating Migration: ${TENANT_ID} ==="

FAILED=0

# Check GKE pod status
GKE_POD_STATUS=$(kubectl --context=gke-cluster get pod \
  -l ns.mdn.io/tenant-id=${TENANT_ID} \
  -n nightscout-tenants \
  -o jsonpath='{.items[0].status.phase}' 2>/dev/null)

if [ "$GKE_POD_STATUS" != "Running" ]; then
  echo "❌ GKE pod not running: ${GKE_POD_STATUS}"
  FAILED=1
else
  echo "✅ GKE pod running"
fi

# Check PVC bound
GKE_PVC_STATUS=$(kubectl --context=gke-cluster get pvc \
  -l ns.mdn.io/tenant-id=${TENANT_ID} \
  -n nightscout-tenants \
  -o jsonpath='{.items[0].status.phase}' 2>/dev/null)

if [ "$GKE_PVC_STATUS" != "Bound" ]; then
  echo "❌ GKE PVC not bound: ${GKE_PVC_STATUS}"
  FAILED=1
else
  echo "✅ GKE PVC bound"
fi

# Check API response
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  "https://${TENANT_ID}.nightscout.example.com/api/v1/status")

if [ "$HTTP_STATUS" != "200" ]; then
  echo "❌ API not responding: HTTP ${HTTP_STATUS}"
  FAILED=1
else
  echo "✅ API responding (HTTP 200)"
fi

# Check document count
SOURCE_COUNT=$(kubectl --context=doks-cluster exec -n nightscout-tenants \
  $(kubectl --context=doks-cluster get pod -l ns.mdn.io/tenant-id=${TENANT_ID} -n nightscout-tenants -o name 2>/dev/null) \
  -c mongodb -- mongo nightscout --quiet --eval "db.entries.count()" 2>/dev/null || echo "0")

TARGET_COUNT=$(kubectl --context=gke-cluster exec -n nightscout-tenants \
  $(kubectl --context=gke-cluster get pod -l ns.mdn.io/tenant-id=${TENANT_ID} -n nightscout-tenants -o name) \
  -c mongodb -- mongo nightscout --quiet --eval "db.entries.count()" 2>/dev/null || echo "0")

DIFF=$((SOURCE_COUNT - TARGET_COUNT))
if [ ${DIFF#-} -gt 100 ]; then
  echo "❌ Document count mismatch: source=${SOURCE_COUNT}, target=${TARGET_COUNT}"
  FAILED=1
else
  echo "✅ Document count matches (source=${SOURCE_COUNT}, target=${TARGET_COUNT})"
fi

# Check Consul registration
CONSUL_DC=$(consul catalog service nightscout -format=json 2>/dev/null | \
  jq -r ".[] | select(.ServiceID | contains(\"${TENANT_ID}\")) | .Datacenter")

if [ "$CONSUL_DC" != "gke-dc" ]; then
  echo "❌ Consul shows wrong datacenter: ${CONSUL_DC}"
  FAILED=1
else
  echo "✅ Consul registration on gke-dc"
fi

# Summary
if [ $FAILED -eq 0 ]; then
  echo "=== Migration Validated Successfully ==="
  exit 0
else
  echo "=== Migration Validation FAILED ==="
  exit 1
fi
```

---

## Data Migration Details

### Migration Job Placement Strategy

Given that the legacy shared MongoDB is accessible only from within the DigitalOcean datacenter, **migration jobs MUST run in the source cluster (DOKS)**.

#### Why Source-Side Execution is Required

| Factor | Source (DOKS) | Destination (GKE) |
|--------|---------------|-------------------|
| Access to Legacy Shared MongoDB | ✓ Direct (private IPs) | ✗ Not routable |
| Access to GKE Gen5 Pod | Via VPN or Consul WAN | ✓ Direct (local) |
| Existing migration decorator | ✓ Already deployed | Needs deployment |
| Network egress cost | Data leaves DO | Data lands locally |

**Conclusion**: Source-side execution is the only viable option without exposing the legacy MongoDB to the public internet.

#### Migration Job Architecture (Source-Side)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     SOURCE-SIDE MIGRATION JOB FLOW                           │
│                                                                              │
│  DOKS Cluster                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                                                                          ││
│  │  ┌──────────────────────────────────────────────────────────────────┐   ││
│  │  │  Migration Job Pod                                                │   ││
│  │  │                                                                   │   ││
│  │  │  ┌─────────────────────┐      ┌─────────────────────┐            │   ││
│  │  │  │  mongodump          │ ───► │  mongorestore       │            │   ││
│  │  │  │  --uri=$SOURCE_URI  │ pipe │  --uri=$TARGET_URI  │            │   ││
│  │  │  └─────────────────────┘      └─────────────────────┘            │   ││
│  │  │           │                            │                          │   ││
│  │  └───────────┼────────────────────────────┼──────────────────────────┘   ││
│  │              │                            │                              ││
│  │              ▼                            │                              ││
│  │  ┌──────────────────────┐                 │                              ││
│  │  │  Legacy Shared       │                 │                              ││
│  │  │  MongoDB             │                 │                              ││
│  │  │  (10.0.50.10:27017)  │                 │                              ││
│  │  └──────────────────────┘                 │                              ││
│  │                                           │                              ││
│  └───────────────────────────────────────────┼──────────────────────────────┘│
│                                              │                               │
│                                              │ VPN or Consul WAN             │
│                                              │                               │
│  GKE Cluster                                 ▼                               │
│  ┌───────────────────────────────────────────────────────────────────────────┐
│  │  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  │  Gen5 Pod (tenant-abc)                                              │  │
│  │  │  ┌──────────────────┐  ┌──────────────────┐                        │  │
│  │  │  │  MongoDB         │  │  Nightscout      │                        │  │
│  │  │  │  (dedicated)     │◄─┤  (after init)    │                        │  │
│  │  │  │  :27017          │  │                  │                        │  │
│  │  │  └──────────────────┘  └──────────────────┘                        │  │
│  │  │                                                                     │  │
│  │  │  Consul Registration: tenant-abc.backends.gke-dc.consul            │  │
│  │  └────────────────────────────────────────────────────────────────────┘  │
│  └───────────────────────────────────────────────────────────────────────────┘
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Destination Connectivity Options

The migration job running in DOKS needs to reach the Gen5 pod on GKE. Two primary options:

#### Option A: Consul WAN DNS Resolution (Recommended)

Since both clusters have deployment controllers syncing pod events to Consul, the GKE pods are discoverable via Consul WAN federation:

```yaml
# Migration Job ConfigMap
data:
  MIGRATION_SOURCE_URI: "mongodb://shared-user:pass@10.0.50.10:27017/tenant-abc"
  MIGRATION_TARGET_URI: "mongodb://admin:pass@tenant-abc.backends.gke-dc.consul:27017/nightscout"
  # OR using the service name format:
  MIGRATION_TARGET_CONSUL_NAME: "tenant-abc.backends.gke-dc.consul"
```

**Prerequisites for Consul DNS:**
1. Consul WAN federation established (see Consul Federation section)
2. Mesh gateways deployed and healthy
3. DOKS pods can resolve `*.gke-dc.consul` via Consul DNS
4. TCP traffic routed through mesh gateways

**Consul DNS Configuration:**
```bash
# Verify Consul DNS resolution from DOKS
kubectl run -it --rm debug --image=alpine --restart=Never -- \
  nslookup tenant-abc.backends.gke-dc.consul consul.consul.svc:8600

# Expected result:
# Server:    consul.consul.svc
# Address:   10.0.100.50:8600
# Name:      tenant-abc.backends.gke-dc.consul
# Address:   10.1.42.15  (GKE pod IP, routed via mesh gateway)
```

#### Option B: VPN with Direct Pod IP

If you establish VPN/Interconnect between DO and GCP, the migration job can use the GKE pod IP directly:

```yaml
# Migration Job ConfigMap
data:
  MIGRATION_SOURCE_URI: "mongodb://shared-user:pass@10.0.50.10:27017/tenant-abc"
  MIGRATION_TARGET_URI: "mongodb://admin:pass@10.1.42.15:27017/nightscout"
  MIGRATION_TARGET_POD_IP: "10.1.42.15"  # Discovered from GKE
```

**Prerequisites for VPN:**
1. Cloud VPN or Dedicated Interconnect configured
2. Routes advertised between VPCs
3. Firewall rules allow MongoDB port (27017) from DOKS to GKE pod CIDR
4. Pod IP discovered via Consul or kubectl query

**Discovering GKE Pod IP:**
```bash
# From DOKS, query GKE cluster for pod IP
GKE_POD_IP=$(kubectl --context=gke-cluster get pod \
  -l ns.mdn.io/tenant-id=tenant-abc \
  -n nightscout-tenants \
  -o jsonpath='{.items[0].status.podIP}')

# Store in ConfigMap for migration job
kubectl patch configmap tenant-abc-config \
  -p '{"data":{"MIGRATION_TARGET_POD_IP":"'${GKE_POD_IP}'"}}'
```

#### Comparison of Connectivity Options

| Factor | Consul WAN DNS | VPN + Direct IP |
|--------|---------------|-----------------|
| **Setup Complexity** | Medium (Consul federation) | Medium (VPN setup) |
| **Runtime Dependency** | Consul + Mesh Gateways | VPN tunnel |
| **Pod IP Changes** | Automatic (DNS updates) | Manual update needed |
| **Network Latency** | Higher (mesh gateway hop) | Lower (direct routing) |
| **Security** | mTLS via mesh | VPN encryption |
| **Failure Mode** | Consul outage breaks DNS | VPN tunnel down |
| **Recommended For** | Dynamic environments | Stable pod IPs |

**Recommendation**: Use **Consul WAN DNS** for automatic discovery, with **VPN as fallback** for debugging or if Consul has issues.

### Webhook Modifications for Cross-Cluster Migration

The existing migration decorator (`instance-userdata-decorator-sync.js`) needs updates to support cross-cluster targets.

#### New ConfigMap Fields

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tenant-abc-config
  namespace: nightscout-tenants
  annotations:
    ns.mdn.io/migration-policy: "cross-cluster"
    ns.mdn.io/migration-phase: "pending"
data:
  # Existing fields
  MIGRATION_ENABLED: "true"
  MIGRATION_METHOD: "mongodump-restore"
  MIGRATION_IMAGE: "mongo:6"
  
  # Source (legacy shared MongoDB)
  MIGRATION_SOURCE_URI: "mongodb://shared-user:pass@10.0.50.10:27017/tenant-abc"
  MIGRATION_SOURCE_SECRET: "legacy-mongo-creds"
  
  # NEW: Cross-cluster destination options
  MIGRATION_TARGET_CLUSTER: "gke-dc"                    # Consul datacenter name
  MIGRATION_TARGET_CONSUL_NAME: "tenant-abc.backends.gke-dc.consul"  # Full Consul DNS (RECOMMENDED)
  MIGRATION_TARGET_SECRET: "tenant-abc-app-credentials" # Credentials secret name
  
  # VPN-only options (use when VPN is available and preferred over Consul)
  MIGRATION_USE_DIRECT_IP: "false"                      # Set to "true" to use VPN mode
  MIGRATION_TARGET_POD_IP: ""                           # Only used when MIGRATION_USE_DIRECT_IP=true
  
  # NEW: Cross-cluster verification
  MIGRATION_VERIFY_TARGET_READY: "true"                 # Wait for target pod Ready
  MIGRATION_VERIFY_CONSUL_REGISTERED: "true"            # Verify target in Consul
```

#### Webhook Code Changes

```javascript
// cmd/webhook/handlers/instance-userdata-decorator-sync.js

function buildMigrationTargetUri(config, podInfo) {
  // Priority 1: Explicit target URI (full control)
  if (config.MIGRATION_TARGET_URI) {
    return config.MIGRATION_TARGET_URI;
  }
  
  // Priority 2: Consul WAN DNS name (RECOMMENDED for cross-cluster)
  // This path works via Consul mesh gateways without VPN
  if (config.MIGRATION_TARGET_CONSUL_NAME) {
    const creds = getTargetCredentials(config.MIGRATION_TARGET_SECRET);
    return `mongodb://${creds.user}:${creds.pass}@${config.MIGRATION_TARGET_CONSUL_NAME}:27017/nightscout`;
  }
  
  // Priority 3: Direct Pod IP (VPN scenario - explicit opt-in only)
  // Only used when MIGRATION_USE_DIRECT_IP=true AND pod IP is available
  if (config.MIGRATION_USE_DIRECT_IP === 'true' && config.MIGRATION_TARGET_POD_IP) {
    const creds = getTargetCredentials(config.MIGRATION_TARGET_SECRET);
    return `mongodb://${creds.user}:${creds.pass}@${config.MIGRATION_TARGET_POD_IP}:27017/nightscout`;
  }
  
  // Priority 4: Local pod IP (existing behavior for same-cluster migration)
  if (podInfo && podInfo.podIp) {
    return `mongodb://admin:${podInfo.password}@${podInfo.podIp}:27017/nightscout`;
  }
  
  throw new Error('No valid migration target specified');
}

// Helper to determine which connectivity method is in use
function getMigrationConnectivityMode(config) {
  if (config.MIGRATION_TARGET_URI) return 'explicit-uri';
  if (config.MIGRATION_TARGET_CONSUL_NAME) return 'consul-wan';
  if (config.MIGRATION_USE_DIRECT_IP === 'true') return 'vpn-direct';
  return 'local';
}

function renderCrossClusterMigrationJob(config, sourceUri, targetUri) {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: `migrate-${config.tenantId}-to-${config.MIGRATION_TARGET_CLUSTER}`,
      namespace: 'nightscout-tenants',
      labels: {
        'ns.mdn.io/tenant-id': config.tenantId,
        'ns.mdn.io/migration-type': 'cross-cluster',
        'ns.mdn.io/target-cluster': config.MIGRATION_TARGET_CLUSTER
      },
      annotations: {
        'ns.mdn.io/source-cluster': 'doks-dc',
        'ns.mdn.io/target-cluster': config.MIGRATION_TARGET_CLUSTER
      }
    },
    spec: {
      backoffLimit: 3,
      ttlSecondsAfterFinished: 3600,
      template: {
        spec: {
          restartPolicy: 'OnFailure',
          containers: [{
            name: 'migrate',
            image: config.MIGRATION_IMAGE || 'mongo:6',
            command: ['/bin/bash', '-c'],
            args: [`
              set -e
              echo "Starting cross-cluster migration for ${config.tenantId}"
              echo "Source: ${sourceUri.replace(/:[^:@]+@/, ':***@')}"
              echo "Target: ${targetUri.replace(/:[^:@]+@/, ':***@')}"
              
              # Verify target is reachable
              echo "Verifying target connectivity..."
              mongosh "${targetUri}" --eval "db.runCommand({ping:1})" || {
                echo "ERROR: Cannot reach target MongoDB"
                exit 1
              }
              
              # Run migration
              echo "Running mongodump | mongorestore..."
              mongodump --uri="${sourceUri}" --archive | \
                mongorestore --uri="${targetUri}" --archive --drop
              
              # Verify migration
              echo "Verifying document counts..."
              SOURCE_COUNT=$(mongosh "${sourceUri}" --quiet --eval "db.entries.count()")
              TARGET_COUNT=$(mongosh "${targetUri}" --quiet --eval "db.entries.count()")
              
              if [ "$SOURCE_COUNT" -ne "$TARGET_COUNT" ]; then
                echo "WARNING: Count mismatch - source=$SOURCE_COUNT target=$TARGET_COUNT"
              else
                echo "SUCCESS: Migrated $TARGET_COUNT documents"
              fi
            `],
            env: [
              { name: 'SOURCE_URI', value: sourceUri },
              { name: 'TARGET_URI', value: targetUri }
            ],
            resources: {
              requests: { cpu: '100m', memory: '256Mi' },
              limits: { cpu: '500m', memory: '512Mi' }
            }
          }],
          // Use same node affinity as tenant pods for network access
          affinity: config.nodeAffinity || {}
        }
      }
    }
  };
}
```

#### Migration Secret Handling

For cross-cluster migration, credentials for both source and target must be available:

```yaml
# Source credentials (legacy shared MongoDB) - already exists
apiVersion: v1
kind: Secret
metadata:
  name: legacy-mongo-creds
  namespace: nightscout-tenants
type: Opaque
data:
  MONGO_USER: c2hhcmVkLXVzZXI=      # shared-user
  MONGO_PASSWORD: c2hhcmVkLXBhc3M=  # shared-pass

# Target credentials - must be synced from GKE or use shared secret
apiVersion: v1
kind: Secret
metadata:
  name: tenant-abc-app-credentials
  namespace: nightscout-tenants
  annotations:
    ns.mdn.io/synced-from: "gke-dc"
type: Opaque
data:
  MONGO_USER: YWRtaW4=              # admin
  MONGO_PASSWORD: Z2VuZXJhdGVk...   # generated password
```

### Storage Paradigm: Shared MongoDB to Per-Tenant PVC

**Important:** Gen3b does NOT use PVCs. The source architecture uses a central shared MongoDB cluster running on DigitalOcean droplets, accessed via private IPs (10.0.50.x). This means:

- **No Velero PVC backup/restore** - There are no source PVCs to migrate
- **Fresh PVC provisioning** - GKE Gen5 creates new PVCs during tenant provisioning
- **Pure data migration** - Only MongoDB data moves, via mongodump/mongorestore

#### Source Architecture (DOKS Gen3b)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     GEN3B SOURCE ARCHITECTURE (DOKS)                         │
│                                                                              │
│  DigitalOcean Kubernetes (DOKS)           DigitalOcean Droplets              │
│  ┌─────────────────────────────┐          ┌─────────────────────────────┐   │
│  │  Tenant Pods (Nightscout)   │          │  Shared MongoDB Cluster      │   │
│  │  ┌─────────┐ ┌─────────┐   │          │  ┌─────────────────────────┐ │   │
│  │  │ tenant-a│ │ tenant-b│   │   ───►   │  │  MongoDB Replica Set    │ │   │
│  │  │ (no PVC)│ │ (no PVC)│   │ Private  │  │  - Primary              │ │   │
│  │  └────┬────┘ └────┬────┘   │   IP     │  │  - Secondary            │ │   │
│  │       │           │        │ Network  │  │  - Arbiter              │ │   │
│  │       └─────┬─────┘        │          │  └─────────────────────────┘ │   │
│  │             │              │          │  IP: 10.0.50.10              │   │
│  └─────────────┼──────────────┘          └─────────────────────────────┘   │
│                │                                                            │
│                └── mongodb://shared-user:pass@10.0.50.10:27017/tenant-a    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Destination Architecture (GKE Gen5)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    GEN5 DESTINATION ARCHITECTURE (GKE)                       │
│                                                                              │
│  Google Kubernetes Engine (GKE)                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │  Tenant Pods (MongoDB + Nightscout co-located)                           ││
│  │                                                                          ││
│  │  ┌─────────────────────────┐    ┌─────────────────────────┐             ││
│  │  │ tenant-a-pod            │    │ tenant-b-pod            │             ││
│  │  │ ┌─────────┐ ┌─────────┐│    │ ┌─────────┐ ┌─────────┐│             ││
│  │  │ │ MongoDB │ │Nightscout││    │ │ MongoDB │ │Nightscout││             ││
│  │  │ │ :27017  │ │ :1337   ││    │ │ :27017  │ │ :1337   ││             ││
│  │  │ └────┬────┘ └─────────┘│    │ └────┬────┘ └─────────┘│             ││
│  │  └──────┼─────────────────┘    └──────┼─────────────────┘             ││
│  │         │                             │                                ││
│  │  ┌──────▼──────┐               ┌──────▼──────┐                        ││
│  │  │ PVC         │               │ PVC         │                        ││
│  │  │ tenant-a-   │               │ tenant-b-   │                        ││
│  │  │ mongodb-data│               │ mongodb-data│                        ││
│  │  │ (10Gi)      │               │ (10Gi)      │                        ││
│  │  └─────────────┘               └─────────────┘                        ││
│  │                                                                          ││
│  └──────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Post-Migration Verification

After data migration completes, verify the transfer was successful:

```bash
#!/bin/bash
# verify-migration.sh

TENANT_ID=$1

# Get document counts from source (shared MongoDB via private IP)
# Must run from DOKS where private IP is accessible
kubectx doks-cluster
SOURCE_ENTRIES=$(mongo "mongodb://shared-user:pass@10.0.50.10:27017/${TENANT_ID}" \
  --quiet --eval "db.entries.count()")

# Get document counts from target (Gen5 dedicated MongoDB)
kubectx gke-cluster
TARGET_ENTRIES=$(kubectl exec -n nightscout-tenants \
  $(kubectl get pod -l ns.mdn.io/tenant-id=${TENANT_ID} -o name) \
  -c mongodb -- mongo nightscout --quiet --eval "db.entries.count()")

if [ "$SOURCE_ENTRIES" -eq "$TARGET_ENTRIES" ]; then
  echo "✅ Document count matches: ${SOURCE_ENTRIES}"
else
  echo "❌ Document count mismatch: source=${SOURCE_ENTRIES}, target=${TARGET_ENTRIES}"
  exit 1
fi

# Additional verification: check critical collections
for COLLECTION in entries treatments devicestatus profile; do
  SOURCE=$(mongo "mongodb://shared-user:pass@10.0.50.10:27017/${TENANT_ID}" \
    --quiet --eval "db.${COLLECTION}.count()")
  TARGET=$(kubectl exec -n nightscout-tenants \
    $(kubectl get pod -l ns.mdn.io/tenant-id=${TENANT_ID} -o name) \
    -c mongodb -- mongo nightscout --quiet --eval "db.${COLLECTION}.count()")
  
  if [ "$SOURCE" -eq "$TARGET" ]; then
    echo "✅ ${COLLECTION}: ${SOURCE} documents"
  else
    echo "❌ ${COLLECTION}: source=${SOURCE}, target=${TARGET}"
  fi
done
```

---

## DNS and Traffic Cutover

### Consul WAN Federation Architecture

Consul WAN federation enables cross-cluster service discovery, allowing traffic to route to tenants on either cluster during migration.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      CONSUL WAN FEDERATION TOPOLOGY                          │
│                                                                              │
│  DOKS Datacenter (doks-dc)              GKE Datacenter (gke-dc) [PRIMARY]     │
│  ┌─────────────────────┐              ┌─────────────────────┐               │
│  │ Consul Servers (3)  │◄────WAN─────►│ Consul Servers (3)  │               │
│  │ - Gossip: 8301      │   Gossip     │ - Gossip: 8301      │               │
│  │ - WAN: 8302         │   (8302)     │ - WAN: 8302         │               │
│  │ - RPC: 8300         │              │ - RPC: 8300         │               │
│  └─────────┬───────────┘              └─────────┬───────────┘               │
│            │                                    │                            │
│  ┌─────────▼───────────┐              ┌─────────▼───────────┐               │
│  │ Mesh Gateway        │◄────mTLS────►│ Mesh Gateway        │               │
│  │ (LoadBalancer:8443) │              │ (LoadBalancer:8443) │               │
│  └─────────────────────┘              └─────────────────────┘               │
│            ▲                                    ▲                            │
│            │                                    │                            │
│  ┌─────────┴───────────┐              ┌─────────┴───────────┐               │
│  │ Tenant Pods         │              │ Tenant Pods         │               │
│  │ (Consul Agents)     │              │ (Consul Agents)     │               │
│  └─────────────────────┘              └─────────────────────┘               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Step 1: Generate TLS Certificates

Consul WAN federation requires TLS. Generate a shared CA:

```bash
# Create CA on GKE (primary datacenter)
consul tls ca create

# Generate server certificates for each datacenter
consul tls cert create -server -dc gke-dc -additional-dnsname="consul-server.consul.svc"
consul tls cert create -server -dc doks-dc -additional-dnsname="consul-server.consul.svc"

# Create Kubernetes secrets
kubectl create secret generic consul-ca-cert \
  --namespace consul \
  --from-file=tls.crt=consul-agent-ca.pem

kubectl create secret generic consul-server-cert \
  --namespace consul \
  --from-file=tls.crt=gke-dc-server-consul-0.pem \
  --from-file=tls.key=gke-dc-server-consul-0-key.pem
```

### Step 2: Generate Gossip Encryption Key

```bash
# Generate gossip key (must be same on both clusters)
GOSSIP_KEY=$(consul keygen)

# Create secret on both clusters
kubectl create secret generic consul-gossip-key \
  --namespace consul \
  --from-literal=key="${GOSSIP_KEY}"
```

### Step 3: Bootstrap ACL System

```bash
# Bootstrap ACL on GKE (primary datacenter)
kubectl exec -n consul consul-server-0 -- consul acl bootstrap > acl-bootstrap.json

# Extract bootstrap token
BOOTSTRAP_TOKEN=$(jq -r '.SecretID' acl-bootstrap.json)

# Create replication token for AWS datacenter
kubectl exec -n consul consul-server-0 -- consul acl token create \
  -token="${BOOTSTRAP_TOKEN}" \
  -description="AWS Replication Token" \
  -policy-name="global-management" \
  > aws-replication-token.json

REPLICATION_TOKEN=$(jq -r '.SecretID' aws-replication-token.json)

# Store tokens as secrets
kubectl create secret generic consul-bootstrap-token \
  --namespace consul \
  --from-literal=token="${BOOTSTRAP_TOKEN}"

kubectl create secret generic consul-replication-token \
  --namespace consul \
  --from-literal=token="${REPLICATION_TOKEN}"
```

### Step 4: Consul Server Configuration (GKE - Primary)

```yaml
# consul/gke-server-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: consul-server-config
  namespace: consul
data:
  server.json: |
    {
      "datacenter": "gke-dc",
      "primary_datacenter": "gke-dc",
      "server": true,
      "bootstrap_expect": 3,
      "ui_config": {
        "enabled": true
      },
      "connect": {
        "enabled": true,
        "enable_mesh_gateway_wan_federation": true
      },
      "acl": {
        "enabled": true,
        "default_policy": "deny",
        "enable_token_persistence": true,
        "tokens": {
          "initial_management": "${BOOTSTRAP_TOKEN}",
          "agent": "${BOOTSTRAP_TOKEN}"
        }
      },
      "encrypt": "${GOSSIP_KEY}",
      "verify_incoming": true,
      "verify_outgoing": true,
      "verify_server_hostname": true,
      "ca_file": "/consul/tls/ca/tls.crt",
      "cert_file": "/consul/tls/server/tls.crt",
      "key_file": "/consul/tls/server/tls.key",
      "ports": {
        "https": 8501,
        "grpc": 8502,
        "serf_wan": 8302
      },
      "retry_join_wan": [
        "consul-mesh-gateway.doks-dc.consul:8443"
      ]
    }
```

### Step 5: Consul Server Configuration (AWS - Secondary)

```yaml
# consul/aws-server-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: consul-server-config
  namespace: consul
data:
  server.json: |
    {
      "datacenter": "doks-dc",
      "primary_datacenter": "gke-dc",
      "server": true,
      "bootstrap_expect": 3,
      "connect": {
        "enabled": true,
        "enable_mesh_gateway_wan_federation": true
      },
      "acl": {
        "enabled": true,
        "default_policy": "deny",
        "enable_token_persistence": true,
        "tokens": {
          "replication": "${REPLICATION_TOKEN}",
          "agent": "${REPLICATION_TOKEN}"
        }
      },
      "encrypt": "${GOSSIP_KEY}",
      "verify_incoming": true,
      "verify_outgoing": true,
      "verify_server_hostname": true,
      "ca_file": "/consul/tls/ca/tls.crt",
      "cert_file": "/consul/tls/server/tls.crt",
      "key_file": "/consul/tls/server/tls.key",
      "ports": {
        "https": 8501,
        "grpc": 8502,
        "serf_wan": 8302
      },
      "retry_join_wan": [
        "consul-mesh-gateway.gke-dc.consul:8443"
      ]
    }
```

### Step 6: Deploy Mesh Gateways

```yaml
# consul/mesh-gateway.yaml
apiVersion: consul.hashicorp.com/v1alpha1
kind: MeshGateway
metadata:
  name: mesh-gateway
  namespace: consul
spec:
  replicas: 2
  wanAddress:
    source: Service
    port: 8443
  service:
    type: LoadBalancer
    annotations:
      # GKE: Reserve static IP
      # networking.gke.io/load-balancer-type: "External"
      # AWS: Use NLB
      # service.beta.kubernetes.io/aws-load-balancer-type: "nlb"
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 256Mi
```

### Step 7: WAN Join Script

```bash
#!/bin/bash
# consul-wan-join.sh

set -e

echo "=== Consul WAN Federation Setup ==="

# Get mesh gateway addresses
GKE_MESH_IP=$(kubectl --context=gke-cluster get svc mesh-gateway \
  -n consul -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
AWS_MESH_IP=$(kubectl --context=doks-cluster get svc mesh-gateway \
  -n consul -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

echo "GKE Mesh Gateway: ${GKE_MESH_IP}"
echo "AWS Mesh Gateway: ${AWS_MESH_IP}"

# Update DNS or /etc/hosts for mesh gateway discovery
# (In production, use proper DNS entries)

# Verify WAN members from GKE
kubectl --context=gke-cluster exec -n consul consul-server-0 -- \
  consul members -wan

# Expected output:
# Node                 Address              Status  Type    Build   Protocol  DC      Partition  Segment
# consul-server-0.gke  10.1.0.5:8302        alive   server  1.17.0  2         gke-dc  default    <all>
# consul-server-0.aws  10.0.0.5:8302        alive   server  1.17.0  2         doks-dc  default    <all>

# Verify services are discoverable across datacenters
kubectl --context=gke-cluster exec -n consul consul-server-0 -- \
  consul catalog services -datacenter=doks-dc

echo "=== WAN Federation Complete ==="
```

### Step 8: Health Check Propagation

Configure health checks to propagate across datacenters:

```yaml
# consul/service-defaults.yaml
apiVersion: consul.hashicorp.com/v1alpha1
kind: ServiceDefaults
metadata:
  name: nightscout
  namespace: nightscout-tenants
spec:
  protocol: http
  meshGateway:
    mode: local  # Use local mesh gateway for cross-DC traffic
  expose:
    checks: true  # Expose health checks through mesh gateway
```

### Step 9: Verify Federation Health

```bash
#!/bin/bash
# verify-consul-federation.sh

echo "=== Verifying Consul WAN Federation ==="

# Check WAN members
echo "1. WAN Members:"
kubectl --context=gke-cluster exec -n consul consul-server-0 -- consul members -wan

# Check ACL replication status
echo "2. ACL Replication Status:"
kubectl --context=doks-cluster exec -n consul consul-server-0 -- \
  consul acl replication status -format=json | jq '.'

# Check cross-datacenter service discovery
echo "3. Cross-DC Service Discovery:"
kubectl --context=gke-cluster exec -n consul consul-server-0 -- \
  consul catalog services -datacenter=doks-dc

# Check mesh gateway health
echo "4. Mesh Gateway Health:"
kubectl --context=gke-cluster exec -n consul consul-server-0 -- \
  consul catalog nodes -service=mesh-gateway

# Verify service resolution across DCs
echo "5. Service Resolution Test:"
kubectl --context=gke-cluster exec -n consul consul-server-0 -- \
  consul catalog service nightscout -datacenter=doks-dc

echo "=== Federation Verification Complete ==="
```

### Consul Federation Monitoring

```yaml
# prometheus/consul-federation-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: consul-federation-alerts
spec:
  groups:
  - name: consul-federation
    rules:
    - alert: ConsulWANMemberDown
      expr: |
        consul_serf_wan_member_status != 1
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Consul WAN member unhealthy"
        
    - alert: ConsulACLReplicationLag
      expr: |
        consul_acl_replication_index_diff > 100
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "ACL replication lagging between datacenters"
        
    - alert: MeshGatewayUnavailable
      expr: |
        up{job="consul-mesh-gateway"} == 0
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "Mesh gateway is down"
```
    port: 8443
  service:
    type: LoadBalancer
```

### DNS TTL Playbook

Proper DNS TTL management is critical for zero-downtime migration. This playbook ensures traffic drains before resource deletion.

#### TTL Timeline

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           DNS TTL TIMELINE                                   │
│                                                                              │
│  Normal         T-24h           T-0            T+TTL          T+7d          │
│  Operations     (Pre-Migrate)   (Migrate)      (Verified)     (Cleanup)     │
│  ┌──────────┐   ┌──────────┐    ┌──────────┐   ┌──────────┐   ┌──────────┐ │
│  │TTL: 3600s│──►│TTL: 60s  │───►│TTL: 60s  │──►│TTL: 300s │──►│TTL: 3600s│ │
│  │(1 hour)  │   │(1 minute)│    │Update IP │   │(5 minutes)│  │(1 hour)  │ │
│  └──────────┘   └──────────┘    └──────────┘   └──────────┘   └──────────┘ │
│       │              │               │              │              │        │
│       │              │               │              │              │        │
│  All traffic    Wait for        Switch DNS     Verify traffic   Restore    │
│  to AWS         cache expire    to GKE         on GKE only      normal TTL │
│                 (1 hour)                                                    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Step 1: Lower TTL Before Migration (T-24h)

```bash
#!/bin/bash
# lower-ttl.sh

TENANT_ID=$1
NEW_TTL=60  # 1 minute

# Get current record
CURRENT_IP=$(aws route53 list-resource-record-sets \
  --hosted-zone-id Z123456789 \
  --query "ResourceRecordSets[?Name=='${TENANT_ID}.nightscout.example.com.'].ResourceRecords[0].Value" \
  --output text)

# Update with lower TTL
aws route53 change-resource-record-sets \
  --hosted-zone-id Z123456789 \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "'${TENANT_ID}'.nightscout.example.com",
        "Type": "A",
        "TTL": '${NEW_TTL}',
        "ResourceRecords": [{"Value": "'${CURRENT_IP}'"}]
      }
    }]
  }'

echo "TTL lowered to ${NEW_TTL}s for ${TENANT_ID}"
echo "Wait at least 1 hour (old TTL) before migrating"
```

#### Step 2: Wait for Old TTL to Expire

```bash
#!/bin/bash
# verify-ttl-propagation.sh

TENANT_ID=$1
EXPECTED_TTL=60

# Check TTL from multiple DNS servers
for DNS in 8.8.8.8 1.1.1.1 208.67.222.222; do
  TTL=$(dig +noall +answer ${TENANT_ID}.nightscout.example.com @${DNS} | awk '{print $2}')
  echo "DNS ${DNS}: TTL=${TTL}"
  if [ "$TTL" -gt "$EXPECTED_TTL" ]; then
    echo "⚠️  TTL still high on ${DNS}, wait longer"
  fi
done
```

#### Step 3: Verify Traffic Drain After DNS Switch

```bash
#!/bin/bash
# verify-traffic-drain.sh

TENANT_ID=$1
WAIT_SECONDS=120  # 2x the 60s TTL

echo "Waiting ${WAIT_SECONDS}s for DNS cache expiry..."
sleep ${WAIT_SECONDS}

# Check DOKS pod is receiving no new connections
AWS_CONNECTIONS=$(kubectl --context=doks-cluster exec -n nightscout-tenants \
  $(kubectl --context=doks-cluster get pod -l ns.mdn.io/tenant-id=${TENANT_ID} -n nightscout-tenants -o name 2>/dev/null) \
  -c nightscout -- netstat -an | grep ESTABLISHED | wc -l 2>/dev/null || echo "0")

if [ "$AWS_CONNECTIONS" -gt 0 ]; then
  echo "⚠️  DOKS pod still has ${AWS_CONNECTIONS} connections"
  echo "   Consider extending wait time"
else
  echo "✅ DOKS pod has no active connections"
  echo "   Safe to proceed with cleanup"
fi

# Check GKE pod is receiving traffic
GKE_CONNECTIONS=$(kubectl --context=gke-cluster exec -n nightscout-tenants \
  $(kubectl --context=gke-cluster get pod -l ns.mdn.io/tenant-id=${TENANT_ID} -n nightscout-tenants -o name) \
  -c nightscout -- netstat -an | grep ESTABLISHED | wc -l 2>/dev/null || echo "0")

echo "GKE pod has ${GKE_CONNECTIONS} active connections"
```

#### Step 4: Restore Normal TTL After Validation (T+7d)

```bash
#!/bin/bash
# restore-ttl.sh

TENANT_ID=$1
NORMAL_TTL=3600  # 1 hour

GKE_IP=$(kubectl --context=gke-cluster get svc -n ingress-nginx ingress-nginx-controller \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

aws route53 change-resource-record-sets \
  --hosted-zone-id Z123456789 \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "'${TENANT_ID}'.nightscout.example.com",
        "Type": "A",
        "TTL": '${NORMAL_TTL}',
        "ResourceRecords": [{"Value": "'${GKE_IP}'"}]
      }
    }]
  }'

echo "TTL restored to ${NORMAL_TTL}s for ${TENANT_ID}"
```

### Traffic Shifting Strategy

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TRAFFIC SHIFT TIMELINE                               │
│                                                                              │
│  Pre-Migration    Migration Day    Day +1         Day +7                    │
│  ┌───────────┐    ┌───────────┐    ┌───────────┐  ┌───────────┐            │
│  │ AWS: 100% │───►│ AWS: 100% │───►│ AWS:  0%  │─►│ AWS:  0%  │            │
│  │ GKE:   0% │    │ GKE:   0% │    │ GKE: 100% │  │ GKE: 100% │            │
│  └───────────┘    └───────────┘    └───────────┘  └───────────┘            │
│                   ▲                ▲              ▲                         │
│                   │                │              │                         │
│             Backup/Restore   DNS Switch    DOKS Cleanup                      │
│                 + TTL Lower  + Verify Drain  (After validation)            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Complete Migration Sequence

```bash
#!/bin/bash
# full-migration-sequence.sh
# Cross-cluster data migration: Gen3b (shared MongoDB) → Gen5 (per-tenant PVC)

TENANT_ID=$1

echo "=== Full Migration Sequence for ${TENANT_ID} ==="

# Step 1: Lower TTL (do this 24h before actual migration)
echo "Step 1: Lower DNS TTL"
./lower-ttl.sh ${TENANT_ID}
echo "⏳ Wait 1 hour for TTL propagation before continuing"
echo "   Run: ./verify-ttl-propagation.sh ${TENANT_ID}"
read -p "Press enter when TTL is propagated..."

# Step 2: Create Gen5 tenant on GKE (provisions fresh PVC + MongoDB pod)
echo "Step 2: Create Gen5 tenant on GKE"
kubectx gke-cluster
kubectl apply -f - <<EOF
apiVersion: nightscout.io/v1alpha1
kind: NightscoutTenant
metadata:
  name: ${TENANT_ID}
  namespace: nightscout-tenants
spec:
  storageType: dedicated
  tier: standard
EOF

# Step 3: Wait for GKE pod ready
echo "Step 3: Wait for GKE pod ready"
kubectl wait --for=condition=ready pod \
  -l ns.mdn.io/tenant-id=${TENANT_ID} \
  -n nightscout-tenants \
  --timeout=300s

# Get Consul DNS name for migration target
GKE_POD_CONSUL="${TENANT_ID}.backends.gke-dc.consul"
echo "GKE target: ${GKE_POD_CONSUL}"

# Step 4: Configure and trigger migration job on DOKS
echo "Step 4: Trigger migration job on DOKS"
kubectx doks-cluster
kubectl patch configmap ${TENANT_ID}-config \
  -n nightscout-tenants \
  --type=merge \
  -p '{
    "data": {
      "MIGRATION_ENABLED": "true",
      "MIGRATION_TARGET_CLUSTER": "gke-dc",
      "MIGRATION_TARGET_CONSUL_NAME": "'${GKE_POD_CONSUL}'",
      "MIGRATION_USE_DIRECT_IP": "false"
    },
    "metadata": {
      "annotations": {
        "ns.mdn.io/migration-policy": "cross-cluster",
        "ns.mdn.io/migration-phase": "pending"
      }
    }
  }'

# Trigger migration
kubectl annotate secret ${TENANT_ID}-mongo-auth \
  ns.mdn.io/migration-needed=true --overwrite

# Step 5: Wait for migration job to complete
echo "Step 5: Wait for migration job"
kubectl wait --for=condition=complete job \
  -l ns.mdn.io/tenant-id=${TENANT_ID},ns.mdn.io/migration-type=cross-cluster \
  -n nightscout-tenants \
  --timeout=600s

# Step 6: Update DNS
echo "Step 6: Update DNS to GKE"
./update-tenant-dns.sh ${TENANT_ID} gke

# Step 7: Verify traffic drain
echo "Step 7: Verify traffic drain from DOKS"
./verify-traffic-drain.sh ${TENANT_ID}

# Step 8: Run validation
echo "Step 8: Validate migration"
./validate-migration.sh ${TENANT_ID}

if [ $? -eq 0 ]; then
  echo "=== Migration Successful ==="
  echo "Schedule cleanup for T+7d: ./cleanup-doks-tenant.sh ${TENANT_ID}"
else
  echo "=== Migration Failed - Initiating Rollback ==="
  ./rollback-tenant.sh ${TENANT_ID}
fi
```

### DNS Update Script

```bash
#!/bin/bash
# update-tenant-dns.sh

TENANT_ID=$1
GKE_INGRESS_IP=$(kubectl get svc -n ingress-nginx ingress-nginx-controller \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

# Update Route53 (if using AWS DNS)
aws route53 change-resource-record-sets \
  --hosted-zone-id Z123456789 \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "'${TENANT_ID}'.nightscout.example.com",
        "Type": "A",
        "TTL": 60,
        "ResourceRecords": [{"Value": "'${GKE_INGRESS_IP}'"}]
      }
    }]
  }'

# Or update CloudFlare
# curl -X PUT "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${RECORD_ID}" \
#   -H "Authorization: Bearer ${CF_TOKEN}" \
#   -H "Content-Type: application/json" \
#   --data '{"type":"A","name":"'${TENANT_ID}'.nightscout.example.com","content":"'${GKE_INGRESS_IP}'"}'
```

---

## Rollback Procedures

### Rollback Decision Criteria

| Severity | Condition | Action |
|----------|-----------|--------|
| **Critical** | >5% tenant errors post-migration | Immediate rollback |
| **High** | Data loss detected | Rollback affected tenants |
| **Medium** | Performance degradation >50% | Pause, investigate |
| **Low** | Minor feature issues | Continue, fix forward |

### Per-Tenant Rollback

Rollback is simple because the source data remains intact in the shared MongoDB during the validation period.

```bash
#!/bin/bash
# rollback-tenant.sh

TENANT_ID=$1

echo "=== Rolling back tenant: ${TENANT_ID} ==="

# 1. Update DNS back to DOKS
# (DOKS Gen3b pod is still connected to shared MongoDB with original data)
./update-tenant-dns.sh ${TENANT_ID} doks

# 2. Remove migration annotations to restore original state
kubectx doks-cluster
kubectl annotate configmap ${TENANT_ID}-config \
  ns.mdn.io/migration-phase- \
  ns.mdn.io/migration-policy- \
  ns.mdn.io/migrated-to-

kubectl patch configmap ${TENANT_ID}-config \
  -n nightscout-tenants \
  --type=merge \
  -p '{"data":{"MIGRATION_ENABLED":"false"}}'

# 3. Delete GKE resources (optional - can keep for retry)
kubectx gke-cluster
kubectl delete nightscouttenant ${TENANT_ID} -n nightscout-tenants --ignore-not-found

# 4. Verify DOKS pod still healthy
kubectx doks-cluster
kubectl get pod -l ns.mdn.io/tenant-id=${TENANT_ID} -n nightscout-tenants

# 5. Update Consul
consul kv put "nightscout/tenants/${TENANT_ID}/cluster" "doks-cluster"

echo "=== Rollback complete: ${TENANT_ID} ==="
echo "Note: Source data in shared MongoDB was never modified"
```

### Full Migration Rollback

For catastrophic failures requiring full rollback:

```bash
#!/bin/bash
# rollback-all.sh

# 1. Stop all GKE workloads
kubectx gke-cluster
kubectl scale deployment --all --replicas=0 -n nightscout-tenants

# 2. Update global DNS to AWS
./update-global-dns.sh aws

# 3. Verify AWS cluster healthy
kubectx doks-cluster
kubectl get pods -n nightscout-tenants | grep -v Running

# 4. Re-enable AWS autoscaling
kubectl patch hpa nightscout-tenants -p '{"spec":{"minReplicas":3}}'

# 5. Alert team
./send-alert.sh "Migration rollback initiated - all traffic on AWS"
```

### Rollback Testing

Before production migration, test rollback procedures:

```bash
# 1. Migrate test tenant to GKE
./migrate-tenant.sh test-tenant-001

# 2. Verify working on GKE
curl https://test-tenant-001.nightscout.example.com/api/v1/status

# 3. Simulate failure and rollback
./rollback-tenant.sh test-tenant-001 test-tenant-001-pre-migration

# 4. Verify working on AWS
curl https://test-tenant-001.nightscout.example.com/api/v1/status

# 5. Document timing
echo "Rollback completed in ${SECONDS} seconds"
```

---

## Monitoring and Observability

### Cross-Cluster Metrics

```yaml
# prometheus/federation-scrape.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-federation
data:
  prometheus.yml: |
    global:
      scrape_interval: 15s
    
    scrape_configs:
    # Federate metrics from AWS cluster
    - job_name: 'federate-aws'
      honor_labels: true
      metrics_path: '/federate'
      params:
        'match[]':
        - '{job=~"nightscout.*"}'
        - '{__name__=~"mongodb.*"}'
      static_configs:
      - targets:
        - 'prometheus.doks-cluster.svc.cluster.local:9090'
      relabel_configs:
      - source_labels: [__address__]
        target_label: cluster
        replacement: doks-cluster
    
    # Local GKE scrape
    - job_name: 'nightscout-gke'
      kubernetes_sd_configs:
      - role: pod
        namespaces:
          names: ['nightscout-tenants']
```

### Migration Progress Dashboard

```yaml
# grafana/migration-dashboard.json
{
  "title": "Federation Migration Progress",
  "panels": [
    {
      "title": "Tenants by Cluster",
      "type": "piechart",
      "targets": [
        {
          "expr": "count(kube_pod_info{namespace='nightscout-tenants'}) by (cluster)"
        }
      ]
    },
    {
      "title": "Migration Rate (tenants/hour)",
      "type": "graph",
      "targets": [
        {
          "expr": "increase(velero_restore_success_total[1h])"
        }
      ]
    },
    {
      "title": "Migration Errors",
      "type": "graph",
      "targets": [
        {
          "expr": "increase(velero_restore_failed_total[1h])"
        }
      ]
    },
    {
      "title": "Cross-Cluster Latency",
      "type": "graph",
      "targets": [
        {
          "expr": "histogram_quantile(0.99, consul_rpc_request_seconds_bucket)"
        }
      ]
    }
  ]
}
```

### Alerting Rules

```yaml
# prometheus/migration-alerts.yaml
groups:
- name: migration-alerts
  rules:
  - alert: MigrationBackupFailed
    expr: velero_backup_failure_total > 0
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "Velero backup failed"
      runbook: "https://runbooks.example.com/migration/backup-failed"
  
  - alert: MigrationRestoreFailed
    expr: velero_restore_failure_total > 0
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "Velero restore failed"
      runbook: "https://runbooks.example.com/migration/restore-failed"
  
  - alert: TenantUnhealthyPostMigration
    expr: |
      (time() - kube_pod_created{namespace="nightscout-tenants"}) < 3600
      and
      kube_pod_status_phase{phase!="Running"} == 1
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "Recently migrated tenant pod not healthy"
  
  - alert: CrossClusterNetworkDown
    expr: up{job="federate-aws"} == 0
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "Cannot reach AWS cluster from GKE"
```

---

## Timeline and Milestones

### Detailed Schedule

| Week | Phase | Activities | Success Criteria |
|------|-------|------------|------------------|
| **1** | Setup | GKE provisioning, networking | Cluster operational, 128 volumes confirmed |
| **2** | Setup | Federation install, Velero | Both clusters federated, backup/restore working |
| **3** | Parallel | Gen 5 on GKE, monitoring | New tenants provisioning on GKE |
| **4** | Parallel | Runbook testing, load test | 10 test tenants migrated successfully |
| **5** | Migrate | Batch 1: 50 inactive tenants | All tenants healthy on GKE |
| **6** | Migrate | Batch 2: 50 low-activity tenants | Migration time <30min per tenant |
| **7** | Migrate | Batch 3: 50 standard tenants | Zero data loss incidents |
| **8** | Migrate | Batch 4: 50 remaining tenants | All tenants on GKE |
| **9** | Cleanup | AWS resource deletion | 50% cost reduction |
| **10** | Cleanup | Federation removal, consolidation | Single-cluster operation |

### Go/No-Go Criteria

**Phase 2 → Phase 3 (Start Migration):**
- [ ] GKE cluster stable for 7 days
- [ ] 10+ test tenants migrated and validated
- [ ] Rollback tested and documented
- [ ] Cross-cluster networking stable (99.9% uptime)
- [ ] Monitoring and alerting operational

**Phase 3 → Phase 4 (Start Cleanup):**
- [ ] All tenants migrated to GKE
- [ ] Zero critical incidents in 7 days
- [ ] All rollback tickets resolved
- [ ] Cost analysis confirms savings

---

## Risk Assessment

### Identified Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| **Data loss during migration** | Low | Critical | Velero backups, validation scripts, rollback procedures |
| **Network partition between clusters** | Medium | High | VPN redundancy, circuit breakers, async operations |
| **GKE volume limits change** | Low | High | Monitor GCP announcements, plan B (ephemeral storage) |
| **Performance degradation on GKE** | Medium | Medium | Load testing, node right-sizing, gradual rollout |
| **Cost overrun during migration** | Medium | Low | Parallel cluster budget, aggressive AWS cleanup |
| **Consul federation issues** | Low | Medium | Mesh gateway redundancy, manual DNS failover |

### Contingency Plans

**If GKE proves unsuitable:**
1. Pivot to Azure AKS (64 volume limit, still 2x improvement)
2. Implement ephemeral storage on current provider
3. Hybrid approach: ephemeral for new tenants, PVC for existing

**If migration velocity too slow:**
1. Increase parallelism (multiple tenant batches)
2. Skip validation for low-risk tenants
3. Accept longer timeline

---

## Comparison: Federation vs Ephemeral Storage

### Decision Matrix

| Factor | Weight | Federation (GKE) | Ephemeral Storage | Winner |
|--------|--------|------------------|-------------------|--------|
| **Implementation Complexity** | 20% | Low (proven tools) | High (custom CDC) | Federation |
| **Data Durability** | 25% | Full | 1-2 min window | Federation |
| **Operational Overhead** | 20% | Medium (multi-cluster) | High (Kafka ops) | Federation |
| **Scalability Ceiling** | 15% | 128/node (finite) | Unlimited | Ephemeral |
| **Provider Flexibility** | 10% | GKE lock-in | Any provider | Ephemeral |
| **Time to Implement** | 10% | 10 weeks | 8 weeks | Ephemeral |

**Weighted Score:**
- Federation: 78/100
- Ephemeral: 65/100

### Recommendation Summary

**Choose Federation Migration if:**
- Current tenant count <5,000
- Data durability is critical
- Team prefers proven Kubernetes patterns
- GKE pricing is acceptable
- Multi-cloud is not a near-term requirement

**Choose Ephemeral Storage if:**
- Tenant count approaching 10,000+
- 1-2 minute data loss is acceptable
- Multi-cloud redundancy required
- Team has Kafka/streaming expertise
- Provider lock-in must be avoided

**For Nightscout's current situation: Federation Migration is recommended.**

---

## Appendix

### A. Commands Reference

```bash
# Federation status
kubefedctl status --all

# Cluster health
kubectl get kubefedclusters -n kube-federation-system

# Migration progress
velero backup get
velero restore get

# Tenant lookup by cluster
kubectl get pods -n nightscout-tenants --context=doks-cluster -l ns.mdn.io/tenant-id=<id>
kubectl get pods -n nightscout-tenants --context=gke-cluster -l ns.mdn.io/tenant-id=<id>

# Cross-cluster Consul query
consul catalog services -datacenter=doks-dc
consul catalog services -datacenter=gke-dc
```

### B. Related Documentation

- [EPHEMERAL-STORAGE-PROPOSAL.md](EPHEMERAL-STORAGE-PROPOSAL.md) - Alternative approach
- [ARCHITECTURE-EVOLUTION.md](ARCHITECTURE-EVOLUTION.md) - Historical context
- [MIGRATION-PLAYBOOK.md](MIGRATION-PLAYBOOK.md) - Existing migration procedures
- [TANKA-DEPLOYMENT.md](TANKA-DEPLOYMENT.md) - Deployment automation

### C. External References

- [KubeFed User Guide](https://github.com/kubernetes-sigs/kubefed/blob/master/docs/userguide.md)
- [Velero Documentation](https://velero.io/docs/)
- [Consul WAN Federation](https://developer.hashicorp.com/consul/docs/east-west/wan-federation)
- [GKE Volume Limits](https://cloud.google.com/kubernetes-engine/docs/concepts/persistent-volumes)
