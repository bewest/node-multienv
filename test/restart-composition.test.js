
// The rolling-restart patch on /sync/updates carries two optional parts:
// pod-healthcheck adoption (lib/tenant-healthcheck.js) and the per-tenant
// Nightscout image (lib/nightscout-image.js).  Both must survive together,
// including the fallback after adoption fails.  Fakes only; run in node:16.
//
// Negative control: drop `.concat(extra(last))` from the fallback in
// restart_deployment and "fallback keeps the image change" fails.

var assert = require('assert');
var http = require('http');
var hc = require('../lib/tenant-healthcheck');
var configure = require('../k8s-deployment-controller');

var IMAGE = 'nightscout/cgm-remote-monitor:latest_dev@sha256:' + 'ab12'.repeat(16);
var cases = [ ];
function test (name, fn) { cases.push({ name: name, fn: fn }); }

function deployment ( ) {
  return {
    metadata: { name: 'tenant-a', resourceVersion: '100' },
    spec: { template: {
      metadata: { annotations: { 'managed-by': 'x' }, labels: { tenant: 'tenant-a' } },
      spec: { containers: [ { name: 'nightscout', image: 'nightscout/cgm-remote-monitor:latest' } ] }
    } }
  };
}

function tenant_configmap ( ) {
  return { metadata: { name: 'tenant-a', annotations: { 'ns.mdn.io/nightscout-image': IMAGE } } };
}

// RFC 6902 subset: add, replace, remove, test
function apply (doc, ops) {
  doc = JSON.parse(JSON.stringify(doc));
  ops.forEach(function (op) {
    var parts = op.path.split('/').slice(1).map(function (p) { return p.replace(/~1/g, '/').replace(/~0/g, '~'); });
    var key = parts.pop();
    var parent = parts.reduce(function (o, k) { if (o[k] === undefined) throw new Error('missing ' + op.path); return o[k]; }, doc);
    if (op.op == 'test') { if (JSON.stringify(parent[key]) !== JSON.stringify(op.value)) throw new Error('test failed ' + op.path); }
    else if (op.op == 'remove') { if (Array.isArray(parent)) parent.splice(+key, 1); else delete parent[key]; }
    else if (Array.isArray(parent) && key == '-') parent.push(op.value);
    else if (Array.isArray(parent) && op.op == 'add') parent.splice(+key, 0, op.value);
    else parent[key] = op.value;
  });
  return doc;
}

function cluster (fail_guarded) {
  var state = { d: deployment( ), patches: [ ] };
  state.appsApi = {
    readNamespacedDeployment: function ( ) { return Promise.resolve({ body: JSON.parse(JSON.stringify(state.d)) }); },
    patchNamespacedDeployment: function (name, ns, patch) {
      state.patches.push(patch);
      if (fail_guarded && patch[0].op == 'test') {
        fail_guarded--;
        var e = new Error('injected'); e.statusCode = 422; return Promise.reject(e);
      }
      state.d = apply(state.d, patch);
      state.d.metadata.resourceVersion = String(+state.d.metadata.resourceVersion + 1);
      return Promise.resolve({ body: state.d });
    }
  };
  return state;
}

function post_update (state, env) {
  var server = configure({
    name: 'test', appsApi: state.appsApi, k8s: { }, consul: { },
    MULTIENV_K8S_NAMESPACE: 'default', MULTIENV_HEALTH_CHECK_SERVICE: 'http://c:3000/',
    default: { deployment: { annotations: { }, labels: { } }, configmap: { annotations: { }, labels: { } } },
    healthcheck: hc.config(env)
  });
  return new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); }).then(function ( ) {
    return new Promise(function (resolve, reject) {
      var payload = JSON.stringify({ type: 'MODIFIED', object: tenant_configmap( ) });
      var req = http.request({ host: '127.0.0.1', port: server.address( ).port, method: 'POST', path: '/sync/updates',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, function (res) {
        res.resume( ); res.on('end', function ( ) { server.close( ); resolve(res.statusCode); });
      });
      req.on('error', reject);
      req.end(payload);
    });
  });
}

function containers (state) {
  return state.d.spec.template.spec.containers.map(function (c) { return c.name + '=' + c.image; });
}

test('legacy: one patch restarts and sets the image', function ( ) {
  var state = cluster(0);
  return post_update(state, { }).then(function (status) {
    assert.strictEqual(status, 200);
    assert.strictEqual(state.patches.length, 1);
    assert.deepStrictEqual(containers(state), [ 'nightscout=' + IMAGE ]);
    assert.ok(state.d.spec.template.metadata.annotations['updated-at']);
  });
});

test('pod mode: one guarded patch restarts, adopts and sets the image', function ( ) {
  var state = cluster(0);
  return post_update(state, { MULTIENV_TENANT_HEALTHCHECK: 'pod' }).then(function (status) {
    assert.strictEqual(status, 200);
    assert.strictEqual(state.patches.length, 1);
    assert.strictEqual(state.patches[0][0].op, 'test');
    assert.deepStrictEqual(containers(state), [ 'nightscout=' + IMAGE, 'pod-healthcheck=busybox:1.36.1' ]);
    assert.strictEqual(state.d.spec.template.metadata.annotations['ns.mdn.io/nightscout-image'], IMAGE);
  });
});

