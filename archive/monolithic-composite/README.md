# Monolithic Composite Controller (Not Shipped)

## Overview

This directory contains the **monolithic composite controller** implementation that was developed during Gen 4 exploration but **not shipped to production**.

## What It Was

A single Metacontroller composite that managed all tenant resources from a single ConfigMap parent:

**Parent**: ConfigMap
**Children**:
- MongoDB StatefulSet + Service
- Nightscout Deployment + Service
- Migration Jobs (if enabled)
- Kafka Topics + Connectors (if CDC enabled)
- PodDisruptionBudgets

**Endpoint**: `/composite/sync`

## Why It Wasn't Shipped

### The Tipping Point Decision (Gen 3b → Gen 4)

When Gen 3b added a **second watch** (pod watch in addition to ConfigMap watch), it became clear that managing resources would need to handle an **arbitrarily large number of resources** per tenant - not just a single Deployment, but 11-12 resources:

- MongoDB StatefulSet, Service, Secret
- Nightscout Deployment, Service
- Kafka Topic, Kafka Connector
- PVCs, PodDisruptionBudgets
- Migration Jobs, VolumeSnapshots

This forced a fundamental design change: from **a single inline async callback using the k8s API** to needing to **expressively declare the set of desired resources**. This tipped the design toward Metacontroller's declarative webhook pattern.

### Critical Problem: Credential Isolation

The monolithic approach had a **security issue**: 

- **All configuration** (including MongoDB credentials) lived in the ConfigMap
- **The environs API** (administration interface) could see ConfigMap contents
- **Result**: API had access to database credentials (violation of least privilege)

### Solution: Two-Composite Architecture

Instead of one composite, we split into **two separate composites**:

1. **Storage Composite** (Secret → MongoDB + Migration)
   - Credentials in Secret (not visible to environs API)
   - Migration as storage-layer concern
   - Blast radius protection via related resources

2. **Compute Composite** (ConfigMap → Nightscout + CDC)
   - Application configuration only
   - No credential access
   - Discovers storage via labels

## Key Design Decisions Documented

See `docs/ARCHITECTURE-EVOLUTION.md` for the full ADR-style documentation of:

1. **Two-Composite vs Monolithic** - Why we chose separation
2. **Annotation-Driven Migration** - Storage-layer concern, not compute
3. **Related Resources Pattern** - Blast radius protection
4. **Credential Isolation** - Secret vs ConfigMap separation

## Files Archived

- `composite-sync.js` - Monolithic sync handler (11-12 resources per tenant)
- `composite-finalize.js` - Cleanup handler for monolithic approach

## What Shipped Instead

**Two-Composite Architecture** (Gen 4):
- Storage: `storage-composite-sync.js` (Secret → MongoDB + Migration)
- Compute: `compute-composite-sync.js` (ConfigMap → Nightscout + CDC)

See `docs/TWO-COMPOSITE-ARCHITECTURE.md` for implementation details.

## Lessons Learned

1. **Separation of Concerns**: Credentials should never mix with application config
2. **Security First**: API surface area matters - limit what each interface can access
3. **Blast Radius**: Related resources prevent cascading deletions
4. **Migration Placement**: Migration is a storage lifecycle event, not a deployment event
5. **Declarative Wins**: Managing 11-12 resources requires declarative manifests, not imperative code

---

**Archived**: January 2025  
**Status**: Exploratory implementation, not shipped  
**Replaced by**: Two-composite architecture (storage + compute)
