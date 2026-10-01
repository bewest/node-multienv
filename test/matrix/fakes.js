'use strict';
// Minimal in-memory fakes for the request matrix (OPS-021 / LAB-021).
//
// * fake Consul agent + catalog (agent/self, service register/deregister,
//   catalog/service/:name with ?tag= filtering)
// * fake Kubernetes API (core v1 ConfigMaps, apps v1 Deployments)
//
// Synthetic data only: tenant names are tenant-a / tenant-b / tenant-new.
// No real tenants, credentials or health data belong here.

var http = require('http');
var url = require('url');

function readBody (req, cb) {
  var chunks = [ ];
  req.on('data', function (c) { chunks.push(c); });
  req.on('end', function ( ) {
    var text = Buffer.concat(chunks).toString( );
    var body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
    cb(body);
  });
}

function send (res, status, obj) {
  var text = obj === undefined ? '' : JSON.stringify(obj);
  // connection: close keeps Node >= 19's automatic keep-alive header out of
  // the k8s client's error objects, which some routes echo back verbatim.
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  res.end(text);
}

// catalog: { service: [ {ServiceAddress, ServicePort, ServiceTags} ] }
function createConsul (catalog) {
  var registered = { };
  var server = http.createServer(function (req, res) {
    var u = url.parse(req.url, true);
    var m;
    if (u.pathname == '/v1/agent/self') {
      return send(res, 200, { Config: { NodeName: 'fake-consul' }, Member: { Name: 'fake-consul' } });
    }
    if (u.pathname == '/v1/agent/service/register') {
      return readBody(req, function (body) {
        registered[(body && (body.ID || body.id || body.Name || body.name)) || 'x'] = body;
        send(res, 200, undefined);
      });
    }
    if ((m = u.pathname.match(/^\/v1\/agent\/service\/deregister\/(.*)$/))) {
      delete registered[m[1]];
      return send(res, 200, undefined);
    }
    if ((m = u.pathname.match(/^\/v1\/catalog\/service\/([^/]+)$/))) {
      var list = catalog[decodeURIComponent(m[1])] || [ ];
      var tags = u.query.tag ? [ ].concat(u.query.tag) : [ ];
      var found = list.filter(function (node) {
        return tags.every(function (t) { return (node.ServiceTags || [ ]).indexOf(t) > -1; });
      });
      return send(res, 200, found);
    }
    send(res, 404, { error: 'fake consul: no route ' + u.pathname });
  });
  server.registered = registered;
  return server;
}

function k8sStatus (code, reason, message) {
  return { kind: 'Status', apiVersion: 'v1', metadata: { }, status: 'Failure', message: message, reason: reason, code: code };
}

function createK8s (seed) {
  // store[kind][name] = object
  var store = { configmaps: { }, deployments: { } };
  var rv = 100;
  (seed || [ ]).forEach(function (obj) {
    store[obj.__kind][obj.metadata.name] = obj;
    delete obj.__kind;
  });
  function stamp (obj, kind) {
    obj.metadata = obj.metadata || { };
    obj.metadata.resourceVersion = String(rv++);
    obj.metadata.namespace = 'default';
    obj.metadata.uid = obj.metadata.uid || ('uid-' + kind + '-' + obj.metadata.name);
    return obj;
  }
  var server = http.createServer(function (req, res) {
    var u = url.parse(req.url, true);
    var p = u.pathname.replace(/\/$/, '');
    if (p == '/api/v1') {
      return send(res, 200, { kind: 'APIResourceList', groupVersion: 'v1', resources: [ { name: 'configmaps', namespaced: true, kind: 'ConfigMap' } ] });
    }
    var m = p.match(/^\/(?:api\/v1|apis\/apps\/v1)\/namespaces\/([^/]+)\/(configmaps|deployments)(?:\/([^/]+))?$/);
    if (!m) { return send(res, 404, k8sStatus(404, 'NotFound', 'fake k8s: no route ' + p)); }
    var kind = m[2];
    var name = m[3] && decodeURIComponent(m[3]);
    var bucket = store[kind];
    readBody(req, function (body) {
      if (!name) {
        if (req.method == 'GET') {
          var items = Object.keys(bucket).sort( ).map(function (k) { return bucket[k]; });
          return send(res, 200, { kind: 'List', apiVersion: 'v1', metadata: { resourceVersion: String(rv) }, items: items });
        }
        if (req.method == 'POST') {
          if (!body || !body.metadata || !body.metadata.name) { return send(res, 422, k8sStatus(422, 'Invalid', 'name required')); }
          if (bucket[body.metadata.name]) { return send(res, 409, k8sStatus(409, 'AlreadyExists', kind + ' "' + body.metadata.name + '" already exists')); }
          bucket[body.metadata.name] = stamp(body, kind);
          return send(res, 201, bucket[body.metadata.name]);
        }
        return send(res, 405, k8sStatus(405, 'MethodNotAllowed', req.method));
      }
      var existing = bucket[name];
      if (req.method == 'GET') {
        if (!existing) { return send(res, 404, k8sStatus(404, 'NotFound', kind + ' "' + name + '" not found')); }
        return send(res, 200, existing);
      }
      if (req.method == 'PUT') {
        if (!existing) { return send(res, 404, k8sStatus(404, 'NotFound', kind + ' "' + name + '" not found')); }
        bucket[name] = stamp(body, kind);
        return send(res, 200, bucket[name]);
      }
      if (req.method == 'PATCH') {
        if (!existing) { return send(res, 404, k8sStatus(404, 'NotFound', kind + ' "' + name + '" not found')); }
        if (body && !Array.isArray(body) && body.metadata) {
          Object.keys(body.metadata).forEach(function (section) {
            var sec = existing.metadata[section] = existing.metadata[section] || { };
            Object.keys(body.metadata[section] || { }).forEach(function (k) {
              if (body.metadata[section][k] === null) { delete sec[k]; } else { sec[k] = body.metadata[section][k]; }
            });
          });
        }
        stamp(existing, kind);
        return send(res, 200, existing);
      }
      if (req.method == 'DELETE') {
        if (!existing) { return send(res, 404, k8sStatus(404, 'NotFound', kind + ' "' + name + '" not found')); }
        delete bucket[name];
        return send(res, 200, { kind: 'Status', apiVersion: 'v1', status: 'Success', details: { name: name, kind: kind } });
      }
      send(res, 405, k8sStatus(405, 'MethodNotAllowed', req.method));
    });
  });
  server.store = store;
  return server;
}

exports.createConsul = createConsul;
exports.createK8s = createK8s;
