#!/usr/bin/env node
'use strict';
// Q-OPERATOR-WATCH (F1, F2, F4) and Q-CONTROLLER-IDEMPOTENT-ADD (F3);
// OPS-036, OPS-071, OPS-073.
//
// The dispatcher cases run k8s-dispatcher.js as a process against a fake
// Kubernetes API whose watches end, expire or fail on cue (test/watch/fakes.js),
// and a fake controller that records the POSTs. The controller cases call the
// /sync/* routes of k8s-deployment-controller.js with a fake apps API.
//
//   node test/operator-watch.test.js
//   OPERATOR_WATCH_CONTROL=<tree at 7deafde> node test/operator-watch.test.js
//
// With OPERATOR_WATCH_CONTROL, the cases marked `control` also run against
// that tree and must fail there; a control that passes fails the run.
// Plain script (node 16 has no node:test). Synthetic data only.

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var Module = require('module');
var child_process = require('child_process');
var fakes = require('./watch/fakes');

var SRC = path.join(__dirname, '..');
var CONTROL = process.env.OPERATOR_WATCH_CONTROL || '';
var VERBOSE = process.env.OPERATOR_WATCH_VERBOSE == '1';
var WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'opwatch-'));

function listen (server) {
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function ( ) { resolve(server.address( ).port); });
  });
}

