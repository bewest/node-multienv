
# Crossplane Resources

This directory contains Crossplane resource definitions and compositions for managing infrastructure.

## Structure

- `compositions/` - Contains Composition resources that define how to fulfill infrastructure requirements
- `definitions/` - Contains InfrastructureDefinition resources that define new composite resources
- `publications/` - Contains InfrastructurePublication resources that expose infrastructure to namespaces
- `examples/` - Example usage of the defined resources

## Usage

The resources in this directory define infrastructure that can be composed and published for use by applications. The key components are:

1. Infrastructure Definitions - Define new kinds of infrastructure resources
2. Compositions - Configure how infrastructure resources are implemented
3. Publications - Make infrastructure available to application namespaces

See individual resource directories for more details.
