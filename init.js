
var exec = require('child_process').exec,
    child;

module.exports = function init (cb) {
  child = exec('./postinstall.sh', function done (err, stdout, stderr) {
    console.log(err);
    console.log(stdout);
    console.log(stderr);
    if (cb && cb.call) {
      cb(err, stdout)
    }
  });

}
