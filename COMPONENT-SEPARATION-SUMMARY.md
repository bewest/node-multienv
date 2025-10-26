# Component Separation: Demuxer vs Resolver

## Critical Architectural Distinction

This document clarifies the separation between two distinct components that serve different interfaces:

### 1. Demuxer / tenant-availability-keeper
**Purpose:** Routes **internal admin change requests** to the correct runner's environs API  
**Interface:** Administration Interface  
**Technology:** Uses cluster's nginx config  
**Generations:** Gen 2, Gen 3a **ONLY**  
**Not used in:** Gen 1 (single master.js, no routing needed), Gen 3b+ (replaced by direct k8s API)  
**Why introduced (Gen 2):** StatefulSet with multiple runner pods needed routing infrastructure to mesh configuration changes to tenant instances  
**Why eliminated (Gen 3b):** Switch from runners to deployment-per-tenant meant routing infrastructure wasn't needed; ConfigMap changes directly influence deployment runtime through k8s API (not through runner admin API)

### 2. Resolver (redirector-server)
**Purpose:** Proxies **external user traffic** from service port to NS instance backends  
**Interface:** Traffic Serving Interface  
**Generations:** ALL (Gen 1, Gen 2, Gen 3a, Gen 3b, Gen 4) - persistent across **all** generations  
**Technology:** Consul + nginx coupling  
**Persistent:** Never scaled down, fundamental to all architectures, unchanged across generations

---

## Two-Interface Architecture

### Admin Interface (Configuration Management)
How tenant configurations are managed and updated:

| Generation | Implementation | Internal Routing |
|------------|----------------|------------------|
| Gen 1 | REST API on `.env` files | N/A (file-based) |
| Gen 2 | REST API on ConfigMaps | Demuxer routes admin changes to StatefulSet runners |
| Gen 3a | ConfigMap watch | Demuxer propagates ConfigMap changes to StatefulSet runners |
| Gen 3b | Dispatcher + deployment-controller | Dispatcher watches ConfigMaps, deployment-operator watches pods. **Kept the watches, added another watch, made work more declarative** (runners, clusters, demuxers scaled down) |
| Gen 4 | Metacontroller webhooks | Fully declarative |

### Traffic Serving Interface (External User Requests)
How external user HTTP requests reach Nightscout instances:

| Generation | Implementation | Consul Updates |
|------------|----------------|----------------|
| Gen 1 | Resolver → tenant processes | `master.js` manually updates Consul |
| Gen 2 | Resolver → StatefulSet runners | `master.js` manually updates Consul |
| Gen 3a | Resolver → StatefulSet runners | `master.js` manually updates Consul |
| Gen 3b | Resolver → per-tenant Deployments | deployment-operator watches pods, updates Consul |
| Gen 4 | Resolver → per-tenant Deployments | Automatic Consul updates |

---

## Key Corrections Made

### Previous Confusion
❌ "demuxer routes traffic to StatefulSet members via Consul"  
❌ "Resolver (demuxer)"  
❌ Conflating admin routing with traffic serving

### Current Clarity
✅ **Demuxer/tenant-availability-keeper**: Routes internal admin change requests (Gen 2, Gen 3a only)  
✅ **Resolver**: Proxies external user traffic to NS backends (ALL generations)  
✅ Clear separation of administration vs. traffic serving interfaces

---

## Architecture Diagrams Updated

### Gen 2 and Gen 3a Now Show:
```
ADMIN INTERFACE (Internal Change Requests):
  ConfigMaps → Demuxer/tenant-availability-keeper → StatefulSet runners
  (Uses cluster's nginx config)

TRAFFIC SERVING INTERFACE (External User Requests):
  Resolver → NS instance backends via Consul + nginx coupling
```

### Gen 3b Shows:
```
ADMIN INTERFACE:
  ConfigMaps → Dispatcher → deployment-controller → Deployments
  (Demuxer and runners scaled down)

TRAFFIC SERVING INTERFACE:
  Resolver → Deployments via Consul + nginx coupling
  (deployment-operator watches pods, updates Consul)
```

