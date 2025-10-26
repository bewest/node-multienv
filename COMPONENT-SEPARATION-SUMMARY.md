# Component Separation: Demuxer vs Resolver

## Critical Architectural Distinction

This document clarifies the separation between two distinct components that serve different interfaces:

### 1. Demuxer / tenant-availability-keeper
**Purpose:** Routes **internal admin change requests** to StatefulSet runners  
**Interface:** Administration Interface  
**Technology:** Uses cluster's nginx config  
**Generations:** Gen 2, Gen 3a only  
**Scaled Down:** Gen 3b (replaced by dispatcher + deployment-controller)

### 2. Resolver
**Purpose:** Proxies **external user traffic** from service port to NS instance backends  
**Interface:** Traffic Serving Interface  
**Technology:** Consul + nginx coupling  
**Generations:** ALL (Gen 1, Gen 2, Gen 3a, Gen 3b, Gen 4)  
**Persistent:** Never scaled down, fundamental to all architectures

---

## Two-Interface Architecture

### Admin Interface (Configuration Management)
How tenant configurations are managed and updated:

| Generation | Implementation | Internal Routing |
|------------|----------------|------------------|
| Gen 1 | REST API on `.env` files | N/A (file-based) |
| Gen 2 | REST API on ConfigMaps | Demuxer routes admin changes to StatefulSet runners |
| Gen 3a | ConfigMap watch | Demuxer propagates ConfigMap changes to StatefulSet runners |
| Gen 3b | Dispatcher + deployment-controller | Creates per-tenant Deployments (demuxer scaled down) |
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

## Documentation Updated

✅ **replit.md** - Two-Interface Design section corrected  
✅ **docs/ARCHITECTURE-EVOLUTION.md** - Gen 2, Gen 3a, Gen 3b architecture diagrams updated  
✅ **docs/ARCHITECTURE-EVOLUTION.md** - Key Characteristics sections clarified  
✅ **docs/ARCHITECTURE-EVOLUTION.md** - Two-Interface Architecture section corrected
