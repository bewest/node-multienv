


var cluster = require('cluster');
var path = require('path');
var glob = require('glob');
var fs = require('fs');
var watch = require('watch');
var shlex = require('shell-quote');
var Server = require('./server');

var work_dir = process.env.WORKER_DIR || '../cgm-remote-monitor';
var work_env = process.env.WORKER_ENV || './envs';
var env = {
    base: __dirname
  , WORKER_DIR: path.resolve(work_dir)
  , WORKER_ENV: path.resolve(__dirname, work_env)
  , HOSTEDPORTS: 5000
};

function read (config) {
  var lines = fs.readFileSync(path.resolve(env.WORKER_ENV, config));
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
  create.last_port = env.HOSTEDPORTS;
  cluster.setupMaster(
    {
      exec: 'server.js'
    }
  );
  return cluster;

}


function fork (env) {
  env.PORT = create.last_port++;

  function start (failures) {
    var worker = cluster.fork(env);
    worker.custom_env = env;
    worker.failures = failures;
    create.handlers[env.envfile] = {worker: worker, env: env};
    worker.on('disconnect', console.log.bind(console, 'DISCONNECT'));
    worker.on('exit', console.log.bind(console, 'EXIT'));
    worker.on('exit', function (ev) {
      console.log('EXITED!?', worker.suicide, worker.failures, arguments);
      if (worker.suicide !== true && worker.failures > 3) {
        console.log('quitting FAILURES', worker.failures);
      } else {
        if (!worker.remove) {
          worker = start(worker.suicide ? worker.failures : worker.failures+1);
        }
      }
    });
    worker.on('error', console.log.bind(console, 'ERROR'));
    watch.createMonitor(path.dirname(env.envfile), { filter: function (ff, stat) {
        return ff == env.envfile;
        if (worker.remove && worker.suicide) {
        } else {
        }
      } }, function (monitor) {
      monitor.on("changed", function (f, curr, prev) {
        console.log('killing', f, env.envfile);
        // env = ;
        scan(create.env, f, function iter (err, environs) {

          env = environs[0];
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
      environs.forEach(function map (env) {
        fork(env);
      });
    });

  });

  console.log('MONITOR', env.WORKER_ENV);
  fs.watch(env.WORKER_ENV, function (event, file) {
    // new file
    var f = path.resolve(env.WORKER_ENV, file);
    // console.log("DFLKDJ", arguments);
    if (event == 'rename' && fs.existsSync(f)) {
      // console.log('CREATED YXYX', f, arguments);
      scan(env, f, function iter (err, environs) {
        environs.forEach(function map (env) {
          fork(env);
        });
      });

    }
  });
  /*
  */

  var server = Server({cluster: cluster, create:create});
  var port = process.env.INTERNAL_PORT || process.env.PORT || 3434;
  server.listen(port);
  server.on('listen', console.log.bind(console, 'port', port));
}
