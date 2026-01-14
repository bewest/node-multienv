function createConfigMapRoutes (k8s, namespace) {
  return {
    fetchConfigMap: function (req, res, next) {
      k8s.readNamespacedConfigMap(req.params.name, namespace).then(function (result) {
        res.configMap = result.body;
        res.result = result.body;
        next( );
      }).catch(next);
    },

    createOrUpdateConfigMap: function (req, res, next) {
      k8s.readNamespacedConfigMap(req.params.name, namespace).then(function ( ) {
        return k8s.replaceNamespacedConfigMap(req.params.name, namespace, req.configMap);
      }).catch(function (error) {
        if (error.statusCode === 404) {
          return k8s.createNamespacedConfigMap(namespace, req.configMap);
        }
        throw error;
      }).then(function (result) {
        res.configMap = result.body;
        res.result = result.body;
        next( );
      }).catch(next);
    },

    deleteConfigMap: function (req, res, next) {
      k8s.deleteNamespacedConfigMap(req.params.name, namespace).then(function ( ) {
        res.status(204);
        res.end( );
        next( );
      }).catch(next);
    },

    listConfigMaps: function (req, res, next) {
      const params = {
        continue: req.query.continue,
        limit: req.query.limit,
        fieldSelector: req.query.fieldSelector,
        labelSelector: req.query.labelSelector
      };
      k8s.listNamespacedConfigMap(namespace, false, false, params.continue, params.fieldSelector, params.labelSelector, params.limit).then(function (result) {
        res.result = result;
        next( );
      }).catch(next);
    }
  };
}

module.exports = createConfigMapRoutes;