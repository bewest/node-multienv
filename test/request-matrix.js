#!/usr/bin/env node
'use strict';
// Request matrix for the restify 8 -> 11 bump (OPS-021).
//
// Starts each HTTP entrypoint of this image (runner server.js, resolver
// redirector-server.js, demuxer tenant-availability-keeper.js, inspector
// k8s-inspector.js, deployment-controller k8s-deployment-controller.js) as a
// child process against in-memory fakes (Consul, Kubernetes, DNS; see
// test/matrix/), sends every case in test/matrix/cases.js and prints one JSON
// document: status, selected headers, body shape and a normalised body sample
// per case, plus the audit-log line that restify wrote for that request.
//
//   node test/request-matrix.js > matrix-new.json
//   node test/matrix-diff.js matrix-old.json matrix-new.json
//
// Env:
//   MATRIX_ONLY=runner,resolver     only these services
//   MATRIX_URL_<SVC>=http://h:p     do not spawn <SVC>; send its cases to this URL
//                                   (audit capture is skipped for it)
//   MATRIX_CONSUL_PORT (8500)       fake Consul port; the deployment controller
//                                   builds its Consul client from a portless URL,
//                                   so it only reaches the fake on 8500.
//   MATRIX_VERBOSE=1                echo child output to stderr
//   MATRIX_OUT=file                 also write the result to this file
//   MATRIX_K8S_INCLUSTER=1          start the inspector and controller the way
//                                   they run in a cluster (MULTIENV_K8S_AUTH
//                                   unset, loadFromCluster): writes the fake
//                                   token to the service-account token path
//                                   (root, throwaway container only) and serves
//                                   the fake Kubernetes API on 127.0.0.1:8001
//
// It is meant to run inside the image, where the fixed ports below are free
// and node_modules match what ships. Layer test/ onto an existing image
// (built from `git archive`, never from a bind-mounted checkout):
//
//   mkdir ctx && git archive HEAD test | tar -x -C ctx
//   printf 'FROM %s\nCOPY test /app/test\nWORKDIR /app\nENTRYPOINT ["node","test/request-matrix.js"]\n' \
//     t1pal-lab/multienv:prod-7deafde > ctx/Dockerfile
//   docker build -q -t multienv-restifymx:old ctx && docker run --rm multienv-restifymx:old > old.json
//
// Every response and audit line is also checked for the fake kubeconfig
// token (leaks_k8s_token), and every other line a service prints is counted in
// log_leaks when it contains the token (OPS-039, D-009). Synthetic data only.

var http = require('http');
var path = require('path');
var fs = require('fs');
var os = require('os');
var child_process = require('child_process');
var fakes = require('./matrix/fakes');
var CASES = require('./matrix/cases');

var ROOT = path.resolve(__dirname, '..');
var VERBOSE = process.env.MATRIX_VERBOSE == '1';
var CONSUL_PORT = parseInt(process.env.MATRIX_CONSUL_PORT || '8500');
var INCLUSTER = process.env.MATRIX_K8S_INCLUSTER == '1';
// loadFromCluster() picks http only for ports 80, 8080 and 8001
var K8S_PORT = INCLUSTER ? 8001 : 18001;
var ONLY = process.env.MATRIX_ONLY ? process.env.MATRIX_ONLY.split(',') : null;
// The fake kubeconfig's bearer token. Any response or log line that contains it
// would carry the real service-account token in a cluster.
var FAKE_TOKEN = 'restifymx-fake-token';
var WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'restifymx-'));
var WORKER_ENV = path.join(WORK, 'envs');
fs.mkdirSync(WORKER_ENV);
fs.writeFileSync(path.join(WORKER_ENV, 'tenant-a.env'), 'WEB_NAME=tenant-a\nDISPLAY_UNITS=mmol\n');
var KUBECONFIG = path.join(WORK, 'kubeconfig.json');
fs.writeFileSync(KUBECONFIG, JSON.stringify({
  apiVersion: 'v1', kind: 'Config', 'current-context': 'fake',
  clusters: [ { name: 'fake', cluster: { server: 'http://127.0.0.1:' + K8S_PORT } } ],
  users: [ { name: 'fake', user: { token: FAKE_TOKEN } } ],
  contexts: [ { name: 'fake', context: { cluster: 'fake', user: 'fake', namespace: 'default' } } ]
}));

