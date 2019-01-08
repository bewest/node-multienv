


var cluster = require('cluster');
var path = require('path');
var glob = require('glob');
var fs = require('fs');
var watch = require('watch');
var shlex = require('shell-quote');
var Server = require('./server');
var debounce = require('debounce');
var dotenv = require('dotenv/lib/main').parse;
var bunyan = require('bunyan');
// var RedisCache = require('./lib/storage');

var bsyslog = require('bunyan-syslog');

var REDIS_ENV = { };
var CONSUL_ENV = {
    service: 'cluster',
    url: process.env.CONSUL || process.env.CONSUL || "consul://consul.service.consul:8500"
};

var LOG_ENV = {
    level: process.env.LOG_LEVEL || 'info'
  , type: process.env.LOG_TYPE || 'sys'
  , facility: process.env.LOG_FACILITY || 'user'
  , host: process.env.LOG_HOST || '127.0.0.1'
  , port: parseInt(process.env.LOG_PORT || '514')
};
var logger = bunyan.createLogger({ name: 'multienv' , streams: [{
  level: LOG_ENV.level,
  type: 'raw',
  stream: bsyslog.createBunyanStream({
    type: LOG_ENV.type,
    facility: bsyslog[LOG_ENV.facility || 'user'],
    host: LOG_ENV.host,
    port: LOG_ENV.port
  })
}] });

var work_dir = process.env.WORKER_DIR || '../cgm-remote-monitor';
var work_env = process.env.WORKER_ENV || './envs';
var env = {
    base: __dirname
  , WORKER_DIR: path.resolve(work_dir)
  , WORKER_ENV: path.resolve(__dirname, work_env)
  , HOSTEDPORTS: 5000
};
var ctx = {
    base: __dirname
  , last_port : env.HOSTEDPORTS
};

function read (config) {
  var lines = fs.readFileSync(path.resolve(env.WORKER_ENV, config));
  var e = dotenv(lines);
  return e;
  var e = { };
  lines.toString( ).split('\n').forEach(function (line) {
    var p = line.split('=');
    if (p.length == 2) {
      var val =  p.slice(1).join('=').trim( );
      e[p[0].trim( )] = shlex.parse(val).join('');
    }
  });
  return e;
}

function create (env) {
  process.chdir(env.WORKER_DIR);
  create.handlers = { };
  // ctx.last_port = env.HOSTEDPORTS;
  cluster.setupMaster(
    {
      silent: true,
      exec: 'server.js'
    }
  );
  return cluster;

}


function fork (env) {
  console.log('CREATE FORK', ctx.last_port);
  var port = env.PORT = ctx.last_port++;
  var inner = { };
  inner.env = env;

  function start (failures) {
    inner.env.port = port;
    inner.env.PORT = port;
    var worker = cluster.fork(inner.env);
    inner.worker = worker;
    worker.logger = logger.child({proc: worker.id, port: port });
    // worker.logger = new syslog.Syslog(['multienv', 'proc', worker.id, worker.port].join(':'));
    // worker.logger = new SysLogger({ tag: ['multienv', 'proc', worker.id, worker.port].join(':'), facility: 'user', hostname: '127.0.0.1', port: 514 });
    worker.process.stdout.on('data', function logstdout (chunk) {
      // worker.logger.log(syslog.LOG_DAEMON + syslog.LOG_INFO, chunk);
      worker.logger.info(chunk.toString( ));
    });
    worker.process.stderr.on('data', function logstderr (chunk) {
      worker.logger.error(chunk.toString( ));
    });
    worker.custom_env = inner.env;
    worker.failures = failures;
    create.handlers[inner.env.envfile] = {worker: worker, env: inner.env, port: inner.env.PORT};
    // inner.worker.once('online', console.log.bind(console, 'WORKER ONLINE', worker));
    // inner.worker.once('listening', console.log.bind(console, 'WORKER LISTENING', worker));
    inner.worker.once('disconnect', console.log.bind(console, 'DISCONNECT'));
    inner.worker.once('exit', console.log.bind(console, 'EXIT'));
    inner.worker.on('request-restart', function (ev) {
      console.log('REQUEST RESTART');
      inner.worker.failures = 0;
      var refreshed = read(inner.env.envfile);
      inner.env = env = merge(env, refreshed);
      inner.worker.remove = false;
      inner.worker.custom_env = inner.env;
      console.log('worker', worker.state);
      if (inner.worker.state == 'listening') {
          // worker && worker.suicide && worker.suicide.call && worker.suicide( );
        console.log('resettig alive');
        inner.worker.kill( );
      } else {
        console.log('recreating deadsies new');
        inner.worker = start(0);
      }
    });
    inner.worker.on('exit', function (ev) {
      console.log('EXITED!?', worker.suicide, worker.failures, arguments);
      if (worker.suicide !== true && worker.failures > 3) {
        console.log('quitting FAILURES', worker.failures);
      } else {
        if (false && !inner.worker.remove) {
          // worker = start(worker.suicide ? worker.failures : worker.failures+1);
          console.log('INNER PRE recreating', inner.env);
          var refreshed = read(inner.env.envfile);
          inner.env = merge(inner.env, refreshed);
          inner.worker.custom_env = inner.env;
          inner.worker = start(inner.worker.suicide ? worker.failures : worker.failures+1);
          /*
          scan(create.env, env.envfile, function iter (err, environs) {

            env = environs[0];
            console.log('INNER recreating', env);
            // worker.kill( );
            worker = start(worker.suicide ? worker.failures : worker.failures+1);
          });
          */
        }
      }
    });
    worker.on('error', console.log.bind(console, 'ERROR'));
    /*
    watch.createMonitor(path.dirname(env.envfile), { filter: function (ff, stat) {
        // console.log('changing', path.basename(ff), path.basename(env.envfile));
        return path.basename(ff) === path.basename(env.envfile);
        if (worker.remove && worker.suicide) {
        } else {
        }
      } }, function (monitor) {
      monitor.on("changed", function (f, curr, prev) {
        console.log('killing', f, env.envfile);
        // env = ;
        scan(create.env, f, function iter (err, environs) {

          env = environs[0];
          console.log('recreating', env);
          worker.custom_env = env;
          worker.kill( );
        });
      });
      monitor.on("removed", function (f, curr, prev) {
        console.log('killing', f, env.envfile);
        worker.remove = true;
        if (worker.state != 'dead') {
          worker.kill( );
        }
      });
      worker.on('exit', function (ev) {
        monitor.stop( );
        // if (!worker.suicide) { }
      });
    });
    */
    /*
    */
    return worker;
  }

  return start(0);
}

