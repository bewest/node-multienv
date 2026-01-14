# Labels and Annotations Currently in Production Code

## Summary of Labels/Annotations in Use

Based on analysis of the codebase (webhook handlers and controller manifests), here are **all** the labels and annotations currently being applied.

## Labels in Use

### Standard Kubernetes Labels (`app.kubernetes.io/*`)

| Label | Values | Applied To | Consistency |
|-------|--------|-----------|-------------|
| `app.kubernetes.io/name` | `ns-mongo`, `nightscout` | All resources | ✅ Consistent |
| `app.kubernetes.io/part-of` | `nightscout-tenant` | Most resources | ⚠️ **Missing from pod templates** |

**Issues:**
- ❌ **Pod templates missing `app.kubernetes.io/part-of`** (line 246-247 in resources.js)
- ❌ Missing: `component`, `instance`, `managed-by`, `version`

### Custom Domain Labels (`ns.mdn.io/*`)

| Label | Values | Applied To | Usage |
|-------|--------|-----------|--------|
| `ns.mdn.io/enabled` | `"true"` | ConfigMap (parent only) | Controller selector |
| `ns.mdn.io/tenant` | tenant ID | **All child resources** | Tenant identification |

**Usage:**
- ✅ Applied consistently to all resources
- ✅ Used for querying tenant resources
- ❌ Not propagated from parent to children (by design, only tenant ID)

### Third-Party Labels

| Label | Values | Applied To | Required By |
|-------|--------|-----------|-------------|
| `strimzi.io/cluster` | `kafka-cluster`, `connect-cluster` | KafkaTopic, KafkaConnector | Strimzi Operator |

## Annotations in Use

### Custom Domain Annotations (`ns.mdn.io/*`)

| Annotation | Values | Applied To | Purpose |
|------------|--------|-----------|---------|
| `ns.mdn.io/backup-policy` | `snapshot`, `skip` | PVC | Backup strategy |
| `ns.mdn.io/backup-ttl` | `30d` (default) | PVC | Retention period |
| `ns.mdn.io/backup-type` | `final` | VolumeSnapshot | Snapshot classification |

## Finalizers in Use

| Finalizer | Applied To | Purpose | Prefix Issue |
|-----------|-----------|---------|--------------|
| `mdn.io/backup-protect` | PVC | Prevent deletion until snapshot | ⚠️ **Inconsistent prefix** |

**Issue:** Should be `ns.mdn.io/backup-protect` to match other custom metadata

## Label Application by Resource Type

### MongoDB Resources

**Secret (ns-mongo-auth):**
```javascript
labels: {
  'app.kubernetes.io/name': 'ns-mongo',
  'app.kubernetes.io/part-of': 'nightscout-tenant',
  'ns.mdn.io/tenant': tenantId
}
```

**Service (ns-mongo):**
```javascript
labels: {
  'app.kubernetes.io/name': 'ns-mongo',
  'app.kubernetes.io/part-of': 'nightscout-tenant',
  'ns.mdn.io/tenant': tenantId
}
```

**StatefulSet (ns-mongo):**
```javascript
metadata:
  labels: {
    'app.kubernetes.io/name': 'ns-mongo',
    'app.kubernetes.io/part-of': 'nightscout-tenant',
    'ns.mdn.io/tenant': tenantId
  }
spec:
  selector:
    matchLabels: {
      'app.kubernetes.io/name': 'ns-mongo'  // ⚠️ Only name, no part-of
    }
  template:
    metadata:
      labels: {
        'app.kubernetes.io/name': 'ns-mongo',
        'app.kubernetes.io/part-of': 'nightscout-tenant',
        'ns.mdn.io/tenant': tenantId
      }
```

**PVC (data-ns-mongo-0):**
```javascript
labels: {
  'app.kubernetes.io/name': 'ns-mongo',
  'app.kubernetes.io/part-of': 'nightscout-tenant',
  'ns.mdn.io/tenant': tenantId
}
// Added by DecoratorController:
annotations: {
  'ns.mdn.io/backup-policy': 'snapshot',
  'ns.mdn.io/backup-ttl': '30d'
}
finalizers: [
  'mdn.io/backup-protect'  // ⚠️ Should be ns.mdn.io/backup-protect
]
```