// in-cluster: what kubelet mounts into the pod, with fake values
var SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
var K8S_ENV = { MULTIENV_K8S_AUTH: 'local', KUBECONFIG: KUBECONFIG };
if (INCLUSTER) {
  fs.mkdirSync(SA_DIR, { recursive: true });
  fs.writeFileSync(path.join(SA_DIR, 'token'), FAKE_TOKEN);
  fs.writeFileSync(path.join(SA_DIR, 'namespace'), 'default');
  fs.writeFileSync(path.join(SA_DIR, 'ca.crt'), 'restifymx fake ca, unused over http\n');
  K8S_ENV = { MULTIENV_K8S_AUTH: '', KUBECONFIG: '', KUBERNETES_SERVICE_HOST: '127.0.0.1', KUBERNETES_SERVICE_PORT: String(K8S_PORT) };
}

var SERVICES = {
  runner: { port: 13434, args: [ 'test/matrix/runner-harness.js' ], env: { PORT: '13434', WORKER_ENV: WORKER_ENV } },
  resolver: { port: 13636, args: [ '-r', './test/matrix/stub-dns.js', 'redirector-server.js' ], env: { INTERNAL_PORT: '13636' } },
  demuxer: { port: 12829, args: [ 'tenant-availability-keeper.js' ], env: { PORT: '12829', CONSUL: 'consul://127.0.0.1:' + CONSUL_PORT } },
  inspector: { port: 12828, args: [ 'k8s-inspector.js' ], env: Object.assign({ PORT: '12828' }, K8S_ENV) },
  controller: { port: 12827, args: [ '-r', './test/matrix/stub-dns.js', 'k8s-deployment-controller.js' ],
    env: Object.assign({ PORT: '12827', CONSUL: 'http://127.0.0.1', POD_IP: '10.0.9.9',
           MULTIENV_HEALTH_CHECK_SERVICE: 'http://multienv-deployment-controller:3000' }, K8S_ENV) },
};

var HEADERS = [ 'content-type', 'content-length', 'transfer-encoding', 'allow', 'location', 'connection',
  'x-accel-redirect', 'x-backend', 'x-backend-name', 'x-backend-port', 'x-backend-state',
  'x-worker-port', 'x-selected-backend', 'not-accel-redirect', 'x-elected-runner',
  'access-control-allow-origin', 'server', 'request-id', 'x-request-id', 'api-version', 'x-response-time', 'upgrade' ];
// present/absent only: the value is per-request
var PRESENCE_ONLY = { 'request-id': 1, 'x-request-id': 1, 'x-response-time': 1 };

