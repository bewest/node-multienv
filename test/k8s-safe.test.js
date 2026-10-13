#!/usr/bin/env node
'use strict';
// lib/k8s-safe.js (OPS-039, D-009): nothing it returns may carry the token
// that @kubernetes/client-node 0.x puts on its result and error objects.
// Plain script (node 16 has no node:test); also runs under node --test.

var assert = require('assert');
var util = require('util');
var safe = require('../lib/k8s-safe');

var TOKEN = 'k8ssafe-fake-token';

// shaped like the `request` IncomingMessage the 0.x client hands back
function fakeResponse (statusCode, body) {
  var request = { uri: { href: 'https://127.0.0.1:6443/api/v1/namespaces/default/configmaps/x' }, method: 'GET',
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + TOKEN } };
  return {
    statusCode: statusCode, body: body, headers: { 'content-type': 'application/json' },
    request: request,
    req: { _header: 'GET /api/v1/namespaces/default/configmaps/x HTTP/1.1\r\nAuthorization: Bearer ' + TOKEN + '\r\n\r\n' },
    toJSON: function ( ) { return { statusCode: statusCode, body: body, headers: this.headers, request: request }; },
  };
}

function fakeHttpError (statusCode, body) {
  var err = new Error('HTTP request failed');
  err.response = fakeResponse(statusCode, body);
  err.body = body;
  err.statusCode = statusCode;
  err.name = 'HttpError';
  return err;
}

function clean (label, v) {
  var text = JSON.stringify(v) + '\n' + util.inspect(v, { depth: null, showHidden: true });
  assert.ok(text.indexOf(TOKEN) === -1, label + ' holds the token: ' + text);
}

var status404 = { kind: 'Status', apiVersion: 'v1', metadata: { }, status: 'Failure', message: 'configmaps "x" not found', reason: 'NotFound', details: { name: 'x', kind: 'configmaps' }, code: 404 };
var e404 = fakeHttpError(404, status404);
// the fixture itself must leak, or the test proves nothing
assert.ok(JSON.stringify(e404).indexOf(TOKEN) > -1, 'fixture should leak via JSON');

var out = safe.error(e404);
clean('error()', out);
assert.ok(out instanceof Error);
assert.strictEqual(out.statusCode, 404);
assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), {
  name: 'HttpError', statusCode: 404, code: 'NotFound', message: 'configmaps "x" not found', body: status404,
});
assert.strictEqual(String(out), 'HttpError: configmaps "x" not found');

clean('summary()', safe.summary(e404));
assert.deepStrictEqual(safe.summary(e404), { name: 'HttpError', code: 'NotFound', statusCode: 404, message: 'configmaps "x" not found' });

// non-JSON error body, extra Status fields dropped
var odd = fakeHttpError(502, '<html>bad gateway</html>');
clean('error(502)', safe.error(odd));
assert.strictEqual(safe.error(odd).body, '<html>bad gateway</html>');
var extra = fakeHttpError(403, Object.assign({ leaked: 'Bearer ' + TOKEN }, status404, { code: 403, reason: 'Forbidden' }));
clean('error(extra Status fields)', safe.error(extra));

// connection errors keep restify's 500 Internal path: no statusCode
var conn = new Error('connect ECONNREFUSED 127.0.0.1:6443');
conn.code = 'ECONNREFUSED';
conn.options = { headers: { Authorization: 'Bearer ' + TOKEN } };
var cOut = safe.error(conn);
clean('error(conn)', cOut);
assert.strictEqual(cOut.statusCode, undefined);
assert.strictEqual(String(cOut), 'Error: connect ECONNREFUSED 127.0.0.1:6443');
clean('summary(conn)', safe.summary(conn));

// resolved results
var list = { kind: 'List', apiVersion: 'v1', metadata: { resourceVersion: '7' }, items: [ ] };
var result = { response: fakeResponse(200, list), body: list };
assert.ok(JSON.stringify(result).indexOf(TOKEN) > -1, 'fixture should leak via JSON');
clean('wrapped()', safe.wrapped(result));
assert.deepStrictEqual(safe.wrapped(result), { body: list });
assert.strictEqual(safe.body(result), list);
clean('summary_result()', safe.summary_result(result));
assert.deepStrictEqual(safe.summary_result(result), { statusCode: 200, kind: 'List', name: undefined, resourceVersion: '7' });

// watch ERROR events
clean('summary(watch)', safe.summary({ type: 'ERROR', object: { kind: 'Status', code: 410, reason: 'Expired', message: 'too old' } }));
assert.deepStrictEqual(safe.summary({ type: 'ERROR', object: { kind: 'Status', code: 410, reason: 'Expired', message: 'too old' } }),
  { code: 'Expired', statusCode: 410, message: 'too old' });

// fail(next)
var got;
safe.fail(function (e) { got = e; })(e404);
clean('fail()', got);
assert.strictEqual(got.statusCode, 404);

console.log('ok - lib/k8s-safe.js: no token in errors, summaries or results');
