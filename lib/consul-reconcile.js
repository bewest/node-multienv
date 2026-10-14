'use strict';
// Register running tenant pods that have no Consul registration at all
// (Q-CONSUL-REGISTER-MISSING, F5a; OPS-071, OPS-073).
//
// The consul operator registers a pod only when it sees that pod change, so a
// pod that became Running while the operator, a controller or a Consul server
// was down stays unregistered and its site doesn't resolve. In each pass,
// this lists the tenant pods and the `backends` registrations (all agents,
// through the catalog) and registers each Running pod whose UID has none.
//
// It never deregisters and never touches a pod that has a registration
// anywhere, so it can't create a duplicate (OPS-046) or remove a working
// route. Stale and duplicate registrations are Q-CONSUL-OPERATOR-RECONCILE.
//
// One pass runs per call. The consul operator, a single replica that already
// drives every registration, asks for a pass on its own timer
// (MULTIENV_CONSUL_RECONCILE_INTERVAL in k8s-dispatcher.js), and an operator
// can ask for one by hand (POST /consul/sync/reconcile). Set the interval only
// in the consul operator's config: the deployment operator runs the same
// dispatcher and would ask for passes too, and the controller reads nothing
// from it. A pass already
// running in this process is not started twice. Each pod is checked again
// just before it is registered, and pods that started less than `graceMs` ago
// are left to the operator. Only Ready pods are registered: a crash-looping
// pod is Running with an IP, but its checks fail, so registering it would only
// have Consul remove it again on every pass. Logs carry counts only.

function parse_duration (text) {
  if (text === undefined || text === null || text === '') { return 0; }
  var m = String(text).trim( ).match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!m) { return NaN; }
  var unit = { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2] || 'ms'];
  return Math.round(parseFloat(m[1]) * unit);
}

function cb2p (fn) {
  return new Promise(function (resolve, reject) {
    fn(function (err, body) { if (err) { reject(err); } else { resolve(body); } });
  });
}

var k8s_safe = require('./k8s-safe');

function is_ready (pod) {
  var conditions = (pod.status && pod.status.conditions) || [ ];
  return conditions.some(function (c) { return c && c.type == 'Ready' && c.status == 'True'; });
}

function registered_ids (entries) {
  var ids = { };
  (entries || [ ]).forEach(function (e) { if (e && e.Service && e.Service.ID) { ids[e.Service.ID] = true; } });
  return ids;
}

// opts:
//   consul       consul client (health.service)
//   listPods     () -> Promise<[pod]>
//   register     (pod, callback(err)) -> registers one pod (the /consul/sync path)
//   graceMs      skip pods that started more recently than this (default 120s)
//   ratePerSec   registrations per second (default 5)
//   maxPerPass   registrations per pass (default 200)
//   service      Consul service name (default 'backends')
//   log, now
function consulReconcile (opts) {
  var consul = opts.consul;
  var log = opts.log || console.log;
  var now = opts.now || Date.now;
  var service = opts.service || 'backends';
  var graceMs = opts.graceMs === undefined ? 120000 : opts.graceMs;
  var ratePerSec = opts.ratePerSec || 5;
  var maxPerPass = opts.maxPerPass || 200;
  var running = false;
  var counters = { passes: 0, registered: 0, failed: 0, raced: 0 };

  function eligible (pod, ids) {
    var m = pod.metadata || { };
    var s = pod.status || { };
    if (ids[m.uid]) { return false; }
    if (m.deletionTimestamp || s.phase != 'Running' || !s.podIP || !(m.labels && m.labels.tenant)) { return false; }
    if (!is_ready(pod)) { return false; }
    var started = Date.parse(s.startTime || '');
    return !isNaN(started) && now( ) - started >= graceMs;
  }

  function sleep (ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function runOnce ( ) {
    if (running) { return { skipped: 'running' }; }
    running = true;
    counters.passes++;
    var summary = { pods: 0, registrations: 0, missing: 0, registered: 0, raced: 0, failed: 0, deferred: 0 };
    try {
      var entries = await cb2p(function (cb) { consul.health.service({ service: service }, cb); });
      var ids = registered_ids(entries);
      summary.registrations = Object.keys(ids).length;
      var pods = await opts.listPods( );
      summary.pods = pods.length;
      var missing = pods.filter(function (pod) { return eligible(pod, ids); });
      summary.missing = missing.length;
      var todo = missing.slice(0, maxPerPass);
      summary.deferred = missing.length - todo.length;
      for (var i = 0; i < todo.length; i++) {
        var pod = todo[i];
        if (i > 0) { await sleep(1000 / ratePerSec); }
        // registered by the operator since the pass began?
        var again = await cb2p(function (cb) { consul.health.service({ service: service, tag: pod.metadata.labels.tenant }, cb); });
        if (registered_ids(again)[pod.metadata.uid]) { summary.raced++; continue; }
        try {
          await cb2p(function (cb) { opts.register(pod, cb); });
          summary.registered++;
        } catch (err) {
          summary.failed++;
        }
      }
      return summary;
    } catch (err) {
      // what failed, not what the client carried (it goes into the 500 body)
      summary.error = k8s_safe.summary(err);
      return summary;
    } finally {
      running = false;
      counters.registered += summary.registered;
      counters.failed += summary.failed;
      counters.raced += summary.raced;
      log('CONSUL RECONCILE', JSON.stringify(summary));
    }
  }

  return { runOnce: runOnce, counters: counters };
}

module.exports = consulReconcile;
consulReconcile.parse_duration = parse_duration;
consulReconcile.is_ready = is_ready;
