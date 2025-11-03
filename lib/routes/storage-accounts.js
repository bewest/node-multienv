/**
 * Route handlers for StorageAccount CRD operations
 * Follows pattern from lib/routes/instances.js
 */

var Client = require("@kubernetes/client-node");
var createStorageAccountTemplate = require('../templates/storage-account');

function createStorageAccountRoutes(kc, namespace, cfg) {
  const k8s = kc.makeApiClient(Client.CustomObjectsApi);
  const CRD_GROUP = 'nightscout.io';
  const CRD_VERSION = 'v1alpha1';
  const CRD_PLURAL = 'storageaccounts';

  return {
    /**
     * Create or update a StorageAccount
     * POST /accounts OR POST /accounts/:account
     */
    createOrUpdateStorageAccount: function (req, res, next) {
      const accountId = req.params.account || req.body.accountId;
      
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
    },

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
