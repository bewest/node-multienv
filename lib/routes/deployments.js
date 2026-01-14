
const _ = require('lodash');
const templates = require('../templates');

function createDeploymentRoutes(k8s, namespace, opts) {

  function fetch_deployment (req, res, next) {
    var result = k8s.appsApi.readNamespacedDeployment(req.params.name, namespace).then(function (result) {
      res.deployment = result.body;
      res.result = result.body;
      next( );
    }).catch(next);
  }

  function create_deployment (req, res, next) {
    k8s.appsApi.createNamespacedDeployment(namespace, req.deployment).then(function (result) {
      res.deployment = result.body;
      res.result = result.body;
      next( );
    }).catch(next);
  }

  function delete_deployment (req, res, next) {
    k8s.appsApi.deleteNamespacedDeployment(req.params.name, namespace).then(function ( ) {
      res.status(204);
      res.end( );
      next( );
    }).catch(next);
  }

  function list_deployments (req, res, next) {
    const params = {
      continue: req.query.continue,
      limit: req.query.limit,
      fieldSelector: req.query.fieldSelector,
      labelSelector: req.query.labelSelector
    };
    k8s.appsApi.listNamespacedDeployment(namespace, false, false, params.continue, params.fieldSelector, params.labelSelector, params.limit).then(function (result) {
      res.result = result;
      next( );
    }).catch(next);
  }

  return {
    fetchDeployment: fetch_deployment,
    createDeployment: create_deployment,
    deleteDeployment: delete_deployment,
    listDeployments: list_deployments
  };
}

module.exports = createDeploymentRoutes;