**PodDisruptionBudget (ns-mongo-pdb):**
```javascript
labels: {
  'app.kubernetes.io/name': 'ns-mongo',
  'ns.mdn.io/tenant': tenantId  // ⚠️ Missing part-of
}
spec:
  selector:
    matchLabels: {
      'app.kubernetes.io/name': 'ns-mongo'
    }
```

### Nightscout Resources

**Deployment (nightscout):**
```javascript
metadata:
  labels: {
    'app.kubernetes.io/name': 'nightscout',
    'app.kubernetes.io/part-of': 'nightscout-tenant',
    'ns.mdn.io/tenant': tenantId
  }
spec:
  selector:
    matchLabels: {
      'app.kubernetes.io/name': 'nightscout'  // ⚠️ Only name
    }
  template:
    metadata:
      labels: {
        'app.kubernetes.io/name': 'nightscout',
        'ns.mdn.io/tenant': tenantId
        // ❌ MISSING: 'app.kubernetes.io/part-of'
      }
```

**Service (nightscout):**
```javascript
labels: {
  'app.kubernetes.io/name': 'nightscout',
  'ns.mdn.io/tenant': tenantId  // ⚠️ Missing part-of
}
spec:
  selector: {
    'app.kubernetes.io/name': 'nightscout'
  }
```

**PodDisruptionBudget (nightscout-pdb):**
```javascript
labels: {
  'app.kubernetes.io/name': 'nightscout',
  'ns.mdn.io/tenant': tenantId  // ⚠️ Missing part-of
}
spec:
  selector:
    matchLabels: {
      'app.kubernetes.io/name': 'nightscout'
    }
```

### Kafka Resources

**KafkaTopic:**
```javascript
labels: {
  'strimzi.io/cluster': 'kafka-cluster',  // Required by Strimzi
  'ns.mdn.io/tenant': tenantId
  // ❌ MISSING: All app.kubernetes.io/* labels
}
```

**KafkaConnector:**
```javascript
labels: {
  'strimzi.io/cluster': 'connect-cluster',  // Required by Strimzi
  'ns.mdn.io/tenant': tenantId
  // ❌ MISSING: All app.kubernetes.io/* labels
}
```

### Snapshot Resources

**VolumeSnapshot:**
```javascript
labels: {
  'app.kubernetes.io/part-of': 'nightscout-tenant',
  'ns.mdn.io/backup-type': 'final'
  // ⚠️ Missing: name, tenant
}
```

## Controller Label Selectors

### CompositeController
```yaml
parentResource:
  labelSelector:
    matchLabels:
      ns.mdn.io/enabled: "true"
```

**Matches:** ConfigMaps with `ns.mdn.io/enabled: "true"` label

### DecoratorController
```yaml
resources:
  - labelSelector:
      matchExpressions:
        - key: app.kubernetes.io/name
          operator: In
          values: ["ns-mongo"]
```

**Matches:** PVCs with `app.kubernetes.io/name: ns-mongo` label

## Issues Summary

### 🔴 Critical Issues

1. **Pod Template Missing Labels** (resources.js:246-247)
   ```javascript
   // Current (WRONG):
   labels: {
     'app.kubernetes.io/name': 'nightscout',
     'ns.mdn.io/tenant': tenantId
   }
   
   // Should be:
   labels: {
     'app.kubernetes.io/name': 'nightscout',
     'app.kubernetes.io/part-of': 'nightscout-tenant',  // ADD THIS
     'ns.mdn.io/tenant': tenantId
   }
   ```

2. **Finalizer Prefix Inconsistent**
   ```javascript
   // Current:
   'mdn.io/backup-protect'
   
   // Should be:
   'ns.mdn.io/backup-protect'
   ```

### 🟡 Warning Issues

3. **Services and PDBs Missing `part-of` Label**
   - Services for both MongoDB and Nightscout
   - PodDisruptionBudgets for both

4. **Kafka Resources Underspecified**
   - Only have Strimzi + tenant labels
   - Missing all `app.kubernetes.io/*` labels

5. **VolumeSnapshot Incomplete Labels**
   - Has `part-of` and `backup-type`
   - Missing `name` and `tenant`

### 📊 Missing Standard Labels (All Resources)

Not currently used anywhere:
- ❌ `app.kubernetes.io/component` (database, application, messaging, job)
- ❌ `app.kubernetes.io/instance` (tenant ID for uniqueness)
- ❌ `app.kubernetes.io/version` (image version)
- ❌ `app.kubernetes.io/managed-by` (metacontroller)

