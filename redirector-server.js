
var restify = require('restify');
var fs = require('fs');
var path = require('path');
var tmp = require('tmp');
var mv = require('mv');
var bunyan = require('bunyan');
var dns = require('dns');

function createServer (opts) {
  var cluster = opts.cluster;
  var master = opts.create;
  if (opts) {
    opts.handleUpgrades = true;
  }
  var server = restify.createServer(opts);
  var Consul = require('./lib/consul')(server, false);
  // var cache = new Consul(CONSUL_ENV, function ( ) { });
  server.on('after', restify.auditLogger({
    log: bunyan.createLogger({
      name: 'audit',
      stream: process.stdout
    })
  }));



  function log_headers_middleware (req, res, next) {
    req.result = { path: req.path( )
    , href: req.href( )
    , headers: req.headers
    };

    console.log('REQUEST', req.result);
    next( );
  };

  function set_site_domain (req, res, next) {
    var domain = req.params.host || req.headers('Host');
    domain.split('.backends').slice(0, -1).slice(0, -1).concat(['.backends.service.consul']).join('' );
    req.result.domain = domain;
    req.site_domain = domain;
    next( );
  }

  function get_port (req, res, next) {
    var domain = req.site_domain;
    console.log('resolve port for domain', domain);
    dns.resolveSrv(domain, function (err, result) {
      console.log('resolved', domain, result);
      if (result.length) {
        req.result.port = result[0].port;
      }
      next( );
    });
  }

  function set_outgoing_headers (req, res, next) {
    res.header('X-Worker-Port', req.result.port || "1234");
    res.header('X-Selected-Backend', req.result.upstream);
    console.log("X-Selected-Backend", req.result.upstream);
    next( );
  }
  function select_backend (req, res, next) {
    // req.result.upstream = 'http://backends.service.consul:' + req.result.port;
    req.result.upstream = 'http://consul.service.consul:' + req.result.port;
    next( );
  }
  function result_is_headers (req, res, next) {

    res.json(req.result);

  };

  function set_site_host_params (req, res, next) {
    req.result.params = req.params;
    req.result.internal_name = req.params.site + '.backends.service.consul';
    req.site_domain = req.result.internal_name;
    next( );
  }

  server.get('/consul-status', function (req, res, next) {
    res.json({msg: 'OK'});
  });

  server.get('/auth', log_headers_middleware, result_is_headers);
  server.get('/auth.*', log_headers_middleware, result_is_headers);
  server.get('/auth/.*', log_headers_middleware, result_is_headers);
  server.get('/debug/.*', log_headers_middleware, result_is_headers);
  server.get('/validate_request/.*', log_headers_middleware, result_is_headers);
  server.get('/validate_domain/.*', log_headers_middleware, set_site_domain, get_port, set_outgoing_headers, result_is_headers);
  server.get('/internal_consul/:site/:host', log_headers_middleware, set_site_domain, set_site_host_params, get_port, select_backend, set_outgoing_headers, result_is_headers);


  return server;
}

exports = module.exports = createServer;

if (!module.parent) {
var CONSUL_ENV = {
    service: 'backends',
    url: process.env.CONSUL || process.env.CONSUL || "consul://consul.service.consul:8500"
};
  var server = createServer(CONSUL_ENV);
  var port = process.env.INTERNAL_PORT || process.env.PORT || 3636;
  function onConnect ( ) { }
  server.listen(port);
  server.on('listening', console.log.bind(console, 'port', port));

}
