
# MetaController Resources

This directory contains MetaController definitions and configurations for managing Nightscout deployments using a webhook-based control pattern.

## Technical Architecture

### Controller Model
The implementation uses MetaController's CompositeController pattern which:
- Implements a declarative reconciliation loop
- Manages parent-child resource relationships
- Provides webhook-based customization
- Handles state transitions and updates

### State Management
Controllers implement a state machine that:
- Tracks resource lifecycle stages
- Manages dependent resource states
- Handles migration scenarios
- Implements rollback capabilities

## Component Architecture

### NightscoutInstance Controller
Primary controller managing the core deployment:
- Implements parent-child relationship tracking
- Manages resource lifecycle and updates
- Handles configuration changes
- Implements health checking

### Storage Controller
Manages persistent storage resources:
- Handles PVC provisioning
- Implements storage class selection
- Manages capacity updates
- Handles backup/restore

### Migration Controller
Orchestrates data migrations:
- Implements source/target validation
- Manages migration job lifecycle
- Handles progress tracking
- Implements failure recovery

### Migration Decorator
Annotation-based migration trigger:
- Watches for migration annotations
- Creates migration resources
- Tracks migration status
- Updates parent resource state

## Technical Implementation

### Webhook API Interface
The controllers integrate with deployment-controller via webhooks:
```javascript
sync: {
  webhook: {
    url: "http://deployment-controller:3000/metacontroller/sync"
  }
}
```

### Resource Management
Controllers handle multiple resource types:
- StatefulSets for stateful components
- Deployments for stateless components
- Services for networking
- PVCs for storage
- Jobs for operations

### State Reconciliation
The sync loop implements:
- Desired state calculation
- Current state observation
- Difference detection
- Update application

### Error Handling
Implements robust error management:
- Retries with backoff
- Status condition updates
- Event recording
- Failure recovery

## Usage Patterns

### Basic Instance
```yaml
apiVersion: nightscout.k8s/v1alpha1
kind: NightscoutInstance
metadata:
  name: demo-instance
spec:
  webName: demo
  storageSize: "2Gi"
```

### Migration Configuration
```yaml
apiVersion: nightscout.k8s/v1alpha1
kind: NightscoutInstance
metadata:
  annotations:
    nightscout.k8s/migrate-from: "mongodb://source/db"
spec:
  webName: migrated
```

## Best Practices
- Implement proper validation
- Use appropriate status conditions
- Handle cleanup properly
- Implement proper logging
- Follow least privilege principle
