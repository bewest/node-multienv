# Labels and Annotations Analysis

## Overview

This document provides a comprehensive review of all labels and annotations used in the project, compares them against Kubernetes best practices, and provides recommendations for standardization.

## Current State

### Custom Domain Labels

#### `ns.mdn.io/*` (Namespace: Nightscout MDN)
| Label/Annotation | Type | Usage | Resources |
|------------------|------|-------|-----------|
| `ns.mdn.io/enabled` | Label | Marks ConfigMaps as parent resources | ConfigMap (parent only) |
| `ns.mdn.io/tenant` | Label | Identifies tenant ID | All child resources |
| `ns.mdn.io/backup-policy` | Annotation | Defines backup strategy | PVC |
| `ns.mdn.io/backup-ttl` | Annotation | Backup retention period | PVC |

#### `mdn.io/*` (Inconsistent prefix)
| Label/Annotation | Type | Usage | Resources |
|------------------|------|-------|-----------|
| `mdn.io/backup-protect` | Finalizer | Prevents PVC deletion until snapshot | PVC |

### Standard Kubernetes Labels

#### `app.kubernetes.io/*` (Recommended)
| Label | Current Usage | Missing From |
|-------|---------------|--------------|
| `app.kubernetes.io/name` | ✅ Most resources | - |
| `app.kubernetes.io/part-of` | ✅ Some resources | Pod templates, Kafka resources |
| `app.kubernetes.io/component` | ❌ Not used | All resources |
| `app.kubernetes.io/instance` | ❌ Not used | All resources |
| `app.kubernetes.io/version` | ❌ Not used | All resources |
| `app.kubernetes.io/managed-by` | ❌ Not used | All resources |

### Third-Party Labels

#### `strimzi.io/*` (Strimzi Kafka Operator)
| Label | Usage | Resources |
|-------|-------|-----------|
| `strimzi.io/cluster` | Required by Strimzi | KafkaTopic, KafkaConnector |

## Issues Identified

### 🔴 Critical Issues

1. **Finalizer Prefix Inconsistency**
   - **Current:** `mdn.io/backup-protect`
   - **Should be:** `ns.mdn.io/backup-protect`
   - **Impact:** Breaks namespace consistency, harder to audit

2. **Missing Pod Template Labels**
   - **Issue:** Nightscout pod template drops `app.kubernetes.io/part-of`
   - **Impact:** Breaks grouping and observability queries
   - **Example:**
     ```bash
     # This won't find Nightscout pods
     kubectl get pods -l app.kubernetes.io/part-of=nightscout-tenant
     ```

3. **Parent Label Not Propagated**
   - **Issue:** `ns.mdn.io/enabled: "true"` only on ConfigMap
   - **Impact:** Can't easily discover all resources belonging to enabled tenants
   - **Current:**
     ```bash
     # Only finds ConfigMaps
     kubectl get all -l ns.mdn.io/enabled=true  # ❌ Returns nothing
     ```

### 🟡 Warning Issues

4. **Incomplete Standard Labels**
   - **Missing:** `component`, `instance`, `managed-by`, `version`
   - **Impact:** Reduced observability, tooling compatibility
   - **Tools affected:** Kubernetes Dashboard, Prometheus, Service Mesh

5. **Kafka Resources Underspecified**
   - **Current:** Only `strimzi.io/cluster` + `ns.mdn.io/tenant`
   - **Impact:** Hard to map topics/connectors to tenant stack without joins

6. **No Observability Annotations**
   - **Missing:** Owner, environment, cost center, contact info
   - **Impact:** Reduced operational context

## Recommendations

### Phase 1: Critical Fixes

#### 1. Align Finalizer Prefix

**Change:**
```diff
- finalizers: ["mdn.io/backup-protect"]
+ finalizers: ["ns.mdn.io/backup-protect"]
```

**Rationale:** Consistent namespace across all custom metadata

#### 2. Add Full Standard Label Set

Apply to **all resources** (including pod templates):

```yaml
labels:
  # Identity
  app.kubernetes.io/name: "nightscout"           # Component name
  app.kubernetes.io/component: "application"     # Role (application, database, queue, etc.)
  app.kubernetes.io/part-of: "nightscout-tenant" # Parent application
  
  # Instance tracking
  app.kubernetes.io/instance: "{{ tenantId }}"   # Unique tenant identifier
  app.kubernetes.io/version: "{{ version }}"     # Image version/tag
  
  # Management
  app.kubernetes.io/managed-by: "metacontroller" # Who manages this
  
  # Custom
  ns.mdn.io/tenant: "{{ tenantId }}"             # Tenant ID
```

