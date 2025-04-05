
var Client = require("@kubernetes/client-node");
var objectId = require('../object-id');

function createInstanceRoutes (kc, namespace) {
  const k8s = kc.makeApiClient(Client.CustomObjectsApi);

  function suggest_template (req, res, next) {
    const { account } = req.params;
    const instance = {
      apiVersion: 'nightscout.k8s/v1alpha1',
      kind: 'NightscoutInstance',
      metadata: {
        name: req.body.internal_name,
        labels: {
          'storage.nightscout.org/account': account,
          'tenant.nightscout.org/internal_name': req.body.internal_name,
          'tenant.nightscout.org/WEB_NAME': req.body.internal_name
          // role: MULTIENV_TENANT_INSTANCE_ROLE
          // component: MULTIENV_TENANT_INSTANCE_COMPONENT
          // TODO: also tenant/WEB_NAME label comes from req.body.internal_name
          //   this value should match /accounts/:account/sites/:name (req.params.name) when the handler is re-used.
          // TODO: use a label passed from environment to allow runtime
          //   environment to tailor things.  include role, component, app or
          //   other relevant annotations for our project
        }
      },
      spec: {
        parameters: {
          storeageAccount: account,
          WEB_NAME: req.body.internal_name
        }
      }
    };

    // return instance;
    res.suggestion = instance;
    next( );
  }

  function create_resource (req, res, next) {
    
    // Create NightscoutInstance CRD
    const { account } = req.params;
    var instance = res.suggestion;
    k8s.createNamespacedCustomObject(
      'nightscout.k8s',
      'v1alpha1', 
      namespace,
      'nightscoutinstances',
      instance
    )
    .then(() => {
      res.json({
        id: objectId(),
        name: req.body.name,
        account: account
      });
      next();
    })
    .catch(next);
  }

  return {
    suggest_template,
    create_resource,
    fetchInstance: function (req, res, next) {
      k8s.getNamespacedCustomObject(
        'nightscout.k8s',
        'v1alpha1',
        namespace,
        'nightscoutinstances',
        req.params.name
      ).then(function (result) {
        res.instance = result.body;
        res.result = result.body;
        next( );
      }).catch(next);
    },

    createOrUpdateInstance: function (req, res, next) {
      const instance = {
        apiVersion: 'nightscout.k8s/v1alpha1',
        kind: 'NightscoutInstance',
        metadata: {
          name: req.params.name
        },
        spec: {
          webName: req.params.name,
          storageSize: req.body.storageSize || '1Gi'
        }
      };

      k8s.getNamespacedCustomObject(
        'nightscout.k8s',
        'v1alpha1',
        namespace,
        'nightscoutinstances',
        req.params.name
      ).then(function ( ) {
        return k8s.replaceNamespacedCustomObject(
          'nightscout.k8s',
          'v1alpha1',
          namespace,
          'nightscoutinstances',
          req.params.name,
          instance
        );
      }).catch(function (error) {
        if (error.statusCode === 404) {
          return k8s.createNamespacedCustomObject(
            'nightscout.k8s',
            'v1alpha1',
            namespace,
            'nightscoutinstances',
            instance
          );
        }
        throw error;
      }).then(function (result) {
        res.result = result.body;
        next( );
      }).catch(next);
    },

    deleteInstance: function (req, res, next) {
      k8s.deleteNamespacedCustomObject(
        'nightscout.k8s',
        'v1alpha1',
        namespace,
        'nightscoutinstances',
        req.params.name
      ).then(function ( ) {
        res.status(204);
        res.end( );
        next( );
      }).catch(next);
    },

    listInstances: function (req, res, next) {
      k8s.listNamespacedCustomObject(
        'nightscout.k8s',
        'v1alpha1',
        namespace,
        'nightscoutinstances'
      ).then(function (result) {
        res.result = result.body;
        next( );
      }).catch(next);
    }
  };
}

module.exports = createInstanceRoutes;
