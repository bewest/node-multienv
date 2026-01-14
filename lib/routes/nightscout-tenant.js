/**
 * Route handlers for NightscoutTenant CRD operations (Gen5)
 * 
 * Two-phase provisioning model:
 * Phase 1: POST /accounts/:storageAccountId
 *   - Creates PVC for MongoDB data
 *   - Creates mongo-auth Secret with root credentials
 *   - Creates NightscoutTenant CR with spec.storage set
 * 
 * Phase 2: POST /accounts/:storageAccountId/sites/:tenantId
 *   - Creates/updates ConfigMap for tenant userdata
 *   - Updates NightscoutTenant CR with spec.tenant and spec.configMapRef
 * 
 * Identity Pattern:
 * - CR name (resourceName): Used for child resource naming (PVC, Jobs, Secrets)
 * - spec.storage: Storage account ID, drives ns.mdn.io/storage label
 * - spec.tenant: Tenant ID (set on site creation), drives ns.mdn.io/tenant label
 */

var Client = require("@kubernetes/client-node");
var crypto = require('crypto');

/**
 * Generate secure random password
 */
function generateSecurePassword(length = 32) {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~';
  let password = '';
  const randomBytes = crypto.randomBytes(length);
  
  for (let i = 0; i < length; i++) {
    password += charset[randomBytes[i] % charset.length];
  }
  
  return password;
}

/**
 * Generate unique username with random suffix
 */
function generateUsername(storageAccountId, prefix = 'nsuser') {
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  return `${prefix}-${storageAccountId}-${randomSuffix}`;
}

/**
 * Generate short unique database name for storage account
 * Format: ns-<short-hash>
 */
function generateDatabaseName(storageAccountId) {
  const hash = crypto.createHash('sha256').update(storageAccountId).digest('hex');
  return `ns-${hash.substring(0, 6)}`;
}

/**
 * Generate API_SECRET for Nightscout
 */
function generateApiSecret(length = 16) {
  return crypto.randomBytes(length).toString('hex');
}

