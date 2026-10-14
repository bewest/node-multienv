
var restify = require('restify');
var bunyan = require('bunyan');
var _ = require('lodash');
// never send or log raw k8s client results/errors: they carry the
// service-account token (OPS-039, D-009)
var k8s_safe = require('./lib/k8s-safe');
var consulReconcile = require('./lib/consul-reconcile');
var self_registration = require('./lib/self-registration');
var Consul = require('consul');
var url = require('url');
var dns = require('dns');
var tenant_healthcheck = require('./lib/tenant-healthcheck');
var nightscout_image = require('./lib/nightscout-image');

function configure (opts) {

  var k8s = opts.k8s;
  var appsApi = opts.appsApi;
  var consul = opts.consul;
  var selected_namespace = opts.MULTIENV_K8S_NAMESPACE;
  var healthcheck = opts.healthcheck || tenant_healthcheck.config({ });

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
    // data.object is the tenant ConfigMap when called from /sync/additions.
    var ns_image = nightscout_image.resolve(opts, data.object);
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
            ...opts.default.deployment.annotations,
            // records a per-tenant image override so it can be reverted
            ...(ns_image.source == 'annotation' ? {
              [nightscout_image.ANNOTATION]: ns_image.image
            } : { })
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
            name: nightscout_image.CONTAINER_NAME,
            image: ns_image.image,
            ...(ns_image.imagePullPolicy ? {
              imagePullPolicy: ns_image.imagePullPolicy
            } : { }),
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
            resources: {
              ...(opts.MULTIENV_TENANT_REQUESTS_ENABLE ? {
                requests: opts.requests
              } : { }),
              ...(opts.MULTIENV_TENANT_LIMITS_ENABLE ? {
                limits: opts.limits
              } : { }),
            }
          } ]
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

    if (healthcheck.style == 'pod') {
      tenant_healthcheck.inject(template.spec.template.spec, healthcheck);
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
    }).catch(k8s_safe.fail(next));
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
      msg.result = k8s_safe.summary_result(result);
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
        msg.result = k8s_safe.summary_result(result);
        console.log("replace or create", msg);
        res.header('Location', '/environs/' + body.metadata.name);
        res.result = result.body;
        next( );
      }).catch(k8s_safe.fail(next));
    }).catch(function (err) {
      console.log('first time creating?', k8s_safe.summary(err));
      appsApi.createNamespacedDeployment(selected_namespace, req.deployment).then(function (result) {
        msg.status = "createNamespacedDeployment result"
        msg.result = k8s_safe.summary_result(result);
        console.log("replace or create", msg);
        var body = result.body;
        res.header('Location', '/environs/' + body.metadata.name);
        res.deployment = result.body;
        // res.result = result.body.data;
        next( );
      }).catch(function (err) {
        console.log('error creating config map', k8s_safe.summary(err));
        next(k8s_safe.error(err));
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
    // res.result = doc[req.params.section][req.params.field];
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
    }).catch(k8s_safe.fail(next));
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

  // F3 (OPS-036, Q-CONTROLLER-IDEMPOTENT-ADD): the tenant ConfigMap version a
  // Deployment was last made from, on the Deployment's own metadata (not the
  // pod template, so writing it restarts nothing).
  var CONFIG_RV = 'multienv.t1pal.org/config-rv';

  // the version to stamp, only for the tenant's own ConfigMap
  function applied_config_rv (req, deploymentName) {
    var meta = (req.body && req.body.object && req.body.object.metadata) || { };
    if (!meta.resourceVersion || meta.name != deploymentName) { return null; }
    return String(meta.resourceVersion);
  }

  // JSON patch ops that set the stamp on an existing Deployment
  function stamp_ops (deployment, rv) {
    if (deployment.metadata && deployment.metadata.annotations) {
      return [{ op: "add", path: "/metadata/annotations/" + CONFIG_RV.replace(/~/g, '~0').replace(/\//g, '~1'), value: rv }];
    }
    return [{ op: "add", path: "/metadata/annotations", value: { [CONFIG_RV]: rv } }];
  }

  function http_status (err) {
    return err && (err.statusCode || (err.response && err.response.statusCode) || (err.body && err.body.code));
  }

  function handle_sync_addition (req, res, next) {
    const deploymentName = req.deployment.metadata.name;
    const rv = opts.MULTIENV_SYNC_ADD_ALWAYS_RESTART ? null : applied_config_rv(req, deploymentName);
    if (rv) {
      req.deployment.metadata.annotations = { ...req.deployment.metadata.annotations, [CONFIG_RV]: rv };
    }

    function done (promise, why) {
      promise.then((result) => {
        console.log(`deployment ${deploymentName} ${why}`);
        res.result = k8s_safe.wrapped(result);
        next( );
      }).catch((err) => {
        console.error("Error updating deployment that couldn't be added.", k8s_safe.summary(err));
        next(k8s_safe.error(err));
      });
    }

    appsApi.createNamespacedDeployment(selected_namespace, req.deployment).then(function (result) {
      res.result = k8s_safe.wrapped(result);
      return next( );
    }).catch((err) => {
      if (rv && http_status(err) == 409) {
        // Already exists. A repeated addition (a re-list, a full-audit
        // replay) restarts the tenant only when its ConfigMap changed since
        // the Deployment was made from it.
        return read_deployment_body(deploymentName).then(function (existing) {
          var annotations = (existing.metadata && existing.metadata.annotations) || { };
          var stamped = annotations[CONFIG_RV];
          if (stamped == rv) {
            console.log("DEPLOYMENT ALREADY FROM THIS CONFIG, NOT RESTARTING", deploymentName, rv);
            res.result = { body: existing };
            return next( );
          }
          if (!stamped) {
            // made before stamps existed: assume it matches its ConfigMap
            return done(patch_deployment(deploymentName, stamp_ops(existing, rv)), `stamped with config ${rv}, not restarted`);
          }
          // changed: restart as /sync/updates would (sidecar adoption in pod
          // mode, the tenant's image), with the new stamp on the same patch
          console.log("CONFIG CHANGED SINCE DEPLOYMENT WAS MADE", deploymentName, stamped, rv);
          var extra_ops = (body) => nightscout_image.update_patch(body, req.body.object, opts).concat(stamp_ops(body, rv));
          return done(restart_deployment(deploymentName, existing, extra_ops), `updated for rolling restart (config ${stamped} -> ${rv})`);
        }).catch((err) => {
          console.error("Error reading deployment that couldn't be added.", deploymentName, k8s_safe.summary(err));
          next(k8s_safe.error(err));
        });
      }
      // maybe previously existed but we are adding a new type of config or are
      // transitioning configmaps in or out of labels configured for different
      // watches to facilitate a hybrid or migrating environment.
      // TODO: consider creating a list of patches to add or remove configmaps
      // based on inspected labels and annotations to help support migrations
      // or hybrid environments.
      // With MULTIENV_TENANT_HEALTHCHECK=pod the restart also adds the
      // pod-healthcheck sidecar if the existing deployment lacks it.
      console.log("ATTEMPT TO PATCH DEPLOYMENT THAT COULD NOT BE CREATED", deploymentName, req.deployment, k8s_safe.summary(err));
      done(restart_deployment(deploymentName), 'updated for rolling restart');
    });
  }

  function patch_deployment (name, patch) {
    var options = { headers: { "Content-Type": "application/json-patch+json" } };
    return appsApi.patchNamespacedDeployment(name, selected_namespace, patch, undefined, undefined, undefined, undefined, undefined, options);
  }

  function read_deployment_body (name) {
    return appsApi.readNamespacedDeployment(name, selected_namespace).then((result) => result.body);
  }

  // Rolling restart, as 7deafde.  In pod mode the same patch also adopts the
  // pod-healthcheck sidecar, guarded by the deployment's resourceVersion so
  // two writers can't both add one.  If that fails, retry once from a fresh
  // read, then fall back to the plain restart so the change that triggered
  // it is never dropped.
  //
  // extra_ops(body), when given, adds ops computed from the deployment as
  // read (the per-tenant Nightscout image); they ride on every attempt,
  // including the fallback, so an image change is never dropped.
  function restart_deployment (name, deployment, extra_ops) {
    var extra = (body) => (extra_ops && body) ? extra_ops(body) : [ ];
    if (healthcheck.style != 'pod') {
      return patch_deployment(name, [ tenant_healthcheck.restart_op( ) ].concat(extra(deployment)));
    }
    var last;
    var read = deployment ? Promise.resolve(deployment) : read_deployment_body(name);
    var attempt = (body) => {
      last = body;
      return patch_deployment(name, tenant_healthcheck.restart_and_adopt_ops(body, name, healthcheck).concat(extra(body)));
    };
    return read.then(attempt)
      .catch((err) => {
        console.log('restart with pod-healthcheck adoption failed, retrying', name, k8s_status(err));
        return read_deployment_body(name).then(attempt);
      }).catch((err) => {
        console.log('adoption failed twice, restarting without it', name, k8s_status(err));
        return patch_deployment(name, [ tenant_healthcheck.restart_op( ) ].concat(extra(last)));
      });
  }

  function k8s_status (err) {
    return (err && (err.statusCode || (err.response && err.response.statusCode))) || 500;
  }

  // Status and name only, never the raw k8s result or error (OPS-039).
  function send_k8s_error (res, next, name, err) {
    var status = k8s_status(err);
    res.json(status, { ok: false, name: name, status: status });
    next(false);   // ends the route; format_result must not send again
  }

  function handle_sync_updates (req, res, next) {
    console.log("INCOMING UPDATE", req.body);
    var annotations = req.body.object.metadata.annotations || { };
    var targetDeployment = annotations['tenant'] || req.body.object.metadata.name;
		appsApi.readNamespacedDeployment(targetDeployment, selected_namespace).then((deployment) => {
      // Per-tenant image override lives on the tenant's own ConfigMap; skip
      // supplementary objects that point at the tenant via annotations.tenant.
      // F3: the restart also records which ConfigMap version it applies.
      var own = targetDeployment == req.body.object.metadata.name;
      var rv = applied_config_rv(req, targetDeployment);
      var image_ops = (own || rv)
        ? (body) => (own ? nightscout_image.update_patch(body, req.body.object, opts) : [ ]).concat(rv ? stamp_ops(body, rv) : [ ])
        : null;
      return restart_deployment(targetDeployment, deployment.body, image_ops);
    }).then((result) => {
				console.log(`deployment ${targetDeployment} updated for rolling restart`);
        // res.result = deployment
        res.result = k8s_safe.wrapped(result);
        next( );
    }).catch((err) => {
      // a failed read was an unhandled rejection in 7deafde: Node printed the
      // whole HttpError (token included) and exited
      console.error("Error updating deployment", targetDeployment, k8s_safe.summary(err));
      next(k8s_safe.error(err));
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
    }).catch(k8s_safe.fail(next));
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
      res.result = k8s_safe.wrapped(result);
      next( );
    }).catch(k8s_safe.fail(next));
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
      res.result = k8s_safe.wrapped(result);
      next( );
    }).catch(k8s_safe.fail(next));
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
    }).catch(k8s_safe.fail(next));
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
      msg.result = k8s_safe.summary_result(result);
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
        msg.result = k8s_safe.summary_result(result);
        console.log("replace or create", msg);
        res.header('Location', '/environs/' + body.metadata.name);
        res.result = result.body.data;
        next( );
      }).catch(function (err) {
        console.log('error replacing config map', k8s_safe.summary(err), body);
        next(k8s_safe.error(err));
      });
    }).catch(function (err) {
      console.log('first time creating?', k8s_safe.summary(err));
      k8s.createNamespacedConfigMap(selected_namespace, req.configmap).then(function (result) {
        msg.status = "createNamespacedConfigMap result"
        msg.result = k8s_safe.summary_result(result);
        console.log("replace or create", msg);
        var body = result.body;
        res.header('Location', '/environs/' + body.metadata.name);
        res.result = result.body.data;
        next( );
      }).catch(function (err) {
        console.log('error creating config map', k8s_safe.summary(err));
        next(k8s_safe.error(err));
      });
    });
  }

  function delete_configmap (req, res, next) {
    k8s.deleteNamespacedConfigMap(req.params.name, selected_namespace).then(function (result) {
      res.json(req.params.name);
      res.status(204);
      res.end( );
      next( );
    }).catch(k8s_safe.fail(next));
  }

  function patch_configmap_remove_field (req, res, next) {
    var targetConfigMap = req.params.name;
    var patch = { metadata: { } };
    patch.metadata[req.params.section] = { [req.params.field]:  null };
    var options = { headers: { "Content-Type": "application/merge-patch+json" } };
    k8s.patchNamespacedConfigMap(targetConfigMap, selected_namespace, patch, undefined, undefined, undefined, undefined, undefined, options)
    .then(function (result) {
      // res.result = null;

      res.status(204);
      res.end( );
      next( );
    }).catch(function (err) {
      console.log("ERROR PATCHING", k8s_safe.summary(err));
      next(k8s_safe.error(err));
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
      res.result = k8s_safe.wrapped(result);
      next( );
    }).catch(function (err) {
      next(k8s_safe.error(err));
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
  // server.get('/deployments/:name/env/:field', fetch_deployment, select_field, format_result );
  server.get('/deployments/:name/env', fetch_deployment, select_env, format_result );
  server.del('/deployments/:name', delete_deployment);
  server.get('/deployments', list_deployments, format_result);

  server.post('/sync/additions', suggest_deployment_template_params, suggest_deployment, handle_sync_addition, format_result);
  server.post('/sync/updates', handle_sync_updates, format_result);
  server.post('/sync/deletions', handle_sync_deletion);

  server.post('/consul/sync/additions', sync_consul_update, format_result);
  server.post('/consul/sync/updates', sync_consul_update, format_result);
  server.post('/consul/sync/deletions', sync_consul_deletion);

  // F5a (Q-CONSUL-REGISTER-MISSING): one pass that registers Running tenant
  // pods with no registration anywhere. Nothing runs it unless asked: the
  // consul operator calls it on MULTIENV_CONSUL_RECONCILE_INTERVAL, or an
  // operator by hand. Answers with the pass's counts.
  var consul_reconcile = consulReconcile({
    consul: consul,
    graceMs: opts.MULTIENV_CONSUL_RECONCILE_GRACE_MS,
    ratePerSec: opts.MULTIENV_CONSUL_RECONCILE_RATE,
    maxPerPass: opts.MULTIENV_CONSUL_RECONCILE_MAX,
    listPods: function ( ) {
      return k8s.listNamespacedPod(selected_namespace, undefined, undefined, undefined, undefined, opts.MULTIENV_CONSUL_RECONCILE_SELECTOR)
        .then(function (result) { return result.body.items || [ ]; });
    },
    register: function (pod, callback) {
      consul.agent.service.register(consul_registration(pod), function (err) { callback(err); });
    },
  });
  server.post('/consul/sync/reconcile', function (req, res, next) {
    consul_reconcile.runOnce( ).then(function (summary) {
      res.json(summary.skipped ? 409 : (summary.error ? 500 : 200), summary);
      next( );
    });
  });

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

  // the backends registration for one Running tenant pod (the pod must have
  // a tenant label; callers check that and that it isn't terminating)
  function consul_registration (serviceData) {
		const tenantName = serviceData.metadata.labels.tenant;
		const serviceID = `${tenantName}-${serviceData.metadata.namespace}`;
    var id = serviceData.metadata.uid;
    var host = serviceData.status.podIP;
    var port = 1337;
		var insert = {
			name: 'backends',
			address: host,
			port: port,
			id: id,
			tags: [ tenantName, serviceID, 'tenant', 'backend' ],
			// EndpointAvailable and ValidPodName; ValidPodName goes to the pod's
			// own sidecar only when this pod has one (lib/tenant-healthcheck.js).
			checks: tenant_healthcheck.consul_checks(serviceData, healthcheck, opts.MULTIENV_HEALTH_CHECK_SERVICE)
			/*
			{
				name: "ValidExpectedPort",
				ttl: '10s',
				interval: '5s',
				http: url.format({protocol: 'http', hostname: host, port: multienv.port,  pathname: ('/environs/' + name + '/assigned/PORT/' + port)}),
				failures_before_critical: 1,
				deregister_critical_service_after: '1m'
			},
			*/
		};
    return insert;
  }

  function sync_consul_update (req, res, next) {
		const serviceData = req.body.object;
    if (serviceData.status.phase != 'Running') {
      console.log("NOTHING TO DO SINCE POD IS NOT RUNNING", req.body);
      return next( );
    }
    if (serviceData.metadata.deletionTimestamp) {
      // A terminating pod still reports Running; re-registering it could
      // resurrect an entry its deletion event already removed (D-011).
      console.log("NOT REGISTERING TERMINATING POD", serviceData.metadata.name);
      return next( );
    }
    if (!serviceData.metadata.labels.tenant) {
      // gen4/isolate pods may lack the label; 7deafde registered these with
      // the tag "undefined" and a check URL that could never pass.
      console.log("NOT REGISTERING POD WITHOUT A tenant LABEL", serviceData.metadata.name);
      return next( );
    }
    var insert = consul_registration(serviceData);
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

  server.get('/healthchecks/pod/:name/assigned/podIP/:ip', assigned_ip_name_health_check);
  server.post('/healthchecks/pod/:name/adopt', function (req, res, next) {
    patch_sidecar(req, res, next, function (body, name) {
      return tenant_healthcheck.adopt_ops(body, healthcheck).length ? tenant_healthcheck.restart_and_adopt_ops(body, name, healthcheck) : [ ];
    });
  });
  server.del('/healthchecks/pod/:name/adopt', function (req, res, next) {
    patch_sidecar(req, res, next, function (body) {
      var ops = tenant_healthcheck.unadopt_ops(body);
      return ops.length ? tenant_healthcheck.guard(body, tenant_healthcheck.restart_ops(body).concat(ops)) : ops;
    });
  });

  // Add or remove one tenant's pod-healthcheck sidecar (canary and rollback,
  // independent of MULTIENV_TENANT_HEALTHCHECK).  Only for deployments whose
  // pod template carries tenant=<name>.  Responds with a summary only, never
  // the raw k8s result or error (OPS-039).
  function patch_sidecar (req, res, next, ops_for) {
    var name = req.params.name;
    read_deployment_body(name).then((body) => {
      if (!tenant_healthcheck.is_tenant_deployment(body, name)) {
        return { status: 422, ok: false, name: name, reason: 'not a tenant deployment' };
      }
      var patch = ops_for(body, name);
      if (!patch.length) return { ok: true, name: name, changed: false };
      return patch_deployment(name, patch)
        .then(( ) => ({ ok: true, name: name, changed: true, ops: patch.length }));
    }).then((summary) => {
      console.log('pod-healthcheck sidecar', req.method, summary);
      var status = summary.status || 200;
      delete summary.status;
      res.json(status, summary);
      next( );
    }).catch((err) => {
      console.log('pod-healthcheck sidecar', req.method, name, 'failed', k8s_status(err));
      send_k8s_error(res, next, name, err);
    });
  }
  server.get('/healthchecks/controller/self/:instance', function (req, res, next) {
    var ok = (req.params.instance == MULTIENV_SELF_ADDRESS);
    res.json(ok ? 200 : 500, { ok, status:  ok ? 'OK' : "bad", host: MULTIENV_SELF_ADDRESS });
    next( );
  });
  server.get('/about/server/status', function (req, res, next) {
    res.json({ ok: true, status: 'OK', host: MULTIENV_SELF_ADDRESS });
    next( );
  });
  return server;
}

module.exports = configure;

if (!module.parent) {
  var port = parseInt(process.env.PORT || '2828')
  var k8s_local = process.env.MULTIENV_K8S_AUTH == 'local';
  var MULTIENV_MANAGED_BY = process.env.MULTIENV_MANAGED_BY || 'multienv/k8s-deployment-controller';
  var MULTIENV_DEFAULT_COMPONENT_LABEL = process.env.MULTIENV_DEFAULT_COMPONENT_LABEL || 'config';
  var MULTIENV_DEFAULT_CONFIG_ROLE = process.env.MULTIENV_DEFAULT_CONFIG_ROLE || 'config-as-deploy';
  var MULTIENV_DEFAULT_APP_LABEL = (process.env.MULTIENV_DEFAULT_APP_LABEL || 'tenant');
  var MULTIENV_SELF_REGISTRATION_NAME = (process.env.MULTIENV_SELF_REGISTRATION_NAME || 'multienv-deployment-controller');
  var MULTIENV_SELF_ADDRESS = (process.env.POD_IP || process.env.HOSTNAME);
  var CONSUL = process.env.CONSUL || 'http://consul.service.consul';
  // Refuse to boot on an unusable image pin rather than fall back to :latest.
  nightscout_image.check_config(process.env);
  var config = {
    MULTIENV_K8S_NAMESPACE: process.env.MULTIENV_K8S_NAMESPACE || 'default',
    MULTIENV_TENANT_NODEPOOL_TARGET: process.env.MULTIENV_TENANT_NODEPOOL_TARGET || 'bigger-tenant-runners',
    MULTIENV_TENANT_REQUESTS_ENABLE: (process.env.MULTIENV_TENANT_REQUESTS_ENABLE ||'1') != 'false',
    MULTIENV_TENANT_LIMITS_ENABLE: (process.env.MULTIENV_TENANT_LIMITS_ENABLE ||'1') != 'false',
    MULTIENV_NIGHTSCOUT_IMAGE: process.env.MULTIENV_NIGHTSCOUT_IMAGE || nightscout_image.DEFAULT_IMAGE,
    MULTIENV_NIGHTSCOUT_IMAGE_PULL_POLICY: process.env.MULTIENV_NIGHTSCOUT_IMAGE_PULL_POLICY,
    MULTIENV_NIGHTSCOUT_IMAGE_REPOS: process.env.MULTIENV_NIGHTSCOUT_IMAGE_REPOS,
    MULTIENV_HEALTH_CHECK_SERVICE: (process.env.MULTIENV_HEALTH_CHECK_SERVICE || 'http://multienv-deployment-controller.service.consul:3000'),
    healthcheck: tenant_healthcheck.config(process.env),
    // F3 off: every repeated addition restarts the tenant, as before
    MULTIENV_SYNC_ADD_ALWAYS_RESTART: process.env.MULTIENV_SYNC_ADD_ALWAYS_RESTART == '1',
    // F5a, per pass (POST /consul/sync/reconcile)
    MULTIENV_CONSUL_RECONCILE_GRACE_MS: consulReconcile.parse_duration(process.env.MULTIENV_CONSUL_RECONCILE_GRACE || '2m'),
    MULTIENV_CONSUL_RECONCILE_RATE: parseFloat(process.env.MULTIENV_CONSUL_RECONCILE_RATE || '5'),
    MULTIENV_CONSUL_RECONCILE_MAX: parseInt(process.env.MULTIENV_CONSUL_RECONCILE_MAX || '200'),
    MULTIENV_CONSUL_RECONCILE_SELECTOR: process.env.MULTIENV_CONSUL_RECONCILE_SELECTOR || 'role=config-as-deploy,managed=multienv',
    requests: {
      cpu: process.env.MULTIENV_TENANT_REQUESTS_CPU || '5m',
      memory: process.env.MULTIENV_TENANT_REQUESTS_MEMORY || '120Mi'
    },
    limits: {
      cpu: process.env.MULTIENV_TENANT_LIMITS_CPU || '500m',
      memory: process.env.MULTIENV_TENANT_LIMITS_MEMORY || '500Mi'
    }
  , default: {
    deployment: {
      annotations: {
        'managed-by': MULTIENV_MANAGED_BY,
      },
      labels: {
        managed: 'multienv', app: MULTIENV_DEFAULT_APP_LABEL, // 'tenant',
        role: MULTIENV_DEFAULT_CONFIG_ROLE
      }
    }
  , configmap: {
      annotations: {
        'managed-by': MULTIENV_MANAGED_BY,
      },
      labels: {
        managed: 'multienv', app: MULTIENV_DEFAULT_APP_LABEL, // 'tenant',
        component: MULTIENV_DEFAULT_COMPONENT_LABEL,
        role: MULTIENV_DEFAULT_CONFIG_ROLE
      }
    }
  }
  };
  console.log('tenant healthcheck', JSON.stringify(tenant_healthcheck.describe(config.healthcheck)));
  var boot = require('bootevent')( );
  boot.acquire(function k8s (ctx, next) {
    var my = this;
    ctx.k8s = require('./lib/k8s')({cluster: !k8s_local});
    ctx.appsApi = require('./lib/k8s').get_appsApi({cluster: !k8s_local});
    ctx.k8s.getAPIResources( ).then(function (res) {
      console.log("CONNECTED", res.body.resources.length > 0);
      next( );
    }).catch(function (err) {
      console.log("FAILURE", k8s_safe.summary(err));
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
      var healthCheckService = url.parse(config.MULTIENV_HEALTH_CHECK_SERVICE);
      // Q-CONTROLLER-SELF-REG (F7, OPS-078): own service ID, re-registered on a timer.
      var registration = self_registration.create(ctx.consul, self_registration.options(process.env, {
        name: MULTIENV_SELF_REGISTRATION_NAME, address: MULTIENV_SELF_ADDRESS, port: healthCheckService.port
      }));
      console.log("CONNECTED TO CONSUL, REGISTERING SELF", registration.service.name, registration.service.id || '(no id)');
      registration.start(function (err) {
        console.log("REGISTERED", registration.service.name, registration.service.id || '(no id)', err ? err.message : 'ok');
        self_registration.deregister_on_exit(registration);
        next( );
      });
    });
  })
  .boot(function booted (ctx) {
    var server = configure(_.extend(config, { k8s: ctx.k8s, appsApi: ctx.appsApi, consul: ctx.consul }));
    server.listen(port, function ( ) {
      console.log('listening', this.address( ));
    });
  });
}