## Comparison with Best Practices

### Current State
```javascript
// What we have today:
{
  'app.kubernetes.io/name': 'nightscout',           // ✅
  'app.kubernetes.io/part-of': 'nightscout-tenant', // ⚠️ Inconsistent
  'ns.mdn.io/tenant': tenantId                      // ✅
}
```

### Recommended State
```javascript
// What we should have:
{
  // Standard Kubernetes (recommended)
  'app.kubernetes.io/name': 'nightscout',
  'app.kubernetes.io/component': 'application',
  'app.kubernetes.io/part-of': 'nightscout-tenant',
  'app.kubernetes.io/instance': tenantId,
  'app.kubernetes.io/version': imageVersion,
  'app.kubernetes.io/managed-by': 'metacontroller',
  
  // Custom (our domain)
  'ns.mdn.io/tenant': tenantId
}
```

## Current Capabilities

### What Works Today ✅

```bash
# Find all resources for a tenant
kubectl get all -l ns.mdn.io/tenant=demo

# Find all MongoDB StatefulSets
kubectl get sts -l app.kubernetes.io/name=ns-mongo

# Find all Nightscout deployments
kubectl get deploy -l app.kubernetes.io/name=nightscout

# Find parent ConfigMaps
kubectl get cm -l ns.mdn.io/enabled=true
```

### What Doesn't Work ❌

```bash
# Find all Nightscout PODS (fails - missing label in pod template)
kubectl get pods -l app.kubernetes.io/part-of=nightscout-tenant
# Returns: No resources found

# Find all database components
kubectl get all -l app.kubernetes.io/component=database
# Returns: No resources found (label doesn't exist)

# Find all resources managed by metacontroller
kubectl get all -l app.kubernetes.io/managed-by=metacontroller
# Returns: No resources found (label doesn't exist)

# Find by instance (tenant as instance)
kubectl get all -l app.kubernetes.io/instance=demo
# Returns: No resources found (label doesn't exist)
```

## Files Containing Label Definitions

1. **`cmd/webhook/handlers/resources.js`** - All resource templates
   - Lines 15-19: MongoDB Secret
   - Lines 35-39: MongoDB Service
   - Lines 62-66: MongoDB StatefulSet metadata
   - Lines 78-82: MongoDB pod template
   - Lines 172-176: MongoDB PVC template
   - Lines 198-201: MongoDB PDB
   - Lines 230-234: Nightscout Deployment metadata
   - Lines 245-248: Nightscout pod template (⚠️ missing part-of)
   - Lines 317-320: Nightscout Service (⚠️ missing part-of)
   - Lines 343-346: Nightscout PDB (⚠️ missing part-of)
   - Lines 382-385: KafkaTopic
   - Lines 404-407: KafkaTopic (DLQ)
   - Lines 461-464: KafkaConnector

2. **`cmd/webhook/handlers/decorator-sync.js`** - PVC annotations/finalizer
   - Line 18-19: Backup annotations
   - Line 23: Finalizer (⚠️ wrong prefix)

3. **`cmd/webhook/handlers/decorator-finalize.js`** - VolumeSnapshot
   - Lines 48-51: Snapshot labels

4. **`k8s/metactl/composite-controller.yaml`** - Parent selector
   - CompositeController uses `ns.mdn.io/enabled: "true"`

5. **`k8s/metactl/decorator-controller.yaml`** - PVC selector
   - DecoratorController uses `app.kubernetes.io/name: ns-mongo`

## Recommendation Priority

**Priority 1 (Critical - Breaks Functionality):**
1. Fix Nightscout pod template to include `app.kubernetes.io/part-of`
2. Fix finalizer prefix to `ns.mdn.io/backup-protect`

**Priority 2 (Important - Consistency):**
3. Add `part-of` to Services and PDBs
4. Add complete standard label set to all resources

**Priority 3 (Enhancement):**
5. Add labels to Kafka resources
6. Add operational annotations support

---

**Bottom Line:**  
We're using a **minimal subset** of Kubernetes standard labels, with some **inconsistencies** (especially in pod templates and finalizer prefix). The custom `ns.mdn.io/tenant` label works well for basic queries, but we're missing the full recommended label set that would improve observability and tooling compatibility.
