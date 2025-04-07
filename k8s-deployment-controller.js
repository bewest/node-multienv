var restify = require('restify');
var bunyan = require('bunyan');
var _ = require('lodash');
var Consul = require('consul');
var url = require('url');
var dns = require('dns');
var objectId = require('./lib/object-id');

function configure (opts) {

  var k8s = opts.k8s;
  var appsApi = opts.appsApi;
  var consul = opts.consul;
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

const templates = require('./lib/templates');

  function suggest (req, res, next) {
    var data = _.extend({ WEB_NAME: req.params.name }, req.query);
    data = _.extend(data, req.body);
    req.suggestion = data;
    next( );
  }


  function template_provisioner_deployment(data) {
    return {
      kind: "Deployment",
      metadata: {
        name: `${data.WEB_NAME}-provisioner`,
        labels: {
          app: 'tenant',
          tenant: data.WEB_NAME,
          component: 'provisioner'
        }
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            app: `${data.WEB_NAME}-provisioner`
          }
        },
        template: {
          metadata: {
            labels: {
              app: `${data.WEB_NAME}-provisioner`
            }
          },
          spec: {
            containers: [{
              name: 'provisioner',
              image: 'nightscout/provisioner:latest',
              env: [{
                name: 'MONGODB_URI',
                value: `mongodb://${data.WEB_NAME}-mongodb:27017/${data.WEB_NAME}`
              }],
              resources: {
                requests: {
                  cpu: '100m',
                  memory: '128Mi'
                },
                limits: {
                  cpu: '200m',
                  memory: '256Mi'
                }
              }
            }]
          }
        }
      }
    };
  }


  function create_nightscout_instance(req, res, next) {
    // Create MongoDB resources first
    k8s.createNamespacedPersistentVolumeClaim(
      selected_namespace,
      templates.template_persistent_volume_claim(req.suggestion)
    ).then(() => {
      return k8s.createNamespacedService(
        selected_namespace, 
        templates.template_mongodb_service(req.suggestion)
      );
    }).then(() => {
      return appsApi.createNamespacedStatefulSet(
        selected_namespace,
        templates.template_mongodb_statefulset(req.suggestion)
      );
    }).then(() => {
      // Create Provisioner API deployment
      return appsApi.createNamespacedDeployment(
        selected_namespace,
        template_provisioner_deployment(req.suggestion)
      );
    }).then(() => {
      // Create CGM Remote Monitor deployment
      return create_deployment(req, res, next);
    }).catch(next);
  }

  function template_deployment (data) {
    var template = {
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
          volumes: [
            {
              name: "mongodb-data",
              persistentVolumeClaim: {
                claimName: `${data.WEB_NAME}-mongodb-data`
              }
            }
          ],
          containers: [
            {
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
              ],
              env: [
                {
                  name: 'MONGODB_URI',
                  value: `mongodb://localhost:27017/${data.WEB_NAME}`
                }
              ],
              resources: {
                ...(opts.MULTIENV_TENANT_REQUESTS_ENABLE ? {
                  requests: opts.requests
                } : { }),
                ...(opts.MULTIENV_TENANT_LIMITS_ENABLE ? {
                  limits: opts.limits
                } : { }),
              }
            },
            {
              name: 'mongodb',
              image: 'mongo:4.4',
              volumeMounts: [
                {
                  name: "mongodb-data",
                  mountPath: "/data/db"
                }
              ],
              resources: {
                requests: {
                  cpu: '100m',
                  memory: '256Mi'
                },
                limits: {
                  cpu: '500m',
                  memory: '512Mi'
                }
              }
            }
          ]
          /*
          // Add nodeSelector to target specific node pool
          nodeSelector: {
            'doks.digitalocean.com/node-pool': 'bigger-tenant-runners'
          }
          */

        }
      }
    }
    };

    if (opts.MULTIENV_TENANT_NODEPOOL_TARGET) {
      template.spec.template.spec.nodeSelector = {
        'doks.digitalocean.com/node-pool': opts.MULTIENV_TENANT_NODEPOOL_TARGET
      };
    }

    return template;
  }

  function suggest_deployment (req, res, next) {
    req.deployment = template_deployment(req.suggestion);
    next( );
  }

  function fetch_deployment (req, res, next) {
    appsApi.readNamespacedDeployment(req.params.name, selected_namespace).then(function (result) {
      res.deployment = result.body;
      res.result = result.body;
      next( );
    }).catch(next);
  }

  function format_multienv_compatible_result (req, res, next) {
    res.result.custom_env = res.result.data;
    res.result.state = 'persisted';
    delete res.result.data;
    next( );
  }

  function create_deployment (req, res, next) {
    var msg = {status: 'create or update starting' };

    // Create PVC first
    k8s.createNamespacedPersistentVolumeClaim(
      selected_namespace,
      templates.template_persistent_volume_claim(req.suggestion)
    ).catch(function(err) {
      if (err.statusCode !== 409) { // Ignore if PVC already exists
        console.log('Error creating PVC:', err);
      }
    });
    appsApi.readNamespacedDeployment(req.params.name, selected_namespace).then(function (result) {
      msg.status = "readNamespacedDeployment result"
      msg.result = result;
      console.log("replace or create", msg);
      var body = result.body;
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

  function select_metadata_field (req, res, next) {
    var doc = res.result;
    switch (req.params.section) {
      case 'userdata':
      case 'data':
        doc = res.result.data;
        break;
      case '':
      case 'metadata':
        doc = res.result.metadata;
        break;
      case 'annotations':
      case 'labels':
        doc = res.result.metadata[req.params.section];
        break;
    }
    if (req.params.field) {
      res.result = doc[req.params.field];
    } else {
      res.result = doc;
    }
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
      const patch = [{
        op: "add",
        path: "/spec/template/metadata/annotations/updated-at",
        value: new Date().toISOString()
      }];
      console.log("ATTEMPT TO PATCH DEPLOYMENT THAT COULD NOT BE CREATED", deploymentName, req.deployment, patch, err.response.body);
     var options = { headers: { "Content-Type": "application/json-patch+json" } };
     appsApi.patchNamespacedDeployment(deploymentName, selected_namespace, patch, undefined, undefined, undefined, undefined, undefined, options)
       .then((result) => {
				console.log(`deployment ${req.deployment.metadata.name} updated for rolling restart`);
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
      },
      labels: {
        ...opts.default.configmap.labels
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

  function patch_configmap_remove_field (req, res, next) {
    var targetConfigMap = req.params.name;
    var patch = { metadata: { } };
    patch.metadata[req.params.section] = { [req.params.field]:  null };
    var options = { headers: { "Content-Type": "application/merge-patch+json" } };
    k8s.patchNamespacedConfigMap(targetConfigMap, selected_namespace, patch, undefined, undefined, undefined, undefined, undefined, options)
    .then(function (result) {
      res.status(204);
      res.end( );
      next( );
    }).catch(function (err) {
      console.log("ERROR PATCHING", err, err.response);
      next(err);
    });
  }

  function patch_configmap_metadata (req, res, next) {
    var targetConfigMap = req.params.name;
    var patch = { metadata: { } };
    if (req.params.field && req.body[req.params.field]) {
      patch.metadata[req.params.section] = _.extend(patch.metadata[req.params.section], { [req.params.field]:  req.body[req.params.field] });
    } else {
      patch.metadata[req.params.section] = req.body;
    }
    var options = { headers: { "Content-Type": "application/merge-patch+json" } };
    k8s.patchNamespacedConfigMap(targetConfigMap, selected_namespace, patch, undefined, undefined, undefined, undefined, undefined, options)
    .then(function (result) {
      res.result = result;
      next( );
    }).catch(function (err) {
      next(err);
    });
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
  server.get('/deployments/:name/env', fetch_deployment, select_env, format_result );
  server.del('/deployments/:name', delete_deployment);
  server.get('/deployments', list_deployments, format_result);

  const createMetacontrollerRoutes = require('./lib/webhook/tenant-webhook-handler');
  const customizeRoute = require('./lib/routes/metacontroller/customize');
  const createDeploymentRoutes = require('./lib/routes/deployments');
  const createConfigMapRoutes = require('./lib/routes/configmaps');
  const createHealthRoutes = require('./lib/routes/health');
  const createInstanceRoutes = require('./lib/routes/instances');

  const metacontrollerRoutes = createMetacontrollerRoutes(opts);
  const deploymentRoutes = createDeploymentRoutes(k8s, selected_namespace, opts);
  const configMapRoutes = createConfigMapRoutes(k8s, selected_namespace, opts);
  const healthRoutes = createHealthRoutes(k8s, selected_namespace);
  const instanceRoutes = createInstanceRoutes(opts.kc, selected_namespace);

  // Deployment routes
  // server.get('/deployments/:name', deploymentRoutes.fetchDeployment, format_result);
  // server.del('/deployments/:name', deploymentRoutes.deleteDeployment);
  // server.get('/deployments', deploymentRoutes.listDeployments, format_result);

  // ConfigMap routes  
  // server.get('/configmaps/:name', configMapRoutes.fetchConfigMap, format_result);
  // server.post('/configmaps/:name', suggest, suggest_config_map, configMapRoutes.createOrUpdateConfigMap, format_result);
  // server.del('/configmaps/:name', configMapRoutes.deleteConfigMap);
  // server.get('/configmaps', configMapRoutes.listConfigMaps, format_result);

  // MetaController webhook endpoints
  server.post('/metacontroller/sync', metacontrollerRoutes);
  server.post('/metacontroller/customize', customizeRoute);
  // server.post('/metacontroller/storage/sync', metacontrollerRoutes.handleStorageSync);
  // server.post('/metacontroller/migration/sync', metacontrollerRoutes.handleMigrationSync);

  server.post('/sync/additions', suggest_deployment_template_params, suggest_deployment, handle_sync_addition, format_result);
  server.post('/sync/updates', handle_sync_updates, format_result);
  server.post('/sync/deletions', handle_sync_deletion);

  server.post('/consul/sync/additions', sync_consul_update, format_result);
  server.post('/consul/sync/updates', sync_consul_update, format_result);
  server.post('/consul/sync/deletions', sync_consul_deletion);

  function sync_consul_addition (req, res, next) {
    console.log("NOTHING TO DO WITH CONSUL SINCE POD IS NOT RUNNING", req.body);
    next( );
  }

  function assigned_ip_name_health_check (req, res, next) {
    var expectedIp = req.params.ip;
    var tenantName = req.params.name;
    var domain = `${tenantName}.backends.${selected_namespace}.svc.cluster.local`;
    dns.resolve(domain, function (err, result) {
      console.log('resolved', err, domain, result);
      if (err) return next(err);
      if (result.length) {
        if (result.indexOf(expectedIp) > -1 ) {
          res.json({ ok: true, status: 'ok' });
        } else {
          res.status(404);
          res.json({ ok: false, status: 'BAD', result } );
        }
      } else {
        res.status(404);
      }
      next( );
    });
  }

  function sync_consul_update (req, res, next) {
		const serviceData = req.body.object;
    if (serviceData.status.phase != 'Running') {
      console.log("NOTHING TO DO SINCE POD IS NOT RUNNING", req.body);
      return next( );
    }
		const tenantName = serviceData.metadata.labels.tenant;
		const serviceID = `${tenantName}-${serviceData.metadata.namespace}`;
    var id = serviceData.metadata.uid;
    var host = serviceData.status.podIP;
    var healthCheckService = url.parse(opts.MULTIENV_HEALTH_CHECK_SERVICE);
    var validPodCheckUrl = url.format({ protocol: healthCheckService.protocol, hostname: healthCheckService.hostname, port: healthCheckService.port,  pathname: ('/healthchecks/pod/' + tenantName + '/assigned/podIP/' + host)});
    var port = 1337;
		var insert = {
			name: 'backends',
			address: host,
			port: port,
			id: id,
			tags: [ tenantName, serviceID, 'tenant', 'backend' ],
			checks: [
        {
				name: "EndpointAvailable",
				ttl: '30s',
				interval: '10s',
				http: url.format({protocol: 'http', hostname: host, port: port,  pathname: '/api/v1/status.txt'}),
				deregister_critical_service_after: '20s'
			},
			{
				name: "ValidPodName",
				ttl: '10s',
				interval: '5s',
				http: validPodCheckUrl,
				failures_before_critical: 1,
				deregister_critical_service_after: '5s'
			},
			]
		};
    consul.agent.service.register(insert, function (err, body, resp) {
      console.log("CREATED BACKEND SITE IN CONSUL", err, insert);
      if (err) {
        return next(err);
      }
      res.result = body;
      next( );
    });
  }

  function sync_consul_deletion (req, res, next) {
		const serviceData = req.body.object;

		const tenantName = serviceData.metadata.tenant;
    var id = serviceData.metadata.uid;
    consul.agent.service.deregister(id, function (err, body, resp) {
      console.log("REMOVED BACKEND SITE FROM CONSUL", id, err, body);
      res.status(204);
      res.end( );
      next( );
    });
  }

  server.get('/configmaps/:name', fetch_config_map, format_multienv_compatible_result, format_result );
  server.post('/configmaps/:name', suggest, suggest_config_map, create_or_update_configmap, format_multienv_compatible_result, format_result);
  server.get('/configmaps/:name/metadata/:section', fetch_config_map, select_metadata_field, format_result );
  server.get('/configmaps/:name/metadata/:section/:field', fetch_config_map, select_metadata_field, format_result );
  server.post('/configmaps/:name/metadata/:section/:field', fetch_config_map, patch_configmap_metadata, format_result );
  server.del('/configmaps/:name/metadata/:section/:field', fetch_config_map, patch_configmap_remove_field);

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

  function template_initial_storage_secret (accountId) {
    const secretName = `${accountId}-secret`;
    
    // TODO: we need to apply labels below that can be passed through from
    // environment variable. Some of the labels should help assist the
    // customize webhook to match this secret.  The webhook will need to
    // include this secret using the labels in order to correctly perform the
    // initializing, provisioning, and other phases.
    // TODO: should include a new DB_NAME as well.
    // todo role: MULTIENV_DEFAULT_SECRET_ROLE (mongodb)
    // 
    // Create K8s secret with provisioning root MongoDB credentials
    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: secretName,
        labels: {
          'app.kubernetes.io/managed-by': 'tenant-controller',
          'storage.nightscout.org/account': accountId
          // TODO: also use tenant/WEB_NAME
          // TODO: use a label passed from environment to allow runtime
          // environment to tailor things.  include role and component labels
        }
      },
      stringData: {
        MONGODB_INITDB_ROOT_USERNAME: `user_${accountId}`,
        MONGODB_INITDB_ROOT_PASSWORD: objectId() 
        // TODO: MONGODB_URL: <formatted_mongo_url>
      }
    };
    return secret;
  }

  function handle_new_provisioner_account_webhook (req, res, next) {
    const accountId = req.params.account || objectId();
    var secret = template_initial_storage_secret(accountId);
    k8s.createNamespacedSecret(selected_namespace, secret)
      .then((result) => {
        console.log("NEW PROVISIONER ACCOUNT RESULT SECRET", result);
        res.json({
          account: accountId,
          resource: result.body
          // name: req.body.name || accountId
        });
        next();
      })
      .catch(next);
  }

  // Account and site provisioning endpoints
  server.post('/accounts', handle_new_provisioner_account_webhook);
  server.post('/accounts/:account', handle_new_provisioner_account_webhook);


  server.post('/accounts/:account/sites', instanceRoutes.suggest_template, instanceRoutes.create_resource);

  // New instances endpoints
  server.get('/instances/:name', instanceRoutes.fetchInstance, format_result);
  server.post('/instances/:name', instanceRoutes.createOrUpdateInstance, format_result);
  server.del('/instances/:name', instanceRoutes.deleteInstance);
  server.get('/instances', instanceRoutes.listInstances, format_result);

  server.get('/healthchecks/pod/:name/assigned/podIP/:ip', assigned_ip_name_health_check);
  return server;
}

if(!module.parent) {
  var port = parseInt(process.env.PORT || '2828')
  var k8s_local = process.env.MULTIENV_K8S_AUTH == 'local';
  var MULTIENV_MANAGED_BY = process.env.MULTIENV_MANAGED_BY || 'multienv/k8s-deployment-controller';
  var MULTIENV_DEFAULT_COMPONENT_LABEL = process.env.MULTIENV_DEFAULT_COMPONENT_LABEL || 'config';
  var MULTIENV_DEFAULT_CONFIG_ROLE = process.env.MULTIENV_DEFAULT_CONFIG_ROLE || 'config-as-deploy';
  var MULTIENV_DEFAULT_APP_LABEL = (process.env.MULTIENV_DEFAULT_APP_LABEL || 'tenant');
  var CONSUL = process.env.CONSUL || 'http://consul.service.consul';
  var config = {
    MULTIENV_K8S_NAMESPACE: process.env.MULTIENV_K8S_NAMESPACE || 'default',
    MULTIENV_TENANT_NODEPOOL_TARGET: process.env.MULTIENV_TENANT_NODEPOOL_TARGET || 'bigger-tenant-runners',
    MULTIENV_TENANT_REQUESTS_ENABLE: (process.env.MULTIENV_TENANT_REQUESTS_ENABLE ||'1') != 'false',
    MULTIENV_TENANT_LIMITS_ENABLE: (process.env.MULTIENV_TENANT_LIMITS_ENABLE ||'1') != 'false',
    MULTIENV_HEALTH_CHECK_SERVICE: (process.env.MULTIENV_HEALTH_CHECK_SERVICE || 'http://multienv-deployment-controller:3000'),
    requests: {
      cpu: process.env.MULTIENV_TENANT_REQUESTS_CPU || '5m',
      memory: process.env.MULTIENV_TENANT_REQUESTS_MEMORY || '120Mi'
    },
    limits: {
      cpu: process.env.MULTIENV_TENANT_LIMITS_CPU || '500m',
      memory: process.env.MULTIENV_TENANT_LIMITS_MEMORY || '500Mi'
    }
  , tenant: {
    storage_init_job_image: process.env.MULTIENV_TENANT_STORAGE_INIT_JOB_IMAGE || 'multienv',
    storage_init_job_command: process.env.MULTIENV_TENANT_STORAGE_INIT_JOB_COMMAND || 'initialize-tenant-storage',
    storage_provisioner_image: process.env.MULTIENV_TENANT_STORAGE_PROVISIONER_IMAGE || 'provisioner',
    storage_migration_job_image: process.env.MULTIENV_TENANT_STORAGE_MIGRATION_JOB_IMAGE || 'provisioner',
    storage_migration_job_command: process.env.MULTIENV_TENANT_STORAGE_MIGRATION_JOB_COMMAND || 'initialize-tenant-storage',
    tenant_app_image: process.env.MULTIENV_TENANT_APP_IMAGE || 'nightscout',
    storage_image: process.env.MULTIENV_TENANT_STORAGE_IMAGE || 'mongo'
  }
  , default: {
    deployment: {
      annotations: {
        'managed-by': MULTIENV_MANAGED_BY,
      },
      labels: {
        managed: 'multienv', app: MULTIENV_DEFAULT_APP_LABEL, 
        role: MULTIENV_DEFAULT_CONFIG_ROLE
      }
    }
  , configmap: {
      annotations: {
        'managed-by': MULTIENV_MANAGED_BY,
      },
      labels: {
        managed: 'multienv', app: MULTIENV_DEFAULT_APP_LABEL, 
        component: MULTIENV_DEFAULT_COMPONENT_LABEL,
        role: MULTIENV_DEFAULT_CONFIG_ROLE
      }
    }
  }
  };
  var boot = require('bootevent')( );
  boot.acquire(function k8s (ctx, next) {
    var my = this;
    ctx.kc = require('./lib/k8s').get_kc({cluster: !k8s_local});
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
  .acquire(function k8s (ctx, next) {
    ctx.consul = new Consul(url.parse(CONSUL));
    ctx.consul.agent.self(function (err, body, response) {
      if (err) {
        console.log("COULD NOT CONNECT TO CONSUL", err);
        process.exit(1);
      }
      console.log("CONNECTED TO CONSUL", body);
      next( );
    });
  })
  .boot(function booted (ctx) {
    var server = configure(_.extend(config, { kc: ctx.kc, k8s: ctx.k8s, appsApi: ctx.appsApi, consul: ctx.consul }));
    server.listen(port, function ( ) {
      console.log('listening', this.address( ));
    });
  });
}
