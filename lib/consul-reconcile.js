'use strict';
// Register running tenant pods that have no Consul registration at all
// (Q-CONSUL-REGISTER-MISSING, F5a; OPS-071, OPS-073).
//
// The consul operator registers a pod only when it sees that pod change, so a
// pod that became Running while the operator, a controller or a Consul server
// was down stays unregistered and its site doesn't resolve. On a slow timer,
// this lists the tenant pods and the `backends` registrations (all agents,
// through the catalog) and registers each Running pod whose UID has none.
//
// It never deregisters and never touches a pod that has a registration
// anywhere, so it can't create a duplicate (OPS-046) or remove a working
// route. Stale and duplicate registrations are Q-CONSUL-OPERATOR-RECONCILE.
//
// Every controller replica runs the timer; only the one holding a Consul
// session lock does a pass, so replicas don't register the same pod twice.
// Each pod is checked again just before it is registered, and pods that
// started less than `graceMs` ago are left to the operator. Logs carry
// counts only.

var os = require('os');

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

function registered_ids (entries) {
  var ids = { };
  (entries || [ ]).forEach(function (e) { if (e && e.Service && e.Service.ID) { ids[e.Service.ID] = true; } });
  return ids;
}

// opts:
//   consul       consul client (health.service, session.create/renew, kv.set)
//   listPods     () -> Promise<[pod]>
//   register     (pod, callback(err)) -> registers one pod (the /consul/sync path)
//   intervalMs   time between passes
//   graceMs      skip pods that started more recently than this (default 120s)
//   ratePerSec   registrations per second (default 5)
//   maxPerPass   registrations per pass (default 200)
//   service      Consul service name (default 'backends')
//   lockKey      KV key for the lock (default 'multienv/consul-reconcile/leader')
//   log, now
function consulReconcile (opts) {
  var consul = opts.consul;
  var log = opts.log || console.log;
  var now = opts.now || Date.now;
  var service = opts.service || 'backends';
  var lockKey = opts.lockKey || 'multienv/consul-reconcile/leader';
  var intervalMs = opts.intervalMs;
  var graceMs = opts.graceMs === undefined ? 120000 : opts.graceMs;
  var ratePerSec = opts.ratePerSec || 5;
  var maxPerPass = opts.maxPerPass || 200;
  var ttlSec = Math.min(86400, Math.max(10, Math.ceil(2 * intervalMs / 1000)));
  var session = null;
  var timer = null;
  var stopped = false;
  var running = false;
  var counters = { passes: 0, led: 0, registered: 0, failed: 0, raced: 0 };

  function hold_lock ( ) {
    var renew = session ? cb2p(function (cb) { consul.session.renew(session, cb); }).then(function (body) {
      return body && body.length ? session : null;
    }, function ( ) { return null; }) : Promise.resolve(null);
    return renew.then(function (id) {
      if (id) { return id; }
      return cb2p(function (cb) {
        consul.session.create({ name: 'multienv-consul-reconcile', ttl: ttlSec + 's', behavior: 'release' }, cb);
      }).then(function (body) { return body.ID; });
    }).then(function (id) {
      session = id;
      return cb2p(function (cb) { consul.kv.set({ key: lockKey, value: os.hostname( ), acquire: id }, cb); });
    }).then(function (held) { return held === true || held === 'true'; });
  }

  function eligible (pod, ids) {
    var m = pod.metadata || { };
    var s = pod.status || { };
    if (ids[m.uid]) { return false; }
    if (m.deletionTimestamp || s.phase != 'Running' || !s.podIP || !(m.labels && m.labels.tenant)) { return false; }
    var started = Date.parse(s.startTime || '');
    return !isNaN(started) && now( ) - started >= graceMs;
  }

  function sleep (ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function runOnce ( ) {
    if (running) { return { skipped: 'running' }; }
    running = true;
    counters.passes++;
    var summary = { leader: false, pods: 0, registrations: 0, missing: 0, registered: 0, raced: 0, failed: 0, deferred: 0 };
    try {
      summary.leader = await hold_lock( );
      if (!summary.leader) { return summary; }
      counters.led++;
      var entries = await cb2p(function (cb) { consul.health.service({ service: service }, cb); });
      var ids = registered_ids(entries);
      summary.registrations = Object.keys(ids).length;
      var pods = await opts.listPods( );
      summary.pods = pods.length;
      var missing = pods.filter(function (pod) { return eligible(pod, ids); });
      summary.missing = missing.length;
      var todo = missing.slice(0, maxPerPass);
      summary.deferred = missing.length - todo.length;
      for (var i = 0; i < todo.length && !stopped; i++) {
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
      summary.error = String(err && (err.message || err.code) || err);
      return summary;
    } finally {
      running = false;
      counters.registered += summary.registered;
      counters.failed += summary.failed;
      counters.raced += summary.raced;
      if (summary.leader || summary.error) {
        log('CONSUL RECONCILE', JSON.stringify(summary));
      }
    }
  }

  function schedule (delay) {
    if (stopped) { return; }
    timer = setTimeout(function ( ) {
      runOnce( ).then(function ( ) { schedule(intervalMs); });
    }, delay);
    if (timer.unref) { timer.unref( ); }
  }

  function start ( ) {
    // replicas start together after a rollout; spread their first passes
    schedule(opts.firstDelayMs === undefined ? Math.floor(Math.random( ) * intervalMs) : opts.firstDelayMs);
  }

  function stop ( ) {
    stopped = true;
    clearTimeout(timer);
  }

  return { start: start, stop: stop, runOnce: runOnce, counters: counters };
}

module.exports = consulReconcile;
consulReconcile.parse_duration = parse_duration;
