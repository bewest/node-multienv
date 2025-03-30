
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
1. Create a NightscoutInstance resource
2. Controller automatically provisions required resources
3. Webhook handler reconciles the desired state
4. Status updates reflect current state

## Resource Management
The controller manages:
- Deployments
- Services
- PersistentVolumeClaims
- Configuration
