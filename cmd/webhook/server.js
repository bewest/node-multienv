const express = require('express');
const k8s = require('@kubernetes/client-node');
const compositeSync = require('./handlers/composite-sync');
const compositeFinalize = require('./handlers/composite-finalize');
const storageCompositeSync = require('./handlers/storage-composite-sync');
const computeCompositeSync = require('./handlers/compute-composite-sync');
const decoratorSync = require('./handlers/decorator-sync');
const decoratorFinalize = require('./handlers/decorator-finalize');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Original monolithic composite (Gen 4 - for tenants with ns.mdn.io/composite=tenant label)
app.post('/composite/sync', compositeSync);
app.post('/composite/finalize', compositeFinalize);

// Two-composite architecture (Gen 4 - separate storage/compute)
app.post('/composite/storage/sync', storageCompositeSync);
app.post('/composite/compute/sync', computeCompositeSync);

// Decorator for PVC backup policy
app.post('/decorator/sync', decoratorSync);
app.post('/decorator/finalize', decoratorFinalize);

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Metacontroller webhook server listening on port ${port}`);
  console.log(`Endpoints:`);
  console.log(`  POST /composite/sync (monolithic tenant composite)`);
  console.log(`  POST /composite/finalize`);
  console.log(`  POST /composite/storage/sync (storage composite)`);
  console.log(`  POST /composite/compute/sync (compute composite)`);
  console.log(`  POST /decorator/sync`);
  console.log(`  POST /decorator/finalize`);
  console.log(`  GET  /health`);
});
