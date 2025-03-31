
# Crossplane Resources

This directory contains Crossplane resource definitions and compositions for managing infrastructure.

## Architecture Overview

Crossplane implements a declarative approach to infrastructure provisioning using the following key patterns:

### Composition Pipeline
The system uses a pipeline-based composition model where:
- Resources are provisioned in a defined sequence
- Each step can reference outputs from previous steps
- Dependencies are automatically managed
- Failures are handled gracefully with rollback capabilities

### Resource Definition Model
- XRDs (Composite Resource Definitions) define the schema and validation rules
- Claims provide namespace-scoped access to infrastructure
- Compositions implement the actual resource creation logic
- Providers handle the underlying infrastructure operations

## Component Details

### Infrastructure Definitions (/definitions)
- Define new composite resources (XRDs)
- Implement schema validation
- Configure claim mapping
- Handle version management

### Compositions (/compositions)
Contains composition pipelines that:
- Define resource creation order
- Handle inter-resource dependencies  
- Implement patch transformations
- Manage secret propagation

### Publications (/publications)
Configure how resources are exposed:
- Namespace binding rules
- Permission models
- Resource quotas
- Usage policies

## Implementation Details

### Resource Provisioning Flow
1. User creates a claim in their namespace
2. Claim controller validates and maps to XR
3. Composition pipeline executes steps
4. Resources are created in dependency order
5. Status is propagated back to claim

### Secret Management
- Sensitive data is handled via Kubernetes secrets
- Automatic propagation to child resources
- Rotation capabilities via composition updates

### Error Handling
- Pipeline step failure handling
- Automatic rollback capabilities
- Status condition propagation
- Event recording

## Usage Examples

See the `/examples` directory for:
- Basic resource provisioning
- Complex multi-resource setups
- Secret handling patterns
- Migration scenarios

## Best Practices
- Use pipeline mode for ordered provisioning
- Implement proper health checks
- Handle cleanup in compositions
- Follow least privilege model
- Implement proper status conditions
