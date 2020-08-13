
var k8s = require("@kubernetes/client-node");
function configure (opts) {

  var kc = new k8s.KubeConfig();
  if (opts && opts.cluster) {
    kc.loadFromCluster();
  } else {
    kc.loadFromDefault();
  }
  return kc.makeApiClient(k8s.CoreV1Api);

}

module.exports = exports = configure;
