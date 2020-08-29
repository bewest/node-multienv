

var restify = require('restify');
var url = require('url');
var _ = require('underscore');
var async = require('async');
const qs = require('querystring');
const got = require('got');

function configureServer (opts, ctx) {
  var server = restify.createServer(opts);
  var consul = ctx.consul;


  function get_candidates (service, next) {
    return consul.catalog.service.nodes({service: service}, next);
  }

  function apply_policies (services) {
    function byTotalActive (x) { return x.HealthStatus.total.active; }
    function hasHealth (x) { return x && x.HealthStatus; }
    return _.sortBy(services.filter(hasHealth), byTotalActive);
  }

  function require_health (services, next) {
    async.each(services, get_health, function finish (err) {
      next(err, services);
    });
  }

  function fetch_services (service, next) {
    return get_candidates(service, function (err, clusters) {
      return require_health(clusters, next);
    })
  }

  function fetch_elected_services (service, next) {
    return fetch_services(service, function (err, services) {
      if (err) throw err;
      return next(apply_policies(services));
    });
  }

  function get_best_service (service, next) {
    return fetch_elected_services(service, function (services) {
      // if (err) throw err;
      return next(elect(services));
    });
  }

  function elect (services) {
    return services[0];
  }

  function suggest (elected) {
    var candidate = { };
    _.extend(candidate, elected);
    return candidate;
  }

  function ratify (elected, next) {
  }

  function get_health (runner, done) {
    var uri = url.format({ hostname: runner.ServiceAddress, port: runner.ServicePort, pathname: '/stats/active', protocol: 'http' });
    console.log("fetching", uri);
    got(uri).json( ).then(function (body) {
      runner.HealthStatus = body;
      done( );
    }).catch(function (err) {
      console.log("ERROR skipping", arguments);
      done( );
    });
  }


  server.use(function (req, res, next) {
    res.locals = { };
    next( );
  });

  function format_locals (req, res, next) {
    res.send(res.locals);
    next( );
  }

  server.get('/suggested/consul/:service', function (req, res, next) {
  });
  server.get('/available/consul/:service', function (req, res, next) {
    fetch_services(req.params.service, function (err, services) {
      res.locals.services = services;
      next( );
    });
  }, format_locals);

  server.get('/elected/consul/:service', function (req, res, next) {
    get_best_service(req.params.service, function (clusters) {
      res.locals.service = clusters;
      console.log('BEST SERVICE', clusters);
      next( );
    })
  },
  format_locals
  );

  server.get('/scheduled/consul/:service/:tenant/:suffix', function (req, res, next) {
    fetch_elected_services(req.params.service, function (services) {
      console.log("SEARCH CLUSTER RESULTS", services.length);
      res.locals.services = services;
      res.locals.preferred = elect(services);
      next( );
    });
  },
  function (req, res, next) {
    var suffix = req.params.suffix || 'backends';
    var domain = [ req.params.tenant, suffix ].join('.');
    var search  = {service: suffix, tag: req.params.tenant };
    console.log('SEARCH TENANT', search);
    consul.catalog.service.nodes(search, function (err, tenants) {
      console.log("SEARCH TENANT RESULTS", tenants.length);
      if (err) return next(err);
      res.locals.tenants = tenants;
      next( );

    });
  },
  function (req, res, next) {
    var tenants = res.locals.tenants;
    function hostsTenant  ( ) { }
    function electRunners (tenant) {
      var runners = _.where(res.locals.services, { ServiceAddress : tenant.ServiceAddress });
      return runners;
    }
    var candidates = _.flatten(_.map(tenants, electRunners));
    console.log("candidates", candidates.length);
    res.locals.candidates = candidates;
    next( );
  },
  function (req, res, next) {
    if (_.isEmpty(res.locals.candidates)) {
      // this is a new/non-existing tenant
      res.locals.elected = res.locals.preferred;
    } else {
      //pre-existing, use a candidate
      res.locals.elected = res.locals.candidates[0];
    }
    var urlish = { hostname: res.locals.elected.ServiceAddress
    , port: res.locals.elected.ServicePort
    , pathname: '/environs/' + req.params.tenant
    , protocol: 'http'
    };
    var uri = url.format(urlish);
    console.log('elected', uri);
    res.locals.endpoint = uri;
    res.header('X-ELECTED-RUNNER', uri);
    next( );
  },
  format_locals
  );

  server.get('/consul/:service', function (req, res, next) {
    consul.catalog.service.nodes({service: req.params.service}, function (err, clusters) {
      res.locals.services = clusters;
      next( );
    });
  },
  function (req, res, next) {
    async.each(res.locals.services, get_health, function finish ( ) {
      res.locals.services = _.sortBy(res.locals.services.filter(function (x) { return x && x.HealthStatus; }), function (x) { return x.HealthStatus.total.active; });
      next( );
    });
  },
  function (req, res, next) {
    res.send(res.locals);
    next( );
  });
  return server;
}


function consul_url_to_opts (input) {
  var u = url.parse(input);
  var q = qs.parse(u.query);
  var protos = { consul: 'http', consuls: 'https' };
  var scheme = protos[u.protocol] || u.protocol;
  var o = {
    host: u.hostname,
    port: u.port,
    url: url.format({protocol: scheme, host: u.host})
  };
  if (u.search && 'https' == scheme) {
    if (q.promisify) {
      o.promisify = true;
    }
    // TODO: security
  }
  return o;
}

function configureWatcher (opts) {
  var config = {

    consul: consul_url_to_opts(options.url)
  };
  console.log('connecting to consul', opts);
  var client = require('consul')(opts);
  return client;
  client.agent.self( function (err, data, res) {
    // client.agent.self(console.log.bind(console, "DEBUG CONSUL"));
    // console.log("CONNECTED TO CONSUL", client, arguments);
    if (err) throw err;
    fn(err, client, data, res);
  });
  // client.agent.self(console.log.bind(console, "DEBUG CONSUL"));
  return client;
}


if (!module.parent) {
  var port = parseInt(process.env.PORT || '2829')
  var boot = require('bootevent')( );
  var env = require('./lib/env');
  boot.acquire(function consul_env (ctx, next) {
    var opts = consul_url_to_opts(env.consul.url);
    ctx.consul = require('consul')(opts);
    ctx.consul.agent.self( function (err, data, res) {
      if (err) throw err;
      console.log('connected to consul');
      next( );
    });
  }).acquire(function server_env (ctx, next) {
    ctx.server = configureServer({ }, ctx);
    next( );
  }).boot(function (ctx) {
    ctx.server.listen(port, function ( ) {
      console.log('listening on', this.address( ));
    });
  });
}

