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
const { createStorageCredentialsDecoratorSync } = require('./handlers/storage-credentials-decorator-sync');
const { createStorageInitializationDecoratorSync } = require('./handlers/storage-initialization-decorator-sync');
const { createStorageInitializationDecoratorCustomize } = require('./handlers/storage-initialization-decorator-customize');
const createInstanceUserdataDecorator = require('./handlers/instance-userdata-decorator');

// Create handlers with config
const storageCompositeSync = createStorageCompositeSync(config);
const storageCompositeCustomize = createStorageCompositeCustomize(config);
const computeCompositeSync = createComputeCompositeSync(config);
const computeCompositeCustomize = createComputeCompositeCustomize(config);
const decoratorSync = createDecoratorSync(config);
const decoratorFinalize = createDecoratorFinalize(config);
const { sync: storageCredentialsDecoratorSync, customize: storageCredentialsDecoratorCustomize } = createStorageCredentialsDecoratorSync(config);
const storageInitializationDecoratorSync = createStorageInitializationDecoratorSync(config);
const storageInitializationDecoratorCustomize = createStorageInitializationDecoratorCustomize(config);
const instanceUserdataDecorator = createInstanceUserdataDecorator(config);
const instanceUserdataDecoratorSync = instanceUserdataDecorator.sync;
const instanceUserdataDecoratorCustomize = instanceUserdataDecorator.customize;

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

// Gen 4: Three-Controller Architecture
// Storage composite: StorageAccount CRD → MongoDB StatefulSet + Migration Jobs
server.post('/composite/storage/customize', storageCompositeCustomize);
server.post('/composite/storage/sync', storageCompositeSync);

// Compute composite: ComputeInstance CRD → Nightscout Deployment + CDC resources
server.post('/composite/compute/customize', computeCompositeCustomize);
server.post('/composite/compute/sync', computeCompositeSync);

// Decorator: PVC backup policy enforcement
server.post('/decorator/sync', decoratorSync);
server.post('/decorator/finalize', decoratorFinalize);

// Decorator: Storage credentials management (ComputeInstance → App Credentials + User Init)
server.post('/decorator/storage-credentials/customize', storageCredentialsDecoratorCustomize);
server.post('/decorator/storage-credentials/sync', storageCredentialsDecoratorSync);

// Decorator: Storage initialization state (mongo-auth Secret → Replica Set Init Tracking)
server.post('/decorator/storage-initialization/customize', storageInitializationDecoratorCustomize);
server.post('/decorator/storage-initialization/sync', ...storageInitializationDecoratorSync);

// Decorator: Instance userdata migration (ConfigMap → Gen 3 to Gen 4 cutover)
server.post('/decorator/instance-userdata/customize', ...instanceUserdataDecoratorCustomize);
server.post('/decorator/instance-userdata/sync', ...instanceUserdataDecoratorSync);

server.get('/health', (req, res, next) => {
  res.send({ status: 'healthy', timestamp: new Date().toISOString() });
  return next();
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Metacontroller webhook server listening on port ${port}`);
  console.log(`Gen 4: Three-Controller Architecture (2 Composites + 4 Decorators)`);
  console.log(`Endpoints:`);
  console.log(`  POST /composite/storage/customize - Storage: Related resource discovery`);
  console.log(`  POST /composite/storage/sync - Storage: StorageAccount → MongoDB + Migration`);
  console.log(`  POST /composite/compute/customize - Compute: Related resource discovery`);
  console.log(`  POST /composite/compute/sync - Compute: ComputeInstance → Nightscout + CDC`);
  console.log(`  POST /decorator/sync - PVC backup policy`);
  console.log(`  POST /decorator/finalize - PVC cleanup`);
  console.log(`  POST /decorator/storage-credentials/sync - Credentials: ComputeInstance → App Creds + User Init`);
  console.log(`  POST /decorator/storage-initialization/customize - Initialization: mongo-auth Secret state tracking`);
  console.log(`  POST /decorator/storage-initialization/sync - Initialization: Replica set init marker`);
  console.log(`  POST /decorator/instance-userdata/customize - ConfigMap migration: Related resource discovery`);
  console.log(`  POST /decorator/instance-userdata/sync - ConfigMap migration: Gen 3 → Gen 4 cutover`);
  console.log(`  GET  /health - Health check`);
});