function scan (env, cb, p) {
  if (!cb.call) {
    if (p && p.call) {
      var tmp = p;
      p = cb;
      cb = tmp;
    }
  } else {
    p = env.WORKER_ENV + '/*.env';
  }
  glob(p, function (err, matches) {
    if (err) { return cb(err, matches); }
    var configs = [ ];
    if (!Array.isArray(matches )) {
      matches = [matches];
    }
    matches.forEach(function iter (file) {
      var defaults = merge({envfile: file}, env);
      var custom = read(file);
      configs.push(merge({PATH: process.env.PATH}, merge(defaults, custom)));
    });
    cb(null, configs);
  });
}


// Merge object b into object a
function merge(a, b) {
  if (a && b) {
    for (var key in b) {
      a[key] = b[key];
    }
  }
  return a;
}

create.env     = env;
create.scan    = scan;
create.read    = read;
create.fork    = fork;
create.merge   = merge;
module.exports = create;


if (!module.parent) {
  process.env.WORKER_DIR = env.WORKER_DIR;

  var init = require('./init')(function ready ( ) {
    console.log(env);
    scan(env, function iter (err, environs) {
      var master = create(env);
      environs.forEach(function map (env, i) {
        console.log('i', i);
        setTimeout(function ( ) {
          console.log('starting', 'i', i);
          fork(env);

        }, i*4*1000);
      });
    });

  });

  console.log('MONITOR', env.WORKER_ENV);
  fs.watch(env.WORKER_ENV,
  // debounce(
  function (event, file) {
    // new file
    var f = path.resolve(env.WORKER_ENV, file);
    console.log('changed', file, event);
    var worker = create.handlers[f] ? create.handlers[f].worker : { state: 'missing' };
    var valid = [null, 'listening', 'online'];
    if (false && event == 'rename' && fs.existsSync(f)) {
      if (valid.indexOf(worker.state) < 1) {
        if (worker.failures) { worker.failures = 0; }
        scan(env, f, function iter (err, environs) {
          environs.forEach(function map (env) {
            fork(env);
          });
        });
      }
    } else {
      if (fs.existsSync(f)) {
        console.log("KILLING IT", worker.state);
          worker.remove = false;
        if (worker && worker.state != 'missing') {
          worker.remove = false;
          if (event == 'change') {
          setTimeout(function ( ) {
            worker.emit('request-restart');
          }, 500);
          }
        } else {
          scan(env, f, function iter (err, environs) {
            environs.forEach(function map (env) {
              console.log('NEW INSTANCE', env);
              fork(env);
            });
          });
        }
        return;
      } else {
        console.log('removing');
        if (worker) {
          worker.remove = true;
          worker.emit('remove');
          worker.kill('SIGTERM');
        }
      }
    }
  }
  // ,  10)
  );




  var server = Server({cluster: cluster, create:create});
  var port = process.env.INTERNAL_PORT || process.env.PORT || 3434;
  function onConnect ( ) {
    server.listen(port);
  }
  var Consul = require('./lib/consul')(server, cluster);
  server.on('listening', console.log.bind(console, 'port', port));
  var cache = new Consul(CONSUL_ENV, onConnect);
  // cache.subscribe(server, cluster);
  // onConnect( );
}
