
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

### Crossplane Webhook Usage
- Composition Functions allow webhook-like behavior
- Can implement complex transformation logic
- Supports external API calls during composition
- Maintains declarative configuration while allowing programmatic interventions

### Implementing MetaController Patterns
1. **Via Pure Crossplane**
   - Use Composition pipeline for staged provisioning
   - Leverage status conditions for phase management
   - Implement resource dependencies through pipeline ordering
   - Use XRD validations for tenant constraints

2. **Hybrid Approach**
   - Use labels to bridge MetaController and Crossplane resources
   - MetaController handles stateful operations
   - Crossplane manages infrastructure resources
   - Shared status propagation through label selectors

### Feasibility Analysis

#### Operational Considerations
- Crossplane: Better stability, simpler upgrades, standard patterns
- MetaController: More flexible, easier debugging, familiar Node.js stack
- Hybrid: Best of both but increased complexity

#### Development Tradeoffs
- Crossplane: Steeper learning curve, more YAML configuration
- MetaController: Faster development cycles, easier testing
- Hybrid: Allows gradual migration, maintains existing code
      