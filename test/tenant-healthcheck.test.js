
// Tenant health checks (lib/tenant-healthcheck.js and its wiring in
// k8s-deployment-controller.js).  No cluster, no consul: k8s and consul are
// fakes.  Run: node test/tenant-healthcheck.test.js
//
// Negative controls (each was run and fails):
// - default MULTIENV_TENANT_HEALTHCHECK to 'pod': "defaults: legacy ...",
//   "legacy template equals 7deafde" and the legacy /sync/* cases fail;
// - build the pod URL from config instead of the pod spec: "style=pod alone
//   never yields a pod URL" and the named-port cases fail;
// - give the sidecar envFrom: the sidecar spec case fails;
// - drop the resourceVersion guard: the concurrent adoption cases fail.

var assert = require('assert');
var http = require('http');
var hc = require('../lib/tenant-healthcheck');
var createServiceCheck = require('consul/lib/utils').createServiceCheck;

var LEGACY_SERVICE = 'http://multienv-deployment-controller.service.consul.:3000/';
var cases = [ ];
function test (name, fn) { cases.push({ name: name, fn: fn }); }

function pod (opts) {
  opts = opts || { };
  var containers = [ { name: 'nightscout', image: 'nightscout/cgm-remote-monitor:latest' } ];
  if (opts.sidecar) containers.push(hc.sidecar_container(hc.config(opts.env || { })));
  if (opts.unnamedPort) containers.push({ name: hc.SIDECAR_NAME, ports: [ { containerPort: 1338 } ] });
  return {
    metadata: { name: 'tenant-a-5d9f-xk2lp', namespace: 'default', uid: '0b6c2a8e-1111-4c2d-9e7f-aaaaaaaaaaaa', labels: { tenant: 'tenant-a' } },
    spec: { containers: containers },
    status: { phase: 'Running', podIP: '10.244.1.7' }
  };
}

// The checks exactly as 7deafde built them (k8s-deployment-controller.js:552-585).
function checks_7deafde (p, service) {
  var url = require('url');
  var host = p.status.podIP;
  var svc = url.parse(service);
  return [
    { name: 'EndpointAvailable', ttl: '30s', interval: '10s',
      http: url.format({ protocol: 'http', hostname: host, port: 1337, pathname: '/api/v1/status.txt' }),
      deregister_critical_service_after: '20s' },
    { name: 'ValidPodName', ttl: '10s', interval: '5s',
      http: url.format({ protocol: svc.protocol, hostname: svc.hostname, port: svc.port, pathname: ('/healthchecks/pod/' + p.metadata.labels.tenant + '/assigned/podIP/' + host) }),
      failures_before_critical: 1, deregister_critical_service_after: '5s' }
  ];
}

function wire (checks) { return checks.map(createServiceCheck); }

// Minimal RFC 6902 subset (add, remove, test) for checking our patches.
function apply_patch (doc, ops) {
  doc = JSON.parse(JSON.stringify(doc));
  ops.forEach(function (op) {
    var parts = op.path.split('/').slice(1);
    var key = parts.pop();
    var parent = parts.reduce(function (o, k) {
      if (o[k] === undefined) throw new Error('missing path ' + op.path);
      return o[k];
    }, doc);
    if (op.op == 'add') {
      if (Array.isArray(parent)) {
        if (key == '-') parent.push(op.value); else parent.splice(+key, 0, op.value);
      } else parent[key] = op.value;
    } else if (op.op == 'remove') {
      if (Array.isArray(parent)) parent.splice(+key, 1); else delete parent[key];
    } else if (op.op == 'test') {
      assert.deepStrictEqual(parent[key], op.value, 'test op failed at ' + op.path);
    } else throw new Error('unsupported op ' + op.op);
  });
  return doc;
}

