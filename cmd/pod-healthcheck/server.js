const restify = require('restify');
var bunyan = require('bunyan');

const PORT = process.env.PORT || 3000;

const podMetadata = {
  pod_uid: process.env.POD_UID || '',
  pod_ip: process.env.POD_IP || '',
  pod_name: process.env.POD_NAME || '',
  pod_namespace: process.env.POD_NAMESPACE || '',
  node_name: process.env.NODE_NAME || '',
};

const podDownstream = {
  POD_UID: process.env.POD_UID || '',
  POD_IP: process.env.POD_IP || '',
  POD_NAME: process.env.POD_NAME || '',
  POD_NAMESPACE: process.env.POD_NAMESPACE || '',
  NODE_NAME: process.env.NODE_NAME || '',
  HOSTNAME: process.env.HOSTNAME || '',
};

const server = restify.createServer({
  name: 'pod-healthcheck',
  version: '1.0.0',
});

server.on('after', restify.plugins.auditLogger({
  log: bunyan.createLogger({
    name: 'audit',
    stream: process.stdout
  }),
  event: 'after'
}));

server.use(restify.plugins.queryParser());

server.get('/healthchecks/pod/:name/assigned/:field/:value', function (req, res, next) {

  var found = podDownstream[req.params.field];
  var valid = req.params.value == found;

  res.send(valid ? 200 : 500, found);
  next( );
});

server.get('/health', (req, res, next) => {
  const field = req.query.field;
  const expected = req.query.expected;

  if (!field) {
    res.send(200, {
      status: 'ok',
      message: 'Health check endpoint ready',
      available_fields: Object.keys(podMetadata),
      metadata: podMetadata,
    });
    return next( );
  }

  const actual = podMetadata[field];
  
  if (actual === undefined) {
    res.send(400, {
      status: 'error',
      message: `Unknown field: ${field}`,
      available_fields: Object.keys(podMetadata),
    });
    return next( );
  }

  if (expected === undefined) {
    res.send(200, {
      status: 'ok',
      field: field,
      actual: actual,
      message: 'No expected value provided, returning actual value only',
    });
    return next( );
  }

  const match = actual === expected;

  res.send(match ? 200 : 503, {
    status: match ? 'ok' : 'mismatch',
    field: field,
    actual: actual,
    expected: expected,
    match: match,
    timestamp: new Date().toISOString(),
  });
  return next( );
});

server.get('/ready', (req, res) => {
  res.send(200, {
    status: 'ready',
    timestamp: new Date().toISOString(),
  });
  return next( );
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Pod health check server listening on port ${PORT}`);
  console.log('Available metadata:', podMetadata);
});
