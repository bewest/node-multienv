const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;

const podMetadata = {
  pod_uid: process.env.POD_UID || '',
  pod_ip: process.env.POD_IP || '',
  pod_name: process.env.POD_NAME || '',
  pod_namespace: process.env.POD_NAMESPACE || '',
  node_name: process.env.NODE_NAME || '',
};

app.get('/health', (req, res) => {
  const field = req.query.field;
  const expected = req.query.expected;

  if (!field) {
    return res.status(200).json({
      status: 'ok',
      message: 'Health check endpoint ready',
      available_fields: Object.keys(podMetadata),
      metadata: podMetadata,
    });
  }

  const actual = podMetadata[field];
  
  if (actual === undefined) {
    return res.status(400).json({
      status: 'error',
      message: `Unknown field: ${field}`,
      available_fields: Object.keys(podMetadata),
    });
  }

  if (expected === undefined) {
    return res.status(200).json({
      status: 'ok',
      field: field,
      actual: actual,
      message: 'No expected value provided, returning actual value only',
    });
  }

  const match = actual === expected;

  res.status(match ? 200 : 503).json({
    status: match ? 'ok' : 'mismatch',
    field: field,
    actual: actual,
    expected: expected,
    match: match,
    timestamp: new Date().toISOString(),
  });
});

app.get('/ready', (req, res) => {
  res.status(200).json({
    status: 'ready',
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Pod health check server listening on port ${PORT}`);
  console.log('Available metadata:', podMetadata);
});
