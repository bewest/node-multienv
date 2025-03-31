
const _ = require('lodash');

function createConfigMapRoutes(k8s, namespace, opts) {
  return {
    fetchConfigMap: async function(req, res, next) {
      try {
        const result = await k8s.readNamespacedConfigMap(req.params.name, namespace);
        res.result = result.body;
        next();
      } catch (error) {
        next(error);
      }
    },

    createOrUpdateConfigMap: async function(req, res, next) {
      try {
        const result = await k8s.readNamespacedConfigMap(req.params.name, namespace)
          .then(existing => {
            const body = existing.body;
            if (req.params.field && req.configmap.data[req.params.field]) {
              body.data[req.params.field] = req.configmap.data[req.params.field];
            } else {
              body.data = req.configmap.data;
            }
            body.metadata.annotations = _.extend(body.metadata.annotations, opts.default.configmap.annotations);
            body.metadata.labels = _.extend(body.metadata.labels, opts.default.configmap.labels);
            return k8s.replaceNamespacedConfigMap(body.metadata.name, namespace, body);
          })
          .catch(err => {
            if (err.statusCode === 404) {
              return k8s.createNamespacedConfigMap(namespace, req.configmap);
            }
            throw err;
          });

        res.header('Location', '/environs/' + result.body.metadata.name);
        res.result = result.body.data;
        next();
      } catch (error) {
        next(error);
      }
    },

    deleteConfigMap: async function(req, res, next) {
      try {
        await k8s.deleteNamespacedConfigMap(req.params.name, namespace);
        res.status(204);
        res.end();
        next();
      } catch (error) {
        next(error);
      }
    },

    listConfigMaps: async function(req, res, next) {
      try {
        const params = {
          continue: req.query.continue,
          limit: req.query.limit,
          fieldSelector: req.query.fieldSelector,
          labelSelector: req.query.labelSelector
        };
        const result = await k8s.listNamespacedConfigMap(namespace, false, false, params.continue, params.fieldSelector, params.labelSelector, params.limit);
        res.result = result;
        next();
      } catch (error) {
        next(error);
      }
    }
  };
}

module.exports = createConfigMapRoutes;
