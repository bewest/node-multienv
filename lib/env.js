const path = require('path');

var CONSUL_ENV = {
    service: 'cluster',
    url: process.env.CONSUL || process.env.CONSUL || "consul://consul.service.consul:8500"
};

var work_dir = process.env.WORKER_DIR || '../cgm-remote-monitor';
var work_env = process.env.WORKER_ENV || './envs';
var env = {
    base: __dirname
  , WORKER_DIR: path.resolve(work_dir)
  , WORKER_ENV: path.resolve(__dirname, work_env)
  , HOSTEDPORTS: 5000
};
exports.consul = CONSUL_ENV;
exports.work_dir = work_dir;
exports.work_env = work_env;
exports.env = env;
