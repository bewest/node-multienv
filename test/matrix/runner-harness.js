'use strict';
// Starts the runner's REST API (server.js, what master.js serves on
// INTERNAL_PORT) with a fake cluster instead of forked Nightscout workers and
// without Consul (LAB-021: master.js blocks on Consul agent.self before it
// listens; server.js itself does not need Consul).
//
// env: PORT, WORKER_ENV (absolute dir holding <tenant>.env files)
var path = require('path');
var fs = require('fs');

var WORKER_ENV = process.env.WORKER_ENV;
if (!WORKER_ENV) { throw new Error('WORKER_ENV required'); }
var master = require('../../master');
var Server = require('../../server');

var envfile = path.join(WORKER_ENV, 'tenant-a.env');
var custom_env = { envfile: envfile, WEB_NAME: 'tenant-a', DISPLAY_UNITS: 'mmol', PORT: '15001', port: '15001' };
var worker = {
  id: 1,
  state: 'listening',
  custom_env: custom_env,
  isDead: function ( ) { return false; }
};
var cluster = { workers: { 1: worker } };
master.handlers = { };
master.handlers[envfile] = { worker: worker, env: custom_env, port: custom_env.PORT };
master.stats = { expected: 1, handled: 1, name: 'internal:cluster' };
master.env.MAX_TENANT_LIMIT = '10';

var server = Server({ cluster: cluster, create: master, watcher: null });
var port = parseInt(process.env.PORT || '13434');
server.listen(port, function ( ) {
  console.log('restifymx runner-harness listening', port);
});
