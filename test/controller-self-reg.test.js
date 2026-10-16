#!/usr/bin/env node
'use strict';
// Q-CONTROLLER-SELF-REG (F7); OPS-078.
//
// lib/self-registration.js, through the real consul client, against a fake
// Consul agent that keeps services by ID the way an agent does: registering
// an ID it holds replaces that entry, and a missing ID defaults to the name.
//
//   node test/controller-self-reg.test.js
//
// The `control` cases register 7deafde's payload (no ID, written out below)
// and check that the F7 property fails for it. Plain script (node 16 has no
// node:test). Synthetic data only.

var assert = require('assert');
var http = require('http');
var url = require('url');
var path = require('path');
var child_process = require('child_process');
var Consul = require('consul');

var selfReg = require('../lib/self-registration');
var VERBOSE = process.env.SELF_REG_VERBOSE == '1';

var NAME = 'multienv-deployment-controller';

// The self-registration payload at 7deafde (k8s-deployment-controller.js boot).
function payload_7deafde (host, port) {
  return {
    name: NAME,
    address: host,
    port: parseInt(port),
    tags: [ 'healthchecks', 'multienv', 'multienv-deployment-controller' ],
    checks: [ {
      name: "HealthCheckServerOk",
      ttl: '30s',
      interval: '10s',
      http: url.format({protocol: 'http', hostname: host, port: port,  pathname: '/about/server/status'}),
      deregister_critical_service_after: '20s'
    } ]
  };
}

// hooks.deregisterDelayMs: hold deregister answers this long
function fakeAgent (hooks) {
  hooks = hooks || { };
  var state = { services: { }, registers: 0, deregisters: [ ], bodies: [ ] };
  var server = http.createServer(function (req, res) {
    var chunks = [ ];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function ( ) {
      var u = url.parse(req.url, true);
      var m;
      function send (status, obj) {
        res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
        res.end(obj === undefined ? '' : JSON.stringify(obj));
      }
      if (u.pathname == '/v1/agent/service/register') {
        var body = JSON.parse(Buffer.concat(chunks).toString( ));
        state.registers++;
        state.bodies.push(body);
        state.services[body.ID || body.Name] = body;
        return send(200);
      }
      if ((m = u.pathname.match(/^\/v1\/agent\/service\/deregister\/(.+)$/))) {
        var id = decodeURIComponent(m[1]);
        state.deregisters.push(id);
        delete state.services[id];
        if (hooks.deregisterDelayMs) { return setTimeout(function ( ) { send(200); }, hooks.deregisterDelayMs); }
        return send(200);
      }
      send(404, 'fake consul: ' + u.pathname);
    });
  });
  server.state = state;
  return server;
}

function listen (server) {
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function ( ) { resolve(server.address( ).port); });
  });
}

function client (port) {
  return new Consul({ host: '127.0.0.1', port: String(port), promisify: false });
}

