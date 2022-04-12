
var chokidar = require('chokidar');
var path = require('path');

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

if (!module.parent) {


  console.log("Welcome to chokidar");
  console.log('WATCHING', env.WORKER_ENV);
  var watcher = chokidar.watch(env.WORKER_ENV, {
    persistent: true
  , atomic: true
  });

  // watcher.on('all', console.log.bind(console, 'chokidar *'));
  watcher.on('error', console.log.bind(console, 'chokidar error'));
  watcher.on('add', function (file) { console.log('add', file); });
  watcher.on('change', function (file) { console.log('change', file); });
  watcher.on('unlink', function (file) { console.log('unlink', file); });


}
