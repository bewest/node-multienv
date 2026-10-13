#!/usr/bin/env node
'use strict';
// Q-CONSUL-REGISTER-MISSING (F5a); OPS-071, OPS-073.
//
// lib/consul-reconcile.js, the controller's POST /consul/sync/reconcile, and
// the consul operator's timer in k8s-dispatcher.js, against a fake Consul HTTP
// API (catalog health, agent register), a fake pod list and a fake
// Kubernetes API for the dispatcher.
//
//   node test/consul-register-missing.test.js
//   OPERATOR_WATCH_CONTROL=<tree at 7deafde> node test/consul-register-missing.test.js
//
// With OPERATOR_WATCH_CONTROL, the cases marked `control` also run against
// that tree and must fail there. Plain script (node 16 has no node:test).
// Synthetic data only.

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var http = require('http');
var url = require('url');
var Module = require('module');
var Consul = require('consul');
var child_process = require('child_process');
var os = require('os');

var SRC = path.join(__dirname, '..');
var CONTROL = process.env.OPERATOR_WATCH_CONTROL || '';
var VERBOSE = process.env.OPERATOR_WATCH_VERBOSE == '1';
var consulReconcile = require('../lib/consul-reconcile');

var LONG_AGO = '2026-01-01T00:00:00Z';

function pod (tenant, opts) {
  opts = opts || { };
  var meta = { name: tenant + '-pod', namespace: 'hosted-tenants', uid: 'uid-' + tenant, labels: { tenant: tenant, role: 'config-as-deploy', managed: 'multienv' } };
  if (opts.deleting) { meta.deletionTimestamp = LONG_AGO; }
  return { metadata: meta, status: { phase: opts.phase || 'Running', podIP: '10.0.2.' + tenant.length, startTime: opts.startTime || LONG_AGO } };
}

function entry (tenant, uid) {
  return { Node: { Node: 'fake' }, Service: { ID: uid || ('uid-' + tenant), Service: 'backends', Tags: [ tenant, 'tenant', 'backend' ] }, Checks: [ ] };
}

// existing: [entry]; hooks.health(n, tag, entries) may return other entries
function fakeConsul (existing, hooks) {
  hooks = hooks || { };
  var state = { registered: [ ], health: 0, requests: 0, registerFails: 0 };
  function entries ( ) {
    return existing.concat(state.registered.map(function (r) { return entry(r.Tags[0], r.ID); }));
  }
  var server = http.createServer(function (req, res) {
    var chunks = [ ];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function ( ) {
      state.requests++;
      var u = url.parse(req.url, true);
      var body = Buffer.concat(chunks).toString( );
      var m;
      function send (status, obj) {
        res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
        res.end(obj === undefined ? '' : JSON.stringify(obj));
      }
      if ((m = u.pathname.match(/^\/v1\/health\/service\/([^/]+)$/))) {
        var list = entries( ).filter(function (e) { return !u.query.tag || e.Service.Tags.indexOf(u.query.tag) > -1; });
        var n = state.health++;
        if (hooks.health) { list = hooks.health(n, u.query.tag, list) || list; }
        return send(200, list);
      }
      if (u.pathname == '/v1/agent/service/register') {
        if (state.registerFails > 0) { state.registerFails--; return send(500, 'fake failure'); }
        state.registered.push(JSON.parse(body));
        return send(200);
      }
      send(404, 'fake consul: ' + u.pathname);
    });
  });
  server.state = state;
  return server;
}

function listen (server) {
  return new Promise(function (resolve) { server.listen(0, '127.0.0.1', function ( ) { resolve(server.address( ).port); }); });
}