#### 3. Fix Pod Template Labels

Ensure Nightscout Deployment pod template includes:
```yaml
spec:
  template:
    metadata:
      labels:
        app.kubernetes.io/name: "nightscout"
        app.kubernetes.io/part-of: "nightscout-tenant"  # ← ADD THIS
        app.kubernetes.io/instance: "{{ tenantId }}"     # ← ADD THIS
        ns.mdn.io/tenant: "{{ tenantId }}"
```

#### 4. Propagate Enabled Label

**Option A:** Add to all children (if needed for discovery)
```yaml
labels:
  ns.mdn.io/enabled: "true"
```

**Option B:** Replace with more specific label
```yaml
labels:
  ns.mdn.io/controller: "nightscout-tenant-controller"
```

### Phase 2: Enhanced Observability

#### 5. Add Component-Specific Labels

```yaml
# MongoDB resources
labels:
  app.kubernetes.io/name: "mongodb"
  app.kubernetes.io/component: "database"
  app.kubernetes.io/part-of: "nightscout-tenant"
  app.kubernetes.io/instance: "{{ tenantId }}"
  app.kubernetes.io/version: "6"
  app.kubernetes.io/managed-by: "metacontroller"

# Nightscout resources
labels:
  app.kubernetes.io/name: "nightscout"
  app.kubernetes.io/component: "application"
  app.kubernetes.io/part-of: "nightscout-tenant"
  app.kubernetes.io/instance: "{{ tenantId }}"
  app.kubernetes.io/version: "{{ nsVersion }}"
  app.kubernetes.io/managed-by: "metacontroller"

# Kafka resources
labels:
  app.kubernetes.io/name: "kafka-cdc"
  app.kubernetes.io/component: "messaging"
  app.kubernetes.io/part-of: "nightscout-tenant"
  app.kubernetes.io/instance: "{{ tenantId }}"
  app.kubernetes.io/managed-by: "metacontroller"
  strimzi.io/cluster: "kafka-cluster"
```

#### 6. Add Operational Annotations

```yaml
annotations:
  # Ownership
  ns.mdn.io/owner: "team-name"
  ns.mdn.io/contact: "email@example.com"
  
  # Environment
  ns.mdn.io/environment: "production"  # or staging, dev
  ns.mdn.io/tenant-tier: "premium"     # or basic, enterprise
  
  # Cost tracking
  ns.mdn.io/cost-center: "CC-12345"
  ns.mdn.io/billing-id: "customer-xyz"
  
  # Documentation
  ns.mdn.io/docs-url: "https://docs.example.com/tenants/{{ tenantId }}"
  
  # Compliance
  ns.mdn.io/data-classification: "phi"  # PHI, PII, public
  ns.mdn.io/retention-policy: "7-years"
```

### Phase 3: Advanced Features

#### 7. Add Version Tracking

Track versions for change management:
```yaml
annotations:
  ns.mdn.io/template-version: "v1.2.0"
  ns.mdn.io/created-at: "2025-10-24T00:00:00Z"
  ns.mdn.io/updated-at: "2025-10-24T12:30:00Z"
  ns.mdn.io/created-by: "admin@example.com"
```

#### 8. Add Dependency Tracking

```yaml
annotations:
  ns.mdn.io/depends-on: "mongodb,kafka-cluster"
  ns.mdn.io/required-by: "ingress-controller"
```

## Proposed Standard Label Set

### Minimal (Phase 1)

```javascript
function standardLabels(tenantId, name, component) {
  return {
    // Standard Kubernetes
    'app.kubernetes.io/name': name,
    'app.kubernetes.io/component': component,
    'app.kubernetes.io/part-of': 'nightscout-tenant',
    'app.kubernetes.io/instance': tenantId,
    'app.kubernetes.io/managed-by': 'metacontroller',
    
    // Custom
    'ns.mdn.io/tenant': tenantId
  };
}

// Usage examples:
standardLabels('demo', 'mongodb', 'database')
standardLabels('demo', 'nightscout', 'application')
standardLabels('demo', 'kafka-cdc', 'messaging')
```

### Complete (Phase 2)

