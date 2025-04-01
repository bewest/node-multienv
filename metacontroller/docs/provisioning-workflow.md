
# Tenant Provisioning Workflow Design

## Overview
This document outlines the design for tenant provisioning using a multi-stage workflow managed by custom controllers and CRDs.

## Architecture Components

### 1. Account Creation (/accounts endpoint)
- Creates K8s Secret containing MongoDB credentials
- Secret creation triggers TenantStorage CRD creation
- Labels link account ID to storage resources

### 2. Storage Provisioning (TenantStorage Controller)
```yaml
apiVersion: nightscout.k8s/v1alpha1
kind: TenantStorage
spec:
  tenantId: "<account-id>"
  needsProvisioning: true
```
- Watches for new TenantStorage resources
- Spawns initialization Job to:
  - Create MongoDB databases
  - Set up user permissions
  - Configure replication
- Updates status upon completion

### 3. Instance Creation (/accounts/:account/sites endpoint)
- Creates NightscoutInstance CRD
- References existing account/storage
```yaml
apiVersion: nightscout.k8s/v1alpha1
kind: NightscoutInstance
spec:
  webName: "<site-name>"
  account: "<account-id>"
```

## Tradeoffs Analysis

### Benefits of Multi-CRD Approach
1. **Separation of Concerns**
   - Storage provisioning isolated from instance management
   - Clear status tracking per component
   - Independent scaling and failure domains

2. **Declarative State Management**
   - Each stage has clear desired state
   - Easier recovery from failures
   - Audit trail via K8s events

3. **Reusability**
   - Storage provisioning can be reused for other services
   - Account management decoupled from Nightscout specifics

### Challenges
1. **Complexity**
   - More moving parts to maintain
   - Multiple controllers to debug
   - Need careful error propagation

2. **Resource Overhead**
   - Additional CRDs in etcd
   - Multiple controller reconciliation loops
   - More K8s API calls

3. **Eventual Consistency**
   - Must handle partial completion states
   - Need clear status propagation
   - Requires robust retry logic

## Alternative Approaches

### 1. Single CRD
- Simpler but less flexible
- Harder to reuse components
- More complex single controller

### 2. Direct API Provisioning
- Faster provisioning
- Less K8s native
- Harder to track state

## Recommendation
The multi-CRD approach provides better separation of concerns and maintainability despite increased complexity. The benefits of declarative state management and reusability outweigh the operational overhead.