function sleep (ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ---- dispatcher as a process -------------------------------------------

var DEPLOYMENT_OPERATOR_ENV = {
  SYNC_CONTROLLER: 'deployment', WATCH_LABELSELECTOR: 'role=config-as-deploy,managed=multienv',
  MULTIENV_K8S_NAMESPACE: 'default', INIT_WITH_FULL_AUDIT: '0',
  DELAY_CROWD_PARALLEL: '6', DELAY_CROWD_INTERVAL_MS: '1', DELAY_CROWD_NO_RANDOM_EXTRA: '1',
  MULTIENV_WATCH_BACKOFF_MS: '50', MULTIENV_POST_RETRY_BASE_MS: '50',
};
var CONSUL_OPERATOR_ENV = Object.assign({ }, DEPLOYMENT_OPERATOR_ENV, {
  FILTER_NONE: '1', WATCH_ENDPOINT: '/api/v1/namespaces/default/pods', DELAY_CROWD_PARALLEL: '12',
});

async function runDispatcher (dir, c) {
  var api = fakes.createApi(c.script);
  var gw = fakes.createGateway(c.statuses);
  var apiPort = await listen(api);
  var gwPort = await listen(gw);
  var kubeconfig = path.join(WORK, 'kubeconfig-' + apiPort + '.json');
  fs.writeFileSync(kubeconfig, JSON.stringify({
    apiVersion: 'v1', kind: 'Config', 'current-context': 'fake',
    clusters: [ { name: 'fake', cluster: { server: 'http://127.0.0.1:' + apiPort } } ],
    users: [ { name: 'fake', user: { token: 'opwatch-fake-token' } } ],
    contexts: [ { name: 'fake', context: { cluster: 'fake', user: 'fake', namespace: 'default' } } ],
  }));
  var gateway = 'http://127.0.0.1:' + gwPort + (c.consul ? '/consul/' : '/');
  var env = Object.assign({ }, process.env, c.consul ? CONSUL_OPERATOR_ENV : DEPLOYMENT_OPERATOR_ENV, c.env || { },
    { MULTIENV_K8S_AUTH: 'local', KUBECONFIG: kubeconfig, CLUSTER_GATEWAY: gateway });
  var child = child_process.spawn(process.execPath, [ path.join(dir, 'k8s-dispatcher.js') ], { env: env, cwd: dir });
  var out = [ ];
  child.stdout.on('data', function (d) { out.push(d.toString( )); });
  child.stderr.on('data', function (d) { out.push(d.toString( )); });
  var exit = null;
  child.on('exit', function (code) { exit = code; });
  var state = { posts: gw.posts, api: api.log, out: out };
  var deadline = Date.now( ) + (c.timeoutMs || 6000);
  while (Date.now( ) < deadline && exit === null && !(c.until && c.until(state))) {
    await sleep(50);
  }
  // let anything in flight land
  await sleep(c.settleMs || 300);
  state.exit = exit;
  if (exit === null) { child.kill('SIGKILL'); }
  api.closeAll( );
  gw.close( );
  return state;
}

function posted (state, p, name) {
  return state.posts.filter(function (x) { return x.path == p && (!name || x.name == name); });
}

var A10 = fakes.configmap('tenant-a', 10);
var B11 = fakes.configmap('tenant-b', 11);
var D12 = fakes.configmap('tenant-d', 12);

var DISPATCHER_CASES = [
  {
    id: 'w1', control: true,
    what: 'F1: a watch that ends is resumed in-process from the last bookmark; a change after the end arrives',
    script: {
      lists: [ { resourceVersion: 20, items: [ A10, B11 ] } ],
      watches: [
        function (q, res) {
          res.writeHead(200);
          res.write(fakes.line('MODIFIED', fakes.configmap('tenant-a', 21)));
          res.write(fakes.bookmark(25));
          setTimeout(function ( ) { res.end( ); }, 100);
        },
        function (q, res) {
          res.writeHead(200);
          if (q.resourceVersion == '25') { res.write(fakes.line('MODIFIED', fakes.configmap('tenant-b', 26))); }
        },
      ],
    },
    until: function (s) { return posted(s, '/sync/updates', 'tenant-b').length > 0; },
    check: function (s) {
      assert.strictEqual(s.exit, null, 'the dispatcher exited (code ' + s.exit + ') when its watch ended');
      assert.strictEqual(s.api.watches[0].query.resourceVersion, '20', 'first watch starts at the listed version');
      assert.ok(s.api.watches.length >= 2, 'no second watch');
      assert.strictEqual(s.api.watches[1].query.resourceVersion, '25', 'second watch resumes from the bookmark');
      assert.strictEqual(posted(s, '/sync/updates', 'tenant-a').length, 1, 'tenant-a update');
      assert.strictEqual(posted(s, '/sync/updates', 'tenant-b').length, 1, 'tenant-b update after the gap');
    },
  },
  {
    id: 'w2', control: true,
    what: 'F2: on 410 Expired, list again and send only the differences; unchanged tenants get nothing',
    script: {
      lists: [
        { resourceVersion: 20, items: [ A10, B11, D12 ] },
        { resourceVersion: 40, items: [ fakes.configmap('tenant-a', 30), B11, fakes.configmap('tenant-c', 31) ] },
      ],
      watches: [
        function (q, res) { res.writeHead(200); res.write(fakes.expired( )); setTimeout(function ( ) { res.end( ); }, 50); },
      ],
    },
    until: function (s) { return s.posts.length >= 3; },
    settleMs: 800,
    check: function (s) {
      assert.strictEqual(s.exit, null, 'the dispatcher exited (code ' + s.exit + ') on Expired');
      assert.strictEqual(posted(s, '/sync/updates', 'tenant-a').length, 1, 'changed tenant-a is an update');
      assert.strictEqual(posted(s, '/sync/additions', 'tenant-c').length, 1, 'new tenant-c is an addition');
      assert.strictEqual(posted(s, '/sync/deletions', 'tenant-d').length, 1, 'missing tenant-d is a deletion');
      assert.strictEqual(s.posts.filter(function (p) { return p.name == 'tenant-b'; }).length, 0, 'unchanged tenant-b got a POST');
      assert.strictEqual(posted(s, '/sync/additions').length, 1, 'only the new tenant is an addition');
      var last = s.api.watches[s.api.watches.length - 1];
      assert.strictEqual(last.query.resourceVersion, '40', 'watches again from the new list');
    },
  },
  {
    id: 'w3', control: true,
    what: 'F4: a POST that fails twice with 503 is retried and delivered once',
    statuses: function (n) { return n < 2 ? 503 : 200; },
    script: {
      lists: [ { resourceVersion: 20, items: [ A10 ] } ],
      watches: [ function (q, res) { res.writeHead(200); res.write(fakes.line('MODIFIED', fakes.configmap('tenant-a', 21))); } ],
    },
    until: function (s) { return s.posts.some(function (p) { return p.status == 200; }); },
    check: function (s) {
      var a = posted(s, '/sync/updates', 'tenant-a');
      assert.deepStrictEqual(a.map(function (p) { return p.status; }), [ 503, 503, 200 ], 'attempts');
    },
  },
  {
    id: 'w4', control: false,
    what: 'F4: a 4xx answer is not retried',
    statuses: function ( ) { return 404; },
    script: {
      lists: [ { resourceVersion: 20, items: [ A10 ] } ],
      watches: [ function (q, res) { res.writeHead(200); res.write(fakes.line('DELETED', fakes.configmap('tenant-a', 21))); } ],
    },
    until: function (s) { return s.posts.length > 0; },
    settleMs: 500,
    check: function (s) {
      assert.strictEqual(s.posts.length, 1, 'a 404 was retried');
    },
  },
  {
    id: 'w5', control: true,
    what: 'F1: after a full-audit start, the next watch resumes; it does not replay every tenant again',
    env: { INIT_WITH_FULL_AUDIT: '1' },
    script: {
      lists: [ { resourceVersion: 20, items: [ A10, B11 ] } ],
      watches: [
        function (q, res) {
          res.writeHead(200);
          if (!q.resourceVersion) {
            res.write(fakes.line('ADDED', A10));
            res.write(fakes.line('ADDED', B11));
          }
          res.write(fakes.bookmark(20));
          setTimeout(function ( ) { res.end( ); }, 100);
        },
      ],
    },
    until: function (s) { return s.api.watches.length >= 2 && s.posts.length >= 2; },
    check: function (s) {
      assert.strictEqual(s.exit, null, 'the dispatcher exited (code ' + s.exit + ')');
      assert.ok(!s.api.watches[0].query.resourceVersion, 'full audit starts without a version');
      assert.strictEqual(s.api.watches[1].query.resourceVersion, '20', 'then resumes from the bookmark');
      assert.strictEqual(posted(s, '/sync/additions').length, 2, 'each tenant added once');
    },
  },
  {
    id: 'w6', control: true,
    what: 'F1/F2 for the consul operator (pods): resumes, and after 410 registers the pod that changed',
    consul: true,
    script: {
      lists: [
        { resourceVersion: 20, items: [ fakes.pod('tenant-a', 10), fakes.pod('tenant-b', 11) ] },
        { resourceVersion: 40, items: [ fakes.pod('tenant-a', 10), fakes.pod('tenant-b', 33) ] },
      ],
      watches: [
        function (q, res) { res.writeHead(200); res.write(fakes.bookmark(25)); setTimeout(function ( ) { res.end( ); }, 50); },
        function (q, res) { res.writeHead(200); res.write(fakes.expired( )); setTimeout(function ( ) { res.end( ); }, 50); },
      ],
    },
    until: function (s) { return s.posts.length >= 1; },
    settleMs: 600,
    check: function (s) {
      assert.strictEqual(s.exit, null, 'the dispatcher exited (code ' + s.exit + ')');
      assert.strictEqual(s.api.watches[1].query.resourceVersion, '25', 'resumed from the bookmark');
      assert.strictEqual(posted(s, '/consul/sync/updates', 'tenant-b-pod').length, 1, 'changed pod sent as an update');
      assert.strictEqual(s.posts.length, 1, 'only the changed pod');
      assert.ok(s.api.lists.every(function (l) { return /\/pods$/.test(l.path); }), 'listed pods');
    },
  },
  {
    id: 'w7', control: false,
    what: 'F2: a re-list that would delete more than MULTIENV_RELIST_MAX_DELETES deletes nothing',
    env: { MULTIENV_RELIST_MAX_DELETES: '1' },
    script: {
      lists: [
        { resourceVersion: 20, items: [ A10, B11, D12 ] },
        { resourceVersion: 40, items: [ fakes.configmap('tenant-a', 30) ] },
      ],
      watches: [ function (q, res) { res.writeHead(200); res.write(fakes.expired( )); setTimeout(function ( ) { res.end( ); }, 50); } ],
    },
    until: function (s) { return s.posts.length >= 1; },
    settleMs: 600,
    check: function (s) {
      assert.strictEqual(posted(s, '/sync/deletions').length, 0, 'deletions were sent');
      assert.strictEqual(posted(s, '/sync/updates', 'tenant-a').length, 1, 'the update still goes');
      assert.ok(s.out.join('').indexOf('RELIST SKIPPED DELETIONS 2') > -1, 'skipped deletions are logged');
    },
  },
  {
    id: 'w8', control: false,
    what: 'MULTIENV_WATCH_EXIT_ON_END=1 keeps the old exit when the watch ends',
    env: { MULTIENV_WATCH_EXIT_ON_END: '1' },
    script: {
      lists: [ { resourceVersion: 20, items: [ A10 ] } ],
      watches: [ function (q, res) { res.writeHead(200); res.write(fakes.bookmark(25)); setTimeout(function ( ) { res.end( ); }, 50); } ],
    },
    check: function (s) {
      assert.strictEqual(s.exit, 0, 'exit code');
      assert.strictEqual(s.api.watches.length, 1, 'one watch');
    },
  },
  {
    id: 'w9', control: false,
    what: 'F1: a watch that keeps failing backs off, then exits 1 after MULTIENV_WATCH_MAX_FAILURES',
    env: { MULTIENV_WATCH_MAX_FAILURES: '3' },
    script: {
      lists: [ { resourceVersion: 20, items: [ A10 ] } ],
      watches: [ 1, 2, 3, 4 ].map(function ( ) { return function (q, res) { res.writeHead(500); res.end('{}'); }; }),
    },
    check: function (s) {
      assert.strictEqual(s.exit, 1, 'exit code');
      assert.strictEqual(s.api.watches.length, 3, 'watch attempts');
      var gaps = s.api.watches.slice(1).map(function (w, i) { return w.at - s.api.watches[i].at; });
      assert.ok(gaps[1] >= gaps[0], 'backoff grows: ' + gaps);
    },
  },
  {
    id: 'w10', control: false,
    what: 'ordering: an ADDED being retried never lands after a later DELETED of the same object',
    statuses: (function ( ) {
      var adds = 0;
      return function (n, p) { if (/additions$/.test(p)) { adds++; return adds <= 2 ? 503 : 200; } return 200; };
    })( ),
    script: {
      lists: [ { resourceVersion: 20, items: [ ] } ],
      watches: [ function (q, res) {
        res.writeHead(200);
        res.write(fakes.line('ADDED', fakes.configmap('tenant-a', 21)));
        setTimeout(function ( ) { res.write(fakes.line('DELETED', fakes.configmap('tenant-a', 22))); }, 20);
      } ],
    },
    until: function (s) { return posted(s, '/sync/deletions', 'tenant-a').length > 0; },
    settleMs: 600,
    check: function (s) {
      var a = s.posts.filter(function (p) { return p.name == 'tenant-a'; });
      var del = a.map(function (p) { return p.path; }).lastIndexOf('/sync/deletions');
      assert.ok(del > -1, 'deletion sent');
      assert.strictEqual(a[a.length - 1].path, '/sync/deletions', 'last POST for the tenant: ' + JSON.stringify(a));
      assert.strictEqual(a.filter(function (p) { return p.path == '/sync/additions' && p.status == 200; }).length, 0,
        'the addition succeeded around the deletion: ' + JSON.stringify(a));
      assert.ok(s.out.join('').indexOf('SUPERSEDED POST') > -1, 'superseded retry is logged');
    },
  },
  {
    id: 'w11', control: false,
    what: 'ordering: an ADDED being retried still lands before a later MODIFIED of the same object',
    statuses: (function ( ) {
      var adds = 0;
      return function (n, p) { if (/additions$/.test(p)) { adds++; return adds <= 2 ? 503 : 200; } return 200; };
    })( ),
    script: {
      lists: [ { resourceVersion: 20, items: [ ] } ],
      watches: [ function (q, res) {
        res.writeHead(200);
        res.write(fakes.line('ADDED', fakes.configmap('tenant-a', 21)));
        setTimeout(function ( ) { res.write(fakes.line('MODIFIED', fakes.configmap('tenant-a', 22))); }, 20);
      } ],
    },
    until: function (s) { return posted(s, '/sync/updates', 'tenant-a').length > 0; },
    settleMs: 400,
    check: function (s) {
      var a = s.posts.filter(function (p) { return p.name == 'tenant-a'; }).map(function (p) { return p.path + ':' + p.status; });
      assert.deepStrictEqual(a, [ '/sync/additions:503', '/sync/additions:503', '/sync/additions:200', '/sync/updates:200' ], 'order');
    },
  },
  {
    id: 'w12', control: false,
    what: 'a watch that only sends non-410 ERROR events backs off and exits 1 after MULTIENV_WATCH_MAX_FAILURES',
    env: { MULTIENV_WATCH_MAX_FAILURES: '3' },
    script: {
      lists: [ { resourceVersion: 20, items: [ A10 ] } ],
      watches: [ 1, 2, 3, 4, 5, 6 ].map(function ( ) { return function (q, res) {
        res.writeHead(200);
        res.write(fakes.line('ERROR', { kind: 'Status', apiVersion: 'v1', metadata: { }, status: 'Failure', reason: 'InternalError', code: 500 }));
        setTimeout(function ( ) { res.end( ); }, 20);
      }; }),
    },
    check: function (s) {
      assert.strictEqual(s.exit, 1, 'exit code');
      assert.strictEqual(s.api.watches.length, 3, 'watch attempts');
    },
  },
  {
    id: 'w13', control: false,
    what: 'F2: deletions held back by MULTIENV_RELIST_MAX_DELETES are not forgotten; a later re-list still sends them',
    env: { MULTIENV_RELIST_MAX_DELETES: '1' },
    script: {
      lists: [
        { resourceVersion: 20, items: [ A10, B11, D12 ] },
        { resourceVersion: 40, items: [ A10 ] },
        { resourceVersion: 60, items: [ A10, B11 ] },
      ],
      watches: [
        function (q, res) { res.writeHead(200); res.write(fakes.expired( )); setTimeout(function ( ) { res.end( ); }, 50); },
        function (q, res) { res.writeHead(200); res.write(fakes.expired( )); setTimeout(function ( ) { res.end( ); }, 50); },
      ],
    },
    until: function (s) { return s.posts.length >= 1; },
    settleMs: 600,
    check: function (s) {
      assert.strictEqual(posted(s, '/sync/additions', 'tenant-b').length, 0, 'tenant-b re-added after a skipped deletion');
      assert.strictEqual(posted(s, '/sync/deletions', 'tenant-d').length, 1, 'tenant-d deletion sent on the later re-list');
      assert.strictEqual(s.posts.length, 1, 'only the deletion: ' + JSON.stringify(s.posts));
    },
  },
];

// ---- controller /sync/* with a fake apps API ----------------------------

var CONFIG_RV = 'multienv.t1pal.org/config-rv';

function httpError (code) {
  var err = new Error('HTTP request failed');
  err.statusCode = code;
  err.body = { kind: 'Status', code: code, reason: code == 409 ? 'AlreadyExists' : 'NotFound' };
  err.response = { statusCode: code, body: err.body };
  return err;
}

function fakeApps (deployments) {
  var calls = [ ];
  function decode (s) { return s.replace(/~1/g, '/').replace(/~0/g, '~'); }
  return {
    calls: calls, deployments: deployments,
    createNamespacedDeployment: function (ns, body) {
      calls.push({ op: 'create', name: body.metadata.name, body: JSON.parse(JSON.stringify(body)) });
      if (deployments[body.metadata.name]) { return Promise.reject(httpError(409)); }
      deployments[body.metadata.name] = JSON.parse(JSON.stringify(body));
      return Promise.resolve({ body: deployments[body.metadata.name], response: { } });
    },
    readNamespacedDeployment: function (name) {
      calls.push({ op: 'read', name: name });
      if (!deployments[name]) { return Promise.reject(httpError(404)); }
      return Promise.resolve({ body: JSON.parse(JSON.stringify(deployments[name])), response: { } });
    },
    patchNamespacedDeployment: function (name, ns, patch) {
      calls.push({ op: 'patch', name: name, patch: patch });
      var d = deployments[name];
      if (!d) { return Promise.reject(httpError(404)); }
      patch.forEach(function (op) {
        assert.strictEqual(op.op, 'add');
        var parts = op.path.split('/').slice(1).map(decode);
        var target = d;
        parts.slice(0, -1).forEach(function (p) {
          assert.ok(target[p] && typeof target[p] == 'object', 'patch path missing: ' + op.path);
          target = target[p];
        });
        target[parts[parts.length - 1]] = op.value;
      });
      return Promise.resolve({ body: d, response: { } });
    },
  };
}

function existing (name, annotations) {
  return {
    kind: 'Deployment',
    metadata: { name: name, annotations: annotations === undefined ? { 'managed-by': 'test' } : annotations },
    spec: { template: { metadata: { annotations: { 'managed-by': 'test' } }, spec: { } } },
  };
}

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

async function runController (dir, c) {
  var configure = loadController(dir);
  var apps = fakeApps(c.deployments || { });
  var server = configure({
    k8s: { }, appsApi: apps, consul: { }, MULTIENV_K8S_NAMESPACE: 'default',
    MULTIENV_HEALTH_CHECK_SERVICE: 'http://multienv-deployment-controller:3000',
    MULTIENV_SYNC_ADD_ALWAYS_RESTART: !!c.alwaysRestart,
    MULTIENV_SYNC_UNSTAMPED: c.unstamped,
    requests: { cpu: '5m', memory: '120Mi' }, limits: { cpu: '500m', memory: '500Mi' },
    default: { deployment: { annotations: { 'managed-by': 'test' }, labels: { managed: 'multienv' } },
      configmap: { annotations: { }, labels: { } } },
  });
  // restify's audit logger writes every request to stdout
  var write = process.stdout.write;
  if (!VERBOSE) { process.stdout.write = function ( ) { return true; }; }
  try {
    var port = await listen(server);
    var statuses = [ ];
    for (var i = 0; i < c.posts.length; i++) {
      statuses.push(await new Promise(function (resolve, reject) {
        var body = JSON.stringify(c.posts[i].body);
        var req = http.request({ host: '127.0.0.1', port: port, method: 'POST', path: c.posts[i].path,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, function (res) {
          res.resume( );
          res.on('end', function ( ) { resolve(res.statusCode); });
        });
        req.on('error', reject);
        req.end(body);
      }));
    }
    server.close( );
    return { apps: apps, statuses: statuses };
  } finally {
    process.stdout.write = write;
  }
}

function added (name, rv) {
  var meta = { name: name, labels: { tenant: name } };
  if (rv !== undefined) { meta.resourceVersion = String(rv); }
  return { path: '/sync/additions', body: { type: 'ADDED', object: { metadata: meta, data: { WEB_NAME: name } } } };
}

function modified (name, rv, annotations) {
  return { path: '/sync/updates', body: { type: 'MODIFIED',
    object: { metadata: { name: name, resourceVersion: String(rv), annotations: annotations || { } }, data: { WEB_NAME: name } } } };
}

function patches (r) { return r.apps.calls.filter(function (c) { return c.op == 'patch'; }); }
function restarts (r) {
  return patches(r).filter(function (c) { return c.patch.some(function (op) { return /updated-at$/.test(op.path); }); });
}
function stampOf (r, name) { return (r.apps.deployments[name].metadata.annotations || { })[CONFIG_RV]; }

var CONTROLLER_CASES = [
  {
    id: 'c1', control: true,
    what: 'F3: a new tenant is created with the ConfigMap version on the Deployment, not on the pod template',
    posts: [ added('tenant-new', 5) ],
    check: function (r) {
      assert.deepStrictEqual(r.statuses, [ 200 ]);
      var d = r.apps.deployments['tenant-new'];
      assert.strictEqual(d.metadata.annotations[CONFIG_RV], '5', 'stamp on the Deployment');
      assert.ok(!(CONFIG_RV in d.spec.template.metadata.annotations), 'stamp is on the pod template');
    },
  },
  {
    id: 'c2', control: true,
    what: 'F3: a repeated addition with the same version restarts nothing',
    deployments: { 'tenant-a': existing('tenant-a', { 'managed-by': 'test', [CONFIG_RV]: '5' }) },
    posts: [ added('tenant-a', 5) ],
    check: function (r) {
      assert.deepStrictEqual(r.statuses, [ 200 ]);
      assert.strictEqual(patches(r).length, 0, 'patched: ' + JSON.stringify(patches(r)));
    },
  },
  {
    id: 'c3', control: false,
    what: 'F3: an addition with a newer version restarts and moves the stamp',
    deployments: { 'tenant-a': existing('tenant-a', { 'managed-by': 'test', [CONFIG_RV]: '5' }) },
    posts: [ added('tenant-a', 6) ],
    check: function (r) {
      assert.deepStrictEqual(r.statuses, [ 200 ]);
      assert.strictEqual(restarts(r).length, 1, 'restarts');
      assert.strictEqual(stampOf(r, 'tenant-a'), '6');
    },
  },
  {
    id: 'c4', control: true,
    what: 'F3: a Deployment made before stamps is restarted once and stamped on a repeated addition (its config may be stale)',
    deployments: { 'tenant-a': existing('tenant-a') },
    posts: [ added('tenant-a', 7), added('tenant-a', 7) ],
    check: function (r) {
      assert.deepStrictEqual(r.statuses, [ 200, 200 ]);
      assert.strictEqual(restarts(r).length, 1, 'restarts: once on the first stamp, not on the repeat');
      assert.strictEqual(stampOf(r, 'tenant-a'), '7');
    },
  },
  {
    id: 'c4s', control: false,
    what: 'F3: MULTIENV_SYNC_UNSTAMPED=stamp stamps a Deployment made before stamps without restarting it',
    unstamped: 'stamp',
    deployments: { 'tenant-a': existing('tenant-a') },
    posts: [ added('tenant-a', 7) ],
    check: function (r) {
      assert.deepStrictEqual(r.statuses, [ 200 ]);
      assert.strictEqual(restarts(r).length, 0, 'restarted');
      assert.strictEqual(stampOf(r, 'tenant-a'), '7');
    },
  },
  {
    id: 'c5', control: false,
    what: 'F3: stamping works when the Deployment has no annotations at all',
    deployments: { 'tenant-a': existing('tenant-a', null) },
    posts: [ added('tenant-a', 7) ],
    check: function (r) {
      assert.deepStrictEqual(r.statuses, [ 200 ]);
      assert.strictEqual(restarts(r).length, 1, 'restarts');
      assert.strictEqual(stampOf(r, 'tenant-a'), '7');
    },
  },
  {
    id: 'c6', control: false,
    what: 'F3: a MODIFIED ConfigMap always restarts, and the stamp follows it; then a repeat addition is a no-op',
    deployments: { 'tenant-a': existing('tenant-a', { 'managed-by': 'test', [CONFIG_RV]: '5' }) },
    posts: [ modified('tenant-a', 8), added('tenant-a', 8) ],
    check: function (r) {
      assert.deepStrictEqual(r.statuses, [ 200, 200 ]);
      assert.strictEqual(restarts(r).length, 1, 'restarts');
      assert.strictEqual(stampOf(r, 'tenant-a'), '8');
    },
  },
  {
    id: 'c7', control: false,
    what: 'F3: a supplementary ConfigMap (annotation tenant=...) restarts its tenant without stamping its own version',
    deployments: { 'tenant-a': existing('tenant-a', { 'managed-by': 'test', [CONFIG_RV]: '5' }) },
    posts: [ modified('tenant-a-extra', 9, { tenant: 'tenant-a' }) ],
    check: function (r) {
      assert.strictEqual(restarts(r).length, 1, 'restarts');
      assert.strictEqual(stampOf(r, 'tenant-a'), '5');
    },
  },
  {
    id: 'c8', control: false,
    what: 'MULTIENV_SYNC_ADD_ALWAYS_RESTART keeps the old restart on every repeated addition',
    alwaysRestart: true,
    deployments: { 'tenant-a': existing('tenant-a', { 'managed-by': 'test', [CONFIG_RV]: '5' }) },
    posts: [ added('tenant-a', 5) ],
    check: function (r) { assert.strictEqual(restarts(r).length, 1, 'restarts'); },
  },
  {
    id: 'c9', control: false,
    what: 'an addition without a resourceVersion behaves as before (restart)',
    deployments: { 'tenant-a': existing('tenant-a') },
    posts: [ added('tenant-a') ],
    check: function (r) {
      assert.strictEqual(restarts(r).length, 1, 'restarts');
      assert.strictEqual(stampOf(r, 'tenant-a'), undefined);
    },
  },
];

// ---- run ----------------------------------------------------------------

async function runCase (kind, dir, c) {
  var r = kind == 'dispatcher' ? await runDispatcher(dir, c) : await runController(dir, c);
  try {
    c.check(r);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message, out: r.out };
  }
}

async function main ( ) {
  var failures = 0;
  var suites = [ [ 'dispatcher', DISPATCHER_CASES ], [ 'controller', CONTROLLER_CASES ] ];
  var only = process.env.OPERATOR_WATCH_ONLY ? process.env.OPERATOR_WATCH_ONLY.split(',') : null;
  for (var s = 0; s < suites.length; s++) {
    var kind = suites[s][0];
    var cases = suites[s][1].filter(function (c) { return !only || only.indexOf(c.id) > -1; });
    for (var i = 0; i < cases.length; i++) {
      var c = cases[i];
      var r = await runCase(kind, SRC, c);
      console.log((r.ok ? 'ok     ' : 'FAIL   ') + c.id + ' ' + c.what + (r.ok ? '' : '\n         ' + r.message));
      if (!r.ok) {
        failures++;
        if (r.out) { console.log(r.out.join('').split('\n').slice(-25).map(function (l) { return '         | ' + l; }).join('\n')); }
      }
      if (CONTROL && c.control) {
        var k = await runCase(kind, CONTROL, c);
        console.log((k.ok ? 'FAIL   ' : 'ok     ') + c.id + ' control: fails on ' + path.basename(CONTROL) + (k.ok ? ' (it passed: the case does not catch the old behaviour)' : ': ' + k.message));
        if (k.ok) { failures++; }
      }
    }
  }
  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(failures ? failures + ' failed' : 'all passed');
  process.exit(failures ? 1 : 0);
}

main( ).catch(function (err) { console.error(err); process.exit(1); });
