#!/usr/bin/env node
'use strict';
// OPS-039: the inspector (k8s-inspector.js, MULTIENV_API inspectors:3000) and
// the deployment controller (k8s-deployment-controller.js) must never send or
// log the Kubernetes service-account token.
//
// Runs test/request-matrix.js for those two services against the fake
// Kubernetes API, once with a kubeconfig (MULTIENV_K8S_AUTH=local) and, when
// running as root in a throwaway container, once the in-cluster way
// (loadFromCluster with a fake token file). Fails when any response body,
// restify audit line or other output line holds the fake token, or when a
// response status differs from the prod (7deafde) baseline below.
//
//   node test/k8s-token-leak.test.js            (plain script; also runs under node --test)
//   K8S_LEAK_INCLUSTER=0 ... to skip the in-cluster pass
//   K8S_LEAK_AUDIT=0 ... to not fail on audit-log leaks (restify 11, OPS-040)
//
// Uses fixed ports (8500, 8001, 18001, 1282x): run it inside the image, never
// next to another matrix run. Synthetic data only.

var path = require('path');
var fs = require('fs');
var os = require('os');
var child_process = require('child_process');

var MATRIX = path.join(__dirname, 'request-matrix.js');

// Response status per case on prod 7deafde (restify 8). The fix must not
// change any of them.
var EXPECTED_STATUS = {
  i01: 200, i02: 404, i03: 200, i04: 200, i05: 404, i06: 200, i07: 200, i08: 200,
  i09: 200, i10: 200, i11: 200, i12: 200, i13: 200, i14: 404, i15: 400, i16: 404,
  c01: 200, c02: 200, c03: 500, c04: 200, c05: 404, c06: 500, c07: 200, c08: 200,
  c09: 200, c10: 404, c11: 200, c12: 200, c13: 200, c14: 200, c15: 204, c16: 200,
  c17: 200, c18: 200, c19: 200, c20: 204, c21: 200, c22: 200, c23: 200, c24: 404,
};

function runMatrix (incluster) {
  var out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'k8stoken-')), 'matrix.json');
  var env = Object.assign({ }, process.env, { MATRIX_ONLY: 'inspector,controller', MATRIX_OUT: out });
  if (incluster) { env.MATRIX_K8S_INCLUSTER = '1'; } else { delete env.MATRIX_K8S_INCLUSTER; }
  var r = child_process.spawnSync(process.execPath, [ MATRIX ], { env: env, stdio: [ 'ignore', 'ignore', 'inherit' ], timeout: 240000 });
  if (r.status !== 0 || !fs.existsSync(out)) {
    throw new Error('request-matrix failed: status ' + r.status + ' signal ' + r.signal);
  }
  return JSON.parse(fs.readFileSync(out));
}

function check (label, m) {
  var failures = [ ];
  var checkAudit = process.env.K8S_LEAK_AUDIT != '0';
  m.cases.forEach(function (c) {
    if (c.error) { failures.push(c.id + ': ' + c.error); return; }
    if (c.leaks_k8s_token) { failures.push(c.id + ' ' + c.method + ' ' + c.path + ': token in response body'); }
    if (c.audit && c.audit.leaks_k8s_token) {
      (checkAudit ? failures : [ ]).push(c.id + ' ' + c.method + ' ' + c.path + ': token in audit log line');
      if (!checkAudit) { console.log('# ' + label + ' ' + c.id + ': token in audit log line (not failing, K8S_LEAK_AUDIT=0)'); }
    }
    if (c.id in EXPECTED_STATUS && c.status !== EXPECTED_STATUS[c.id]) {
      failures.push(c.id + ' ' + c.method + ' ' + c.path + ': status ' + c.status + ', 7deafde gave ' + EXPECTED_STATUS[c.id]);
    }
  });
  Object.keys(EXPECTED_STATUS).forEach(function (id) {
    if (!m.cases.some(function (c) { return c.id == id; })) { failures.push(id + ': case missing'); }
  });
  Object.keys(m.log_leaks || { }).forEach(function (svc) {
    failures.push(svc + ': token in ' + m.log_leaks[svc] + ' log line(s)');
  });
  var cases = m.cases.length;
  if (failures.length) {
    console.log('not ok - ' + label + ' (' + m.k8s_auth + ', node ' + m.versions.node + ', restify ' + m.versions.restify + '): ' + failures.length + ' failure(s)');
    failures.forEach(function (f) { console.log('  ' + f); });
  } else {
    console.log('ok - ' + label + ' (' + m.k8s_auth + ', node ' + m.versions.node + ', restify ' + m.versions.restify + '): ' + cases + ' cases, no token in responses or logs, statuses match 7deafde');
  }
  return failures.length;
}

var failed = 0;
failed += check('kubeconfig', runMatrix(false));
var canInCluster = typeof process.getuid == 'function' && process.getuid( ) === 0;
if (process.env.K8S_LEAK_INCLUSTER == '0' || !canInCluster) {
  console.log('# skipped in-cluster pass (needs root in a throwaway container to write the service-account token path)');
} else {
  failed += check('in-cluster', runMatrix(true));
}
process.exit(failed ? 1 : 0);