function normalise (text) {
  if (typeof text !== 'string') { return text; }
  return text
    .split(WORK).join('<WORK>')
    .split(os.hostname( )).join('<HOSTNAME>')
    .replace(/\/tmp\/tmp-[0-9A-Za-z-]+/g, '<TMP>')
    .replace(/[A-Z][a-z]{2}, \d\d [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d GMT/g, '<HTTPDATE>')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<DATE>')
    .replace(/"(pid|hostname|latency|time)":("[^"]*"|\d+)/g, '"$1":"<$1>"');
}

function shape (v, depth) {
  depth = depth || 0;
  if (v === null) { return 'null'; }
  if (Array.isArray(v)) { return v.length ? [ depth > 5 ? 'array' : shape(v[0], depth + 1) ] : [ ]; }
  if (typeof v === 'object') {
    if (depth > 5) { return 'object'; }
    var o = { };
    Object.keys(v).sort( ).forEach(function (k) { o[normalise(k)] = shape(v[k], depth + 1); });
    return o;
  }
  return typeof v;
}

// ---- child process management ------------------------------------------
var AUDIT = { };     // req id -> [audit records]
var LOGS = { };      // svc -> { signature: count }
var LOG_LEAKS = { }; // svc -> number of non-audit output lines holding the token

function logSignature (obj) {
  var flavour = ('v' in obj && 'name' in obj) ? 'bunyan' : (typeof obj.level === 'number' ? 'pino-like' : 'json');
  return flavour + ':' + (obj.name || '-') + ':' + Object.keys(obj).sort( ).join(',');
}

// restify 10 with a bunyan audit logger drops the req serializer and dumps
// the raw IncomingMessage, which only has rawHeaders
function rawHeader (req, name) {
  var raw = req && req.rawHeaders;
  if (!Array.isArray(raw)) { return undefined; }
  for (var i = 0; i + 1 < raw.length; i += 2) { if (String(raw[i]).toLowerCase( ) == name) { return raw[i + 1]; } }
  return undefined;
}

function onLine (svc, line) {
  if (VERBOSE) { process.stderr.write('[' + svc + '] ' + line + '\n'); }
  var leaks = line.indexOf(FAKE_TOKEN) > -1;
  if (line[0] !== '{') {
    if (leaks) { LOG_LEAKS[svc] = (LOG_LEAKS[svc] || 0) + 1; }
    return;
  }
  var obj;
  try { obj = JSON.parse(line); } catch (e) { return; }
  var isAudit = obj.audit === true || obj.name === 'audit';
  if (isAudit) {
    // restify ignores x-request-id for req_id here, so key on the header we sent
    var id = (obj.req && obj.req.headers && obj.req.headers['x-request-id']) || rawHeader(obj.req, 'x-request-id') || obj.req_id;
    obj.__bytes = line.length;
    (AUDIT[id] = AUDIT[id] || [ ]).push(obj);
  } else {
    if (leaks) { LOG_LEAKS[svc] = (LOG_LEAKS[svc] || 0) + 1; }
    var sig = logSignature(obj);
    LOGS[svc] = LOGS[svc] || { };
    LOGS[svc][sig] = (LOGS[svc][sig] || 0) + 1;
  }
}

function spawn (svc, done) {
  var spec = SERVICES[svc];
  var env = Object.assign({ }, process.env, spec.env);
  var child = child_process.spawn(process.execPath, spec.args, { cwd: ROOT, env: env, stdio: [ 'ignore', 'pipe', 'pipe' ] });
  spec.child = child;
  spec.exited = null;
  spec.tail = [ ];
  function reader (stream) {
    var buf = '';
    stream.on('data', function (chunk) {
      buf += chunk.toString( );
      var lines = buf.split('\n');
      buf = lines.pop( );
      lines.forEach(function (l) {
        spec.tail.push(l); if (spec.tail.length > 30) { spec.tail.shift( ); }
        onLine(svc, l);
      });
    });
  }
  reader(child.stdout);
  reader(child.stderr);
  child.on('exit', function (code, signal) { spec.exited = { code: code, signal: signal }; });
  waitForPort(spec, Date.now( ) + 15000, done);
}

function waitForPort (spec, deadline, done) {
  if (spec.exited) { return done(new Error('exited during start: ' + JSON.stringify(spec.exited) + '\n' + spec.tail.join('\n'))); }
  var req = http.request({ host: '127.0.0.1', port: spec.port, path: '/__restifymx_probe', method: 'GET' }, function (res) {
    res.resume( );
    res.on('end', function ( ) { done( ); });
  });
  req.on('error', function ( ) {
    if (Date.now( ) > deadline) { return done(new Error('timeout waiting for port ' + spec.port + '\n' + spec.tail.join('\n'))); }
    setTimeout(waitForPort, 200, spec, deadline, done);
  });
  req.end( );
}

// ---- requests -------------------------------------------------------------
function send (base, c, cb) {
  var u = new URL(base);
  // connection: close pins the client side: Node >= 19 clients default to
  // keep-alive, which would otherwise show up as a server difference.
  var headers = Object.assign({ 'x-request-id': 'restifymx-' + c.id, connection: 'close' }, c.headers || { });
  if (c.body !== undefined) { headers['content-length'] = Buffer.byteLength(c.body); }
  var finished = false;
  function finish (r) { if (!finished) { finished = true; cb(r); } }
  var req = http.request({ host: u.hostname, port: u.port, path: c.path, method: c.method, headers: headers }, function (res) {
    var chunks = [ ];
    res.on('data', function (d) { chunks.push(d); });
    res.on('end', function ( ) {
      finish({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString( ) });
    });
    res.on('error', function (err) { finish({ error: err.code || err.message }); });
  });
  req.setTimeout(c.timeout || 5000, function ( ) { finish({ error: 'timeout' }); req.destroy( ); });
  req.on('error', function (err) { finish({ error: err.code || err.message }); });
  if (c.body !== undefined) { req.write(c.body); }
  req.end( );
}

function record (c, r) {
  var out = { id: c.id, svc: c.svc, method: c.method, path: c.path };
  if (c.why) { out.why = c.why; }
  if (r.error) { out.error = r.error; return out; }
  out.status = r.status;
  out.headers = { };
  HEADERS.forEach(function (h) {
    if (h in r.headers) { out.headers[h] = PRESENCE_ONLY[h] ? '<present>' : normalise(String(r.headers[h])); }
  });
  var parsed;
  try { parsed = r.text ? JSON.parse(r.text) : undefined; } catch (e) { parsed = undefined; }
  out.body_kind = r.text === '' ? 'empty' : (parsed === undefined ? 'text' : 'json');
  if (parsed !== undefined) { out.body_shape = shape(parsed); }
  out.body_sample = normalise(r.text).slice(0, 400);
  if (r.text.indexOf(FAKE_TOKEN) > -1) { out.leaks_k8s_token = true; }
  return out;
}

function auditFor (c) {
  var lines = AUDIT['restifymx-' + c.id] || [ ];
  if (!lines.length) { return { count: 0 }; }
  var a = lines[0];
  return {
    count: lines.length,
    leaks_k8s_token: lines.some(function (l) { return JSON.stringify(l).indexOf(FAKE_TOKEN) > -1; }) || undefined,
    flavour: ('v' in a) ? 'bunyan' : 'pino',
    name: a.name,
    time_type: typeof a.time,
    keys: Object.keys(a).filter(function (k) { return k != '__bytes'; }).sort( ),
    // order of magnitude only, the exact size varies with ports and timings
    kbytes: Math.round(a.__bytes / 1024),
    req_keys: a.req ? Object.keys(a.req).sort( ) : null,
    res_keys: a.res ? Object.keys(a.res).sort( ) : null,
    msg: normalise(a.msg),
    level: a.level,
    res_statusCode: a.res && a.res.statusCode,
    err: a.err ? { keys: Object.keys(a.err).sort( ), name: a.err.name, code: a.err.code, message: normalise(a.err.message) } : undefined,
  };
}

function versions ( ) {
  function v (name) {
    try { return require(path.join(ROOT, 'node_modules', name, 'package.json')).version; } catch (e) { return null; }
  }
  return { node: process.version, restify: v('restify'), 'find-my-way': v('find-my-way'), bunyan: v('bunyan'), pino: v('pino'),
    '@kubernetes/client-node': v('@kubernetes/client-node'), consul: v('consul') };
}

function main ( ) {
  var consul = fakes.createConsul({
    cluster: [ { Node: 'runner-1', ServiceAddress: '127.0.0.1', ServicePort: SERVICES.runner.port, ServiceTags: [ 'cluster' ] } ],
    backends: [ { Node: 'runner-1', ServiceAddress: '127.0.0.1', ServicePort: 15001, ServiceTags: [ 'tenant-a', 'tenant', 'backend' ] } ],
    emptysvc: [ ],
  });
  var k8s = fakes.createK8s([
    { __kind: 'configmaps', kind: 'ConfigMap', apiVersion: 'v1',
      metadata: { name: 'tenant-a', labels: { managed: 'multienv', app: 'tenant' }, annotations: { 'managed-by': 'restifymx' } },
      data: { WEB_NAME: 'tenant-a', DISPLAY_UNITS: 'mmol' } },
    { __kind: 'deployments', kind: 'Deployment', apiVersion: 'apps/v1',
      metadata: { name: 'tenant-a', labels: { managed: 'multienv', app: 'tenant', internal_name: 'tenant-a' } },
      spec: { replicas: 1, template: { metadata: { annotations: { } } } } },
  ]);
  var result = { generated_by: 'test/request-matrix.js', versions: versions( ), k8s_auth: INCLUSTER ? 'in-cluster' : 'kubeconfig',
    cases: [ ], logs: LOGS, log_leaks: LOG_LEAKS, restarts: [ ] };

  consul.listen(CONSUL_PORT, '127.0.0.1', function ( ) {
    k8s.listen(K8S_PORT, '127.0.0.1', function ( ) {
      var svcs = Object.keys(SERVICES).filter(function (s) { return !ONLY || ONLY.indexOf(s) > -1; });
      runServices(svcs, result, function ( ) {
        Object.keys(SERVICES).forEach(function (s) { if (SERVICES[s].child && !SERVICES[s].exited) { SERVICES[s].child.kill('SIGKILL'); } });
        consul.close( ); k8s.close( );
        var text = JSON.stringify(result, null, 2) + '\n';
        if (process.env.MATRIX_OUT) { fs.writeFileSync(process.env.MATRIX_OUT, text); }
        // exit only after stdout drains: a pipe truncates at 64k otherwise
        process.stdout.write(text, function ( ) { process.exit(0); });
      });
    });
  });
}

function runServices (svcs, result, done) {
  if (!svcs.length) { return done( ); }
  var svc = svcs.shift( );
  var spec = SERVICES[svc];
  var external = process.env['MATRIX_URL_' + svc.toUpperCase( )];
  var base = external || ('http://127.0.0.1:' + spec.port);
  var cases = CASES.filter(function (c) { return c.svc == svc; });
  function start (cb) {
    if (external) { return cb( ); }
    spawn(svc, function (err) {
      if (err) { result.cases.push({ id: svc + '-start', svc: svc, error: 'start failed: ' + normalise(err.message) }); }
      cb(err);
    });
  }
  start(function (err) {
    if (err) { return runServices(svcs, result, done); }
    (function next (i) {
      if (i >= cases.length) {
        if (spec.child && !spec.exited) { spec.child.kill('SIGTERM'); }
        return setTimeout(runServices, 100, svcs, result, done);
      }
      var c = cases[i];
      if (!external && spec.exited) {
        // died after the previous case was recorded
        result.restarts.push('before-' + c.id);
        return spawn(svc, function (err) {
          if (err) { return runServices(svcs, result, done); }
          next(i);
        });
      }
      send(base, c, function (r) {
        // give the 'after' audit event a moment to flush
        setTimeout(function ( ) {
          var rec = record(c, r);
          if (!external) { rec.audit = auditFor(c); }
          if (!external && spec.exited) {
            rec.process_exited = spec.exited;
            rec.last_output = spec.tail.slice(-6).map(normalise);
            result.restarts.push(c.id);
            result.cases.push(rec);
            return spawn(svc, function (err) {
              if (err) { result.cases.push({ id: c.id + '-restart', svc: svc, error: 'restart failed' }); return runServices(svcs, result, done); }
              next(i + 1);
            });
          }
          result.cases.push(rec);
          next(i + 1);
        }, 150);
      });
    })(0);
  });
}

main( );
