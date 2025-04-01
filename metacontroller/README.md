
# MetaController Resources

This directory contains MetaController definitions and configurations for managing Nightscout deployments using webhook-based control patterns.

## Technical Architecture

### Controller Model
The implementation uses MetaController's CompositeController and DecoratorController patterns which:
- Implements declarative reconciliation loops
- Manages parent-child resource relationships
- Provides webhook-based customization
- Handles state transitions and updates

### Architectural Patterns

#### Config-as-Deploy Pattern
We implement a config-driven deployment pattern where:
- Each tenant has a ConfigMap in the hosted-tenants namespace
- ConfigMaps are tagged with `config-as-deploy`
- A dispatcher watches ConfigMap changes
- Changes trigger controller updates via webhooks
- Controller reconciles deployment state

This pattern aligns with MetaController's decorator approach, where resource changes trigger reconciliation.

#### Unified StatefulSet Pattern
Moving towards a unified pod model where:
- Single StatefulSet manages multiple containers:
  - Nightscout webapp
  - MongoDB database
  - Admin/tooling container (optional)
- Shared volume mounts
- Coordinated lifecycle management
- Simplified networking model

Benefits:
- Reduced operational complexity
- Improved resource utilization
- Simplified state management
- Better container coordination

### Phase Management
The controllers implement phase-based state management to handle complex provisioning workflows. See [Webhook Phase Management](docs/webhook-phase-management.md) for details on implementing phase transitions and dependency management.

### Component Architecture

#### NightscoutInstance Controller
Primary controller managing the core deployment:
- Implements parent-child relationship tracking
- Manages resource lifecycle and updates
- Handles configuration changes
- Implements health checking

#### Migration Controller
Implements migration orchestration through:
- ConfigMap annotation watching (`migrate-config-crd`)
- Migration job creation and management
- Progress tracking and status updates
- Uses existing dispatcher/controller infrastructure

Migration Flow:
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tenant-config
  annotations:
    nightscout.k8s/migrate-config-crd: "true"
    nightscout.k8s/migration-source: "mongodb://source/db"
  labels:
    config-as-deploy: "true"
```

#### Storage Controller
Manages persistent storage resources:
- Handles PVC provisioning
- Implements storage class selection
- Manages capacity updates
- Handles backup/restore

#### Migration Decorator
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
- StatefulSets for unified pods
- Services for networking
- PVCs for storage
- Jobs for migrations

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
