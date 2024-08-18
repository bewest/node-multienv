
var restify = require('restify');
var bunyan = require('bunyan');
var _ = require('lodash');

function configure (opts) {

  var k8s = opts.k8s;
  var appsApi = opts.appsApi;
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

  function template_deployment (data) {
    return {
      kind: "Deployment"
    , metadata: {
      name: data.WEB_NAME,
      annotations: {
        ...opts.default.deployment.annotations
        // 'managed-by': 'multienv/k8s-deployment-controller'
      },
      labels: {
        ...opts.default.deployment.labels,
        // managed: 'multienv', app: 'tenant',
        internal_name: data.WEB_NAME
      }
    }
    , spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          internal_name: data.WEB_NAME
          
        }
      },
      template: {
        metadata: {
          name: data.WEB_NAME,
          annotations: {
            ...opts.default.deployment.annotations
            // 'managed-by': 'multienv/k8s-deployment-controller'
          },
          labels: {
            ...opts.default.deployment.labels,
            internal_name: data.WEB_NAME,
            tenant: data.WEB_NAME,
            // app: 'tenant'
          }

        },
        spec: {
          hostname: `${data.WEB_NAME}`,
          subdomain: "backends",
          containers: [ {
            name: 'nightscout',
            image: 'nightscout/cgm-remote-monitor:latest',
            envFrom: [
              {
                secretRef: {
                  name: `${data.WEB_NAME}-secrets`
                , optional: true
                },
              },
              {
                configMapRef: {
                  name: data.WEB_NAME
                , optional: true
                }
              }
            ]
          } ]
        }
      }
    }
    };
  }

  function suggest_deployment (req, res, next) {
    req.deployment = template_deployment(req.suggestion);
    next( );
  }

  function fetch_deployment (req, res, next) {
    appsApi.readNamespacedDeployment(req.params.name, selected_namespace).then(function (result) {
      res.result = result.body;
      next( );
    }).catch(next);
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

  function create_deployment (req, res, next) {
    var msg = {status: 'create or update starting' };
    appsApi.readNamespacedDeployment(req.params.name, selected_namespace).then(function (result) {
      msg.status = "readNamespacedDeployment result"
      msg.result = result;
      console.log("replace or create", msg);
      var body = result.body;
      /*
      if (req.params.field && req.deployment.data[req.params.field]) {
        body.data[req.params.field] = req.deployment.data[req.params.field];
      } else {
        body.data = req.deployment.data;
      }
      */
      // console.log("READ before update", req.deployment.data, body);
      console.log("before update", req.suggestion);
      appsApi.replaceNamespacedDeployment(body.metadata.name, selected_namespace, body).then(function (result) {
        msg.status = "replaceNamespacedDeployment result"
        msg.result = result;
        console.log("replace or create", msg);
        res.header('Location', '/environs/' + body.metadata.name);
        res.result = result.body;
        next( );
      }).catch(next);
    }).catch(function (err) {
      console.log('first time creating?', err);
      appsApi.createNamespacedDeployment(selected_namespace, req.deployment).then(function (result) {
        msg.status = "createNamespacedDeployment result"
        msg.result = result;
        console.log("replace or create", msg);
        var body = result.body;
        res.header('Location', '/environs/' + body.metadata.name);
        res.deployment = result.body;
        // res.result = result.body.data;
        next( );
      }).catch(function (err) {
        console.log('error creating config map', err);
        next(err);
      });
    });
  }

  function select_data_field (req, res, next) {
    var doc = res.result;
    res.result = doc[req.params.field];
    next( );
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

  function delete_deployment (req, res, next) {
    appsApi.deleteNamespacedDeployment(req.params.name, selected_namespace).then(function (result) {
      res.json(req.params.name);
      res.status(204);
      res.end( );
      next( );
    }).catch(next);
  }

  function suggest_deployment_template_params (req, res, next) {
    console.log("INCOMING UPDATE", req.body);
    // TODO: inspect annotations and/or labels to see if this configmap or
    // secret should be added.
    // or if the deployment should be restarted.
    // TODO: inspect annotation or labels to determine the tenant's name if
    // this is a supplementary secret or configmap.
    var data = _.extend({ WEB_NAME: req.body.object.metadata.name }, req.query);
    data = _.extend(data, req.body);
    req.suggestion = data;
    next( );

  }

  function handle_sync_addition (req, res, next) {
    const deploymentName = req.deployment.metadata.name;

    appsApi.createNamespacedDeployment(selected_namespace, req.deployment).then(function (result) {
      res.result = result;
      return next( );
    }).catch((err) => {
      // maybe previously existed but we are adding a new type of config or are
      // transitioning configmaps in or out of labels configured for different
      // watches to facilitate a hybrid or migrating environment.
      // TODO: consider creating a list of patches to add or remove configmaps
      // based on inspected labels and annotations to help support migrations
      // or hybrid environments.
      const patch = [{
        op: "add",
        path: "/spec/template/metadata/annotations/updated-at",
        // path: "/spec/template/metadata/annotations",
        // path: "/metadata/annotations/updated-at",
        // value: { "updated-at": new Date().toISOString() }
        value: new Date().toISOString()
      }];
      console.log("ATTEMPT TO PATCH DEPLOYMENT THAT COULD NOT BE CREATED", deploymentName, req.deployment, patch, err.response.body);
     // Perform the patch operation
     var options = { headers: { "Content-Type": "application/json-patch+json" } };
     appsApi.patchNamespacedDeployment(deploymentName, selected_namespace, patch, undefined, undefined, undefined, undefined, undefined, options)
       .then((result) => {
				console.log(`deployment ${req.deployment.metadata.name} updated for rolling restart`);
        // res.result = deployment
        res.result = result;
        next( );
      }).catch((err) => {
        console.error("Error updating deployment that couldn't be added.", err);
        next(err);
      });
    });
  }


  function handle_sync_updates (req, res, next) {
    console.log("INCOMING UPDATE", req.body);
    var annotations = req.body.object.metadata.annotations || { };
    var targetDeployment = annotations['tenant'] || req.body.object.metadata.name;
		appsApi.readNamespacedDeployment(targetDeployment, selected_namespace).then((deployment) => {
      const patch = [{
				op: "add",
				path: "/spec/template/metadata/annotations/updated-at",
				value: new Date().toISOString()
			}];
      var options = { headers: { "Content-Type": "application/json-patch+json" } };
      appsApi.patchNamespacedDeployment(targetDeployment, selected_namespace, patch, undefined, undefined, undefined, undefined, undefined, options)
      .then((result) => {
				console.log(`deployment ${targetDeployment} updated for rolling restart`);
        // res.result = deployment
        res.result = result;
        next( );
      }).catch((err) => {
        console.error("Error updating deployment", err);
        next(err);
      });
    });
  }

  function handle_sync_deletion (req, res, next) {
    var annotations = req.body.object.metadata.annotations || { };
    var targetDeployment = annotations['tenant'] || req.body.object.metadata.name;
    appsApi.deleteNamespacedDeployment(targetDeployment, selected_namespace).then(function (result) {
      res.json(req.params.name);
      res.status(204);
      res.end( );
      next( );
    }).catch(next);
  }

  function list_configmaps (req, res, next) {
    var params = {
      continue: req.query.continue,
      limit: req.query.limit
    };
    var fieldSelector = req.query.fieldSelector;
    var labelSelector = req.query.labelSelector;
    var resourceVersion = null;
    k8s.listNamespacedConfigMap(selected_namespace, false, false, params.continue, fieldSelector, labelSelector, params.limit, resourceVersion).then(function (result, resp) {
      res.result = result;
      next( );
    }).catch(next);
  }

  function list_deployments (req, res, next) {
    var params = {
      continue: req.query.continue,
      limit: req.query.limit
    };
    var fieldSelector = req.query.fieldSelector;
    var labelSelector = req.query.labelSelector;
    var resourceVersion = null;
    appsApi.listNamespacedDeployment(selected_namespace, false, false, params.continue, fieldSelector, labelSelector, params.limit, resourceVersion).then(function (result, resp) {
      res.result = result;
      next( );
    }).catch(next);
  }

  function template_config_map (data) {
    return { kind: "ConfigMap"
    , metadata: { name: data.WEB_NAME,
      annotations: {
        ...opts.default.configmap.annotations
        // 'managed-by': 'multienv/k8s-deployment-controller'
      },
      labels: {
        ...opts.default.configmap.labels
        // managed: 'multienv', app: 'tenant'
      }
    }
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

  function create_or_update_configmap (req, res, next) {
    var msg = {status: 'create or update starting' };
    k8s.readNamespacedConfigMap(req.params.name, selected_namespace).then(function (result) {
      msg.status = "readNamespacedConfigMap result"
      msg.result = result;
      console.log("replace or create", msg);
      var body = result.body;
      if (req.params.field && req.configmap.data[req.params.field]) {
        body.data[req.params.field] = req.configmap.data[req.params.field];
      } else {
        body.data = req.configmap.data;
      }
      body.metadata.annotations = _.extend(body.metadata.annotations, opts.default.configmap.annotations);
      body.metadata.labels = _.extend(body.metadata.labels, opts.default.configmap.labels);
      console.log("READ before update", req.configmap.data, body);
      console.log("before update", req.suggestion);
      k8s.replaceNamespacedConfigMap(body.metadata.name, selected_namespace, body).then(function (result) {
        msg.status = "replaceNamespacedConfigMap result"
        msg.result = result;
        console.log("replace or create", msg);
        res.header('Location', '/environs/' + body.metadata.name);
        res.result = result.body.data;
        next( );
      }).catch(next);
    }).catch(function (err) {
      console.log('first time creating?', err);
      k8s.createNamespacedConfigMap(selected_namespace, req.configmap).then(function (result) {
        msg.status = "createNamespacedConfigMap result"
        msg.result = result;
        console.log("replace or create", msg);
        var body = result.body;
        res.header('Location', '/environs/' + body.metadata.name);
        res.result = result.body.data;
        next( );
      }).catch(function (err) {
        console.log('error creating config map', err);
        next(err);
      });
    });
  }

  function delete_configmap (req, res, next) {
    k8s.deleteNamespacedConfigMap(req.params.name, selected_namespace).then(function (result) {
      res.json(req.params.name);
      res.status(204);
      res.end( );
      next( );
    }).catch(next);
  }

  server.get('/inspect/:name', fetch_deployment, format_result );

  server.post('/inspect/:name', suggest, suggest_deployment, create_deployment, format_result);
  server.post('/template/:name', suggest, suggest_deployment, function (req, res, next) {
    res.result = req.deployment;
    next( );
  }, format_result);

  server.get('/inspect/:name/env/:field', fetch_deployment, select_field, format_result );
  server.get('/inspect/:name/env', fetch_deployment, select_env, format_result );
  server.post('/inspect/:name/env/:field', suggest, suggest_deployment, create_deployment, select_field, format_result );

  server.del('/inspect/:name', delete_deployment);

  server.get('/deployments/:name', fetch_deployment, format_multienv_compatible_result, format_result );
  server.post('/deployments/:name', suggest, suggest_deployment, create_deployment, format_multienv_compatible_result, format_result);
  // server.get('/deployments/:name/env/:field', fetch_deployment, select_field, format_result );
  server.get('/deployments/:name/env', fetch_deployment, select_env, format_result );
  server.del('/deployments/:name', delete_deployment);
  server.get('/deployments', list_deployments, format_result);

  server.post('/sync/additions', suggest_deployment_template_params, suggest_deployment, handle_sync_addition, format_result);
  server.post('/sync/updates', handle_sync_updates, format_result);
  server.post('/sync/deletions', handle_sync_deletion);

  server.get('/configmaps/:name', fetch_config_map, format_multienv_compatible_result, format_result );
  server.post('/configmaps/:name', suggest, suggest_config_map, create_or_update_configmap, format_multienv_compatible_result, format_result);
  server.get('/configmaps/:name/env/:field', fetch_config_map, select_field, format_result );
  server.get('/configmaps/:name/env', fetch_config_map, select_env, format_result );
  server.post('/configmaps/:name/env/:field', suggest, suggest_config_map, create_or_update_configmap, select_data_field, format_result );
  server.del('/configmaps/:name', delete_configmap);
  server.get('/configmaps', list_configmaps, format_result);

  server.get('/environs/:name', fetch_deployment, fetch_config_map, format_multienv_compatible_result, format_result );
  server.post('/environs/:name', suggest, suggest_config_map, create_or_update_configmap, format_multienv_compatible_result, format_result);
  server.get('/environs/:name/env/:field', fetch_config_map, select_field, format_result );
  server.get('/environs/:name/env', fetch_config_map, select_env, format_result );
  server.post('/environs/:name/env/:field', suggest, suggest_config_map, create_or_update_configmap, select_data_field, format_result );
  server.del('/environs/:name', delete_configmap);
  return server;
}

if (!module.parent) {
  var port = parseInt(process.env.PORT || '2828')
  var k8s_local = process.env.MULTIENV_K8S_AUTH == 'local';
  var MULTIENV_MANAGED_BY = process.env.MULTIENV_MANAGED_BY || 'multienv/k8s-deployment-controller';
  var MULTIENV_DEFAULT_COMPONENT_LABEL = process.env.MULTIENV_DEFAULT_COMPONENT_LABEL || 'config';
  var MULTIENV_DEFAULT_CONFIG_ROLE = process.env.MULTIENV_DEFAULT_CONFIG_ROLE || 'config-as-deploy';
  var config = {
    MULTIENV_K8S_NAMESPACE: process.env.MULTIENV_K8S_NAMESPACE || 'default'
  , default: {
    deployment: {
      annotations: {
        'managed-by': MULTIENV_MANAGED_BY,
      },
      labels: {
        managed: 'multienv', app: 'tenant',
      }
    }
  , configmap: {
      annotations: {
        'managed-by': MULTIENV_MANAGED_BY,
      },
      labels: {
        managed: 'multienv', app: 'tenant',
        component: MULTIENV_DEFAULT_COMPONENT_LABEL,
        role: MULTIENV_DEFAULT_CONFIG_ROLE
      }
    }
  }
  };
  var boot = require('bootevent')( );
  boot.acquire(function k8s (ctx, next) {
    var my = this;
    ctx.k8s = require('./lib/k8s')({cluster: !k8s_local});
    ctx.appsApi = require('./lib/k8s').get_appsApi({cluster: !k8s_local});
    ctx.k8s.getAPIResources( ).then(function (res) {
      console.log("CONNECTED", res.body.resources.length > 0);
      next( );
    }).catch(function (err) {
      console.log("FAILURE", err);
      process.exit(1);
    });
  })
  .boot(function booted (ctx) {
    var server = configure(_.extend(config, { k8s: ctx.k8s, appsApi: ctx.appsApi }));
    server.listen(port, function ( ) {
      console.log('listening', this.address( ));
    });
  });
}

