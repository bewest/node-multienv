#!/usr/bin/env node
'use strict';
// Compare two request-matrix.js outputs case by case.
//   node test/matrix-diff.js old.json new.json [--samples]
// Exit status 1 when any status, header, body shape, process exit or audit
// line differs. Audit-log differences are printed grouped at the end.

var fs = require('fs');
var args = process.argv.slice(2);
var samples = args.indexOf('--samples') > -1;
args = args.filter(function (a) { return a[0] !== '-'; });
var A = JSON.parse(fs.readFileSync(args[0]));
var B = JSON.parse(fs.readFileSync(args[1]));

function j (v) { return v === undefined ? '(none)' : JSON.stringify(v); }
function index (r) { var o = { }; r.cases.forEach(function (c) { o[c.id] = c; }); return o; }
var a = index(A), b = index(B);
var ids = Object.keys(a).concat(Object.keys(b).filter(function (k) { return !(k in a); }));

console.log('old: ' + j(A.versions));
console.log('new: ' + j(B.versions));
console.log('');

var differing = 0;
var auditGroups = { };
ids.forEach(function (id) {
  var x = a[id] || { }, y = b[id] || { };
  var diffs = [ ];
  function cmp (label, p, q) { if (j(p) !== j(q)) { diffs.push('  ' + label + ': ' + j(p) + ' -> ' + j(q)); } }
  cmp('error', x.error, y.error);
  cmp('status', x.status, y.status);
  var hs = { };
  Object.keys(x.headers || { }).concat(Object.keys(y.headers || { })).forEach(function (h) { hs[h] = 1; });
  Object.keys(hs).sort( ).forEach(function (h) { cmp('header ' + h, (x.headers || { })[h], (y.headers || { })[h]); });
  cmp('body_kind', x.body_kind, y.body_kind);
  cmp('body_shape', x.body_shape, y.body_shape);
  if (samples || j(x.body_shape) === j(y.body_shape)) { cmp('body_sample', x.body_sample, y.body_sample); }
  cmp('process_exited', x.process_exited, y.process_exited);
  cmp('leaks_k8s_token (response)', x.leaks_k8s_token, y.leaks_k8s_token);
  var httpDiffs = diffs.length;
  var xa = x.audit || { }, ya = y.audit || { };
  cmp('audit.count', xa.count, ya.count);
  cmp('audit.leaks_k8s_token', xa.leaks_k8s_token, ya.leaks_k8s_token);
  cmp('audit.flavour', xa.flavour, ya.flavour);
  cmp('audit.name', xa.name, ya.name);
  cmp('audit.time_type', xa.time_type, ya.time_type);
  cmp('audit.keys', xa.keys, ya.keys);
  cmp('audit.req_keys', xa.req_keys, ya.req_keys);
  cmp('audit.kbytes', xa.kbytes, ya.kbytes);
  cmp('audit.res_keys', xa.res_keys, ya.res_keys);
  cmp('audit.msg', xa.msg, ya.msg);
  cmp('audit.res_statusCode', xa.res_statusCode, ya.res_statusCode);
  function errsig (e) { return e && { keys: e.keys, name: e.name, code: e.code }; }
  cmp('audit.err', errsig(xa.err), errsig(ya.err));
  cmp('audit.err.message', xa.err && xa.err.message, ya.err && ya.err.message);
  // audit-log differences are the same for most cases: group them
  diffs.slice(httpDiffs).forEach(function (d) { (auditGroups[d] = auditGroups[d] || [ ]).push(id); });
  if (httpDiffs) {
    differing++;
    var c = x.id ? x : y;
    console.log(id + ' ' + (c.svc || '') + ' ' + (c.method || '') + ' ' + (c.path || '') + (c.why ? '   # ' + c.why : ''));
    console.log(diffs.slice(0, httpDiffs).join('\n'));
  }
});

var ag = Object.keys(auditGroups);
if (ag.length) {
  console.log('');
  console.log('audit log differences (grouped):');
  ag.forEach(function (d) {
    var list = auditGroups[d];
    console.log(d + '\n    in ' + list.length + ' cases: ' + (list.length > 12 ? list.slice(0, 12).join(' ') + ' ...' : list.join(' ')));
  });
}

function logsets (r) { return r.logs || { }; }
var la = logsets(A), lb = logsets(B);
Object.keys(la).concat(Object.keys(lb)).filter(function (v, i, s) { return s.indexOf(v) == i; }).forEach(function (svc) {
  var sa = Object.keys(la[svc] || { }).sort( ), sb = Object.keys(lb[svc] || { }).sort( );
  if (j(sa) !== j(sb)) {
    console.log('non-audit JSON log signatures, ' + svc + ':');
    sa.filter(function (s) { return sb.indexOf(s) < 0; }).forEach(function (s) { console.log('  - ' + s); });
    sb.filter(function (s) { return sa.indexOf(s) < 0; }).forEach(function (s) { console.log('  + ' + s); });
  }
});

console.log('');
console.log(differing + ' of ' + ids.length + ' cases differ in status, headers, body or process exit; ' +
  ag.length + ' distinct audit-log differences');
process.exit(differing || ag.length ? 1 : 0);
