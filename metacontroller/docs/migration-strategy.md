# Migration Strategy and Implementation Status

## Current Architecture
- NightscoutInstance CRD manages tenant lifecycle
- TenantMigration CRD handles data migration between instances
- MetaController decorator pattern observes migration annotations
- Phase-based migration workflow with status tracking
- Environment-driven label configuration

## Configuration 

### Environment Variables
```bash
# Label Configuration
TENANT_APP_LABEL=tenant       # Default app label for tenant resources
TENANT_COMPONENT_LABEL=app    # Default component label
MIGRATION_BATCH_LABEL=batch   # Label for grouping migration resources
TENANT_ID_LABEL=tenant-id    # Tenant identifier label

# Resource Selectors
WATCH_LABEL_SELECTOR=app=tenant   # Label selector for customize hook
```

## Migration Implementation Status

### Completed Components
1. **Migration Controller**
   - Watches TenantMigration CRD
   - Creates migration jobs based on source/target URIs
   - Manages job lifecycle and status updates
   - Configurable via environment variables

2. **Migration Decorator**
   - Watches NightscoutInstance annotations
   - Triggers migrations via `nightscout.k8s/migrate-from` annotation
   - Creates supporting resources (jobs, configmaps)
   - Label-based resource tracking

3. **Webhook Handlers**
   - Phase-based migration handling
   - Resource creation templates
   - Status propagation logic
   - Customizable label matching

### Code Completeness Checklist
- [x] CRD Definitions (TenantMigration, NightscoutInstance)
- [x] Controller YAML configurations
- [x] Phase-based webhook handlers
- [x] Template generation
- [x] Migration job management
- [x] Label configuration
- [ ] Health check implementation
- [ ] Progress tracking
- [ ] Data validation
- [ ] Cross-namespace permissions

### Resource Labeling Strategy
```yaml
metadata:
  labels:
    ${TENANT_APP_LABEL}: nightscout
    ${TENANT_COMPONENT_LABEL}: ${component}
    ${TENANT_ID_LABEL}: ${tenantId}
    ${MIGRATION_BATCH_LABEL}: ${batchId}
```

### Migration Job Configuration
1. **Container Configuration**
   - Use minimal migration image
   - Mount necessary secrets/configs
   - Set resource limits appropriately

2. **Environment Variables**
   ```yaml
   env:
   - name: MIGRATION_SOURCE_URI
     valueFrom:
       secretKeyRef:
         name: migration-source
         key: uri
   - name: MIGRATION_TARGET_URI
     valueFrom:
       secretKeyRef:
         name: migration-target
         key: uri
   - name: WEBHOOK_BASE_URL
     value: http://deployment-controller:3000
   ```

3. **Development/Testing Setup**

### Best Practices
1. **Resource Management**
   - Use node selectors for migration jobs
   - Implement pod disruption budgets
   - Set appropriate timeouts

2. **Monitoring/Logging**
   - Add standardized labels for log aggregation
   - Include correlation IDs in logs
   - Track migration metrics

3. **Security**
   - Use service accounts with minimal permissions
   - Rotate migration credentials
   - Validate data before/after migration

## Next Steps
1. Implement progress tracking
2. Add validation webhooks
3. Develop rollback procedures
4. Create monitoring dashboards