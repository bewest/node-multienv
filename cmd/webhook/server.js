const restify = require('restify');
var bunyan = require('bunyan');
const config = require('./config');

// Import handler factories
const createStorageCompositeSync = require('./handlers/storage-composite-sync');
const createStorageCompositeCustomize = require('./handlers/storage-composite-customize');
const createComputeCompositeSync = require('./handlers/compute-composite-sync');
const createComputeCompositeCustomize = require('./handlers/compute-composite-customize');
const createDecoratorSync = require('./handlers/decorator-sync');
const createDecoratorFinalize = require('./handlers/decorator-finalize');

// Create handlers with config
const storageCompositeSync = createStorageCompositeSync(config);
const storageCompositeCustomize = createStorageCompositeCustomize(config);
const computeCompositeSync = createComputeCompositeSync(config);
const computeCompositeCustomize = createComputeCompositeCustomize(config);
const decoratorSync = createDecoratorSync(config);
const decoratorFinalize = createDecoratorFinalize(config);

const server = restify.createServer({
  name: config.server.name,
  version: '1.0.0',
});

const port = config.server.port;

server.on('after', restify.plugins.auditLogger({
  log: bunyan.createLogger({
    name: 'audit',
    stream: process.stdout
  }),
  event: 'after'
}));

server.use(restify.plugins.bodyParser());

server.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path()}`);
  next();
});

// Gen 4: Two-Composite Architecture
// Storage composite: Secret → MongoDB StatefulSet + Migration Jobs
server.post('/composite/storage/customize', storageCompositeCustomize);
server.post('/composite/storage/sync', storageCompositeSync);

// Compute composite: ConfigMap → Nightscout Deployment + CDC resources
server.post('/composite/compute/customize', computeCompositeCustomize);
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
  console.log(`  POST /composite/storage/customize - Storage: Related resource discovery`);
  console.log(`  POST /composite/storage/sync - Storage: Secret → MongoDB + Migration`);
  console.log(`  POST /composite/compute/customize - Compute: Related resource discovery`);
  console.log(`  POST /composite/compute/sync - Compute: ConfigMap → Nightscout + CDC`);
  console.log(`  POST /decorator/sync - PVC backup policy`);
  console.log(`  POST /decorator/finalize - PVC cleanup`);
  console.log(`  GET  /health - Health check`);
});
