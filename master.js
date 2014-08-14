


var cluster = require('cluster');
var path = require('path');
var glob = require('glob');
var fs = require('fs');

var work_dir = process.env.WORKER_DIR || '../cgm-remote-monitor';
var work_env = process.env.WORKER_ENV ||  './envs';
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
      e[p[0].trim( )] = p.slice(1).join('=').trim( );
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
  worker = cluster.fork(env);
  create.handlers[env.envfile] = {worker: worker, env: env};
  return worker;
}

function scan (env, cb) {
  glob(env.WORKER_ENV + '/*.env', function (err, matches) {
    if (err) { return cb(err, matches); }
    var configs = [ ];
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
  console.log(env);
  scan(env, function iter (err, environs) {
    var master = create(env);
    environs.forEach(function map (env) {
      fork(env);

    });
  });
}
