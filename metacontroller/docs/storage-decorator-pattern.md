
# Storage Decorator Pattern

## Overview
The storage decorator pattern manages the lifecycle relationship between Secrets and PersistentVolumeClaims (PVCs) in a decoupled way. This pattern ensures data persistence and proper cleanup through finalizer management.

## Design Guidelines

### 1. Resource Management
- PVCs should be the primary managed resource
- Secrets act as configuration/credentials stores
- Use finalizers to protect storage resources from accidental deletion

### 2. Decorator Controller Structure
```yaml
apiVersion: metacontroller.k8s.io/v1alpha1
kind: DecoratorController
metadata:
  name: storage-decorator
spec:
  resources:
    - apiVersion: v1
      resource: secrets
      labelSelector:
        matchLabels:
          "storage.nightscout.org/account": "*"
  attachments:
    - apiVersion: v1
      resource: persistentvolumeclaims
```

### 3. Sync Hook Implementation Guidelines

The sync hook should:
1. First identify existing PVC attachments
2. Maintain any existing attachments unless explicitly marked for deletion
3. Create PVC if none exists
4. Manage finalizer lifecycle

Example sync hook flow:
```javascript
function handleSync(request) {
  const { object: secret, attachments, finalizing } = request;
  
  // Find existing PVC
  const pvc = attachments.PersistentVolumeClaim?.find(p => 
    p.metadata.labels['storage.nightscout.org/account'] === account);

  if (finalizing) {
    // Handle cleanup logic
    return handleFinalization(secret, pvc);
  }

  // Maintain or create PVC
  return {
    attachments: [generatePVC(secret)],
    patches: [addFinalizerIfNeeded(secret)]
  };
}
```

## Implementation Considerations

### PVC-First vs Secret-First Creation
There are two approaches to resource creation order:

1. **Current Pattern (Secret-First)**
   - Secret created during account creation
   - Decorator creates/manages PVC
   - Benefits: Clear ownership, simpler secret management

2. **Alternative Pattern (PVC-First)**
   - PVC created during account creation
   - Decorator manages secret lifecycle
   - Benefits: Storage provisioning guarantees

The current Secret-First pattern is recommended because:
- Secrets contain the initial configuration
- Account creation naturally generates credentials
- PVC provisioning can be retried if needed

### Finalizer Management
Finalizers should:
- Protect PVC from accidental deletion
- Implement cleanup challenge/response pattern
- Allow manual intervention when needed

## Best Practices
1. Always pass through existing attachments unless explicitly handling deletion
2. Use consistent labeling for resource association
3. Implement proper error handling and status updates
4. Consider backup/restore scenarios in the design
