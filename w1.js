
var watch = require('watch');
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


  console.log("Welcome to watch");
  var interval = parseInt(process.env.WATCH_INTERVAL_MS || 222) / 1000;
  console.log('WATCHING', env.WORKER_ENV);
	watch.watchTree(path.dirname(env.WORKER_ENV), {interval: .222}, function (f, curr, prev) {
    console.log('file', f);
    if (typeof f == "object" && prev === null && curr === null) {
      // Finished walking the tree
      console.log(f, 'finished');
    } else if (prev === null) {
      // f is a new file
      console.log(f, 'new');
    } else if (curr.nlink === 0) {
      // f was removed
      console.log(f, 'removed');
    } else {
      // f was changed
      console.log(f, 'changed');
    }
  });

}
