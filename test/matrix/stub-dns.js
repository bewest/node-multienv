'use strict';
// Preloaded with `node -r ./test/matrix/stub-dns.js <entrypoint>` so the
// resolver (redirector-server.js) and deployment-controller health checks can
// be exercised without Consul DNS. Synthetic answers only.
var dns = require('dns');

function enotfound (name, cb) {
  var err = new Error('queryA ENOTFOUND ' + name);
  err.code = 'ENOTFOUND';
  err.hostname = name;
  process.nextTick(cb, err);
}

dns.resolveSrv = function (name, cb) {
  // <site>.backends.service.consul
  if (/^tenant-a\./.test(name)) {
    return process.nextTick(cb, null, [ { name: '0a000105.addr.dc1.consul', port: 15001, priority: 1, weight: 1 } ]);
  }
  if (/^tenant-b\./.test(name)) {
    return process.nextTick(cb, null, [ { name: 'runner-1.node.dc1.consul', port: 15002, priority: 1, weight: 1 } ]);
  }
  return enotfound(name, cb);
};

dns.resolve = function (name, rrtype, cb) {
  if (typeof rrtype === 'function') { cb = rrtype; }
  if (/^runner-1\.node\./.test(name)) { return process.nextTick(cb, null, [ '10.0.1.6' ]); }
  // <tenant>.backends.<ns>.svc.cluster.local (deployment-controller healthcheck)
  if (/^tenant-a\.backends\./.test(name)) { return process.nextTick(cb, null, [ '10.0.1.5' ]); }
  return enotfound(name, cb);
};
