const restify = require('restify');
const k8s = require('@kubernetes/client-node');
const storageCompositeSync = require('./handlers/storage-composite-sync');
const computeCompositeSync = require('./handlers/compute-composite-sync');
const decoratorSync = require('./handlers/decorator-sync');
const decoratorFinalize = require('./handlers/decorator-finalize');

const server = restify.createServer({
  name: 'metacontroller-webhook',
  version: '1.0.0',
});

const port = process.env.PORT || 3000;

server.use(restify.plugins.bodyParser());

server.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path()}`);
  next();
});

// Gen 4: Two-Composite Architecture
// Storage composite: Secret → MongoDB StatefulSet + Migration Jobs
server.post('/composite/storage/sync', storageCompositeSync);

// Compute composite: ConfigMap → Nightscout Deployment + CDC resources
server.post('/composite/compute/sync', computeCompositeSync);

// Decorator: PVC backup policy enforcement
server.post('/decorator/sync', decoratorSync);
server.post('/decorator/finalize', decoratorFinalize);

server.get('/health', (req, res, next) => {
  res.send({ status: 'healthy', timestamp: new Date().toISOString() });
  return next();
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Metacontroller webhook server listening on port ${port}`);
  console.log(`Gen 4: Two-Composite Architecture`);
  console.log(`Endpoints:`);
  console.log(`  POST /composite/storage/sync - Storage: Secret → MongoDB + Migration`);
  console.log(`  POST /composite/compute/sync - Compute: ConfigMap → Nightscout + CDC`);
  console.log(`  POST /decorator/sync - PVC backup policy`);
  console.log(`  POST /decorator/finalize - PVC cleanup`);
  console.log(`  GET  /health - Health check`);
});
