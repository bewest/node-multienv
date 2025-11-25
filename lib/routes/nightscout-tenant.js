
var Client = require("@kubernetes/client-node");

function createProvisionerRoutes(kc, namespace, cfg) {
  const k8s = kc.makeApiClient(Client.CustomObjectsApi);
  const CRD_GROUP = 'nightscout.io';
  const CRD_VERSION = 'v1alpha1';
  const CRD_PLURAL = 'nightscouttenants';

  // pipeline of handlers for /accounts/:account - createOrUpdateAccount
  // * template and create PVC (don't replace)
  // * template and create mongo-auth Secret (don't replace, without a force query param?)
  // * template and create NightscoutTenant - ok to replace? sensitive to body param storageType to set initialStorageType


  // pipeline of handlers for /accounts/:account/sites/:site

  // * template and [re]create/replace/preserve configmap
  // * update NightscoutTenant without tenantId


  // pipeline of handlers for get NightscoutTenant, and remove NightscoutTenant REST requests as well.

}
