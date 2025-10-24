const express = require('express');
const k8s = require('@kubernetes/client-node');
const compositeSync = require('./handlers/composite-sync');
const compositeFinalize = require('./handlers/composite-finalize');
const decoratorSync = require('./handlers/decorator-sync');
const decoratorFinalize = require('./handlers/decorator-finalize');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

app.post('/composite/sync', compositeSync);
app.post('/composite/finalize', compositeFinalize);
app.post('/decorator/sync', decoratorSync);
app.post('/decorator/finalize', decoratorFinalize);

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Metacontroller webhook server listening on port ${port}`);
  console.log(`Endpoints:`);
  console.log(`  POST /composite/sync`);
  console.log(`  POST /composite/finalize`);
  console.log(`  POST /decorator/sync`);
  console.log(`  POST /decorator/finalize`);
  console.log(`  GET  /health`);
});