function deployment (spec, opts) {
  opts = opts || { };
  var meta = { labels: { tenant: opts.tenant === undefined ? 'tenant-a' : opts.tenant } };
  if (opts.tenant === null) delete meta.labels.tenant;
  if (!opts.noAnnotations) meta.annotations = { 'managed-by': 'x' };
  return {
    metadata: { name: 'tenant-a', resourceVersion: '100' },
    spec: { template: { metadata: meta, spec: spec } }
  };
}

// ---------------------------------------------------------------- config

test('defaults: legacy, 7deafde timings', function () {
  var cfg = hc.config({ });
  assert.strictEqual(cfg.style, 'legacy');
  assert.deepStrictEqual(cfg.endpoint, { interval: '10s', timeout: '', deregister: '20s' });
  assert.deepStrictEqual(cfg.validpod, { interval: '5s', timeout: '', deregister: '5s' });
  assert.strictEqual(cfg.port, 1338);
});

test('an initially passing ValidPodName cannot be configured (D-011 §4)', function () {
  var cfg = hc.config({ MULTIENV_CONSUL_VALIDPOD_INITIAL_STATUS: 'passing' });
  var w = wire(hc.consul_checks(pod(), cfg, LEGACY_SERVICE));
  assert.strictEqual(w[0].Status, undefined);
  assert.strictEqual(w[1].Status, undefined);
});

test('unknown style falls back to legacy', function () {
  assert.strictEqual(hc.config({ MULTIENV_TENANT_HEALTHCHECK: 'Pods' }).style, 'legacy');
  assert.strictEqual(hc.config({ MULTIENV_TENANT_HEALTHCHECK: 'POD' }).style, 'pod');
});

test('refuses the Nightscout port and malformed ports at boot', function () {
  assert.throws(function () { hc.config({ MULTIENV_TENANT_HEALTHCHECK_PORT: '1337' }); });
  assert.throws(function () { hc.config({ MULTIENV_TENANT_HEALTHCHECK_PORT: 'abc' }); });
  assert.throws(function () { hc.config({ MULTIENV_TENANT_HEALTHCHECK_PORT: '1338abc' }); });
  assert.throws(function () { hc.config({ MULTIENV_TENANT_HEALTHCHECK_PORT: '70000' }); });
});

// ---------------------------------------------------------------- consul checks

test('defaults reproduce 7deafde on the wire', function () {
  var p = pod();
  assert.deepStrictEqual(wire(hc.consul_checks(p, hc.config({ }), LEGACY_SERVICE)), wire(checks_7deafde(p, LEGACY_SERVICE)));
  assert.strictEqual(hc.consul_checks(p, hc.config({ }), LEGACY_SERVICE)[1].http,
    'http://multienv-deployment-controller.service.consul.:3000/healthchecks/pod/tenant-a/assigned/podIP/10.244.1.7');
});

