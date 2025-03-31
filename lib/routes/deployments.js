
const _ = require('lodash');

function createDeploymentRoutes(k8s, namespace, opts) {
  const templates = require('../templates');
  function fetch_deployment function (req, res, next) {
    var result = k8s.appsApi.readNamespacedDeployment(req.params.name, namespace).then(function (result) {
    res.deployment = result.body;
    res.result = result.body;
    next();
  }).catch(next);
    
}

  
  return {
    fetchDeployment: async function(req, res, next) {
      try {
        const result = await k8s.appsApi.readNamespacedDeployment(req.params.name, namespace);
        res.deployment = result.body;
        res.result = result.body;
        next();
      } catch (error) {
        next(error);
      }
    },

    createDeployment: async function(req, res, next) {
      try {
        const result = await k8s.appsApi.createNamespacedDeployment(namespace, req.deployment);
        res.deployment = result.body;
        res.result = result.body;
        next();
      } catch (error) {
        next(error);
      }
    },

    deleteDeployment: async function(req, res, next) {
      try {
        await k8s.appsApi.deleteNamespacedDeployment(req.params.name, namespace);
        res.status(204);
        res.end();
        next();
      } catch (error) {
        next(error);
      }
    },

    listDeployments: async function(req, res, next) {
      try {
        const params = {
          continue: req.query.continue,
          limit: req.query.limit,
          fieldSelector: req.query.fieldSelector,
          labelSelector: req.query.labelSelector
        };
        const result = await k8s.appsApi.listNamespacedDeployment(namespace, false, false, params.continue, params.fieldSelector, params.labelSelector, params.limit);
        res.result = result;
        next();
      } catch (error) {
        next(error);
      }
    }
  };
}

module.exports = createDeploymentRoutes;
