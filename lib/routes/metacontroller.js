
const createDeploymentRoutes = require('./deployments');

function createMetacontrollerRoutes(k8s, namespace) {
  const webhookHandler = require('../webhook_handler')(k8s, namespace);

  return {
    handleSync: async function handleSyncFunction(req, res, next) {
      try {
        const response = await webhookHandler.handleSync(req.body.parent, req.body.children);
        res.send(response);
        next();
      } catch (error) {
        next(error);
      }
    },

    handleStorageSync: async function handleStorageSyncFunction(req, res, next) {
      try {
        const response = await webhookHandler.handleStorageSync(req.body.parent, req.body.children);
        res.send(response);
        next(); 
      } catch (error) {
        next(error);
      }
    },

    handleMigrationSync: async function handleMigrationSyncFunction(req, res, next) {
      try {
        const response = await webhookHandler.handleMigrationSync(req.body.parent, req.body.children);
        res.send(response);
        next();
      } catch (error) {
        next(error);
      }
    }
  };
}

module.exports = createMetacontrollerRoutes;
