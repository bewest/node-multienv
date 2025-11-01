/**
 * Route handlers for ComputeInstance CRD operations
 * Follows pattern from lib/routes/instances.js
 */

var Client = require("@kubernetes/client-node");
var createComputeInstanceTemplate = require('../templates/compute-instance');

function createComputeInstanceRoutes(kc, namespace) {
  const k8s = kc.makeApiClient(Client.CustomObjectsApi);
  const CRD_GROUP = 'nightscout.io';
  const CRD_VERSION = 'v1alpha1';
  const CRD_PLURAL = 'computeinstances';

  return {
    /**
     * Create or update a ComputeInstance (site/tenant)
     * POST /accounts/:account/sites/:name OR POST /accounts/:account/sites
     */
    createOrUpdateComputeInstance: function (req, res, next) {
      const accountId = req.params.account;
      const bodyInternalName = req.body?.internal_name;
      const urlParamName = req.params.name || req.query.name;
      const tenantId = bodyInternalName || urlParamName;

      if (!tenantId) {
        return next(new Error('Tenant name required in URL parameter or body.internal_name'));
      }

      if (!accountId) {
        return next(new Error('Account ID required in URL parameter'));
      }

      const computeInstance = createComputeInstanceTemplate(tenantId, accountId, req.body);

      // Idempotent: try to get existing resource first
      k8s.getNamespacedCustomObject(
        CRD_GROUP,
        CRD_VERSION,
        namespace,
        CRD_PLURAL,
        tenantId
      ).then(function (existing) {
        // ComputeInstance exists, update it
        console.log("UPDATING EXISTING COMPUTEINSTANCE", tenantId);
        // Preserve resourceVersion to avoid 409 conflict errors
        computeInstance.metadata.resourceVersion = existing.body.metadata.resourceVersion;
        return k8s.replaceNamespacedCustomObject(
          CRD_GROUP,
          CRD_VERSION,
          namespace,
          CRD_PLURAL,
          tenantId,
          computeInstance
        );
      }).catch(function (error) {
        // ComputeInstance doesn't exist (404), create it
        if (error.statusCode === 404 || error.response?.statusCode === 404) {
          console.log("CREATING NEW COMPUTEINSTANCE", tenantId);
          return k8s.createNamespacedCustomObject(
            CRD_GROUP,
            CRD_VERSION,
            namespace,
            CRD_PLURAL,
            computeInstance
          );
        }
        throw error;
      }).then(function (result) {
        console.log("COMPUTEINSTANCE READY", tenantId);
        res.json({
          tenant: tenantId,
          compute: tenantId,
          account: accountId,
          resource: result.body
        });
        next();
      }).catch(next);
    },

    /**
     * Get a ComputeInstance by name
     * GET /accounts/:account/sites/:name
     */
    getComputeInstance: function (req, res, next) {
      const tenantId = req.params.name;
      
      k8s.getNamespacedCustomObject(
        CRD_GROUP,
        CRD_VERSION,
        namespace,
        CRD_PLURAL,
        tenantId
      ).then(function (result) {
        res.result = result.body;
        next();
      }).catch(next);
    },

    /**
     * List ComputeInstances for an account
     * GET /accounts/:account/sites
     */
    listComputeInstances: function (req, res, next) {
      const accountId = req.params.account;
      
      // listNamespacedCustomObject signature: (group, version, namespace, plural, pretty, allowWatchBookmarks, _continue, fieldSelector, labelSelector, ...)
      k8s.listNamespacedCustomObject(
        CRD_GROUP,
        CRD_VERSION,
        namespace,
        CRD_PLURAL,
        undefined, // pretty
        undefined, // allowWatchBookmarks
        undefined, // _continue
        undefined, // fieldSelector
        accountId ? `storage.nightscout.org/account=${accountId}` : undefined // labelSelector
      ).then(function (result) {
        res.result = result.body;
        next();
      }).catch(next);
    },

    /**
     * Delete a ComputeInstance
     * DELETE /accounts/:account/sites/:name
     */
    deleteComputeInstance: function (req, res, next) {
      const tenantId = req.params.name;
      
      k8s.deleteNamespacedCustomObject(
        CRD_GROUP,
        CRD_VERSION,
        namespace,
        CRD_PLURAL,
        tenantId
      ).then(function () {
        res.status(204);
        res.end();
        next();
      }).catch(next);
    }
  };
}

module.exports = createComputeInstanceRoutes;
