
var k8s = require("@kubernetes/client-node");

function get_kc (opts) {
  var kc = new k8s.KubeConfig();
  if (opts && opts.cluster) {
    kc.loadFromCluster();
  } else {
    kc.loadFromDefault();
  }
  return kc;
}

function configure (opts) {
  var kc = get_kc(opts);
  return kc.makeApiClient(k8s.CoreV1Api);

}

module.exports = exports = configure;
configure.get_kc = get_kc;