```javascript
function standardLabels(tenantId, name, component, version) {
  return {
    // Standard Kubernetes
    'app.kubernetes.io/name': name,
    'app.kubernetes.io/component': component,
    'app.kubernetes.io/part-of': 'nightscout-tenant',
    'app.kubernetes.io/instance': tenantId,
    'app.kubernetes.io/version': version,
    'app.kubernetes.io/managed-by': 'metacontroller',
    
    // Custom
    'ns.mdn.io/tenant': tenantId,
    'ns.mdn.io/controller': 'nightscout-tenant-controller'
  };
}

function operationalAnnotations(tenant) {
  return {
    'ns.mdn.io/owner': tenant.owner || '',
    'ns.mdn.io/environment': tenant.environment || 'production',
    'ns.mdn.io/tenant-tier': tenant.tier || 'basic',
    'ns.mdn.io/created-at': new Date().toISOString()
  };
}
```

## Migration Plan

### Step 1: Update Finalizer (Non-breaking)
```javascript
// handlers/decorator-sync.js
finalizers: ['ns.mdn.io/backup-protect']  // was: mdn.io/backup-protect
```

### Step 2: Add Standard Labels (Backward compatible)
```javascript
// handlers/resources.js
const baseLabels = {
  'app.kubernetes.io/name': componentName,
  'app.kubernetes.io/component': componentType,
  'app.kubernetes.io/part-of': 'nightscout-tenant',
  'app.kubernetes.io/instance': tenantId,
  'app.kubernetes.io/managed-by': 'metacontroller',
  'ns.mdn.io/tenant': tenantId
};
```

### Step 3: Fix Pod Templates (Breaking for selectors)
Ensure all Deployment/StatefulSet pod templates include full label set.

**⚠️ Caution:** Changing labels used in selectors requires resource recreation.

### Step 4: Add Versions (Optional)
Extract version from images and add to labels:
```javascript
const nsVersion = parent.data?.NS_IMAGE?.split(':')[1] || 'latest';
labels['app.kubernetes.io/version'] = nsVersion;
```

### Step 5: Add Operational Annotations (Optional)
Allow users to specify in ConfigMap:
```yaml
data:
  TENANT_ID: "demo"
  OWNER: "team-cgm"
  ENVIRONMENT: "production"
  TIER: "premium"
```

## Validation Queries

After migration, these queries should work:

```bash
# All resources for a tenant
kubectl get all -l app.kubernetes.io/instance=demo

# All database components
kubectl get all -l app.kubernetes.io/component=database

# All Nightscout tenant resources
kubectl get all -l app.kubernetes.io/part-of=nightscout-tenant

# All Metacontroller-managed resources
kubectl get all -l app.kubernetes.io/managed-by=metacontroller

# Specific tenant's Nightscout pods
kubectl get pods -l app.kubernetes.io/name=nightscout,app.kubernetes.io/instance=demo

# All MongoDB instances across tenants
kubectl get sts -l app.kubernetes.io/name=mongodb

# Premium tier tenants
kubectl get cm -l ns.mdn.io/tenant-tier=premium
```

## Best Practices Compliance

### ✅ Aligned with Kubernetes Recommendations

- [Recommended Labels](https://kubernetes.io/docs/concepts/overview/working-with-objects/common-labels/)
- Domain-qualified custom labels
- Consistent naming (lowercase, hyphens)
- Meaningful semantic grouping

### ✅ Aligned with Industry Standards

- [OpenTelemetry Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/)
- [Prometheus Labeling](https://prometheus.io/docs/practices/naming/)
- [Service Mesh Compatibility](https://istio.io/latest/docs/ops/deployment/requirements/)

## Summary

### Current Issues
- ❌ Inconsistent finalizer prefix (`mdn.io` vs `ns.mdn.io`)
- ❌ Missing standard Kubernetes labels (component, instance, managed-by, version)
- ❌ Pod template label inconsistency
- ❌ Parent label not propagated to children
- ❌ Kafka resources underspecified

### Recommended Changes
1. **Critical:** Align finalizer to `ns.mdn.io/backup-protect`
2. **Critical:** Add full standard label set to all resources
3. **Critical:** Fix pod template labels
4. **Important:** Add component-specific labels
5. **Optional:** Add operational annotations
6. **Optional:** Add version tracking

### Benefits
- 🎯 Improved discoverability
- 📊 Better observability and monitoring
- 🔍 Consistent querying across resources
- 🤝 Tooling compatibility (Dashboard, Prometheus, Service Mesh)
- 📝 Operational context for support teams

---

**Next Step:** Implement Phase 1 critical fixes in `handlers/resources.js`
