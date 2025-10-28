# Deprecated: Monolithic Migration Script

**Status**: Archived (December 2024)  
**Reason**: Bypasses infrastructure, violates Gen 4 architecture principles

## Why This Was Deprecated

This `migrate-to-two-composite.js` script was an early migration tool that directly manipulates Kubernetes resources using `@kubernetes/client-node`. While functional, it has significant architectural problems:

### Problems with This Approach

1. **Bypasses the REST API Facade**
   - Directly calls K8s API instead of using the provisioner REST endpoints
   - Duplicates logic that already exists in webhooks
   - Makes the REST API irrelevant for migrations

2. **Violates Gen 4 Philosophy**
   - Gen 4 is about **declarative orchestration** via Metacontroller
   - This script is **imperative orchestration** that does everything itself
   - Doesn't leverage the webhook infrastructure at all

3. **Maintenance Burden**
   - Secret/ConfigMap creation logic exists in two places (script + webhooks)
   - Changes to storage/compute templates require updating both
   - More surface area for bugs and inconsistencies

4. **Monolithic Design**
   - Tries to be a "migration orchestrator" that handles everything
   - Doesn't compose with other tooling
   - All-or-nothing execution model

### The Right Approach: tools/gen4-migration.sh

The canonical migration tool is now **`tools/gen4-migration.sh`**, which:

✅ **Uses the REST API** - Calls controller endpoints via HTTP, not direct K8s API  
✅ **Labels trigger webhooks** - Storage Secrets with `ns.mdn.io/composite: storage` trigger webhook  
✅ **Annotations drive behavior** - Migration annotations declaratively trigger migration Jobs  
✅ **Composable** - Individual commands (create-storage, trigger-migration, validate) can be used separately  
✅ **Operator-friendly** - Uses curl instead of requiring K8s client library

### Migration Script Comparison

| Aspect | migrate-to-two-composite.js (DEPRECATED) | gen4-migration.sh (CANONICAL) |
|--------|------------------------------------------|-------------------------------|
| Secret creation | `k8sApi.createNamespacedSecret()` | `POST /secrets/:name` via controller |
| ConfigMap update | `k8sApi.replaceNamespacedConfigMap()` | Manual step (not in script) |
| Migration trigger | Direct K8s API annotation writes | `POST /secrets/.../annotations/...` API |
| Dependencies | Requires `@kubernetes/client-node` | Only needs curl + controller URL |
| Philosophy | Imperative K8s orchestration | REST API + declarative triggers |
| Infrastructure usage | Direct K8s API | Controller REST API → webhooks |
| Maintainability | Duplicates webhook logic | Labels trigger webhook behavior |

## If You Need This Code

The script is preserved here for reference, but **should not be used**. If you need migration functionality:

1. Use `tools/gen4-migration.sh` for operational migrations
2. Use the REST API directly for integration with external systems
3. See `docs/TWO-COMPOSITE-ARCHITECTURE.md` for complete migration workflows

## Key Lesson

In a declarative Kubernetes platform, **triggers are better than orchestrators**. Instead of writing code that "does the migration," write code that "asks the platform to migrate" by setting the right labels/annotations and letting Metacontroller handle the orchestration.

This aligns with Kubernetes best practices and the entire Gen 4 architecture philosophy.
