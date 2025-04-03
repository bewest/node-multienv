
# Migration Strategy and Implementation Status

## Current Architecture
- Each tenant has a deployment named `{webName}` in `hosted-tenants` namespace
- ConfigMaps tagged with `config-as-deploy` trigger updates
- Dispatcher watches ConfigMap changes and notifies controller
- MetaController decorator pattern manages resource updates

## Migration Implementation Status

### Completed Components
1. **Migration Controller**
   - Watches TenantMigration CRD
   - Creates migration jobs based on source/target URIs
   - Manages job lifecycle and status updates

2. **Migration Decorator**
   - Watches NightscoutInstance annotations
   - Triggers migrations via `nightscout.k8s/migrate-from` annotation
   - Creates supporting resources (jobs, configmaps)

3. **Webhook Handlers**
   - Phase-based migration handling
   - Resource creation templates
   - Status propagation logic

### Code Completeness Checklist
- [x] CRD Definitions (TenantMigration, NightscoutInstance)
- [x] Controller YAML configurations
- [x] Basic webhook handlers
- [x] Template generation
- [ ] Rollback mechanisms
- [ ] Progress tracking
- [ ] Data validation
- [ ] Cross-namespace permissions

## Operational Guidelines

### Resource Labeling Strategy
```yaml
metadata:
  labels:
    app.kubernetes.io/name: nightscout
    app.kubernetes.io/instance: ${webName}
    app.kubernetes.io/component: migration
    nightscout.k8s/tenant: ${tenantId}
    nightscout.k8s/migration-batch: ${batchId}
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
