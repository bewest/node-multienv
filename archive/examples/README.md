# Archived Examples

## Overview

This directory contains example manifests that were created during Gen 4 exploration but **do not reflect the shipped two-composite architecture**. These examples are archived for historical reference.

## Archived Files

### nightscout-instance.yaml

**Issue**: Uses a CRD-style `NightscoutInstance` custom resource

```yaml
apiVersion: nightscout.k8s/v1alpha1
kind: NightscoutInstance
```

**Why Archived**:
- Gen 4 two-composite architecture does NOT use custom resource definitions (CRDs)
- Shipped implementation uses native Kubernetes resources:
  - Storage: `Secret` (v1 API)
  - Compute: `ConfigMap` (v1 API)
- This example appears to be from an experimental CRD-based approach

**What Shipped Instead**:

The two-composite architecture uses standard Kubernetes resources:

1. **Storage Secret** (`metacontroller/examples/storage-secret.yaml`):
```yaml
apiVersion: v1
kind: Secret
metadata:
  labels:
    ns.mdn.io/composite: storage
    storage.nightscout.org/account: demo
```

2. **Compute ConfigMap** (`metacontroller/examples/compute-configmap.yaml`):
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  labels:
    ns.mdn.io/composite: compute
    storage.nightscout.org/account: demo
```

## Why We Don't Use CRDs

**Design Decision**: Use native Kubernetes resources instead of CRDs

**Rationale**:
1. **Simplicity**: No CRD installation required (just Metacontroller)
2. **API Compatibility**: Environs API already works with ConfigMaps (Gen 3b compatibility)
3. **Operational Simplicity**: Operators familiar with ConfigMaps/Secrets
4. **GitOps Ready**: Standard resources work with all GitOps tools
5. **Migration Path**: Easier to migrate from Gen 3b ConfigMaps

**Trade-off**: 
- Lost validation at API level (must validate in webhook)
- Gained simplicity and compatibility

---

**Archived**: January 2025  
**Status**: Exploratory example, not shipped  
**See Instead**: `metacontroller/examples/` for two-composite examples
