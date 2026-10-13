#!/usr/bin/env node
'use strict';
// Q-CONSUL-REGISTER-MISSING (F5a); OPS-071, OPS-073.
//
// lib/consul-reconcile.js and its wiring in k8s-deployment-controller.js,
// against a fake Consul HTTP API (catalog health, agent register, sessions,
// KV lock) and a fake pod list.
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
  var state = { registered: [ ], sessions: { }, lock: null, nextSession: 1, health: 0, requests: 0, registerFails: 0 };
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
      if (u.pathname == '/v1/session/create') {
        var id = 'session-' + (state.nextSession++);
        state.sessions[id] = JSON.parse(body || '{}');
        return send(200, { ID: id });
      }
      if ((m = u.pathname.match(/^\/v1\/session\/renew\/(.+)$/))) {
        if (!state.sessions[m[1]]) { return send(404, 'Session id not found'); }
        return send(200, [ { ID: m[1] } ]);
      }
      if ((m = u.pathname.match(/^\/v1\/kv\/(.+)$/)) && u.query.acquire) {
        var sid = u.query.acquire;
        if (!state.sessions[sid]) { return send(500, 'invalid session'); }
        if (state.lock && state.lock != sid && state.sessions[state.lock]) { return send(200, false); }
        state.lock = sid;
        return send(200, true);
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
    consul: consul, intervalMs: 60000, ratePerSec: 1000,
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

async function controllerPass (dir, consul, pods, interval) {
  var configure = loadController(dir);
  var listed = [ ];
  var k8s = { listNamespacedPod: function (ns, a, b, c, d, selector) {
    listed.push({ ns: ns, selector: selector });
    return Promise.resolve({ body: { items: pods } });
  } };
  var log = console.log;
  if (!VERBOSE) { console.log = function ( ) { }; }
  var server = configure({
    k8s: k8s, appsApi: { }, consul: consul, MULTIENV_K8S_NAMESPACE: 'hosted-tenants',
    MULTIENV_HEALTH_CHECK_SERVICE: 'http://multienv-deployment-controller:3000',
    MULTIENV_CONSUL_RECONCILE_INTERVAL_MS: interval, MULTIENV_CONSUL_RECONCILE_FIRST_DELAY_MS: 0,
    MULTIENV_CONSUL_RECONCILE_GRACE_MS: 120000, MULTIENV_CONSUL_RECONCILE_RATE: 1000, MULTIENV_CONSUL_RECONCILE_MAX: 200,
    MULTIENV_CONSUL_RECONCILE_SELECTOR: 'role=config-as-deploy,managed=multienv',
    requests: { }, limits: { }, default: { deployment: { annotations: { }, labels: { } }, configmap: { annotations: { }, labels: { } } },
  });
  try {
    await sleep(700);
  } finally {
    console.log = log;
    if (server.consul_reconcile) { server.consul_reconcile.stop( ); }
  }
  return { listed: listed, reconcile: !!server.consul_reconcile };
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
    what: 'the controller, with MULTIENV_CONSUL_RECONCILE_INTERVAL set, registers only the Running pod with no registration',
    run: function (dir) {
      return withConsul([ entry('tenant-a') ], null, async function (consul, state) {
        var r = await controllerPass(dir, consul, MIXED, 60000);
        assert.deepStrictEqual(ids(state), [ 'uid-tenant-b' ], 'registered');
        var reg = state.registered[0];
        assert.strictEqual(reg.Name, 'backends');
        assert.strictEqual(reg.Address, '10.0.2.8');
        assert.ok(reg.Tags.indexOf('tenant-b') > -1, 'tenant tag');
        assert.strictEqual(reg.Checks.length, 2, 'same checks as /consul/sync');
        assert.deepStrictEqual(r.listed, [ { ns: 'hosted-tenants', selector: 'role=config-as-deploy,managed=multienv' } ]);
      });
    },
  },
  {
    id: 'r2', control: false,
    what: 'off by default: no interval, no timer, no Consul or pod requests',
    run: function (dir) {
      return withConsul([ ], null, async function (consul, state) {
        var r = await controllerPass(dir, consul, MIXED, 0);
        assert.strictEqual(r.reconcile, false, 'reconcile started');
        assert.strictEqual(state.requests, 0, 'consul requests');
        assert.strictEqual(r.listed.length, 0, 'pod lists');
      });
    },
  },
  {
    id: 'r3', control: false,
    what: 'a pod registered on any agent is never registered again (no duplicates)',
    run: function ( ) {
      return withConsul([ entry('tenant-a'), entry('tenant-b') ], null, async function (consul, state) {
        var s = await reconciler(consul, [ pod('tenant-a'), pod('tenant-b') ]).runOnce( );
        assert.strictEqual(s.leader, true);
        assert.strictEqual(s.missing, 0);
        assert.strictEqual(state.registered.length, 0);
      });
    },
  },
  {
    id: 'r4', control: false,
    what: 'two replicas at once: only the lock holder registers, each missing pod once',
    run: function ( ) {
      return withConsul([ ], null, async function (consul, state) {
        var pods = [ pod('tenant-a'), pod('tenant-b'), pod('tenant-c') ];
        var both = await Promise.all([ reconciler(consul, pods).runOnce( ), reconciler(consul, pods).runOnce( ) ]);
        assert.deepStrictEqual(both.map(function (s) { return s.leader; }).sort( ), [ false, true ], 'leaders');
        assert.deepStrictEqual(ids(state), [ 'uid-tenant-a', 'uid-tenant-b', 'uid-tenant-c' ]);
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
    id: 'r9', control: false,
    what: 'the session is renewed between passes, and replaced when Consul has dropped it',
    run: function ( ) {
      return withConsul([ ], null, async function (consul, state) {
        var r = reconciler(consul, [ ]);
        assert.strictEqual((await r.runOnce( )).leader, true);
        assert.strictEqual((await r.runOnce( )).leader, true);
        assert.strictEqual(state.nextSession, 2, 'one session for two passes');
        state.sessions = { };
        assert.strictEqual((await r.runOnce( )).leader, true);
        assert.strictEqual(state.nextSession, 3, 'a new session after the old one was dropped');
        assert.strictEqual(state.sessions['session-2'].TTL, '120s', 'TTL is twice the interval');
      });
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
