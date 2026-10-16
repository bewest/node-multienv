'use strict';
// Fakes for test/operator-watch.test.js (Q-OPERATOR-WATCH).
//
// * createApi: a fake Kubernetes API for ConfigMaps and Pods in one namespace
//   that serves lists and watches from a script, so a test decides what each
//   watch request sends and when it ends.
// * createGateway: a fake deployment controller that records the
//   dispatcher's POSTs and answers with scripted status codes.
//
// Synthetic data only: tenant-a, tenant-b, ... No real tenants.

var http = require('http');
var url = require('url');

function send (res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  res.end(obj === undefined ? '' : JSON.stringify(obj));
}

function readBody (req, cb) {
  var chunks = [ ];
  req.on('data', function (c) { chunks.push(c); });
  req.on('end', function ( ) {
    var text = Buffer.concat(chunks).toString( );
    try { cb(text ? JSON.parse(text) : null); } catch (e) { cb(text); }
  });
}

function configmap (name, rv, data) {
  return { kind: 'ConfigMap', apiVersion: 'v1',
    metadata: { name: name, namespace: 'default', resourceVersion: String(rv), uid: 'uid-cm-' + name,
      labels: { role: 'config-as-deploy', managed: 'multienv' } },
    data: data || { WEB_NAME: name } };
}

function pod (tenant, rv, phase) {
  var name = tenant + '-pod';
  return { kind: 'Pod', apiVersion: 'v1',
    metadata: { name: name, namespace: 'default', resourceVersion: String(rv), uid: 'uid-pod-' + tenant,
      labels: { role: 'config-as-deploy', managed: 'multienv', tenant: tenant } },
    status: { phase: phase || 'Running', podIP: '10.0.1.' + (tenant.charCodeAt(tenant.length - 1) % 200) } };
}

function line (type, object) {
  return JSON.stringify({ type: type, object: object }) + '\n';
}

function bookmark (rv) {
  return line('BOOKMARK', { kind: 'ConfigMap', apiVersion: 'v1', metadata: { resourceVersion: String(rv) } });
}

function expired ( ) {
  return line('ERROR', { kind: 'Status', apiVersion: 'v1', metadata: { }, status: 'Failure',
    message: 'too old resource version: 20 (35)', reason: 'Expired', code: 410 });
}

// script: {
//   lists: [ { resourceVersion, items } ... ]   one per list request; the last repeats
//   watches: [ function (query, res) ... ]      one per watch request; after the
//                                               last, watches stay open
// }
function createApi (script) {
  var log = { lists: [ ], watches: [ ] };
  var open = [ ];
  var server = http.createServer(function (req, res) {
    var u = url.parse(req.url, true);
    var p = u.pathname.replace(/\/$/, '');
    if (p == '/api/v1') {
      return send(res, 200, { kind: 'APIResourceList', groupVersion: 'v1',
        resources: [ { name: 'configmaps', namespaced: true, kind: 'ConfigMap' }, { name: 'pods', namespaced: true, kind: 'Pod' } ] });
    }
    if (!/^\/api\/v1\/namespaces\/default\/(configmaps|pods)$/.test(p)) {
      return send(res, 404, { kind: 'Status', code: 404, reason: 'NotFound', message: 'fake api: ' + p });
    }
    if (u.query.watch == 'true' || u.query.watch == '1') {
      var n = log.watches.length;
      log.watches.push({ path: p, query: u.query, at: Date.now( ) });
      var fn = script.watches[n];
      if (!fn) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('');
        open.push(res);
        return;
      }
      return fn(u.query, res);
    }
    var lists = script.lists || [ { resourceVersion: '1', items: [ ] } ];
    var list = lists[Math.min(log.lists.length, lists.length - 1)];
    log.lists.push({ path: p, query: u.query });
    send(res, 200, { kind: 'List', apiVersion: 'v1', metadata: { resourceVersion: String(list.resourceVersion) },
      items: u.query.limit ? list.items.slice(0, parseInt(u.query.limit)) : list.items });
  });
  server.log = log;
  server.closeAll = function ( ) {
    open.forEach(function (res) { try { res.end( ); } catch (e) { } });
    server.close( );
  };
  return server;
}

// statuses(n, path, body) -> HTTP status for the n-th POST (default 200)
function createGateway (statuses) {
  var posts = [ ];
  var server = http.createServer(function (req, res) {
    readBody(req, function (body) {
      var u = url.parse(req.url);
      var n = posts.length;
      var status = statuses ? statuses(n, u.pathname, body) : 200;
      posts.push({ path: u.pathname, type: body && body.type, name: body && body.object && body.object.metadata.name,
        rv: body && body.object && body.object.metadata.resourceVersion, status: status });
      send(res, status, status < 300 ? { ok: true } : { ok: false });
    });
  });
  server.posts = posts;
  return server;
}

exports.createApi = createApi;
exports.createGateway = createGateway;
exports.configmap = configmap;
exports.pod = pod;
exports.line = line;
exports.bookmark = bookmark;
exports.expired = expired;