function sleep (ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function withConsul (existing, hooks, fn) {
  var server = fakeConsul(existing, hooks);
  var port = await listen(server);
  var consul = new Consul({ host: '127.0.0.1', port: String(port) });
  try { return await fn(consul, server.state); } finally { server.close( ); }
}

function reconciler (consul, pods, extra) {
  return consulReconcile(Object.assign({
    consul: consul, ratePerSec: 1000,
    listPods: function ( ) { return Promise.resolve(pods); },
    register: function (p, cb) {
      consul.agent.service.register({ name: 'backends', id: p.metadata.uid, address: p.status.podIP, port: 1337, tags: [ p.metadata.labels.tenant, 'tenant', 'backend' ] }, function (err) { cb(err); });
    },
    log: VERBOSE ? console.log : function ( ) { },
  }, extra || { }));
}

function ids (state) { return state.registered.map(function (r) { return r.ID; }).sort( ); }

// ---- controller wiring --------------------------------------------------

function loadController (dir) {
  var file = path.join(dir, 'k8s-deployment-controller.js');
  var src = fs.readFileSync(file, 'utf8');
  if (!/module\.exports\s*=.*configure/.test(src)) { src += '\nmodule.exports = configure;\n'; }
  var m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(dir).concat(module.paths, (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean));
  m._compile(src, file);
  return m.exports;
}

function post (port, p) {
  return new Promise(function (resolve, reject) {
    var req = http.request({ host: '127.0.0.1', port: port, method: 'POST', path: p,
      headers: { 'content-type': 'application/json', 'content-length': 2 } }, function (res) {
      var chunks = [ ];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function ( ) {
        var text = Buffer.concat(chunks).toString( );
        var body; try { body = JSON.parse(text); } catch (e) { body = text; }
        resolve({ status: res.statusCode, body: body });
      });
    });
    req.on('error', reject);
    req.end('{}');
  });
}

// start the controller with fakes; fn(port, listed)
async function withController (dir, consul, pods, fn) {
  var configure = loadController(dir);
  var listed = [ ];
  var k8s = { listNamespacedPod: function (ns, a, b, c, d, selector) {
    listed.push({ ns: ns, selector: selector });
    return Promise.resolve({ body: { items: pods } });
  } };
  var log = console.log;
  var write = process.stdout.write;
  if (!VERBOSE) { console.log = function ( ) { }; process.stdout.write = function ( ) { return true; }; }
  var server;
  try {
    server = configure({
      k8s: k8s, appsApi: { }, consul: consul, MULTIENV_K8S_NAMESPACE: 'hosted-tenants',
      MULTIENV_HEALTH_CHECK_SERVICE: 'http://multienv-deployment-controller:3000',
      MULTIENV_CONSUL_RECONCILE_GRACE_MS: 120000, MULTIENV_CONSUL_RECONCILE_RATE: 1000, MULTIENV_CONSUL_RECONCILE_MAX: 200,
      MULTIENV_CONSUL_RECONCILE_SELECTOR: 'role=config-as-deploy,managed=multienv',
      requests: { }, limits: { }, default: { deployment: { annotations: { }, labels: { } }, configmap: { annotations: { }, labels: { } } },
    });
    var port = await listen(server);
    return await fn(port, listed);
  } finally {
    console.log = log;
    process.stdout.write = write;
    if (server) { server.close( ); }
  }
}

// ---- the consul operator (k8s-dispatcher.js) as a process ----------------

function fakeK8s ( ) {
  return http.createServer(function (req, res) {
    var u = url.parse(req.url, true);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (u.pathname.replace(/\/$/, '') == '/api/v1') {
      return res.end(JSON.stringify({ kind: 'APIResourceList', resources: [ { name: 'pods', namespaced: true, kind: 'Pod' } ] }));
    }
    if (u.query.watch) { return res.write(''); }   // a watch that stays open, with no events
    res.end(JSON.stringify({ kind: 'List', metadata: { resourceVersion: '1' }, items: [ ] }));
  });
}

async function runOperator (dir, env, ms) {
  var api = fakeK8s( );
  var calls = [ ];
  var gw = http.createServer(function (req, res) {
    calls.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ pods: 0, registered: 0 }));
  });
  var apiPort = await listen(api);
  var gwPort = await listen(gw);
  var work = fs.mkdtempSync(path.join(os.tmpdir(), 'f5a-'));
  var kubeconfig = path.join(work, 'kubeconfig.json');
  fs.writeFileSync(kubeconfig, JSON.stringify({
    apiVersion: 'v1', kind: 'Config', 'current-context': 'fake',
    clusters: [ { name: 'fake', cluster: { server: 'http://127.0.0.1:' + apiPort } } ],
    users: [ { name: 'fake', user: { token: 'f5a-fake-token' } } ],
    contexts: [ { name: 'fake', context: { cluster: 'fake', user: 'fake', namespace: 'default' } } ],
  }));
  var child = child_process.spawn(process.execPath, [ path.join(dir, 'k8s-dispatcher.js') ], { cwd: dir, stdio: VERBOSE ? 'inherit' : 'ignore',
    env: Object.assign({ }, process.env, {
      MULTIENV_K8S_AUTH: 'local', KUBECONFIG: kubeconfig, SYNC_CONTROLLER: 'deployment', FILTER_NONE: '1',
      WATCH_ENDPOINT: '/api/v1/namespaces/default/pods', WATCH_LABELSELECTOR: 'role=config-as-deploy,managed=multienv',
      CLUSTER_GATEWAY: 'http://127.0.0.1:' + gwPort + '/consul/' }, env) });
  var started = Date.now( );
  await sleep(ms);
  child.kill('SIGKILL');
  api.close( );
  gw.close( );
  fs.rmSync(work, { recursive: true, force: true });
  return { calls: calls, started: started };
}

