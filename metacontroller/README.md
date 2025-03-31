
# MetaController Resources

This directory contains MetaController definitions and configurations for managing Nightscout instances.

## Overview
MetaController is a pattern for building custom controllers in Kubernetes. This implementation specifically manages Nightscout deployments through a declarative API.

## Components

### 1. NightscoutInstance Controller
The primary controller that manages Nightscout deployments. It handles:
- Creation and management of Kubernetes resources
- State reconciliation
- Resource lifecycle management

### 2. Webhook API
Integrates with the deployment controller to:
- Process sync requests
- Handle resource updates
- Manage state transitions

## Key Resources

### Controllers (/controllers)
- `nightscout-controller.yaml`: Defines the CompositeController for managing Nightscout instances
- Handles parent-child resource relationships
- Configures webhook synchronization

### CRDs (/crds)
- `nightscoutinstance.yaml`: Custom Resource Definition for Nightscout instances
- Defines the schema and validation rules
- Specifies available configuration options

### Webhooks
- Implements reconciliation logic
- Handles resource creation/updates
- Manages dependent resources

## Usage

### Basic Instance Creation
```yaml
apiVersion: nightscout.k8s/v1alpha1
kind: NightscoutInstance
metadata:
  name: demo-instance
spec:
  webName: demo
  storageSize: "2Gi"
```

### Migration Using Annotations
```yaml
apiVersion: nightscout.k8s/v1alpha1
kind: NightscoutInstance
metadata:
  name: migrated-instance
  annotations:
    nightscout.k8s/migrate-from: "mongodb://oldhost:27017/olddb"
spec:
  webName: migrated
  storageSize: "2Gi"
```

### Storage Provisioning
```yaml
apiVersion: nightscout.k8s/v1alpha1
kind: TenantStorage
metadata:
  name: new-tenant-storage
spec:
  tenantId: new-tenant
  needsProvisioning: true
```

### Migration Job
```yaml
apiVersion: nightscout.k8s/v1alpha1
kind: TenantMigration
metadata:
  name: tenant-migration
spec:
  tenantId: tenant-to-migrate
  sourceUri: "mongodb://source:27017/db"
```

## Resource Management
The controller manages:
- Deployments
- Services
- PersistentVolumeClaims
- Configuration