function sleep (ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function cb2p (fn) {
  return new Promise(function (resolve, reject) { fn(function (err) { if (err) { reject(err); } else { resolve( ); } }); });
}

function instances (agent) {
  return Object.keys(agent.state.services).filter(function (id) { return agent.state.services[id].Name == NAME; }).length;
}

var cases = [ ];
function test (name, fn) { cases.push({ name: name, fn: fn }); }

function opts_for (pod, extra) {
  var env = Object.assign({ POD_NAME: pod }, extra || { });
  return selfReg.options(env, { name: NAME, address: '10.0.0.' + pod.length, port: '3000' });
}

// The property F7 adds: N controllers through one agent are N instances.
async function three_through_one_agent (register) {
  var agent = fakeAgent( );
  var port = await listen(agent);
  try {
    var consul = client(port);
    var pods = [ 'controller-a', 'controller-bb', 'controller-ccc' ];
    for (var i = 0; i < pods.length; i++) { await register(consul, pods[i]); }
    return instances(agent);
  } finally { agent.close( ); }
}

test('three controllers through one agent are three instances', async function ( ) {
  var n = await three_through_one_agent(function (consul, pod) {
    var r = selfReg.create(consul, Object.assign(opts_for(pod), { intervalMs: 0 }));
    return cb2p(r.start);
  });
  assert.strictEqual(n, 3);
});

test('control: 7deafde payload (no id) through one agent is one instance', async function ( ) {
  var n = await three_through_one_agent(function (consul, pod) {
    var o = opts_for(pod);
    return cb2p(function (cb) { consul.agent.service.register(payload_7deafde(o.address, o.port), cb); });
  });
  assert.strictEqual(n, 1);
  assert.throws(function ( ) { assert.strictEqual(n, 3); }, 'the F7 property must fail for 7deafde');
});

test("MULTIENV_SELF_REGISTER_ID=none sends 7deafde's request", async function ( ) {
  var agent = fakeAgent( );
  var port = await listen(agent);
  try {
    var consul = client(port);
    var o = selfReg.options({ MULTIENV_SELF_REGISTER_ID: 'none', POD_NAME: 'controller-a' }, { name: NAME, address: '10.0.0.1', port: '3000' });
    assert.strictEqual(o.id, undefined);
    await cb2p(selfReg.create(consul, Object.assign(o, { intervalMs: 0 })).start);
    await cb2p(function (cb) { consul.agent.service.register(payload_7deafde('10.0.0.1', '3000'), cb); });
    assert.deepStrictEqual(agent.state.bodies[0], agent.state.bodies[1]);
  } finally { agent.close( ); }
});

test('the request carries an HTTP check and no TTL (the client drops ttl)', async function ( ) {
  var agent = fakeAgent( );
  var port = await listen(agent);
  try {
    await cb2p(selfReg.create(client(port), Object.assign(opts_for('controller-a'), { intervalMs: 0 })).start);
    var body = agent.state.bodies[0];
    assert.strictEqual(body.ID, NAME + '-controller-a');
    assert.strictEqual(body.Name, NAME);
    var check = body.Check || (body.Checks || [ ])[0];
    assert.ok(check.HTTP, 'http check');
    assert.strictEqual(check.Interval, '10s');
    assert.strictEqual(check.TTL, undefined);
    assert.strictEqual(check.DeregisterCriticalServiceAfter, '20s');
  } finally { agent.close( ); }
});

test('a deregistered instance comes back within one interval', async function ( ) {
  var agent = fakeAgent( );
  var port = await listen(agent);
  var r = selfReg.create(client(port), Object.assign(opts_for('controller-a'), { intervalMs: 100 }));
  try {
    await cb2p(r.start);
    assert.strictEqual(instances(agent), 1);
    delete agent.state.services[r.service.id];
    assert.strictEqual(instances(agent), 0);
    await sleep(250);
    assert.strictEqual(instances(agent), 1);
    assert.ok(r.stats.registered >= 2);
  } finally { await cb2p(function (cb) { r.stop(500, cb); }).catch(function ( ) { }); agent.close( ); }
});

test('control: registered once (7deafde), a deregistered instance stays gone', async function ( ) {
  var agent = fakeAgent( );
  var port = await listen(agent);
  try {
    var o = opts_for('controller-a');
    await cb2p(function (cb) { client(port).agent.service.register(payload_7deafde(o.address, o.port), cb); });
    delete agent.state.services[NAME];
    await sleep(250);
    assert.strictEqual(instances(agent), 0);
  } finally { agent.close( ); }
});

test('interval 0 registers once', async function ( ) {
  var agent = fakeAgent( );
  var port = await listen(agent);
  try {
    var o = opts_for('controller-a', { MULTIENV_SELF_REGISTER_INTERVAL: '0' });
    assert.strictEqual(o.intervalMs, 0);
    await cb2p(selfReg.create(client(port), o).start);
    await sleep(250);
    assert.strictEqual(agent.state.registers, 1);
  } finally { agent.close( ); }
});

test('MULTIENV_SELF_REGISTER_ID=none alone also registers only once (one-setting back-out)', function ( ) {
  var base = { name: NAME, address: '10.0.0.1', port: '3000' };
  assert.strictEqual(selfReg.options({ MULTIENV_SELF_REGISTER_ID: 'none' }, base).intervalMs, 0);
  assert.strictEqual(selfReg.options({ MULTIENV_SELF_REGISTER_ID: 'none', MULTIENV_SELF_REGISTER_INTERVAL: '30s' }, base).intervalMs, 30000);
});

test('options: default interval, durations, bad value, pod name and hostname', function ( ) {
  assert.strictEqual(opts_for('p').intervalMs, 60000);
  assert.strictEqual(opts_for('p', { MULTIENV_SELF_REGISTER_INTERVAL: '30s' }).intervalMs, 30000);
  assert.strictEqual(opts_for('p', { MULTIENV_SELF_REGISTER_INTERVAL: '2m' }).intervalMs, 120000);
  assert.strictEqual(opts_for('p', { MULTIENV_SELF_REGISTER_INTERVAL: 'soon' }).intervalMs, 60000);
  assert.strictEqual(opts_for('p').id, NAME + '-p');
  var fromHost = selfReg.options({ }, { name: NAME, address: '10.0.0.1', port: '3000' });
  assert.strictEqual(fromHost.id, NAME + '-' + require('os').hostname( ));
});

test('stop calls back within its timeout when Consul is slow', async function ( ) {
  var agent = fakeAgent({ deregisterDelayMs: 2000 });
  var port = await listen(agent);
  try {
    var r = selfReg.create(client(port), Object.assign(opts_for('controller-a'), { intervalMs: 0 }));
    await cb2p(r.start);
    var t0 = Date.now( );
    var err = await new Promise(function (resolve) { r.stop(200, resolve); });
    assert.ok(Date.now( ) - t0 < 1000, 'bounded');
    assert.ok(err && /timed out/.test(err.message));
  } finally { agent.close( ); }
});

// A child process registers, installs the exit handler and waits; the parent
// sends it a signal.
var CHILD = [
  "var selfReg = require(" + JSON.stringify(path.join(__dirname, '..', 'lib', 'self-registration')) + ");",
  "var Consul = require('consul');",
  "var consul = new Consul({ host: '127.0.0.1', port: process.env.FAKE_PORT, promisify: false });",
  "var o = selfReg.options(process.env, { name: 'multienv-deployment-controller', address: '10.0.0.9', port: '3000' });",
  "var r = selfReg.create(consul, o);",
  "r.start(function (err) { selfReg.deregister_on_exit(r, 500); process.send('ready'); });",
  "setInterval(function ( ) { }, 1000);"
].join('\n');

async function signalled (signal, env) {
  var agent = fakeAgent( );
  var port = await listen(agent);
  try {
    var child = child_process.spawn(process.execPath, [ '-e', CHILD ], {
      cwd: path.join(__dirname, '..'), stdio: [ 'ignore', VERBOSE ? 'inherit' : 'ignore', VERBOSE ? 'inherit' : 'ignore', 'ipc' ],
      env: Object.assign({ }, process.env, { FAKE_PORT: String(port), POD_NAME: 'controller-a' }, env || { })
    });
    await new Promise(function (resolve, reject) { child.once('message', resolve); child.once('exit', function (c) { reject(new Error('child exited ' + c)); }); });
    var exited = new Promise(function (resolve) { child.once('exit', function (code, sig) { resolve({ code: code, signal: sig }); }); });
    child.kill(signal);
    var result = await exited;
    return { result: result, deregisters: agent.state.deregisters.slice( ), left: instances(agent) };
  } finally { agent.close( ); }
}

test('SIGTERM deregisters its own ID, then exits by the signal', async function ( ) {
  var out = await signalled('SIGTERM');
  assert.deepStrictEqual(out.deregisters, [ NAME + '-controller-a' ]);
  assert.strictEqual(out.left, 0);
  assert.strictEqual(out.result.signal, 'SIGTERM');
});

test('SIGINT deregisters too (pm2 stops cluster workers with SIGINT)', async function ( ) {
  var out = await signalled('SIGINT');
  assert.deepStrictEqual(out.deregisters, [ NAME + '-controller-a' ]);
  assert.strictEqual(out.result.signal, 'SIGINT');
});

test('with MULTIENV_SELF_REGISTER_ID=none, SIGTERM leaves the shared registration alone', async function ( ) {
  var out = await signalled('SIGTERM', { MULTIENV_SELF_REGISTER_ID: 'none' });
  assert.deepStrictEqual(out.deregisters, [ ]);
  assert.strictEqual(out.left, 1);
  assert.strictEqual(out.result.signal, 'SIGTERM');
});

test('the controller boot uses the module', function ( ) {
  var src = require('fs').readFileSync(path.join(__dirname, '..', 'k8s-deployment-controller.js'), 'utf8');
  assert.ok(/require\('\.\/lib\/self-registration'\)/.test(src));
  assert.ok(/self_registration\.deregister_on_exit\(registration\)/.test(src));
  assert.ok(!/REGISTERING SELF", body/.test(src), 'no agent/self body in logs');
});

(async function main ( ) {
  var failed = 0;
  for (var i = 0; i < cases.length; i++) {
    try { await cases[i].fn( ); console.log('ok', i + 1, cases[i].name); }
    catch (e) { failed++; console.log('not ok', i + 1, cases[i].name); console.log('  ' + (e && e.stack || e)); }
  }
  console.log((cases.length - failed) + '/' + cases.length + ' passed');
  process.exit(failed ? 1 : 0);
})( );
