const express = require('express');
const k8s = require('@kubernetes/client-node');
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

// Gen 4: Two-Composite Architecture
// Storage composite: Secret → MongoDB StatefulSet + Migration Jobs
app.post('/composite/storage/sync', storageCompositeSync);

// Compute composite: ConfigMap → Nightscout Deployment + CDC resources
app.post('/composite/compute/sync', computeCompositeSync);

// Decorator: PVC backup policy enforcement
app.post('/decorator/sync', decoratorSync);
app.post('/decorator/finalize', decoratorFinalize);

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Metacontroller webhook server listening on port ${port}`);
  console.log(`Gen 4: Two-Composite Architecture`);
  console.log(`Endpoints:`);
  console.log(`  POST /composite/storage/sync - Storage: Secret → MongoDB + Migration`);
  console.log(`  POST /composite/compute/sync - Compute: ConfigMap → Nightscout + CDC`);
  console.log(`  POST /decorator/sync - PVC backup policy`);
  console.log(`  POST /decorator/finalize - PVC cleanup`);
  console.log(`  GET  /health - Health check`);
});