var MIXED = [
  pod('tenant-a'),                                         // registered already
  pod('tenant-b'),                                         // missing: register
  pod('tenant-c', { phase: 'Pending' }),                   // not running
  pod('tenant-d', { deleting: true }),                     // terminating
  pod('tenant-e', { startTime: new Date( ).toISOString( ) }), // inside the grace period
];

var CASES = [
  {
    id: 'r1', control: true,
    what: 'POST /consul/sync/reconcile registers only the Running pod with no registration, and answers with counts',
    run: function (dir) {
      return withConsul([ entry('tenant-a') ], null, async function (consul, state) {
        await withController(dir, consul, MIXED, async function (port, listed) {
          var r = await post(port, '/consul/sync/reconcile');
          assert.strictEqual(r.status, 200, 'status');
          assert.deepStrictEqual(ids(state), [ 'uid-tenant-b' ], 'registered');
          assert.strictEqual(r.body.missing, 1);
          assert.strictEqual(r.body.registered, 1);
          var reg = state.registered[0];
          assert.strictEqual(reg.Name, 'backends');
          assert.strictEqual(reg.Address, '10.0.2.8');
          assert.ok(reg.Tags.indexOf('tenant-b') > -1, 'tenant tag');
          assert.strictEqual(reg.Checks.length, 2, 'same checks as /consul/sync');
          assert.deepStrictEqual(listed, [ { ns: 'hosted-tenants', selector: 'role=config-as-deploy,managed=multienv' } ]);
        });
      });
    },
  },
  {
    id: 'r2', control: false,
    what: 'the controller does nothing by itself: no Consul or pod requests until a pass is asked for',
    run: function (dir) {
      return withConsul([ ], null, async function (consul, state) {
        await withController(dir, consul, MIXED, async function (port, listed) {
          await sleep(500);
          assert.strictEqual(state.requests, 0, 'consul requests');
          assert.strictEqual(listed.length, 0, 'pod lists');
        });
      });
    },
  },
  {
    id: 'r3', control: false,
    what: 'a pod registered on any agent is never registered again (no duplicates)',
    run: function ( ) {
      return withConsul([ entry('tenant-a'), entry('tenant-b') ], null, async function (consul, state) {
        var s = await reconciler(consul, [ pod('tenant-a'), pod('tenant-b') ]).runOnce( );
        assert.strictEqual(s.missing, 0);
        assert.strictEqual(state.registered.length, 0);
      });
    },
  },
  {
    id: 'r4', control: false,
    what: 'a second pass asked for while one is running in the same controller is refused (409)',
    run: function (dir) {
      return withConsul([ ], null, async function (consul, state) {
        var pods = [ 'a', 'b', 'c' ].map(function (x) { return pod('tenant-' + x); });
        await withController(dir, consul, pods, async function (port) {
          var both = await Promise.all([ post(port, '/consul/sync/reconcile'), post(port, '/consul/sync/reconcile') ]);
          assert.deepStrictEqual(both.map(function (r) { return r.status; }).sort( ), [ 200, 409 ], 'statuses');
          assert.deepStrictEqual(ids(state), [ 'uid-tenant-a', 'uid-tenant-b', 'uid-tenant-c' ]);
        });
      });
    },
  },
  {
    id: 'r5', control: false,
    what: 'a pod the operator registers during the pass is skipped (re-checked by tenant just before registering)',
    run: function ( ) {
      var hooks = { health: function (n, tag, list) { return tag == 'tenant-b' ? [ entry('tenant-b') ] : list; } };
      return withConsul([ ], hooks, async function (consul, state) {
        var s = await reconciler(consul, [ pod('tenant-a'), pod('tenant-b') ]).runOnce( );
        assert.strictEqual(s.missing, 2);
        assert.strictEqual(s.raced, 1);
        assert.deepStrictEqual(ids(state), [ 'uid-tenant-a' ]);
      });
    },
  },
  {
    id: 'r6', control: false,
    what: 'at most MULTIENV_CONSUL_RECONCILE_MAX per pass; the rest wait for the next pass',
    run: function ( ) {
      return withConsul([ ], null, async function (consul, state) {
        var pods = [ 'a', 'b', 'c', 'd', 'e' ].map(function (x) { return pod('tenant-' + x); });
        var r = reconciler(consul, pods, { maxPerPass: 2 });
        var s1 = await r.runOnce( );
        assert.strictEqual(s1.registered, 2);
        assert.strictEqual(s1.deferred, 3);
        var s2 = await r.runOnce( );
        assert.strictEqual(s2.registered, 2);
        var s3 = await r.runOnce( );
        assert.strictEqual(s3.registered, 1);
        assert.strictEqual(state.registered.length, 5);
      });
    },
  },
  {
    id: 'r7', control: false,
    what: 'registrations are throttled to MULTIENV_CONSUL_RECONCILE_RATE per second',
    run: function ( ) {
      return withConsul([ ], null, async function (consul) {
        var pods = [ 'a', 'b', 'c', 'd' ].map(function (x) { return pod('tenant-' + x); });
        var t0 = Date.now( );
        var s = await reconciler(consul, pods, { ratePerSec: 10 }).runOnce( );
        assert.strictEqual(s.registered, 4);
        assert.ok(Date.now( ) - t0 >= 290, 'took ' + (Date.now( ) - t0) + 'ms');
      });
    },
  },
  {
    id: 'r8', control: false,
    what: 'a failed registration is counted and the pass continues',
    run: function ( ) {
      return withConsul([ ], null, async function (consul, state) {
        state.registerFails = 1;
        var s = await reconciler(consul, [ pod('tenant-a'), pod('tenant-b') ]).runOnce( );
        assert.strictEqual(s.failed, 1);
        assert.strictEqual(s.registered, 1);
      });
    },
  },
  {
    id: 'r9', control: true,
    what: 'the consul operator, with MULTIENV_CONSUL_RECONCILE_INTERVAL set, asks for a pass every interval',
    run: async function (dir) {
      var r = await runOperator(dir, { MULTIENV_CONSUL_RECONCILE_INTERVAL: '400ms' }, 1900);
      var passes = r.calls.filter(function (u) { return u == '/consul/sync/reconcile'; });
      assert.ok(passes.length >= 2 && passes.length <= 4, 'passes: ' + passes.length);
    },
  },
  {
    id: 'r9b', control: false,
    what: 'the consul operator asks for no pass when MULTIENV_CONSUL_RECONCILE_INTERVAL is unset',
    run: async function (dir) {
      var r = await runOperator(dir, { }, 1200);
      assert.strictEqual(r.calls.filter(function (u) { return /reconcile/.test(u); }).length, 0, 'passes');
    },
  },
  {
    id: 'r10', control: false,
    what: 'durations: 10m, 30s, 1500, empty',
    run: function ( ) {
      var d = consulReconcile.parse_duration;
      assert.strictEqual(d('10m'), 600000);
      assert.strictEqual(d('30s'), 30000);
      assert.strictEqual(d('1500'), 1500);
      assert.strictEqual(d(''), 0);
      assert.ok(isNaN(d('ten minutes')));
    },
  },
];

async function main ( ) {
  var failures = 0;
  var only = process.env.OPERATOR_WATCH_ONLY ? process.env.OPERATOR_WATCH_ONLY.split(',') : null;
  for (var i = 0; i < CASES.length; i++) {
    var c = CASES[i];
    if (only && only.indexOf(c.id) == -1) { continue; }
    try {
      await c.run(SRC);
      console.log('ok     ' + c.id + ' ' + c.what);
    } catch (err) {
      failures++;
      console.log('FAIL   ' + c.id + ' ' + c.what + '\n         ' + err.message);
    }
    if (CONTROL && c.control) {
      try {
        await c.run(CONTROL);
        failures++;
        console.log('FAIL   ' + c.id + ' control: passed on ' + path.basename(CONTROL) + ' (the case does not catch the old behaviour)');
      } catch (err) {
        console.log('ok     ' + c.id + ' control: fails on ' + path.basename(CONTROL) + ': ' + err.message.split('\n')[0]);
      }
    }
  }
  console.log(failures ? failures + ' failed' : 'all passed');
  process.exit(failures ? 1 : 0);
}

main( ).catch(function (err) { console.error(err); process.exit(1); });
