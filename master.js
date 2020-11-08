


var cluster = require('cluster');
var path = require('path');
var glob = require('glob');
var fs = require('fs');
var watch = require('watch');
var chokidar = require('chokidar');
var shlex = require('shell-quote');
var Server = require('./server');
var debounce = require('debounce');
var dotenv = require('dotenv/lib/main').parse;
var bunyan = require('bunyan');
// var RedisCache = require('./lib/storage');

var bsyslog = require('bunyan-syslog');

var REDIS_ENV = { };
var CLUSTER_CONSUL_ID = process.env.CLUSTER_CONSUL_ID || false;
var BACKENDS_CONSUL_ID = process.env.BACKENDS_CONSUL_ID || false;
var ALLOW_MULTIPLE_CLUSTER = process.env.ALLOW_MULTIPLE_CLUSTER == '1';
var CONSUL_ENV = {
    service: 'cluster',
    allows_mesh: ALLOW_MULTIPLE_CLUSTER,
    cluster_id: CLUSTER_CONSUL_ID || 'internal:cluster',
    backends_id: BACKENDS_CONSUL_ID || 'internal:backend',
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
  , cluster_host: process.env.HOSTNAME
  , MAX_TENANT_LIMIT: process.env.MAX_TENANT_LIMIT
  , WORKER_DIR: path.resolve(work_dir)
  , WORKER_ENV: path.resolve(__dirname, work_env)
  , HOSTEDPORTS: parseInt(process.env.HOSTEDPORTS || '5000')
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
  create.stats = { expected: 0, handled: 0, name: CONSUL_ENV.cluster_id };
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
    inner.env.port = port.toString( );
    inner.env.PORT = port.toString( );
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
    // inner.worker.once('disconnect', console.log.bind(console, 'DISCONNECT'));
    // inner.worker.once('exit', console.log.bind(console, 'EXIT'));
    inner.worker.on('request-restart', function (ev) {
      console.log('REQUEST RESTART');
      inner.worker.failures = 0;
      var refreshed = read(inner.env.envfile);
      inner.env = env = merge(env, refreshed);
      inner.worker.remove = false;
      inner.worker.custom_env = inner.env;
      var old = inner.worker;
      console.log('worker', worker);
      inner.worker = start(0).once('online', function ( ) {
        console.log('replacing', old.id, this.id);
        old.kill( );
      });;
      /*
      if (inner.worker.state == 'listening') {
          // worker && worker.suicide && worker.suicide.call && worker.suicide( );
        console.log('resettig alive');
        inner.worker.kill( );
      } else {
        console.log('recreating deadsies new');
        inner.worker = start(0);
      }
      */
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
    inner.worker.on('error', console.log.bind(console, 'ERROR'));

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

function createWatcher (env) {
  var master = create(env);
  var max_tenants = parseInt(env.MAX_TENANT_LIMIT);
  console.log('MONITOR', env.WORKER_ENV);
  var watcher = chokidar.watch(env.WORKER_ENV, {
    persistent: true
  , atomic: true
  });
  // watcher.on('all', console.log.bind(console, 'chokidar *'));
  watcher.on('error', console.log.bind(console, 'chokidar error'));

  watcher.on('add', function (file, stats) {
    var currently_hosted = create.stats.expected;
    create.stats.expected++;
    if (max_tenants && currently_hosted >= max_tenants) {
      console.log('abandoning, over quota', file);
      return;
    }
    console.log('adding', file);
    scan(env, file, function iter (err, environs) {
      environs.forEach(function map (env) {
        console.log('NEW INSTANCE', env);
        fork(env);
      });
    });
  });

  watcher.on('change', function (file, stats) {
    console.log('changed', file);
    var worker = create.handlers[file] ? create.handlers[file].worker : { state: 'missing' };
    worker.remove = false;
    if (worker && worker.emit) {
      worker.emit('request-restart');
    } else {
      console.log("ERROR WORKER MISSING, scane to recreate?", worker);
    }

  });

  watcher.on('unlink', function (f, stats) {
    console.log('removed', f);
    create.stats.expected--;
    var worker = create.handlers[f] ? create.handlers[f].worker : null;
    if (worker) {
      worker.remove = true;
      worker.emit('remove');
      worker.kill('SIGTERM');
    }
  });
  return watcher;
}

create.env     = env;
create.scan    = scan;
create.read    = read;
create.fork    = fork;
create.merge   = merge;
create.watcher = createWatcher;
module.exports = create;


if (!module.parent) {
  process.env.WORKER_DIR = env.WORKER_DIR;

  var init = require('./init')(function ready ( ) {
    console.log(env);
    var watcher = createWatcher(env);
    /*
    scan(env, function iter (err, environs) {
      environs.forEach(function map (env, i) {
        console.log('i', i);
        setTimeout(function ( ) {
          console.log('starting', 'i', i);
          fork(env);

        }, i*4*1000);
      });
    });
    */
    var server = Server({cluster: cluster, create:create, watcher:watcher});
    var port = process.env.INTERNAL_PORT || process.env.PORT || 3434;
    function onConnect ( ) {
      server.listen(port);
    }
    var Consul = require('./lib/consul')(server, cluster);
    server.on('listening', function ( ) {
      console.log.bind(console, 'port', port);
      process.on('SIGTERM', function ( ) {
        watcher.close( ).then(function ( ) {
          console.log('stopped watching');
          server.close(function ( ) {
            console.log("server closed, disconnecting cluster");

            cluster.disconnect(function ( ) {
              console.log("cluster disconnected");
            });
          });
        });
      });
    });
    var cache = new Consul(CONSUL_ENV, onConnect);

  });



  // cache.subscribe(server, cluster);
  // onConnect( );
}
