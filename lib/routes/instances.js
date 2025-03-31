
function createInstanceRoutes (k8s, namespace) {
  return {
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
