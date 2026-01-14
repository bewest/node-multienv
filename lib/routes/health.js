
const dns = require('dns');

function createHealthRoutes(k8s, namespace) {
  return {
    assignedIpNameHealthCheck: function(req, res, next) {
      const expectedIp = req.params.ip;
      const tenantName = req.params.name;
      const domain = `${tenantName}.backends.${namespace}.svc.cluster.local`;
      
      dns.resolve(domain, function(err, result) {
        if (err) return next(err);
        if (result.length) {
          if (result.indexOf(expectedIp) > -1) {
            res.json({ ok: true, status: 'ok' });
          } else {
            res.status(404);
            res.json({ ok: false, status: 'BAD', result });
          }
        } else {
          res.status(404);
        }
        next();
      });
    }
  };
}

module.exports = createHealthRoutes;
