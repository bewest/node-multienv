
# Webhook vs Declarative Compositions

## Overview
This document compares two approaches to composing resources in our infrastructure:
1. Webhook-based composition via MetaController
2. Declarative composition via Crossplane

## Webhook-Based Composition (MetaController)

### Characteristics
- Dynamic resource generation through JavaScript/Node.js code
- Stateful decision making based on external systems
- Complex conditional logic for provisioning steps
- Direct API calls to external services

### Example from our codebase:
```javascript
// From webhook_handler.js
function handleSync(parent, children) {
  const response = {
    status: {},
    children: []
  };
  
  if (parent.spec.parameters.needsProvisioning) {
    response.children.push(
      templates.template_init_storage_job(data)
    );
  }
  return response;
}
```

## Declarative Composition (Crossplane)

### Characteristics
- Static resource templates defined in YAML
- Transform-based field mapping
- Pipeline-oriented composition steps
- Pure Kubernetes native resources

### Example from our codebase:
```yaml
# From nightscout.yaml
pipeline:
  - step: setup-storage
    resources:
      - name: mongodb-pvc
        base:
          apiVersion: v1
          kind: PersistentVolumeClaim
```

## Trade-offs

### Webhook Benefits
1. Complex Logic
   - Runtime decisions
   - External system integration
   - Rich transformation capabilities

2. Flexibility
   - Custom error handling
   - Dynamic resource generation
   - Stateful operations

### Declarative Benefits
1. Reliability
   - No runtime dependencies
   - Predictable outcomes
   - Version controlled templates

2. Simplicity
   - Native Kubernetes patterns
   - Easier to audit
   - Lower operational overhead

## Current Implementation
- [ ] TODO: describe how crossplane uses webhooks
- [ ] TODO: describe how crossplane can be used to implement similar if not the same functionality as an operational or even hybrid (via labels) alternative to metacontroller.
- [ ] compare and contrast operational vs development feasibility of these approaches
      