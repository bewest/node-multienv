/**
 * Tenant Migration Decorator Controller
 * 
 * Orchestrates shared → dedicated MongoDB data migration for Gen5 NightscoutTenants.
 * Watches ConfigMaps (tenant configuration) and manages migration Jobs.
 * 
 * Target: ConfigMap with role=config-as-deploy label (tenant config)
 * Related Resources:
 *   - Pods (for target MongoDB IP)
 *   - Jobs (migration job tracking)
 *   - Secrets (app-credentials for target MongoDB URI)
 * 
 * Migration Flow:
 *   1. Tenant starts in shared mode (ConfigMap points to external MongoDB)
 *   2. Operator requests migration via annotation: ns.mdn.io/migration-policy=auto
 *   3. Provisioner creates dedicated infrastructure (mongo-auth Secret, PVC)
 *   4. Tenant composite renders Pod with MongoDB container
 *   5. This decorator detects ready Pod + app-credentials Secret
 *   6. Renders migration Job to copy data from ConfigMap.data.mongo → dedicated MongoDB
 *   7. On Job success, stamps ns.mdn.io/data-migrated on ConfigMap
 *   8. Tenant composite reads annotation and switches to dedicated mode
 * 
 * Annotation Schema (on ConfigMap):
 *   ns.mdn.io/migration-policy:
 *     - "auto": Migration runs automatically when prerequisites are met
 *     - "manual": Migration waits for explicit trigger (ns.mdn.io/migration-phase=copying)
 *     - "disabled": No migration (opt-out, stays on shared)
 *     - (absent): No migration requested
 *   
 *   ns.mdn.io/migration-phase:
 *     - "pending": Migration requested but prerequisites not met
 *     - "copying": Migration Job running
 *     - "completed": Migration succeeded
 *     - "failed": Migration failed (check Job logs)
 *   
 *   ns.mdn.io/data-migrated: ISO timestamp when migration completed successfully
 *   ns.mdn.io/migration-job-name: Name of the migration Job for audit
 * 
 * Key Design Points:
 *   - ConfigMap is the parent resource (annotations on ConfigMap, not CR)
 *   - Stable Job name ({tenantId}-migrate-data) for audit trail
 *   - Independent from init-replica-set and app-credentials-init decorators
 *   - Idempotent: safe to reconcile multiple times
 *   - Rollback capability: modify migration-policy to "disabled" to stay on shared
 */

const { renderMigrationJob } = require('./resources');

