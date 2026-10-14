'use strict';
// Keep this deployment controller registered in Consul under its own service
// ID (Q-CONTROLLER-SELF-REG, F7; OPS-078).
//
// Every tenant's ValidPodName check resolves the controller by its service
// name (multienv-deployment-controller.service.consul). Before this, each
// controller registered once at boot with no ID, so Consul used the name as
// the ID: two controllers whose registrations reached the same agent shared
// one ID and the later replaced the earlier, and a registration Consul
// removed (deregister_critical_service_after) never came back until the
// controller restarted.
//
// Now each controller registers as <name>-<pod name>, keeps the same name
// (so DNS is unchanged), and registers again on a timer. Registering an ID
// that an agent already holds just updates it, so the timer is harmless when
// nothing was lost. On SIGTERM or SIGINT it deregisters its own ID, best
// effort and bounded, then lets the signal take its usual course.
//
// Settings (environment):
//   MULTIENV_SELF_REGISTER_INTERVAL  re-register every this long (default 60s;
//                                    '0' registers once at boot, as before)
//   MULTIENV_SELF_REGISTER_ID        'none' registers with no ID, as before
//                                    (and never deregisters, since that ID is
//                                    shared); anything else uses <name>-<pod>
//   POD_NAME                         pod name for the ID (downward API);
//                                    falls back to the hostname, which
//                                    Kubernetes sets to the pod name
//
// The check is the one used before: HTTP every 10s, removed after 20s
// critical. The `ttl` key is kept for an identical payload; the consul client
// drops it when `http` and `interval` are set, so Consul never sees a TTL.
// Logs carry the name, ID and counts only.

var url = require('url');
var os = require('os');

var DEFAULT_INTERVAL_MS = 60000;
var DEREGISTER_TIMEOUT_MS = 1000;

function parse_duration (text) {
  if (text === undefined || text === null || text === '') { return undefined; }
  var m = String(text).trim( ).match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!m) { return NaN; }
  var unit = { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2] || 'ms'];
  return Math.round(parseFloat(m[1]) * unit);
}

// base: { name, address, port }
function options (env, base) {
  var opts = { name: base.name, address: base.address, port: base.port, intervalMs: DEFAULT_INTERVAL_MS };
  var interval = parse_duration(env.MULTIENV_SELF_REGISTER_INTERVAL);
  if (interval === undefined) {
    opts.intervalMs = DEFAULT_INTERVAL_MS;
  } else if (isNaN(interval)) {
    console.log("SELF REGISTRATION: ignoring MULTIENV_SELF_REGISTER_INTERVAL, not a duration; using", DEFAULT_INTERVAL_MS, "ms");
  } else {
    opts.intervalMs = interval;
  }
  if (env.MULTIENV_SELF_REGISTER_ID != 'none') {
    opts.id = base.name + '-' + (env.POD_NAME || os.hostname( ));
  }
  return opts;
}

function payload (opts) {
  var service = {
    name: opts.name,
    address: opts.address,
    port: parseInt(opts.port),
    tags: [ 'healthchecks', 'multienv', 'multienv-deployment-controller' ],
    checks: [ {
      name: "HealthCheckServerOk",
      ttl: '30s',
      interval: '10s',
      http: url.format({protocol: 'http', hostname: opts.address, port: opts.port,  pathname: '/about/server/status'}),
      deregister_critical_service_after: '20s'
    } ]
  };
  if (opts.id) { service.id = opts.id; }
  return service;
}

function create (consul, opts) {
  var service = payload(opts);
  var stats = { registered: 0, failed: 0 };
  var timer = null;
  var stopped = false;

  function register (cb) {
    consul.agent.service.register(service, function (err) {
      if (err) { stats.failed++; } else { stats.registered++; }
      cb(err);
    });
  }

  function start (cb) {
    register(function (err) {
      if (opts.intervalMs > 0 && !stopped) {
        timer = setInterval(function ( ) {
          register(function (err) {
            if (err) {
              console.log("SELF REGISTRATION FAILED", service.name, service.id || '(no id)', err.message, 'registered', stats.registered, 'failed', stats.failed);
            }
          });
        }, opts.intervalMs);
        if (timer.unref) { timer.unref( ); }
      }
      cb(err);
    });
  }

  // Stops the timer and deregisters this ID, calling back within timeoutMs.
  function stop (timeoutMs, cb) {
    stopped = true;
    if (timer) { clearInterval(timer); timer = null; }
    if (!service.id) { return cb( ); }
    var done = false;
    var t = setTimeout(function ( ) { finish(new Error('deregister timed out')); }, timeoutMs);
    consul.agent.service.deregister(service.id, finish);
    function finish (err) {
      if (done) { return; }
      done = true;
      clearTimeout(t);
      cb(err);
    }
  }

  return { service: service, stats: stats, start: start, stop: stop };
}

// On SIGTERM or SIGINT: deregister (bounded), then re-raise the signal with
// the default handler, so the process exits as it did before.
function deregister_on_exit (registration, timeoutMs) {
  if (!registration.service.id) { return; }
  timeoutMs = timeoutMs || DEREGISTER_TIMEOUT_MS;
  [ 'SIGTERM', 'SIGINT' ].forEach(function (signal) {
    process.once(signal, function ( ) {
      registration.stop(timeoutMs, function (err) {
        console.log("SELF DEREGISTERED", registration.service.name, registration.service.id, err ? err.message : 'ok');
        process.kill(process.pid, signal);
      });
    });
  });
}

module.exports = {
  options: options,
  payload: payload,
  create: create,
  deregister_on_exit: deregister_on_exit,
  parse_duration: parse_duration,
  DEFAULT_INTERVAL_MS: DEFAULT_INTERVAL_MS
};
