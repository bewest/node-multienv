# Archived Migration Documentation

## Overview

This directory contains migration-related documentation that was created during Gen 4 development but **does not reflect the shipped implementation**. These documents are archived for historical reference.

## Why These Documents Were Archived

### DATABASE-MIGRATION-STRATEGY.md

**Issue**: Used different label/annotation scheme than what was shipped

- **Documented**: `ns.mdn.io/db-topology` (shared/dedicated/hybrid)
- **Shipped**: `ns.mdn.io/storage-type` (shared/dedicated)
- **Documented**: `ns.mdn.io/db-migration-status` (pending/in-progress/complete/failed)
- **Shipped**: `ns.mdn.io/migration-needed`, `ns.mdn.io/migration-complete` (boolean annotations)

**Reason for Change**: 
- Simplified annotation model (boolean flags instead of state machine)
- Clearer intent declaration (migration-needed vs migration-status)
- Removed hybrid state (unnecessary complexity)

### DATABASE-MIGRATION-AUTOMATED.md

**Issue**: Described ConfigMap-based migration approach that was NOT shipped

- **Documented**: Migration triggered by ConfigMap fields (`MIGRATION_ENABLED`, `MIGRATION_SOURCE_URI`)
- **Shipped**: Migration triggered by Secret annotations (`ns.mdn.io/migration-needed`)
- **Documented**: Migration handled by compute composite (monolithic approach)
- **Shipped**: Migration handled by storage composite (two-composite architecture)

**Reason for Change**:
Design Decision #2 (see `docs/ARCHITECTURE-EVOLUTION.md`):
- Migration is a **storage-layer concern**, not a compute concern
- Credentials belong in Secrets, not ConfigMaps
- Storage composite handles migration Jobs
- Compute composite has zero migration logic

## What Shipped Instead

**Canonical Documentation**: `docs/TWO-COMPOSITE-ARCHITECTURE.md`

**Migration Pattern**:
1. Annotation-driven migration on storage Secret
2. Storage composite checks `ns.mdn.io/migration-needed` annotation
3. Storage composite renders migration Job when needed
4. Migration tracked in Secret status
5. Compute composite unaware of migration

**Example**:
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: storage-demo
  labels:
    ns.mdn.io/composite: storage
    storage.nightscout.org/account: demo
  annotations:
    ns.mdn.io/storage-type: dedicated
    ns.mdn.io/migration-needed: "true"
    ns.mdn.io/migration-source-uri: "mongodb://user:pass@shared-mongodb:27017/nightscout"
stringData:
  replicas: "1"
  storageGi: "2"
  mongoImage: "mongo:6"
  username: "nsuser"
  password: "newpass"
  database: "nightscout"
```

## Key Differences Summary

| Aspect | Archived Docs | Shipped Implementation |
|--------|---------------|------------------------|
| Migration Trigger | ConfigMap field | Secret annotation |
| Handler | Compute composite | Storage composite |
| Credential Location | ConfigMap (insecure) | Secret (secure) |
| Label Scheme | db-topology/db-migration-status | storage-type/migration-needed |
| Architecture | Monolithic composite | Two-composite |

## Lessons Learned

1. **Separation of Concerns**: Migration is a database lifecycle event (storage), not an application event (compute)
2. **Security First**: Credentials must never be in ConfigMaps
3. **Simplicity Wins**: Boolean annotations clearer than state machines
4. **Document Final State**: Only document what shipped, archive drafts

---

**Archived**: January 2025  
**Status**: Exploratory documentation, not shipped  
**Replaced by**: docs/TWO-COMPOSITE-ARCHITECTURE.md