function createDecoratorSync(config) {
  
  function findResource(collection, predicate) {
    if (!collection) return null;
    if (Array.isArray(collection)) {
      return collection.find(predicate);
    }
    return Object.values(collection).find(predicate);
  }
  
  function jobSucceeded(job) {
    if (!job) return false;
    const status = job.status || {};
    return (status.succeeded || 0) > 0;
  }
  
  function jobFailed(job) {
    if (!job) return false;
    const status = job.status || {};
    const backoffLimit = job.spec?.backoffLimit || 3;
    return (status.failed || 0) > backoffLimit;
  }
  
  function cleanForAttachment(resource) {
    if (!resource) return null;
    const cleaned = JSON.parse(JSON.stringify(resource));
    if (cleaned.metadata) {
      delete cleaned.metadata.resourceVersion;
      delete cleaned.metadata.uid;
      delete cleaned.metadata.creationTimestamp;
      delete cleaned.metadata.generation;
      delete cleaned.metadata.managedFields;
      delete cleaned.metadata.selfLink;
    }
    delete cleaned.status;
    return cleaned;
  }
  
  /**
   * Stage 1: Initialize context from webhook request
   */
  function initialize(req, res, next) {
    const { object: configMap, related, attachments } = req.body;
    
    req.configMap = configMap;
    req.related = related || {};
    req.attachments = attachments || {};
    req.tenantId = configMap.metadata.labels?.tenant;
    req.namespace = configMap.metadata.namespace;
    
    res.attachments = [];
    res.annotations = {};
    res.labels = {};
    
    console.log('Tenant Migration Decorator: ConfigMap', configMap.metadata.name);
    console.log('  Tenant ID:', req.tenantId);
    console.log('  Namespace:', req.namespace);
    
    if (!req.tenantId) {
      console.log('  No tenant label - skipping');
      res.send({ attachments: [] });
      return;
    }
    
    return next();
  }
  
  /**
   * Stage 2: Check migration policy annotation
   * Gates entire pipeline based on policy value
   */
  function checkMigrationPolicy(req, res, next) {
    const annotations = req.configMap.metadata?.annotations || {};
    
    req.migrationPolicy = annotations['ns.mdn.io/migration-policy'] || config.migration.default_migration_policy;
    req.migrationPhase = annotations['ns.mdn.io/migration-phase'];
    req.dataMigrated = annotations['ns.mdn.io/data-migrated'];
    
    console.log('  Migration policy:', req.migrationPolicy || '(none)');
    console.log('  Migration phase:', req.migrationPhase || '(none)');
    console.log('  Data migrated:', req.dataMigrated || '(no)');
    
    if (req.dataMigrated) {
      console.log('  Migration already completed - no-op');
      res.send({ attachments: [] });
      return;
    }
    
    if (!req.migrationPolicy) {
      console.log('  No migration policy set - skipping');
      res.send({ attachments: [] });
      return;
    }
    
    if (req.migrationPolicy === 'disabled') {
      console.log('  Migration disabled - skipping');
      res.send({ attachments: [] });
      return;
    }
    
    if (req.migrationPolicy !== 'auto' && req.migrationPolicy !== 'manual') {
      console.log(`  Unknown migration policy: ${req.migrationPolicy} - skipping`);
      res.send({ attachments: [] });
      return;
    }
    
    return next();
  }
  
  /**
   * Stage 3: Discover related resources
   * Find tenant Pod (for MongoDB IP) and app-credentials Secret
   */
  function discoverResources(req, res, next) {
    const pods = req.related['Pod.v1'] || {};
    const secrets = req.related['Secret.v1'] || {};
    const tenants = req.related['NightscoutTenant.nightscout.io/v1alpha1'] || {};
    const jobs = req.attachments['Job.batch/v1'] || {};

    req.tenantPod = findResource(pods, p =>
      p.metadata?.labels?.tenant === req.tenantId &&
      (p.metadata?.labels?.['app.kubernetes.io/component'] === 'tenant-pod' ||
       p.metadata?.labels?.['ns.mdn.io/storage'] === req.tenantId) &&
       (p.metadata?.annotations?.['ns.mdn.io/migration-phase'] === 'copying' ) &&
       (p.status.phase === 'Running')
    );

    req.tenantCR = findResource(tenants, p =>
      p.metadata?.labels?.['ns.mdn.io/tenant'] === req.tenantId
    );

    req.appCredentialsSecret = findResource(secrets, s =>
      s.metadata?.labels?.['ns.mdn.io/credential-type'] === 'application' &&
      s.metadata?.labels?.['ns.mdn.io/tenant'] === req.tenantId
    );
    
    const migrationJobName = `${req.tenantId}-migrate-data`;
    req.existingMigrationJob = jobs[migrationJobName] || 
      findResource(req.related['Job.batch/v1'], j => j.metadata?.name === migrationJobName);
    
    console.log('  Tenant Pod:', req.tenantPod?.metadata?.name || '(not found)');
    console.log('  App-credentials Secret:', req.appCredentialsSecret?.metadata?.name || '(not found)');
    console.log('  Existing migration Job:', req.existingMigrationJob?.metadata?.name || '(none)');
    
    if (req.tenantPod) {
      req.podIP = req.tenantPod.status?.podIP;
      req.podPhase = req.tenantPod.status?.phase;
      const mongoReady = req.tenantPod.status?.containerStatuses?.find(c =>
        c.name === 'mongodb' && c.ready
      );
      req.mongoReady = !!mongoReady;
      
      console.log('    Pod phase:', req.podPhase);
      console.log('    Pod IP:', req.podIP || '(pending)');
      console.log('    MongoDB container ready:', req.mongoReady);
    }
    
    return next();
  }
  
  /**
   * Stage 4: Evaluate prerequisites for migration
   */
  function evaluatePrerequisites(req, res, next) {
    req.prerequisites = {
      isTenant: req.tenantCR && req.tenantCR.spec.configMapRef.name == req.configMap.metadata.name,
      hasPod: !!req.tenantPod,
      podRunning: req.podPhase === 'Running',
      hasPodIP: !!req.podIP,
      mongoReady: req.mongoReady,
      hasAppCredentials: !!req.appCredentialsSecret,
      hasSourceMongo: !!req.configMap.data?.mongo
    };
    
    req.prerequisitesMet = Object.values(req.prerequisites).every(v => v);
    
    console.log('  ', req.tenantId, ' Prerequisites:', JSON.stringify(req.prerequisites));
    console.log('  All prerequisites met:', req.prerequisitesMet);
    
    return next();
  }
  
  /**
   * Stage 5: Plan migration Job
   * Renders or preserves migration Job based on state
   */
  function planMigrationJob(req, res, next) {
    const migrationJobName = `${req.tenantId}-migrate-data`;
    
    if (req.existingMigrationJob) {
      if (jobSucceeded(req.existingMigrationJob)) {
        console.log('  Migration Job succeeded - marking data migrated');
        res.annotations['ns.mdn.io/data-migrated'] = new Date().toISOString();
        res.annotations['ns.mdn.io/migration-phase'] = 'completed';
        res.labels['role'] = 'dedicated';
        // res.annotations['ns.mdn.io/migration-job-name'] = migrationJobName;
        res.attachments.push(cleanForAttachment(req.existingMigrationJob));
        return next();
      }

      if (jobFailed(req.existingMigrationJob)) {
        console.log('  Migration Job failed - marking phase failed');
        res.annotations['ns.mdn.io/migration-phase'] = 'failed';
        res.attachments.push(cleanForAttachment(req.existingMigrationJob));
        return next();
      }
      
      console.log('  Migration Job in progress - preserving');
      // res.annotations['ns.mdn.io/migration-phase'] = 'copying';
      // res.attachments.push(cleanForAttachment(req.existingMigrationJob));
      // return next();
    }

    var isAutomaticPolicyApplicable = req.configMap.metadata.labels.role == config.migration.auto_migrate_role;
    var isAutomatic = req.migrationPolicy == 'auto';
    var isTenant = req.prerequisites.isTenant;
    var isNotStarted = req.migrationPhase !== 'copying';
    var autoPolicy = { isAutomaticPolicyApplicable, isAutomatic, isTenant, isNotStarted };
    console.log('  START MIGRATION PROCESS?', req.tenantId, Object.values(autoPolicy).every(v => v), autoPolicy);
    if (isAutomaticPolicyApplicable && isAutomatic && isTenant && isNotStarted) {
      console.log("  Automatic stamping annotating as migration-phase");
      res.annotations['ns.mdn.io/migration-phase'] = 'copying';
      return next( );
    }

    if (!req.prerequisitesMet) {
      console.log('  Prerequisites not met - cannot render migration Job');
      return next();
    }


    if (req.migrationPolicy === 'manual' && req.migrationPhase !== 'copying') {
      res.annotations['ns.mdn.io/migration-phase'] = 'copying';
      console.log('  Manual policy requires explicit phase=copying to start');
      return next();
    }

    console.log('  Rendering migration Job');
    console.log(`    Source: ConfigMap ${req.configMap.metadata.name} (data.mongo)`);
    console.log(`    Target: Secret ${req.appCredentialsSecret.metadata.name} → Pod IP ${req.podIP}`);
    
    const migrationJob = renderMigrationJob({
      tenantId: req.tenantId,
      namespace: req.namespace,
      configMapName: req.configMap.metadata.name,
      appCredentialsSecretName: req.appCredentialsSecret.metadata.name,
      podIP: req.podIP,
      labels: {
        tenant: req.tenantId,
        'app.kubernetes.io/part-of': 'nightscout-tenant'
      }
    }, config);
    
    res.attachments.push(migrationJob);
    // res.annotations['ns.mdn.io/migration-phase'] = 'copying';
    // res.annotations['ns.mdn.io/migration-job-name'] = migrationJobName;
    
    console.log('  Migration Job rendered:', migrationJobName);
    
    return next();
  }
  
  /**
   * Stage 6: Format decorator response
   */
  function formatResponse(req, res, next) {
    const hasAnnotationChanges = Object.keys(res.annotations).length > 0;
    const hasLabelChanges = Object.keys(res.labels).length > 0;
    const hasAttachments = res.attachments.length > 0;
    
    if (!hasAnnotationChanges && !hasAttachments) {
      console.log('  No changes - returning no-op');
      res.send({ attachments: [] });
      return;
    }
    
    const response = {
      attachments: res.attachments
    };
    
    if (hasAnnotationChanges) {
      response.annotations = res.annotations;
    }
    
    if (hasLabelChanges) {
      response.labels = res.labels;
    }
    
    console.log('  Response:', response);
    
    res.send(response);
  }
  
  const sync = [
    initialize,
    checkMigrationPolicy,
    discoverResources,
    evaluatePrerequisites,
    planMigrationJob,
    formatResponse
  ];
  
  /**
   * Customize hook: Discover related resources dynamically
   * Returns selectors for Pods, Jobs, and Secrets
   */
  function customizeMigrationRelated(req, res, next) {
    const { parent } = req.body;
    const tenantId = parent.metadata?.labels?.tenant;
    
    console.log('Tenant Migration Decorator customize: ConfigMap', parent.metadata?.name);
    console.log('  Tenant ID:', tenantId);
    
    if (!tenantId) {
      console.log('  No tenant label - returning empty relatedResources');
      return res.json({ relatedResources: [] });
    }
    
    const relatedResources = [
      /*
      */
      {
        apiVersion: 'nightscout.io/v1alpha1',
        resource: 'nightscouttenants',
        labelSelector: {
          matchLabels: {
            'app.kubernetes.io/name': 'nightscout-tenant',
            'ns.mdn.io/tenant': tenantId
          }
        }
      },
      {
        apiVersion: 'v1',
        resource: 'pods',
        labelSelector: {
          matchLabels: {
            'ns.mdn.io/composite': 'tenant',
            tenant: tenantId
          }
        }
      },
      {
        apiVersion: 'v1',
        resource: 'secrets',
        labelSelector: {
          matchExpressions: [
            {
              key: 'ns.mdn.io/credential-type',
              operator: 'In',
              values: ['application']
            },
            {
              key: 'ns.mdn.io/composite',
              operator: 'In',
              values: ['tenant']
            },
            {
              key: 'ns.mdn.io/tenant',
              operator: 'In',
              values: [tenantId]
            }
          ]
        }
      }
    ];
    
    console.log('  Related resources:', relatedResources.length);
    
    res.json({ relatedResources });
  }
  
  const customize = [customizeMigrationRelated];
  
  return { sync, customize };
}

module.exports = createDecoratorSync;