function createNightscoutTenantRoutes(kc, namespace, cfg) {
  const k8sCustom = kc.makeApiClient(Client.CustomObjectsApi);
  const k8sCore = kc.makeApiClient(Client.CoreV1Api);
  
  const CRD_GROUP = 'nightscout.io';
  const CRD_VERSION = 'v1alpha1';
  const CRD_PLURAL = 'nightscouttenants';

  /**
   * Template: PVC for MongoDB data
   * Name: data-{storageAccountId}-0
   */
  function templatePVC(storageAccountId, cfg, options = {}) {
    const pvcName = `data-${storageAccountId}-0`;
    const storageSize = options.storageSize || cfg.default?.storageSize || '2Gi';
    const storageClass = options.storageClass || cfg.default?.storageClass;
    const storageType = options.storageType || cfg.default?.provisioner?.storageType || 'dedicated';
    const tier = options.tier || 'basic';
    
    const pvc = {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: pvcName,
        labels: {
          'app.kubernetes.io/name': 'mongodb',
          'app.kubernetes.io/component': 'database',
          'app.kubernetes.io/part-of': 'nightscout-tenant',
          'app.kubernetes.io/managed-by': 'provisioner',
          'ns.mdn.io/storage': storageAccountId
        },
        annotations: {
          // 'ns.mdn.io/storage-type': storageType,
          'ns.mdn.io/tier': tier,
          'ns.mdn.io/created-at': new Date().toISOString()
        }
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: {
          requests: {
            storage: storageSize
          }
        }
      }
    };
    
    if (storageClass) {
      pvc.spec.storageClassName = storageClass;
    }
    
    return pvc;
  }

  /**
   * Template: mongo-auth Secret with root credentials
   * Name: {storageAccountId}-mongo-auth
   */
  function templateMongoAuthSecret(storageAccountId, cfg, options = {}) {
    const secretName = `${storageAccountId}-mongo-auth`;
    const storageType = options.storageType || cfg.default?.provisioner?.storageType || 'dedicated';
    const tier = options.tier || 'basic';
    
    const rootUsername = generateUsername(storageAccountId, 'admin');
    const rootPassword = generateSecurePassword(16);
    const appUsername = generateUsername(storageAccountId, 'app');
    const appPassword = generateSecurePassword(16);
    const databaseName = generateDatabaseName(storageAccountId);
    
    return {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: secretName,
        labels: {
          'app.kubernetes.io/name': 'mongodb-auth',
          'app.kubernetes.io/component': 'database',
          'app.kubernetes.io/part-of': 'nightscout-tenant',
          'app.kubernetes.io/managed-by': 'provisioner',
          'ns.mdn.io/storage': storageAccountId,
          'ns.mdn.io/composite': 'mongodb-auth'
        },
        annotations: {
          'ns.mdn.io/storage-type': storageType,
          'ns.mdn.io/tier': tier,
          'ns.mdn.io/created-at': new Date().toISOString()
        }
      },
      stringData: {
        STORAGE: storageAccountId,
        MONGO_INITDB_ROOT_USERNAME: rootUsername,
        MONGO_INITDB_ROOT_PASSWORD: rootPassword,
        MONGO_INITDB_DATABASE: databaseName,
        username: appUsername,
        password: appPassword,
        database: databaseName
      }
    };
  }

  /**
   * Template: NightscoutTenant CR
   * Name: {storageAccountId}
   */
  function templateNightscoutTenantCR(storageAccountId, cfg, options = {}) {
    const pvcName = `data-${storageAccountId}-0`;
    const mongoAuthSecretRef = `${storageAccountId}-mongo-auth`;
    const storageType = options.storageType || cfg.default?.provisioner?.storageType || 'dedicated';
    const mongodbVersion = options.mongodbVersion || cfg.default?.mongodbVersion || '7.0';
    const nightscoutImage = options.nightscoutImage || cfg.default?.nightscoutImage || 'nightscout/cgm-remote-monitor:latest';
    
    const cr = {
      apiVersion: `${CRD_GROUP}/${CRD_VERSION}`,
      kind: 'NightscoutTenant',
      metadata: {
        name: storageAccountId,
        labels: {
          'app.kubernetes.io/name': 'nightscout-tenant',
          'app.kubernetes.io/managed-by': 'metacontroller',
          'ns.mdn.io/storage': storageAccountId
        },
        annotations: {
          'ns.mdn.io/created-at': new Date().toISOString()
        }
      },
      spec: {
        storage: storageAccountId,
        pvcName: pvcName,
        mongoAuthSecretRef: mongoAuthSecretRef,
        selector: {
          matchLabels: {
            'ns.mdn.io/storage': storageAccountId,
            'app.kubernetes.io/part-of': 'nightscout-tenant', 
            'ns.mdn.io/composite': 'tenant', 
          }
        },
        initialStorageType: storageType,
        mongodbVersion: mongodbVersion,
        nightscoutImage: nightscoutImage
      }
    };
    
    if (options.storageSize) {
      cr.spec.storageSize = options.storageSize;
    }
    if (options.storageClass) {
      cr.spec.storageClass = options.storageClass;
    }
    if (options.tier) {
      cr.spec.tier = options.tier;
    }
    
    return cr;
  }

  /**
   * Template: ConfigMap for tenant userdata
   * Name: {tenantId} or custom name
   */
  function templateConfigMap(storageAccountId, tenantId, cfg, options = {}) {
    const configMapName = options.configMapName || `${tenantId}`;
    const apiSecret = options.apiSecret || generateApiSecret();
    
    const labels = {
      'app.kubernetes.io/name': 'nightscout-config',
      'app.kubernetes.io/component': 'configuration',
      'app.kubernetes.io/part-of': 'nightscout-tenant',
      'app.kubernetes.io/managed-by': 'provisioner',
      'ns.mdn.io/storage': storageAccountId,
      'role': 'dedicated'
    };
    
    if (tenantId) {
      labels['ns.mdn.io/tenant'] = tenantId;
    }
    
    return {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: configMapName,
        labels: labels,
        annotations: {
          'ns.mdn.io/created-at': new Date().toISOString()
        }
      },
      data: {
        API_SECRET: apiSecret,
        ENABLE: options.enable || 'careportal boluscalc food rawbg iob cob bwp cage sage basal pump openaps',
        TIME_FORMAT: options.timeFormat || '24',
        THEME: options.theme || 'colors',
        DISPLAY_UNITS: options.displayUnits || 'mmol',
        ...(options.data || {})
      }
    };
  }

  /**
   * Generate a unique storage account ID
   */
  function generateStorageAccountId() {
    return crypto.randomBytes(8).toString('hex');
  }

  /**
   * Handler: Ensure storage account ID exists (generate if not provided)
   * Must run before any resource creation handlers
   */
  function ensureStorageAccountId(req, res, next) {
    let storageAccountId = req.params.account || req.body?.accountId || req.body?.storageAccountId;
    
    if (!storageAccountId) {
      storageAccountId = generateStorageAccountId();
      console.log(`[NightscoutTenant] Generated storage account ID: ${storageAccountId}`);
    }
    
    req.params.account = storageAccountId;
    req.storageAccountId = storageAccountId;
    
    console.log(`[NightscoutTenant] Storage account ID: ${storageAccountId}`);
    next();
  }

  /**
   * Handler: Create or get PVC (idempotent)
   */
  function handleCreateOrGetPVC(req, res, next) {
    const storageAccountId = req.params.account;
    const pvcName = `data-${storageAccountId}-0`;
    
    console.log(`[NightscoutTenant] Checking PVC: ${pvcName}`);
    
    k8sCore.readNamespacedPersistentVolumeClaim(pvcName, namespace)
      .then((existing) => {
        console.log(`[NightscoutTenant] PVC exists: ${pvcName}`);
        req.pvc = existing.body;
        req.pvcCreated = false;
        next();
      })
      .catch((err) => {
        if (err.statusCode === 404 || err.response?.statusCode === 404) {
          console.log(`[NightscoutTenant] Creating PVC: ${pvcName}`);
          const pvc = templatePVC(storageAccountId, cfg, req.body || {});
          
          return k8sCore.createNamespacedPersistentVolumeClaim(namespace, pvc)
            .then((result) => {
              console.log(`[NightscoutTenant] PVC created: ${pvcName}`);
              req.pvc = result.body;
              req.pvcCreated = true;
              next();
            });
        }
        throw err;
      })
      .catch(next);
  }

  /**
   * Handler: Create or get mongo-auth Secret (idempotent, preserves existing credentials)
   */
  function handleCreateOrGetMongoAuthSecret(req, res, next) {
    const storageAccountId = req.params.account;
    const secretName = `${storageAccountId}-mongo-auth`;
    
    console.log(`[NightscoutTenant] Checking mongo-auth Secret: ${secretName}`);
    
    k8sCore.readNamespacedSecret(secretName, namespace)
      .then((existing) => {
        console.log(`[NightscoutTenant] mongo-auth Secret exists: ${secretName}`);
        req.mongoAuthSecret = existing.body;
        req.secretCreated = false;
        
        const storageType = req.body?.storageType || cfg.default?.provisioner?.storageType || 'dedicated';
        const tier = req.body?.tier || 'basic';
        const currentStorageType = existing.body.metadata?.annotations?.['ns.mdn.io/storage-type'];
        const currentTier = existing.body.metadata?.annotations?.['ns.mdn.io/tier'];
        
        if (currentStorageType !== storageType || currentTier !== tier) {
          console.log(`[NightscoutTenant] Updating mongo-auth Secret metadata: ${secretName}`);
          const updated = {
            ...existing.body,
            metadata: {
              ...existing.body.metadata,
              labels: {
                ...existing.body.metadata.labels,
                'ns.mdn.io/storage': storageAccountId,
                'ns.mdn.io/composite': 'mongodb-auth'
              },
              annotations: {
                ...existing.body.metadata.annotations,
                'ns.mdn.io/storage-type': storageType,
                'ns.mdn.io/tier': tier,
                'ns.mdn.io/updated-at': new Date().toISOString()
              }
            }
          };
          return k8sCore.replaceNamespacedSecret(secretName, namespace, updated)
            .then((result) => {
              req.mongoAuthSecret = result.body;
              next();
            });
        }
        
        next();
      })
      .catch((err) => {
        if (err.statusCode === 404 || err.response?.statusCode === 404) {
          console.log(`[NightscoutTenant] Creating mongo-auth Secret: ${secretName}`);
          const secret = templateMongoAuthSecret(storageAccountId, cfg, req.body || {});
          
          return k8sCore.createNamespacedSecret(namespace, secret)
            .then((result) => {
              console.log(`[NightscoutTenant] mongo-auth Secret created: ${secretName}`);
              req.mongoAuthSecret = result.body;
              req.secretCreated = true;
              next();
            });
        }
        throw err;
      })
      .catch(next);
  }

  /**
   * Handler: Create or update NightscoutTenant CR
   */
  function handleCreateOrUpdateTenantCR(req, res, next) {
    const storageAccountId = req.params.account;
    
    console.log(`[NightscoutTenant] Checking NightscoutTenant CR: ${storageAccountId}`);
    
    k8sCustom.getNamespacedCustomObject(CRD_GROUP, CRD_VERSION, namespace, CRD_PLURAL, storageAccountId)
      .then((existing) => {
        console.log(`[NightscoutTenant] NightscoutTenant CR exists: ${storageAccountId}`);
        
        const cr = templateNightscoutTenantCR(storageAccountId, cfg, req.body || {});
        cr.metadata.resourceVersion = existing.body.metadata.resourceVersion;
        
        if (existing.body.spec.tenant) {
          cr.spec.tenant = existing.body.spec.tenant;
        }
        if (existing.body.spec.configMapRef) {
          cr.spec.configMapRef = existing.body.spec.configMapRef;
        }
        
        return k8sCustom.replaceNamespacedCustomObject(
          CRD_GROUP, CRD_VERSION, namespace, CRD_PLURAL, storageAccountId, cr
        ).then((result) => {
          console.log(`[NightscoutTenant] NightscoutTenant CR updated: ${storageAccountId}`);
          req.tenantCR = result.body;
          req.crCreated = false;
          next();
        });
      })
      .catch((err) => {
        if (err.statusCode === 404 || err.response?.statusCode === 404) {
          console.log(`[NightscoutTenant] Creating NightscoutTenant CR: ${storageAccountId}`);
          const cr = templateNightscoutTenantCR(storageAccountId, cfg, req.body || {});
          
          return k8sCustom.createNamespacedCustomObject(
            CRD_GROUP, CRD_VERSION, namespace, CRD_PLURAL, cr
          ).then((result) => {
            console.log(`[NightscoutTenant] NightscoutTenant CR created: ${storageAccountId}`);
            req.tenantCR = result.body;
            req.crCreated = true;
            next();
          });
        }
        throw err;
      })
      .catch(next);
  }

  /**
   * Handler: Format account creation response
   */
  function formatAccountResponse(req, res, next) {
    res.json({
      account: req.params.account,
      storageType: req.tenantCR?.spec?.initialStorageType,
      phase: req.tenantCR?.status?.phase || 'Pending',
      resources: {
        pvc: {
          name: req.pvc?.metadata?.name,
          created: req.pvcCreated
        },
        secret: {
          name: req.mongoAuthSecret?.metadata?.name,
          created: req.secretCreated
        },
        tenant: {
          name: req.tenantCR?.metadata?.name,
          created: req.crCreated
        }
      }
    });
    next();
  }

  /**
   * Handler: Create or update ConfigMap for site
   */
  function handleCreateOrUpdateConfigMap(req, res, next) {
    const storageAccountId = req.params.account;
    // const tenantId = req.params.site;
    const tenantId = req.body.internal_name;
    const configMapName = req.body?.configMapName || `${tenantId}`;
    
    console.log(`[NightscoutTenant] Checking ConfigMap: ${configMapName}`);
    
    k8sCore.readNamespacedConfigMap(configMapName, namespace)
      .then((existing) => {
        console.log(`[NightscoutTenant] ConfigMap exists: ${configMapName}`);
        
        const updated = {
          ...existing.body,
          metadata: {
            ...existing.body.metadata,
            labels: {
              ...existing.body.metadata.labels,
              'ns.mdn.io/storage': storageAccountId,
              'ns.mdn.io/tenant': tenantId
            },
            annotations: {
              ...existing.body.metadata.annotations,
              'ns.mdn.io/updated-at': new Date().toISOString()
            }
          },
          data: {
            ...existing.body.data,
            ...(req.body?.data || {})
          }
        };
        
        return k8sCore.replaceNamespacedConfigMap(configMapName, namespace, updated)
          .then((result) => {
            console.log(`[NightscoutTenant] ConfigMap updated: ${configMapName}`);
            req.configMap = result.body;
            req.configMapCreated = false;
            next();
          });
      })
      .catch((err) => {
        if (err.statusCode === 404 || err.response?.statusCode === 404) {
          console.log(`[NightscoutTenant] Creating ConfigMap: ${configMapName}`);
          const cm = templateConfigMap(storageAccountId, tenantId, cfg, {
            configMapName,
            ...(req.body || {})
          });
          
          return k8sCore.createNamespacedConfigMap(namespace, cm)
            .then((result) => {
              console.log(`[NightscoutTenant] ConfigMap created: ${configMapName}`);
              req.configMap = result.body;
              req.configMapCreated = true;
              next();
            });
        }
        throw err;
      })
      .catch(next);
  }

  /**
   * Handler: Update NightscoutTenant CR with tenant ID and configMapRef
   */
  function handleUpdateTenantWithSite(req, res, next) {
    const storageAccountId = req.params.account;
    const tenantId = req.params.site;
    const configMapName = req.configMap?.metadata?.name;
    
    console.log(`[NightscoutTenant] Updating NightscoutTenant CR with site: ${storageAccountId} -> ${tenantId}`);
    
    k8sCustom.getNamespacedCustomObject(CRD_GROUP, CRD_VERSION, namespace, CRD_PLURAL, storageAccountId)
      .then((existing) => {
        const cr = existing.body;
        
        cr.spec.tenant = tenantId;
        cr.spec.configMapRef = {
          name: configMapName,
          namespace: namespace
        };
        
        cr.metadata.labels = cr.metadata.labels || {};
        cr.metadata.labels['ns.mdn.io/tenant'] = tenantId;
        
        cr.metadata.annotations = cr.metadata.annotations || {};
        cr.metadata.annotations['ns.mdn.io/site-created-at'] = new Date().toISOString();
        
        return k8sCustom.replaceNamespacedCustomObject(
          CRD_GROUP, CRD_VERSION, namespace, CRD_PLURAL, storageAccountId, cr
        );
      })
      .then((result) => {
        console.log(`[NightscoutTenant] NightscoutTenant CR updated with site: ${storageAccountId}`);
        req.tenantCR = result.body;
        next();
      })
      .catch(next);
  }

  /**
   * Handler: Format site creation response
   */
  function formatSiteResponse(req, res, next) {
    res.json({
      account: req.params.account,
      site: req.params.site,
      configMap: {
        name: req.configMap?.metadata?.name,
        created: req.configMapCreated
      },
      tenant: {
        name: req.tenantCR?.metadata?.name,
        spec: {
          storage: req.tenantCR?.spec?.storage,
          tenant: req.tenantCR?.spec?.tenant,
          configMapRef: req.tenantCR?.spec?.configMapRef
        }
      }
    });
    next();
  }

  /**
   * Handler: Get NightscoutTenant CR by name
   */
  function getTenantCR(req, res, next) {
    const storageAccountId = req.params.account;
    
    k8sCustom.getNamespacedCustomObject(CRD_GROUP, CRD_VERSION, namespace, CRD_PLURAL, storageAccountId)
      .then((result) => {
        res.result = result.body;
        next();
      })
      .catch(next);
  }

  /**
   * Handler: List all NightscoutTenant CRs
   */
  function listTenantCRs(req, res, next) {
    const labelSelector = req.query?.labelSelector;
    
    k8sCustom.listNamespacedCustomObject(
      CRD_GROUP, CRD_VERSION, namespace, CRD_PLURAL,
      undefined, undefined, undefined, undefined, labelSelector
    )
      .then((result) => {
        res.result = result.body;
        next();
      })
      .catch(next);
  }

  /**
   * Handler: Delete NightscoutTenant CR
   * Note: PVC and mongo-auth Secret are protected resources (not deleted)
   */
  function deleteTenantCR(req, res, next) {
    const storageAccountId = req.params.account;
    
    console.log(`[NightscoutTenant] Deleting NightscoutTenant CR: ${storageAccountId}`);
    console.log(`[NightscoutTenant] Note: PVC and mongo-auth Secret are protected and will not be deleted`);
    
    k8sCustom.deleteNamespacedCustomObject(CRD_GROUP, CRD_VERSION, namespace, CRD_PLURAL, storageAccountId)
      .then(() => {
        res.status(204);
        res.end();
        next();
      })
      .catch(next);
  }

  /**
   * Handler: Delete site (removes ConfigMap and clears spec.tenant/configMapRef)
   */
  function deleteSite(req, res, next) {
    const storageAccountId = req.params.account;
    const tenantId = req.params.site;
    
    console.log(`[NightscoutTenant] Deleting site: ${storageAccountId}/${tenantId}`);
    
    k8sCustom.getNamespacedCustomObject(CRD_GROUP, CRD_VERSION, namespace, CRD_PLURAL, storageAccountId)
      .then((existing) => {
        const cr = existing.body;
        const configMapName = cr.spec.configMapRef?.name;
        
        if (configMapName) {
          return k8sCore.deleteNamespacedConfigMap(configMapName, namespace)
            .then(() => {
              console.log(`[NightscoutTenant] ConfigMap deleted: ${configMapName}`);
            })
            .catch((err) => {
              if (err.statusCode !== 404 && err.response?.statusCode !== 404) {
                throw err;
              }
              console.log(`[NightscoutTenant] ConfigMap already deleted: ${configMapName}`);
            })
            .then(() => cr);
        }
        
        return cr;
      })
      .then((cr) => {
        delete cr.spec.tenant;
        delete cr.spec.configMapRef;
        
        if (cr.metadata.labels) {
          delete cr.metadata.labels['ns.mdn.io/tenant'];
        }
        
        return k8sCustom.replaceNamespacedCustomObject(
          CRD_GROUP, CRD_VERSION, namespace, CRD_PLURAL, storageAccountId, cr
        );
      })
      .then((result) => {
        console.log(`[NightscoutTenant] Site cleared from NightscoutTenant CR: ${storageAccountId}`);
        res.json({
          account: storageAccountId,
          site: tenantId,
          deleted: true,
          message: 'Site deleted. ConfigMap removed and tenant deactivated. PVC and mongo-auth Secret preserved.'
        });
        next();
      })
      .catch(next);
  }

  /**
   * Handler: Format result for GET operations
   */
  function formatResult(req, res, next) {
    if (res.result) {
      res.json(res.result);
    }
    next();
  }

  return {
    createOrUpdateAccount: [
      ensureStorageAccountId,
      handleCreateOrGetPVC,
      handleCreateOrGetMongoAuthSecret,
      handleCreateOrUpdateTenantCR,
      formatAccountResponse
    ],
    
    createOrUpdateSite: [
      handleCreateOrUpdateConfigMap,
      handleUpdateTenantWithSite,
      formatSiteResponse
    ],
    
    getTenant: [getTenantCR, formatResult],
    
    listTenants: [listTenantCRs, formatResult],
    
    deleteTenant: deleteTenantCR,
    
    deleteSite: deleteSite
  };
}

module.exports = createNightscoutTenantRoutes;
