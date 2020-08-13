
var restify = require('restify');
var bunyan = require('bunyan');
var _ = require('lodash');

function configure (opts) {

  var k8s = opts.k8s;

  var server = restify.createServer(opts);

  server.on('after', restify.plugins.auditLogger({
    log: bunyan.createLogger({
      name: 'audit',
      stream: process.stdout
    }),
    event: 'after'
  }));

  // 
  server.get('/inspect/:name', fetch_config_map, format_result );

  function suggest (req, res, next) {
    var data = _.extend({}, req.params);
    data = _.extend(data, req.body);
    req.suggestion = data;
    next( );
  }

  function template_config_map (data) {
    return { kind: "ConfigMap"
    , metadata: { name: data.name }
    , data: data
    };
  }

  function suggest_config_map (req, res, next) {
    req.configmap = template_config_map(req.suggestion);
    next( );
  }

  function fetch_config_map (req, res, next) {
    logger.info("foo");
    k8s.readNamespacedConfigMap(req.params.name, 'default').then(function (result) {
      res.result = result.body;
      next( );
    });
  }

  function format_result (res, res, next) {
    res.send(res.result);
    res.end( );
    next( );
  }

  function create_config_map (req, res, next) {
    k8s.createNamespacedConfigMap('default', req.configmap).then(function (result) {
      res.result = result;
      next( );
    });
  }

  server.post('/inspect/:name', suggest, suggest_config_map, create_config_map, format_result);

  server.del('/inspect/:name', function (req, res, next) {
    next( );
  });
  return server;
}

if (!module.parent) {
  var port = parseInt(process.env.PORT || '2828')
  var boot = require('bootevent')( );
  boot.acquire(function k8s (ctx, next) {
    var my = this;
    ctx.k8s = require('./lib/k8s')( );
    ctx.k8s.listNamespace( ).then(function (res) {
      next( );
    }).catch(my.fail);
  })
  .boot(function booted (ctx) {
    var server = configure({ k8s: ctx.k8s });
    server.listen(port, function ( ) {
      console.log('listening', this.address( ));
    });
  });
}

