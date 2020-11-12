
var restify = require('restify');
var bunyan = require('bunyan');
var _ = require('lodash');

function configure (opts) {

  var k8s = opts.k8s;
  var selected_namespace = opts.MULTIENV_K8S_NAMESPACE;

  var server = restify.createServer(opts);

  server.on('after', restify.plugins.auditLogger({
    log: bunyan.createLogger({
      name: 'audit',
      stream: process.stdout
    }),
    event: 'after'
  }));
  server.use(restify.plugins.queryParser( ));
  server.use(restify.plugins.bodyParser( ));

  // 

  function suggest (req, res, next) {
    var data = _.extend({ WEB_NAME: req.params.name }, req.query);
    data = _.extend(data, req.body);
    req.suggestion = data;
    next( );
  }

  function template_config_map (data) {
    return { kind: "ConfigMap"
    , metadata: { name: data.WEB_NAME, labels: { managed: 'multienv', app: 'tenant' } }
    , data: data
    };
  }

  function suggest_config_map (req, res, next) {
    req.configmap = template_config_map(req.suggestion);
    next( );
  }

  function fetch_config_map (req, res, next) {
    k8s.readNamespacedConfigMap(req.params.name, selected_namespace).then(function (result) {
      res.result = result.body;
      next( );
    }).catch(next);
  }

  function format_result (req, res, next) {
    res.send(res.result);
    res.end( );
    next( );
  }

  function format_multienv_compatible_result (req, res, next) {
    res.result.custom_env = res.result.data;
    res.result.state = 'persisted';
    delete res.result.data;
    /*
    var v = {
      id: worker.id || null
    , custom_env: worker.custom_env
    , state: worker.state || 'missing'
    , isDead: worker.isDead && worker.isDead( )
    // , url: "http://" + [ 'localhost', worker.custom_env.PORT ].join(':') + '/'
    // , status_url: "http://" + [ 'localhost', worker.custom_env.PORT ].join(':') + '/api/v1/status.json'
    };
    */
    next( );
  }

  function create_config_map (req, res, next) {
    k8s.readNamespacedConfigMap(req.params.name, selected_namespace).then(function (result) {
      var body = result.body;
      if (req.params.field && req.configmap.data[req.params.field]) {
        body.data[req.params.field] = req.configmap.data[req.params.field];
      } else {
        body.data = req.configmap.data;
      }
      console.log("READ before update", req.configmap.data, body);
      console.log("before update", req.suggestion);
      k8s.replaceNamespacedConfigMap(body.metadata.name, selected_namespace, body).then(function (result) {
        res.header('Location', '/environs/' + body.metadata.name);
        res.result = result.body;
        next( );
      }).catch(next);
    }).catch(function (err) {
      k8s.createNamespacedConfigMap(selected_namespace, req.configmap).then(function (result) {
        res.header('Location', '/environs/' + body.metadata.name);
        res.result = result.body;
        next( );
      }).catch(function (err) {
        console.log('error creating config map', err);
        next(err);
      });
    });
  }


  function select_field (req, res, next) {
    var doc = res.result;
    res.result = doc.data[req.params.field];
    next( );
  }

  function select_env (req, res, next) {
    var doc = res.result;
    res.result = doc.data;
    next( );
  }

  function delete_configmap (req, res, next) {
    k8s.deleteNamespacedConfigMap(req.params.name, selected_namespace).then(function (result) {
      res.json(req.params.name);
      res.status(204);
      res.end( );
      next( );
    }).catch(next);
  }

  server.get('/inspect/:name', fetch_config_map, format_result );

  server.post('/inspect/:name', suggest, suggest_config_map, create_config_map, format_result);

  server.get('/inspect/:name/env/:field', fetch_config_map, select_field, format_result );
  server.get('/inspect/:name/env', fetch_config_map, select_env, format_result );
  server.post('/inspect/:name/env/:field', suggest, suggest_config_map, create_config_map, select_field, format_result );

  server.del('/inspect/:name', delete_configmap);

  server.get('/environs/:name', fetch_config_map, format_multienv_compatible_result, format_result );
  server.post('/environs/:name', suggest, suggest_config_map, create_config_map, format_multienv_compatible_result, format_result);
  server.get('/environs/:name/env/:field', fetch_config_map, select_field, format_result );
  server.get('/environs/:name/env', fetch_config_map, select_env, format_result );
  server.post('/environs/:name/env/:field', suggest, suggest_config_map, create_config_map, select_field, format_result );
  server.del('/environs/:name', delete_configmap);

  return server;
}

if (!module.parent) {
  var port = parseInt(process.env.PORT || '2828')
  var k8s_local = process.env.MULTIENV_K8S_AUTH == 'local';
  var config = {
    MULTIENV_K8S_NAMESPACE: process.env.MULTIENV_K8S_NAMESPACE || 'default'
  };
  var boot = require('bootevent')( );
  boot.acquire(function k8s (ctx, next) {
    var my = this;
    ctx.k8s = require('./lib/k8s')({cluster: !k8s_local});
    ctx.k8s.getAPIResources( ).then(function (res) {
      console.log("CONNECTED", res.body.resources.length > 0);
      next( );
    }).catch(function (err) {
      console.log("FAILURE", err);
      process.exit(1);
    });
  })
  .boot(function booted (ctx) {
    var server = configure(_.extend(config, { k8s: ctx.k8s }));
    server.listen(port, function ( ) {
      console.log('listening', this.address( ));
    });
  });
}