test('pod mode: fallback keeps the image change when adoption keeps failing', function ( ) {
  var state = cluster(2);
  return post_update(state, { MULTIENV_TENANT_HEALTHCHECK: 'pod' }).then(function (status) {
    assert.strictEqual(status, 200);
    assert.strictEqual(state.patches.length, 3);
    assert.deepStrictEqual(containers(state), [ 'nightscout=' + IMAGE ]);
  });
});

// RC1: F3's config-version stamp (multienv.t1pal.org/config-rv) composes
// with adoption and the image pin, on /sync/updates and on a re-addition.
var CONFIG_RV = 'multienv.t1pal.org/config-rv';

function post_sync (state, env, path, type, configmap) {
  var server = configure({
    name: 'test', appsApi: state.appsApi, k8s: { }, consul: { },
    MULTIENV_K8S_NAMESPACE: 'default', MULTIENV_HEALTH_CHECK_SERVICE: 'http://c:3000/',
    default: { deployment: { annotations: { }, labels: { } }, configmap: { annotations: { }, labels: { } } },
    healthcheck: hc.config(env)
  });
  return new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); }).then(function ( ) {
    return new Promise(function (resolve, reject) {
      var payload = JSON.stringify({ type: type, object: configmap });
      var req = http.request({ host: '127.0.0.1', port: server.address( ).port, method: 'POST', path: path,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, function (res) {
        res.resume( ); res.on('end', function ( ) { server.close( ); resolve(res.statusCode); });
      });
      req.on('error', reject);
      req.end(payload);
    });
  });
}

function versioned_configmap (rv) {
  var cm = tenant_configmap( );
  cm.metadata.resourceVersion = String(rv);
  cm.data = { WEB_NAME: 'tenant-a' };
  return cm;
}

function with_create (state) {
  state.appsApi.createNamespacedDeployment = function ( ) {
    var e = new Error('exists'); e.statusCode = 409; e.body = { code: 409 }; return Promise.reject(e);
  };
  return state;
}

test('RC1 pod mode: /sync/updates restarts, adopts, sets the image and stamps the version in one guarded patch', function ( ) {
  var state = cluster(0);
  return post_sync(state, { MULTIENV_TENANT_HEALTHCHECK: 'pod' }, '/sync/updates', 'MODIFIED', versioned_configmap(42)).then(function (status) {
    assert.strictEqual(status, 200);
    assert.strictEqual(state.patches.length, 1);
    assert.strictEqual(state.patches[0][0].op, 'test');
    assert.deepStrictEqual(containers(state), [ 'nightscout=' + IMAGE, 'pod-healthcheck=busybox:1.36.1' ]);
    assert.strictEqual(state.d.metadata.annotations[CONFIG_RV], '42');
    assert.ok(!(CONFIG_RV in state.d.spec.template.metadata.annotations), 'stamp on the pod template');
  });
});

test('RC1 pod mode: a re-addition with a changed version restarts, adopts, sets the image and moves the stamp', function ( ) {
  var state = with_create(cluster(0));
  state.d.metadata.annotations = { [CONFIG_RV]: '41' };
  return post_sync(state, { MULTIENV_TENANT_HEALTHCHECK: 'pod' }, '/sync/additions', 'ADDED', versioned_configmap(42)).then(function (status) {
    assert.strictEqual(status, 200);
    assert.strictEqual(state.patches.length, 1);
    assert.strictEqual(state.patches[0][0].op, 'test');
    assert.deepStrictEqual(containers(state), [ 'nightscout=' + IMAGE, 'pod-healthcheck=busybox:1.36.1' ]);
    assert.strictEqual(state.d.metadata.annotations[CONFIG_RV], '42');
    assert.ok(state.d.spec.template.metadata.annotations['updated-at']);
  });
});

test('RC1 pod mode: a re-addition with the same version patches nothing (no restart, no adoption)', function ( ) {
  var state = with_create(cluster(0));
  state.d.metadata.annotations = { [CONFIG_RV]: '42' };
  return post_sync(state, { MULTIENV_TENANT_HEALTHCHECK: 'pod' }, '/sync/additions', 'ADDED', versioned_configmap(42)).then(function (status) {
    assert.strictEqual(status, 200);
    assert.strictEqual(state.patches.length, 0);
  });
});

test('RC1 pod mode: an unstamped Deployment is stamped on re-addition without a restart or adoption', function ( ) {
  var state = with_create(cluster(0));
  return post_sync(state, { MULTIENV_TENANT_HEALTHCHECK: 'pod' }, '/sync/additions', 'ADDED', versioned_configmap(42)).then(function (status) {
    assert.strictEqual(status, 200);
    assert.strictEqual(state.patches.length, 1);
    assert.deepStrictEqual(state.patches[0].map(function (op) { return op.path; }), [ '/metadata/annotations' ]);
    assert.strictEqual(state.d.metadata.annotations[CONFIG_RV], '42');
    assert.deepStrictEqual(containers(state), [ 'nightscout=nightscout/cgm-remote-monitor:latest' ]);
  });
});

(function run (i, failed) {
  if (i >= cases.length) {
    console.log(failed ? (failed + ' of ' + cases.length + ' failed') : ('all ' + cases.length + ' passed'));
    process.exit(failed ? 1 : 0);
  }
  Promise.resolve( ).then(cases[i].fn).then(function ( ) {
    console.log('ok   ' + cases[i].name); run(i + 1, failed);
  }, function (err) {
    console.log('FAIL ' + cases[i].name + '\n     ' + String(err && err.stack || err).split('\n').slice(0, 3).join('\n     '));
    run(i + 1, failed + 1);
  });
})(0, 0);
