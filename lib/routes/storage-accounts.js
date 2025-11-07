/**
 * Route handlers for StorageAccount CRD operations
 * Follows pattern from lib/routes/instances.js
 */

var Client = require("@kubernetes/client-node");
var createStorageAccountTemplate = require('../templates/storage-account');

/**
 * Generate secure random password
 */
function generateSecurePassword(length = 32) {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*-_+=';
  const crypto = require('crypto');
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
function generateUsername(storageAccount, prefix='nsuser') {
  const crypto = require('crypto');
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  return `${prefix}-${storageAccount}-${randomSuffix}`;
}

/**
 * Generate short unique database name for storage account
 * Format: ns-<short-hash>
 */
function generateDatabaseName(storageAccount) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(storageAccount).digest('hex');
  return `ns-${hash.substring(0, 6)}`;
}


function createStorageAccountRoutes(kc, namespace, cfg) {
  const k8s = kc.makeApiClient(Client.CustomObjectsApi);
  const CRD_GROUP = 'nightscout.io';
  const CRD_VERSION = 'v1alpha1';
  const CRD_PLURAL = 'storageaccounts';

  function template_initial_storage_secret (accountId, storageType, tier, stringData) {
    const secretName = `${accountId}-mongo-auth`;
    
    // Create K8s secret with provisioning root MongoDB credentials
    // This Secret triggers the storage composite controller via ns.mdn.io/composite label
    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: secretName,
        labels: {
          'app.kubernetes.io/managed-by': 'metacontroller',
          'storage.nightscout.org/account': accountId,
          // set to storage to manage as a child, set to key to set as related?
          'ns.mdn.io/composite': 'key' // TODO: set via env variable/config?
        },
        annotations: {
          'ns.mdn.io/storage-type': storageType,
          'ns.mdn.io/tier': tier || 'basic',
          'ns.mdn.io/created-at': new Date().toISOString(),
          // [ANNOTATIONS.PROTECTED_RESOURCE]: 'true'
        },
        ownerReferences: null  // CRITICAL: Protected resource - survives parent deletion
      },
      stringData
    };
    return secret;
  }

  function handle_new_provisioner_account_webhook (req, res, next) {
    const k8s = kc.makeApiClient(Client.CoreV1Api);
    const selected_namespace = namespace;
    const accountId = req.params.account || objectId();
    req.params.account = accountId;
    const storageType = req.body?.storageType || cfg.default.provisioner.storageType;
    const tier = req.body?.tier;
    
    const secretName = `${accountId}-mongo-auth`;
      // Generate new credentials

    const root_username = generateUsername(accountId, 'admin');
    const root_password = generateSecurePassword(32);
    const databaseName = generateDatabaseName(accountId);
    const stringData = {
      STORAGE: accountId,
      MONGO_INITDB_ROOT_USERNAME: root_username,
      MONGO_INITDB_ROOT_PASSWORD: root_password,
      MONGO_INITDB_DATABASE: databaseName
    };

    var secret = template_initial_storage_secret(accountId, storageType, tier, stringData);
    
    // Idempotent: try to get existing secret first
    k8s.readNamespacedSecret(secretName, selected_namespace)
      .then((existing) => {
        // Secret exists, update it
        secret = template_initial_storage_secret(accountId, storageType, tier, { });
        secret.data = existing.body.data;
        console.log("UPDATING EXISTING PROVISIONER ACCOUNT SECRET WITH EXISTING DATA", secretName, existing);
        console.log("UPDATING EXISTING PROVISIONER ACCOUNT SECRET OLD LABELS/ANNOTATIONS", existing.body.metadata.labels, existing.body.metadata.annotations);
        console.log("REPLACED PROVISIONER ACCOUNT SECRET OLD LABELS/ANNOTATIONS", secret.metadata.labels, secret.metadata.annotations);
        return k8s.replaceNamespacedSecret(secretName, selected_namespace, secret);
      })
      .catch((err) => {
        // Secret doesn't exist (404), create it
        if (err.statusCode === 404 || err.response?.statusCode === 404) {
          console.log("CREATING NEW PROVISIONER ACCOUNT SECRET", secretName);
          return k8s.createNamespacedSecret(selected_namespace, secret);
        }
        throw err;
      })
      .then((result) => {
        console.log("PROVISIONER ACCOUNT SECRET READY", secretName);
        res.storageSecret = {
          account: accountId,
          storageType: secret.metadata.annotations['ns.mdn.io/storage-type'],
          tier: secret.metadata.annotations['ns.mdn.io/tier'],
          resource: result.body
        };
        next();
      })
      .catch(next);
  }

  function createOrUpdateStorageAccountCRD (req, res, next) {
    const accountId = req.params.account || req.body.accountId;
    // if (req.storageSecret) { }
    
    if (!accountId) {
      return next(new Error('Account ID required in URL parameter or body.accountId'));
    }

    const storageAccount = createStorageAccountTemplate(accountId, cfg, req.body);

    // Idempotent: try to get existing resource first
    k8s.getNamespacedCustomObject(
      CRD_GROUP,
      CRD_VERSION,
      namespace,
      CRD_PLURAL,
      accountId
    ).then(function (existing) {
      // StorageAccount exists, update it
      console.log("UPDATING EXISTING STORAGEACCOUNT", accountId);
      // Preserve resourceVersion to avoid 409 conflict errors
      storageAccount.metadata.resourceVersion = existing.body.metadata.resourceVersion;
      return k8s.replaceNamespacedCustomObject(
        CRD_GROUP,
        CRD_VERSION,
        namespace,
        CRD_PLURAL,
        accountId,
        storageAccount
      );
    }).catch(function (error) {
      // StorageAccount doesn't exist (404), create it
      if (error.statusCode === 404 || error.response?.statusCode === 404) {
        console.log("CREATING NEW STORAGEACCOUNT", accountId);
        return k8s.createNamespacedCustomObject(
          CRD_GROUP,
          CRD_VERSION,
          namespace,
          CRD_PLURAL,
          storageAccount
        );
      }
      throw error;
    }).then(function (result) {
      console.log("STORAGEACCOUNT READY", accountId);
      res.json({
        account: accountId,
        tier: storageAccount.spec.tier,
        resource: result.body
      });
      next();
    }).catch(next);
  }

  return {
    /**
     * Create or update a StorageAccount
     * POST /accounts OR POST /accounts/:account
     */
    createOrUpdateStorageAccount: [ handle_new_provisioner_account_webhook, createOrUpdateStorageAccountCRD ],

    /**
     * Get a StorageAccount by name
     * GET /accounts/:account
     */
    getStorageAccount: function (req, res, next) {
      const accountId = req.params.account;
      
      k8s.getNamespacedCustomObject(
        CRD_GROUP,
        CRD_VERSION,
        namespace,
        CRD_PLURAL,
        accountId
      ).then(function (result) {
        res.result = result.body;
        next();
      }).catch(next);
    },

    /**
     * List all StorageAccounts
     * GET /accounts
     */
    listStorageAccounts: function (req, res, next) {
      k8s.listNamespacedCustomObject(
        CRD_GROUP,
        CRD_VERSION,
        namespace,
        CRD_PLURAL
      ).then(function (result) {
        res.result = result.body;
        next();
      }).catch(next);
    },

    /**
     * Delete a StorageAccount
     * DELETE /accounts/:account
     */
    deleteStorageAccount: function (req, res, next) {
      const accountId = req.params.account;
      
      k8s.deleteNamespacedCustomObject(
        CRD_GROUP,
        CRD_VERSION,
        namespace,
        CRD_PLURAL,
        accountId
      ).then(function () {
        res.status(204);
        res.end();
        next();
      }).catch(next);
    }
  };
}

module.exports = createStorageAccountRoutes;
