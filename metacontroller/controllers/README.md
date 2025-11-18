# Metacontroller Definitions

## Authoritative Source: Jsonnet

The Metacontroller CompositeController and DecoratorController definitions are **generated from jsonnet** and should not be manually edited as YAML files.

### Authoritative Files

- **`jsonnet/lib-k8s-multienv/metacontroller.libsonnet`** - Controller definitions
- **`jsonnet/lib-k8s-multienv/gen4.libsonnet`** - Gen4 stack generator

### Controllers Defined

**Composite Controllers:**
- `storageComposite()` - StorageAccount CRD → MongoDB StatefulSet + Services + Jobs
- `computeComposite()` - ComputeInstance CRD → Nightscout Deployment + Services

**Decorator Controllers:**
- `storageCredentialsDecorator()` - ComputeInstance CRD → App credentials + User initialization
- `storageInitializationDecorator()` - mongo-auth Secret → Replica set initialization tracking
- `instanceUserdataDecorator()` - Gen3 ConfigMap → Gen4 migration orchestration
- `pvcBackupDecorator()` - PVC → VolumeSnapshot backup enforcement

### Inspecting Controller Definitions

To see the generated controller definitions:

```bash
# Render the gen4-test environment
cd jsonnet/environments/gen4-test
jsonnet -J ../../vendor main.jsonnet

# Or use jb and kubectl to see what would be applied
jsonnet -J ../../vendor main.jsonnet | kubectl apply --dry-run=client -f -
```

### Modifying Controllers

To modify controller definitions:

1. Edit `jsonnet/lib-k8s-multienv/metacontroller.libsonnet`
2. Test changes by rendering an environment
3. Apply to cluster via jsonnet (not individual YAML files)

See `jsonnet/README.md` for complete documentation on the jsonnet library structure.
