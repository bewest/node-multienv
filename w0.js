var fs = require('fs');
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
  process.env.WORKER_DIR = env.WORKER_DIR;

  console.log("Welcome to fs.watch");
  fs.watch(env.WORKER_ENV,
  function (event, file) {
    // new file
    var f = path.resolve(env.WORKER_ENV, file);
    console.log('changed', file, event);
    var valid = [null, 'listening', 'online'];
    if (false && event == 'rename' && fs.existsSync(f)) {
      console.log('ignored rename', file);
    } else {
      if (fs.existsSync(f)) {
        console.log("exists new or changed", file);
        return;
      } else {
        console.log('removed', file);
      }
    }
  }
  );
}