---

## The Gen 3a → Gen 3b Transition

### What Changed: Tenant Per Process → Tenant Per Deployment

**Gen 3a (Tenant per process):**
- StatefulSet of master.js runners
- Each runner manages multiple tenant processes
- Demuxer routes admin changes to runners
- ConfigMap watch triggers demuxer propagation

**Gen 3b (Tenant per deployment):**
- Per-tenant Kubernetes Deployments
- Each tenant gets isolated Deployment
- Dispatcher watches ConfigMaps → creates Deployments
- deployment-operator watches pods → updates Consul

### What Was Kept vs Scaled Down

**Scaled Down:**
- ❌ Runners (StatefulSet of master.js)
- ❌ Clusters (multi-instance coordination)
- ❌ Demuxers (tenant-availability-keeper for admin routing)

**Kept:**
- ✅ ConfigMap watches (dispatcher continues watching ConfigMaps)

**Added:**
- ✅ Pod watches (deployment-operator watches pods for Consul registration)

**Made More Declarative:**
- Instead of streaming changes to stateful runners
- Declaratively create/update per-tenant Deployments
- Let Kubernetes manage pod lifecycle

### The Tipping Point: Gen 3b → Gen 4

**The Critical Insight:**
When the **second watch** (pod watch) was added to the ConfigMap watch in Gen 3b, it became clear that managing resources would need to handle an **arbitrarily large number of resources** per tenant - not just a single Deployment, but 11-12 resources:
- MongoDB StatefulSet, Service, Secret
- Nightscout Deployment, Service
- Kafka Topic, Kafka Connector
- PVCs, PodDisruptionBudgets
- Migration Jobs, VolumeSnapshots

**The Design Change:**
This forced evolving from **a single inline async callback using the k8s API** to needing to **expressively declare the set of desired resources**. This requirement tipped the design toward Metacontroller's declarative webhook pattern, where the webhook returns a complete manifest of all desired child resources.

---

## Consul Update Evolution

### Manual Updates (Gen 1-3a)
`master.js` running inside StatefulSet runners manually updates Consul based on internal process state.

### Automatic Updates (Gen 3b+)
`deployment-operator` watches pod lifecycle events and automatically updates Consul registration.

---

## Design Rationale

**Why Resolver + Consul persists across ALL generations:**
- Ensures traffic workload runs on scalable worker nodes, not control plane
- Provides horizontal scaling for traffic capacity
- Consul enables dynamic service discovery for healthy backends
- Architecture-independent pattern that works regardless of admin interface implementation

**Why Demuxer was only temporary (Gen 2-3a):**
- Needed to route admin changes to stateful runners in multi-instance setup
- Once per-tenant Deployments replaced StatefulSet runners, admin routing became direct (dispatcher → deployment-controller)
- No longer needed for StatefulSet coordination

---

## Current State

**Production:** Gen 3b (Deployment controller with ConfigMap/pod watches)  
**Work-in-Progress:** Gen 4 (Metacontroller-based)

### Gen 3b Key Innovations
- ConfigMap changes → k8s API → Deployments (direct control)
- Both runners and demuxer mesh infrastructure **eliminated**
- Resolver component remains unchanged from previous generations
- deployment-operator watches pods and automatically updates Consul

---

## Documentation Updated

✅ **replit.md** - Two-Interface Design section corrected, current state noted  
✅ **docs/ARCHITECTURE-EVOLUTION.md** - Gen 2, Gen 3a, Gen 3b architecture diagrams updated  
✅ **docs/ARCHITECTURE-EVOLUTION.md** - Key Characteristics sections clarified  
✅ **docs/ARCHITECTURE-EVOLUTION.md** - Two-Interface Architecture section corrected  
✅ **docs/ARCHITECTURE-EVOLUTION.md** - Status table updated (Gen 3b = Current, Gen 4 = WIP)  
✅ **COMPONENT-SEPARATION-SUMMARY.md** - Demuxer usage clarified (Gen 2-3a only)