test('style=pod alone never yields a pod URL (OPS-003)', function () {
  var checks = hc.consul_checks(pod(), hc.config({ MULTIENV_TENANT_HEALTHCHECK: 'pod' }), LEGACY_SERVICE);
  assert.ok(/\/assigned\/podIP\//.test(checks[1].http), checks[1].http);
});

test('sidecar without the named port is not trusted', function () {
  var checks = hc.consul_checks(pod({ unnamedPort: true }), hc.config({ }), LEGACY_SERVICE);
  assert.ok(/\/assigned\/podIP\//.test(checks[1].http), checks[1].http);
});

test('pod with sidecar gets the pod-local URL, whatever the style', function () {
  ['legacy', 'pod'].forEach(function (style) {
    var p = pod({ sidecar: true });
    var checks = hc.consul_checks(p, hc.config({ MULTIENV_TENANT_HEALTHCHECK: style }), LEGACY_SERVICE);
    assert.strictEqual(checks[1].http, 'http://10.244.1.7:1338/healthchecks/pod/tenant-a/assigned/POD_UID/0b6c2a8e-1111-4c2d-9e7f-aaaaaaaaaaaa');
  });
});

test('pod URL follows the port the pod declares, not the controller config', function () {
  var p = pod({ sidecar: true, env: { MULTIENV_TENANT_HEALTHCHECK_PORT: '8080' } });
  var checks = hc.consul_checks(p, hc.config({ }), LEGACY_SERVICE);
  assert.ok(checks[1].http.indexOf('http://10.244.1.7:8080/') === 0, checks[1].http);
});

test('timing overrides reach the wire', function () {
  var cfg = hc.config({
    MULTIENV_CONSUL_VALIDPOD_INTERVAL: '10s', MULTIENV_CONSUL_VALIDPOD_DEREGISTER_AFTER: '1m',
    MULTIENV_CONSUL_VALIDPOD_TIMEOUT: '2s',
    MULTIENV_CONSUL_ENDPOINT_INTERVAL: '15s', MULTIENV_CONSUL_ENDPOINT_TIMEOUT: '3s'
  });
  var w = wire(hc.consul_checks(pod(), cfg, LEGACY_SERVICE));
  assert.strictEqual(w[0].Interval, '15s');
  assert.strictEqual(w[0].Timeout, '3s');
  assert.strictEqual(w[1].Interval, '10s');
  assert.strictEqual(w[1].Timeout, '2s');
  assert.strictEqual(w[1].DeregisterCriticalServiceAfter, '1m');
});

// ---------------------------------------------------------------- sidecar spec

test('sidecar: no envFrom, hardened, Downward API env, named port, no probes', function () {
  var c = hc.sidecar_container(hc.config({ }));
  assert.strictEqual(c.envFrom, undefined);
  assert.strictEqual(c.livenessProbe, undefined);
  assert.strictEqual(c.readinessProbe, undefined);
  assert.strictEqual(c.startupProbe, undefined);
  assert.strictEqual(c.imagePullPolicy, 'IfNotPresent');
  assert.strictEqual(c.securityContext.runAsUser, 65534);
  assert.deepStrictEqual(hc.sidecar_volume(), { name: 'pod-healthcheck-www', emptyDir: { sizeLimit: '1Mi' } });
  assert.strictEqual(c.securityContext.runAsNonRoot, true);
  assert.strictEqual(c.securityContext.readOnlyRootFilesystem, true);
  assert.strictEqual(c.securityContext.allowPrivilegeEscalation, false);
  assert.deepStrictEqual(c.securityContext.capabilities, { drop: ['ALL'] });
  assert.deepStrictEqual(c.ports, [ { containerPort: 1338, name: 'healthcheck' } ]);
  var env = {}; c.env.forEach(function (e) { env[e.name] = e; });
  assert.strictEqual(env.TENANT.valueFrom.fieldRef.fieldPath, "metadata.labels['tenant']");
  assert.strictEqual(env.POD_UID.valueFrom.fieldRef.fieldPath, 'metadata.uid');
  assert.strictEqual(env.PORT.value, '1338');
  assert.deepStrictEqual(c.resources, { requests: { cpu: '1m', memory: '4Mi' }, limits: { cpu: '20m', memory: '32Mi' } });
});

test('inject is idempotent', function () {
  var spec = { containers: [ { name: 'nightscout' } ] };
  hc.inject(spec, hc.config({ }));
  hc.inject(spec, hc.config({ }));
  assert.deepStrictEqual(spec.containers.map(function (c) { return c.name; }), ['nightscout', 'pod-healthcheck']);
  assert.deepStrictEqual(spec.volumes, [ hc.sidecar_volume() ]);
});

// ---------------------------------------------------------------- patches

test('adopt_ops on a 7deafde deployment (no volumes) then unadopt round-trips', function () {
  var d = deployment({ containers: [ { name: 'nightscout' } ] });
  var ops = hc.adopt_ops(d, hc.config({ }));
  assert.deepStrictEqual(ops.map(function (o) { return o.op + ' ' + o.path; }),
    ['add /spec/template/spec/containers/-', 'add /spec/template/spec/volumes']);
  var adopted = apply_patch(d, ops);
  assert.strictEqual(hc.sidecar_port(adopted.spec.template.spec), 1338);
  assert.deepStrictEqual(hc.adopt_ops(adopted, hc.config({ })), [ ]);
  var back = apply_patch(adopted, hc.unadopt_ops(adopted));
  assert.deepStrictEqual(back.spec.template.spec.containers, d.spec.template.spec.containers);
  assert.deepStrictEqual(back.spec.template.spec.volumes, [ ]);
});

test('adopt_ops appends to existing volumes', function () {
  var d = deployment({ containers: [ { name: 'nightscout' } ], volumes: [ { name: 'other', emptyDir: {} } ] });
  var adopted = apply_patch(d, hc.adopt_ops(d, hc.config({ })));
  assert.deepStrictEqual(adopted.spec.template.spec.volumes.map(function (v) { return v.name; }), ['other', 'pod-healthcheck-www']);
  var back = apply_patch(adopted, hc.unadopt_ops(adopted));
  assert.deepStrictEqual(back.spec.template.spec, d.spec.template.spec);
});

test('unadopt_ops is guarded by test ops and is empty without a sidecar', function () {
  assert.deepStrictEqual(hc.unadopt_ops(deployment({ containers: [ { name: 'nightscout' } ] })), [ ]);
  var adopted = apply_patch(deployment({ containers: [ { name: 'nightscout' } ] }),
    hc.adopt_ops(deployment({ containers: [ { name: 'nightscout' } ] }), hc.config({ })));
  var ops = hc.unadopt_ops(adopted);
  assert.strictEqual(ops[0].op, 'test');
  assert.strictEqual(ops[2].op, 'test');
});

test('adopt_ops tolerates a body without a pod template', function () {
  assert.deepStrictEqual(hc.adopt_ops({ metadata: { } }, hc.config({ })), [ ]);
  assert.deepStrictEqual(hc.unadopt_ops({ }), [ ]);
});

test('restart_and_adopt_ops: guarded by resourceVersion; a stale second adoption fails', function () {
  var d = deployment({ containers: [ { name: 'nightscout' } ] });
  var first = hc.restart_and_adopt_ops(d, 'tenant-a', hc.config({ }));
  var second = hc.restart_and_adopt_ops(d, 'tenant-a', hc.config({ }));
  assert.deepStrictEqual(first[0], { op: 'test', path: '/metadata/resourceVersion', value: '100' });
  var after = apply_patch(d, first);
  after.metadata.resourceVersion = '101';
  assert.throws(function () { apply_patch(after, second); });
  // and from a fresh read there is nothing to adopt: restart only, unguarded
  assert.deepStrictEqual(hc.restart_and_adopt_ops(after, 'tenant-a', hc.config({ })).map(function (o) { return o.op; }), ['add']);
});

test('restart_and_adopt_ops: no sidecar for a deployment without tenant=<name>', function () {
  var d = deployment({ containers: [ { name: 'nightscout' } ] }, { tenant: null });
  assert.strictEqual(hc.restart_and_adopt_ops(d, 'tenant-a', hc.config({ })).length, 1);
  var other = deployment({ containers: [ { name: 'nightscout' } ] }, { tenant: 'tenant-z' });
  assert.strictEqual(hc.restart_and_adopt_ops(other, 'tenant-a', hc.config({ })).length, 1);
});

test('restart_ops works when the pod template has no annotations', function () {
  var d = deployment({ containers: [ { name: 'nightscout' } ] }, { noAnnotations: true });
  var after = apply_patch(d, hc.restart_ops(d));
  assert.ok(after.spec.template.metadata.annotations['updated-at']);
});

// ---------------------------------------------------------------- controller wiring

function fake_cluster (existing) {
  var calls = { patches: [ ], registrations: [ ], creates: [ ] };
  var deployments = { };
  (existing || [ ]).forEach(function (d) { deployments[d.metadata.name] = d; });
  function not_found ( ) {
    var err = new Error('HTTP request failed');
    err.statusCode = 404;
    err.response = { statusCode: 404, body: { reason: 'NotFound' }, request: { headers: { Authorization: 'Bearer FAKE-SA-TOKEN' } } };
    return err;
  }
  var appsApi = {
    readNamespacedDeployment: function (name) {
      return deployments[name] ? Promise.resolve({ body: JSON.parse(JSON.stringify(deployments[name])) }) : Promise.reject(not_found());
    },
    createNamespacedDeployment: function (ns, body) {
      calls.creates.push(body);
      if (calls.create_error) return Promise.reject(calls.create_error);
      if (deployments[body.metadata.name]) {
        var err = new Error('conflict'); err.statusCode = 409; err.response = { statusCode: 409, body: { reason: 'AlreadyExists' } };
        return Promise.reject(err);
      }
      deployments[body.metadata.name] = body;
      return Promise.resolve({ body: body });
    },
    patchNamespacedDeployment: function (name, ns, patch) {
      calls.patches.push({ name: name, patch: patch });
      if (calls.before_patch) calls.before_patch(name, patch);
      if (calls.fail_guarded && patch[0] && patch[0].op == 'test' && patch[0].path == '/metadata/resourceVersion') {
        calls.fail_guarded--;
        var e = new Error('injected'); e.statusCode = 422; e.response = { statusCode: 422, request: { headers: { Authorization: 'Bearer FAKE-SA-TOKEN' } } };
        return Promise.reject(e);
      }
      try {
        deployments[name] = apply_patch(deployments[name], patch);
      } catch (err) {
        var e2 = new Error('patch failed'); e2.statusCode = 422; e2.response = { statusCode: 422, request: { headers: { Authorization: 'Bearer FAKE-SA-TOKEN' } } };
        return Promise.reject(e2);
      }
      deployments[name].metadata.resourceVersion = String(+(deployments[name].metadata.resourceVersion || 0) + 1);
      return Promise.resolve({ body: deployments[name] });
    }
  };
  var consul = { agent: { service: {
    register: function (insert, cb) { calls.registrations.push(insert); cb(null, { }); },
    deregister: function (id, cb) { cb(null, { }); }
  } } };
  return { appsApi: appsApi, consul: consul, calls: calls, deployments: deployments };
}

function controller (cluster, env) {
  var configure = require('../k8s-deployment-controller');
  return configure({
    name: 'test', appsApi: cluster.appsApi, consul: cluster.consul, k8s: { },
    MULTIENV_K8S_NAMESPACE: 'default', MULTIENV_HEALTH_CHECK_SERVICE: LEGACY_SERVICE,
    MULTIENV_TENANT_NODEPOOL_TARGET: 'pool', MULTIENV_TENANT_REQUESTS_ENABLE: true, MULTIENV_TENANT_LIMITS_ENABLE: true,
    requests: { cpu: '5m', memory: '120Mi' }, limits: { cpu: '500m', memory: '500Mi' },
    default: { deployment: { annotations: { 'managed-by': 'x' }, labels: { managed: 'multienv' } },
               configmap: { annotations: { }, labels: { } } },
    healthcheck: hc.config(env || { })
  });
}

function request (server, method, path, body) {
  return new Promise(function (resolve, reject) {
    var payload = body ? JSON.stringify(body) : '';
    var req = http.request({ host: '127.0.0.1', port: server.address().port, method: method, path: path,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, function (res) {
      var chunks = '';
      res.on('data', function (c) { chunks += c; });
      res.on('end', function () { resolve({ status: res.statusCode, body: chunks }); });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function with_server (cluster, env, fn) {
  var server = controller(cluster, env);
  return new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); })
    .then(function () { return fn(server); })
    .then(function (v) { server.close(); return v; }, function (e) { server.close(); throw e; });
}

function settle ( ) { return new Promise(function (r) { setTimeout(r, 50); }); }

test('controller: /consul/sync/updates registers 7deafde checks by default', function () {
  var cluster = fake_cluster();
  return with_server(cluster, { }, function (server) {
    var p = pod();
    return request(server, 'POST', '/consul/sync/updates', { type: 'MODIFIED', object: p }).then(function (res) {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(cluster.calls.registrations.length, 1);
      var insert = cluster.calls.registrations[0];
      assert.strictEqual(insert.id, p.metadata.uid);
      assert.strictEqual(insert.address, '10.244.1.7');
      assert.deepStrictEqual(insert.tags, ['tenant-a', 'tenant-a-default', 'tenant', 'backend']);
      assert.deepStrictEqual(wire(insert.checks), wire(checks_7deafde(p, LEGACY_SERVICE)));
    });
  });
});

test('controller: a pod without a tenant label is not registered', function () {
  var cluster = fake_cluster();
  return with_server(cluster, { }, function (server) {
    var p = pod(); delete p.metadata.labels.tenant;
    return request(server, 'POST', '/consul/sync/updates', { type: 'MODIFIED', object: p }).then(function (res) {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(cluster.calls.registrations.length, 0);
    });
  });
});

test('controller: registration of a pod with the sidecar uses the pod URL', function () {
  var cluster = fake_cluster();
  return with_server(cluster, { }, function (server) {
    return request(server, 'POST', '/consul/sync/updates', { type: 'MODIFIED', object: pod({ sidecar: true }) }).then(function () {
      assert.ok(/:1338\/healthchecks\/pod\/tenant-a\/assigned\/POD_UID\//.test(cluster.calls.registrations[0].checks[1].http));
    });
  });
});

test('controller: legacy /sync/updates patches only the restart annotation', function () {
  var cluster = fake_cluster([ deployment({ containers: [ { name: 'nightscout' } ] }) ]);
  return with_server(cluster, { }, function (server) {
    return request(server, 'POST', '/sync/updates', { type: 'MODIFIED', object: { metadata: { name: 'tenant-a' } } })
      .then(settle).then(function () {
        assert.strictEqual(cluster.calls.patches.length, 1);
        assert.deepStrictEqual(cluster.calls.patches[0].patch.map(function (o) { return o.path; }),
          ['/spec/template/metadata/annotations/updated-at']);
      });
  });
});

test('controller: pod-mode /sync/updates adopts the sidecar inside the restart', function () {
  var cluster = fake_cluster([ deployment({ containers: [ { name: 'nightscout' } ] }) ]);
  return with_server(cluster, { MULTIENV_TENANT_HEALTHCHECK: 'pod' }, function (server) {
    return request(server, 'POST', '/sync/updates', { type: 'MODIFIED', object: { metadata: { name: 'tenant-a' } } })
      .then(settle).then(function () {
        assert.strictEqual(cluster.calls.patches.length, 1);
        assert.strictEqual(hc.sidecar_port(cluster.deployments['tenant-a'].spec.template.spec), 1338);
      }).then(function () {
        // a second update restarts but does not add a second sidecar
        return request(server, 'POST', '/sync/updates', { type: 'MODIFIED', object: { metadata: { name: 'tenant-a' } } }).then(settle);
      }).then(function () {
        assert.strictEqual(cluster.calls.patches[1].patch.length, 1);
      });
  });
});

test('controller: pod-mode /sync/additions creates with sidecar, re-addition adopts', function () {
  var cluster = fake_cluster([ deployment({ containers: [ { name: 'nightscout' } ] }) ]);
  return with_server(cluster, { MULTIENV_TENANT_HEALTHCHECK: 'pod' }, function (server) {
    return request(server, 'POST', '/sync/additions', { type: 'ADDED', object: { metadata: { name: 'tenant-b' } } })
      .then(function (res) {
        assert.strictEqual(res.status, 200);
        assert.ok(hc.has_sidecar(cluster.calls.creates[0].spec.template.spec));
        return request(server, 'POST', '/sync/additions', { type: 'ADDED', object: { metadata: { name: 'tenant-a' } } });
      }).then(settle).then(function () {
        assert.strictEqual(cluster.calls.patches.length, 1);
        assert.ok(hc.has_sidecar(cluster.deployments['tenant-a'].spec.template.spec));
      });
  });
});

test('controller: legacy /sync/additions creates without sidecar, re-addition only restarts', function () {
  var cluster = fake_cluster([ deployment({ containers: [ { name: 'nightscout' } ] }) ]);
  return with_server(cluster, { }, function (server) {
    return request(server, 'POST', '/sync/additions', { type: 'ADDED', object: { metadata: { name: 'tenant-b' } } })
      .then(function () {
        assert.ok(!hc.has_sidecar(cluster.calls.creates[0].spec.template.spec));
        return request(server, 'POST', '/sync/additions', { type: 'ADDED', object: { metadata: { name: 'tenant-a' } } });
      }).then(settle).then(function () {
        assert.strictEqual(cluster.calls.patches[0].patch.length, 1);
      });
  });
});

test('controller: adopt/unadopt routes work in legacy mode and are idempotent', function () {
  var cluster = fake_cluster([ deployment({ containers: [ { name: 'nightscout' } ] }) ]);
  return with_server(cluster, { }, function (server) {
    return request(server, 'POST', '/healthchecks/pod/tenant-a/adopt').then(function (res) {
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(JSON.parse(res.body), { ok: true, name: 'tenant-a', changed: true, ops: 4 });
      return request(server, 'POST', '/healthchecks/pod/tenant-a/adopt');
    }).then(function (res) {
      assert.deepStrictEqual(JSON.parse(res.body), { ok: true, name: 'tenant-a', changed: false });
      return request(server, 'DELETE', '/healthchecks/pod/tenant-a/adopt');
    }).then(function (res) {
      assert.strictEqual(JSON.parse(res.body).changed, true);
      assert.ok(!hc.has_sidecar(cluster.deployments['tenant-a'].spec.template.spec));
      return request(server, 'DELETE', '/healthchecks/pod/tenant-a/adopt');
    }).then(function (res) {
      assert.strictEqual(JSON.parse(res.body).changed, false);
    });
  });
});

test('controller: adopt on a missing deployment returns a summary, never the k8s error (OPS-039)', function () {
  var cluster = fake_cluster();
  return with_server(cluster, { }, function (server) {
    return request(server, 'POST', '/healthchecks/pod/nope/adopt').then(function (res) {
      assert.strictEqual(res.status, 404);
      assert.deepStrictEqual(JSON.parse(res.body), { ok: false, name: 'nope', status: 404 });
      assert.ok(res.body.indexOf('FAKE-SA-TOKEN') < 0);
    });
  });
});

test('controller: legacy template equals 7deafde, field for field', function () {
  var cluster = fake_cluster();
  return with_server(cluster, { }, function (server) {
    return request(server, 'POST', '/sync/additions', { type: 'ADDED', object: { metadata: { name: 'tenant-b' } } }).then(function () {
      assert.deepStrictEqual(JSON.parse(JSON.stringify(cluster.calls.creates[0])), require('./fixtures/template-7deafde.json'));
    });
  });
});

test('controller: a terminating pod is not re-registered', function () {
  var cluster = fake_cluster();
  return with_server(cluster, { }, function (server) {
    var p = pod(); p.metadata.deletionTimestamp = '2026-10-08T00:00:00Z';
    return request(server, 'POST', '/consul/sync/updates', { type: 'MODIFIED', object: p }).then(function (res) {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(cluster.calls.registrations.length, 0);
    });
  });
});

test('controller: /sync/updates for a missing deployment answers 404, no token, no crash', function () {
  var cluster = fake_cluster();
  return with_server(cluster, { MULTIENV_TENANT_HEALTHCHECK: 'pod' }, function (server) {
    return request(server, 'POST', '/sync/updates', { type: 'MODIFIED', object: { metadata: { name: 'nope' } } }).then(function (res) {
      assert.strictEqual(res.status, 404);
      assert.ok(res.body.indexOf('FAKE-SA-TOKEN') < 0);
    });
  });
});

test('controller: create error without .response still restarts the existing deployment', function () {
  var cluster = fake_cluster([ deployment({ containers: [ { name: 'nightscout' } ] }) ]);
  cluster.calls.create_error = new Error('socket hang up');
  return with_server(cluster, { }, function (server) {
    return request(server, 'POST', '/sync/additions', { type: 'ADDED', object: { metadata: { name: 'tenant-a' } } }).then(function (res) {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(cluster.calls.patches.length, 1);
    });
  });
});

test('controller: concurrent adoption by another replica leaves one sidecar and still restarts', function () {
  var cluster = fake_cluster([ deployment({ containers: [ { name: 'nightscout' } ] }) ]);
  var raced = false;
  cluster.calls.before_patch = function (name) {
    if (raced) return;
    raced = true;   // another replica adopts between our read and our patch
    var d = cluster.deployments[name];
    cluster.deployments[name] = apply_patch(d, hc.adopt_ops(d, hc.config({ })));
    cluster.deployments[name].metadata.resourceVersion = '150';
  };
  return with_server(cluster, { MULTIENV_TENANT_HEALTHCHECK: 'pod' }, function (server) {
    return request(server, 'POST', '/sync/updates', { type: 'MODIFIED', object: { metadata: { name: 'tenant-a' } } }).then(function (res) {
      assert.strictEqual(res.status, 200);
      var names = cluster.deployments['tenant-a'].spec.template.spec.containers.map(function (c) { return c.name; });
      assert.deepStrictEqual(names, ['nightscout', 'pod-healthcheck']);
      assert.ok(cluster.deployments['tenant-a'].spec.template.metadata.annotations['updated-at']);
    });
  });
});

test('controller: if adoption keeps failing, the restart still happens', function () {
  var cluster = fake_cluster([ deployment({ containers: [ { name: 'nightscout' } ] }) ]);
  cluster.calls.fail_guarded = 2;
  return with_server(cluster, { MULTIENV_TENANT_HEALTHCHECK: 'pod' }, function (server) {
    return request(server, 'POST', '/sync/updates', { type: 'MODIFIED', object: { metadata: { name: 'tenant-a' } } }).then(function (res) {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(cluster.calls.patches.length, 3);
      assert.ok(!hc.has_sidecar(cluster.deployments['tenant-a'].spec.template.spec));
      assert.ok(cluster.deployments['tenant-a'].spec.template.metadata.annotations['updated-at']);
    });
  });
});

test('controller: adopt refuses a deployment that is not tenant=<name>', function () {
  var cluster = fake_cluster([ deployment({ containers: [ { name: 'nightscout' } ] }, { tenant: null }) ]);
  return with_server(cluster, { }, function (server) {
    return request(server, 'POST', '/healthchecks/pod/tenant-a/adopt').then(function (res) {
      assert.strictEqual(res.status, 422);
      assert.deepStrictEqual(JSON.parse(res.body), { ok: false, name: 'tenant-a', reason: 'not a tenant deployment' });
      assert.strictEqual(cluster.calls.patches.length, 0);
    });
  });
});

// ---------------------------------------------------------------- runner

(function run (i, failed) {
  if (i >= cases.length) {
    console.log(failed ? (failed + ' of ' + cases.length + ' failed') : ('all ' + cases.length + ' passed'));
    process.exit(failed ? 1 : 0);
  }
  var c = cases[i];
  Promise.resolve().then(c.fn).then(function () {
    console.log('ok   ' + c.name);
    run(i + 1, failed);
  }, function (err) {
    console.log('FAIL ' + c.name + '\n     ' + (err && err.stack || err).toString().split('\n').slice(0, 4).join('\n     '));
    run(i + 1, failed + 1);
  });
})(0, 0);
