var k8slib = require("@kubernetes/client-node");
var ndjson = require('ndjson');
var _ = require('underscore');
var through = require('through2');
var transform = require('parallel-transform');
var got = require('got');
var url = require('url');
var path = require('path');
// never log raw k8s client results/errors: they carry the service-account
// token (OPS-039, D-009)
var k8s_safe = require('./lib/k8s-safe');
var resumableWatch = require('./lib/resumable-watch');

var stream = require('stream');

const randomRange = (min, max) => Math.floor(Math.random() * (max - min)) + min;

function toJSONStream ( ) {
  var s = ndjson.parse ( );
  // s.on('data', console.log.bind(console, 'parsed'));
  return s;
}

function slowRateStream (opts) {

  var min = opts.randomMin || 0;
  var max = opts.randomMax || 300;
  var default_delay = opts.delay || 500;
  function operation (update, callback) {

    var time_to_take = default_delay;
    if (opts.random) {
      time_to_take += randomRange(min, max);
    }
    function operate ( ) {
      callback(null, update);
    }
    if (default_delay) {
      return setTimeout(operate, time_to_take);
    }
    return operate( );
  }

  var tr = transform(opts.parallel, operation);
  return tr;
}

function naivePostToGateway (opts) {
  // each element in the stream describes a tenant

  function operation (update, callback) {
    var object = update.object;
    var endpoint = url.parse(opts.gateway);
    var name = object.metadata.name;
    var pathname = '/environs/' + name;
    var api = url.format({hostname: endpoint.hostname, port: endpoint.port, protocol: endpoint.protocol, pathname: pathname });
    var method = update.type == 'DELETED' ?  got.delete : got.post;
    var data = object.data;
    if (!data) {
      console.log('WRONG?!', name, update, data);
      return callback( );
    }

    data.internal_name = name;
    console.log(name, 'to gateway', name, api, object.metadata.name, object.metadata.resourceVersion);
    method(api, {json: data}).json( ).then( function (body) {
      console.log(name, 'SUCCESSFUL', api);
      update.gateway = {err: null, success: body};
      callback(null, update);
    }).catch(function (err) {
      console.log(name, "ERROR POST", name, api, k8s_safe.summary(err));
      update.gateway = {err: err};
      callback(null, update);
    });
  }

  var tr = transform(opts.parallel, operation);
  return tr;
}


function syncPostToController (opts) {
  // Per-object ordering (RC1 review of F4). parallel-transform keeps output
  // order, not the order requests reach the controller, and a retry can hold
  // its slot for minutes: an ADDED being retried could land after a later
  // DELETED for the same object and bring the tenant back. So events for one
  // object (namespace/name) are sent one at a time, in arrival order, and a
  // failed event stops retrying once a DELETED for that object is queued
  // behind it. (Any other newer event waits its turn: an ADDED being retried
  // must still land before a later MODIFIED, which doesn't create.)
  var queues = { };
  var sequence = 0;
  function operation (update, callback) {
    var object = update.object;
    var endpoint = url.parse(opts.gateway);
    var url_prefix = endpoint.pathname;
    var name = object.metadata.name;
    // var pathname = '/environs/' + name;
    // Determine the appropriate endpoint based on the update type
    let pathname;
    switch (update.type) {
        case 'ADDED':
            pathname = path.join(url_prefix, '/sync/additions');
            break;
        case 'MODIFIED':
            pathname = path.join(url_prefix, '/sync/updates');
            break;
        case 'DELETED':
            pathname = path.join(url_prefix, '/sync/deletions');
            break;
        default:
            console.error('Unknown update type:', update.type);
            return callback(); // Skip processing for unknown types
    }
    var api = url.format({hostname: endpoint.hostname, port: endpoint.port, protocol: endpoint.protocol, pathname: pathname });
    // var method = update.type == 'DELETED' ?  got.delete : got.post;

    var key = (object.metadata.namespace || '') + '/' + name;
    var queue = queues[key] || (queues[key] = { latest: 0, tail: Promise.resolve( ) });
    var mine = ++sequence;
    queue.latest = mine;
    queue.deleted = update.type == 'DELETED' ? mine : (queue.deleted || 0);
    // an older event for this object waiting out a retry delay gives way now
    if (queue.wake && update.type == 'DELETED') { queue.wake( ); }
    function superseded ( ) { return queue.deleted > mine; }
    var release;
    var previous = queue.tail;
    queue.tail = new Promise(function (resolve) { release = resolve; });
    function finish (result) {
      if (queue.latest === mine) { delete queues[key]; }
      release( );
      callback(null, result);
    }

    console.log(name, 'to gateway', name, api, object.metadata.name, object.metadata.resourceVersion);
    // F4 (OPS-073): a failed POST used to be logged and dropped. Retry
    // connection errors, timeouts, 408, 429 and 5xx with backoff; this holds
    // one of the parallel slots, so a controller outage slows the watch
    // instead of losing its events.
    var retries = opts.retries || 0;
    function attempt (n) {
      if (n > 0 && superseded( )) {
        // a DELETED for this object arrived while this one waited to retry
        console.log(name, 'SUPERSEDED POST, a deletion of this object is queued', api);
        update.gateway = {err: null, superseded: true};
        return finish(update);
      }
      got.post(api, {json: update, timeout: opts.timeout, retry: 0}).json( ).then( function (body) {
        console.log(name, 'SUCCESSFUL', api);
        update.gateway = {err: null, success: body};
        finish(update);
      }).catch(function (err) {
        console.log(name, "ERROR POST", name, api, k8s_safe.summary(err));
        var status = err && err.response && err.response.statusCode;
        var retryable = !status || status == 408 || status == 429 || status >= 500;
        if (retryable && superseded( )) {
          console.log(name, 'SUPERSEDED POST, a deletion of this object is queued', api);
          update.gateway = {err: err, superseded: true};
          return finish(update);
        }
        if (retryable && n < retries) {
          var delay = Math.min(opts.retryMaxMs || 60000, (opts.retryBaseMs || 4000) * Math.pow(2, n));
          console.log(name, 'RETRY POST', n + 1, 'of', retries, 'in', delay, 'ms', api);
          var timer = setTimeout(function ( ) { queue.wake = null; attempt(n + 1); }, delay);
          queue.wake = function ( ) { clearTimeout(timer); queue.wake = null; attempt(n + 1); };
          return;
        }
        if (retryable) {
          console.log(name, 'DROPPED POST after', n + 1, 'attempts', api);
        }
        update.gateway = {err: err};
        finish(update);
      });
    }
    previous.then(function ( ) { attempt(0); });
  }

  var tr = transform(opts.parallel, operation);
  return tr;
}

// F5a (Q-CONSUL-REGISTER-MISSING): this process is the single consul
// operator, so it is the one place that asks the controller for a
// register-missing pass. The first pass comes one full interval after start,
// so a restarting or overlapping operator pod doesn't add passes.
var reconcile_timer = null;
function startReconcileTimer (opts) {
  if (reconcile_timer || !(opts.interval > 0)) { return; }
  var endpoint = url.parse(opts.gateway);
  var api = url.format({hostname: endpoint.hostname, port: endpoint.port, protocol: endpoint.protocol,
    pathname: path.join(endpoint.pathname, '/sync/reconcile') });
  console.log('CONSUL RECONCILE every', opts.interval, 'ms via', api);
  reconcile_timer = setInterval(function ( ) {
    got.post(api, {json: { }, timeout: opts.timeout, retry: 0}).json( ).then(function (summary) {
      console.log('CONSUL RECONCILE', JSON.stringify(summary));
    }).catch(function (err) {
      var body = err && err.response && err.response.body;
      console.log('CONSUL RECONCILE FAILED', err && err.response && err.response.statusCode, typeof body == 'string' ? body.slice(0, 300) : k8s_safe.summary(err));
    });
  }, opts.interval);
}

function naiveGetFromGateway (opts) {
  // each element in the stream describes a tenant

  function operation (update, callback) {
    var object = update.object;
    var endpoint = url.parse(opts.gateway);
    var name = object.metadata.name;
    var pathname = '/environs/' + name;
    var api = url.format({hostname: endpoint.hostname, port: endpoint.port, protocol: endpoint.protocol, pathname: pathname });
    var data = object.data;
    console.log(name, 'getting health from gateway', api, object.metadata.resourceVersion, object.data.WEB_NAME);
    got(api).json( ).then( function (body) {
      console.log(name, 'successful GET', api);
      update.health = {err: null, success: body};
      callback(null, update);
    }).catch(function (err) {
      console.log(name, "ERROR GET", api, k8s_safe.summary(err));
      update.health = {err: err};
      callback(null, update);
    });
  }

  var tr = transform(opts.parallel, operation);
  return tr;
}


function emit_init (s) {
  var done = false;
  function emit (data) {
    if (!done) s.emit('initialized');
    done = true;
    // s.off('data', emitter);
  }
  var emitter = _.debounce(emit, 500);
  s.on('data', emitter);
}

function inspectBookmarks (opts, k8s) {
  var tr_opts = {
    highWaterMark: 32000
  };
  var bookmarkName = opts.bookmarkName;
  var bookmarkNamespace = opts.bookmarkNamespace;
  var deleteStaleBookmark = opts.deleteStaleBookmark;

  function iterate (chunk, callback) {
    if (chunk.type != 'ERROR') {
      this.push(chunk);
      return setImmediate(function ( ) {
        callback( );
      });
    }

    var err = chunk;
    if ('Failure' == chunk.object.status && 'Expired' == chunk.object.reason) {
      console.log("EXPIRED resourceVersion", chunk);
      return k8s.readNamespacedConfigMap(bookmarkName, bookmarkNamespace).then(function (result) {
        console.log('EXISTING BOOKMARK equivalent?', opts, opts.resourceVersion, result.body.data.resourceVersion, opts.resourceVersion == result.body.data.resourceVersion);
        console.log('EXISTING BOOKMARK', result.body);
        if (deleteStaleBookmark) {
          return k8s.deleteNamespacedConfigMap(bookmarkName, bookmarkNamespace).then(function (result) {
            console.log('REMOVED BOOKMARK', result.body);
            callback(err);
          });
        }
        return callback(err);
      }).catch(function (missing) {
        console.log('NO EXISTING BOOKMARK', bookmarkName, bookmarkNamespace, k8s_safe.summary(missing));
        callback(err);
      });

    }
    console.log("UNRECOGNIZED ERROR", err)
    callback(err);

  };
  var tr = transform(opts.parallel || 16, tr_opts, iterate);
  return tr;
}

function saveBookMark (opts, k8s) {
  var tr_opts = {
    highWaterMark: 32000,
  };
  var bookmarkName = opts.bookmarkName;
  var bookmarkNamespace = opts.bookmarkNamespace;

  var tr = through.obj(tr_opts, function (chunk, enc, callback) {
    if (chunk.type != 'BOOKMARK') {
      this.push(chunk);
      return setImmediate(function ( ) {
        callback( );
      });
    }

    console.log("SAVING BOOKMARK", chunk);
    k8s.readNamespacedConfigMap(bookmarkName, bookmarkNamespace).then(function (result) {
      var body = result.body;
      console.log("OLD BOOKMARK", body);
      body.data.resourceVersion = chunk.object.metadata.resourceVersion;
      body.data.WATCH_RESOURCEVERSION = chunk.object.metadata.resourceVersion;
      return k8s.replaceNamespacedConfigMap(bookmarkName, bookmarkNamespace, body).then(function (result) {
        console.log("SAVED NEW BOOKMARK", bookmarkName, bookmarkNamespace, result.body);
        return callback( );
      });
    }).catch(function (err) {
      console.log("BOOKMARK DOES NOT EXIST, WILL CREATE");
      var body = {
        kind: 'ConfigMap',
        metadata: {
          name: bookmark_config.bookmarkName,
          labels: {
            app: 'dispatcher',
            config: 'bookmark'
          },
          type: 'BOOKMARK'
        },
        data: {
          resourceVersion: chunk.object.metadata.resourceVersion
        , WATCH_RESOURCEVERSION:  chunk.object.metadata.resourceVersion
        }

      };
      k8s.createNamespacedConfigMap(bookmark_config.bookmarkNamespace, body).then(function (res) {
        console.log("CREATED BOOKMARK CONFIGMAP", res.body);
        return callback( );
      }).catch(function (err) {
        console.log("COULD NOT CREATE BOOKMARK CONFIGMAP", bookmark_config, k8s_safe.summary(err));
        return callback( );

      });
    });

  });
  return tr;
}

function ignoreBookMark (opts, k8s) {
  var tr_opts = {
    highWaterMark: 32000,
  };
  var bookmarkName = opts.bookmarkName;
  var bookmarkNamespace = opts.bookmarkNamespace;

  var tr = through.obj(tr_opts, function (chunk, enc, callback) {
    if (chunk.type != 'BOOKMARK') {
      this.push(chunk);
    } else {
      console.log("IGNORING BOOKMARK", chunk);
    }
    return setImmediate(function ( ) {
      callback( );
    });

  });
  return tr;
}


function pre (options) {
  var opts = {
    highWaterMark: 32000,
  };
  var tr = through.obj(opts, function (chunk, enc, callback) {
    console.log(chunk.object.metadata.name, 'begin', chunk.type);
    var self = this;
    if (options.filter_none || chunk.object.data) {
      this.push(chunk);
    } else {
      console.log('DROPPING', chunk);
    }
    setImmediate(function ( ) {
      callback( );
    });
  });
  return tr;
}

function post ( ) {
  var tr = through.obj(function (chunk, enc, callback) {
    console.log(chunk.object.metadata.name, 'done', chunk.type);
    var self = this;
    setImmediate(function ( ) {
      // This is the destination stream, just drop everything so 
      // we don't hog memory.
      // self.push(chunk);
      callback( );
    });
  });
  return tr;
}

function configure (opts) {
  var k8s = opts.k8s;
  var kc = opts.kc;
  var watch = new k8slib.Watch(kc);
  // optional query parameters can go here.
  // fieldSelector
  // labelSelector
  // namespace
  // resourceVersion
  // continue
  // allowWatchBookmarks
  var config = _.pick(opts.watch, 'fieldSelector', 'labelSelector', 'resourceVersion', '_continue');
  var api_endpoint = opts.watch.endpoint; // '/api/v1/namespaces/default/configmaps'
  var params = _.extend(config, { allowWatchBookmarks: true });
  return watch.watch(api_endpoint, params,
    // callback is called for each received object.
    function (type, apiObj, watchObj) {

      // just log it as seen for now
      // most handling and processing is done in streams in order to handle
      // control flow and instruentation for observability.
      console.log(apiObj.metadata.name, 'audit', type, apiObj.metadata.resourceVersion);
      if (type == 'BOOKMARK') {
        console.log('BOOKMARK -> _continue', apiObj);
      }
    },
    // done callback is called if the watch terminates normally
    function (err) {
      console.log(err && k8s_safe.summary(err));
    }
  );
  // function predicate (data) { }
}

if (!module.parent) {
  var port = parseInt(process.env.PORT || '2929');
  var k8s_local = process.env.MULTIENV_K8S_AUTH == 'local';
  var CLUSTER_GATEWAY = process.env.CLUSTER_GATEWAY || 'http://localhost:2831';
  var WATCH_NAMESPACE = process.env.MULTIENV_K8S_NAMESPACE || 'default';
  var WATCH_ENDPOINT = process.env.WATCH_ENDPOINT || ('/api/v1/namespaces/' + WATCH_NAMESPACE + '/configmaps');
  var WATCH_FIELDSELECTOR = process.env.WATCH_FIELDSELECTOR || '';
  var WATCH_LABELSELECTOR = process.env.WATCH_LABELSELECTOR || 'app=tenant,managed=multienv';
  var WATCH_RESOURCEVERSION = process.env.WATCH_RESOURCEVERSION || '';
  var WATCH_CONTINUE = process.env.WATCH_CONTINUE || '';
  var INIT_WITH_FULL_AUDIT = process.env.INIT_WITH_FULL_AUDIT == '1';
  var SYNC_CONTROLLER = process.env.SYNC_CONTROLLER || 'runner'; // default, deployment, consul
  var SYNC_DEPLOYMENT_CONTROLLER = process.env.SYNC_DEPLOYMENT_CONTROLLER == '1';
  var gateway_opts = {
    gateway: CLUSTER_GATEWAY,
    parallel: parseInt(process.env.PARALLEL_UPDATES || '12'),
    highWaterMark: 100,
    // F4: about 2 minutes of retries by default
    retries: parseInt(process.env.MULTIENV_POST_RETRIES || '5'),
    retryBaseMs: parseInt(process.env.MULTIENV_POST_RETRY_BASE_MS || '4000'),
    retryMaxMs: parseInt(process.env.MULTIENV_POST_RETRY_MAX_MS || '60000'),
    timeout: parseInt(process.env.MULTIENV_POST_TIMEOUT_MS || '60000'),
  };
  // F1/F2 (OPS-036, OPS-071, OPS-073): resume an ended watch in-process.
  // MULTIENV_WATCH_EXIT_ON_END=1 brings back the old exit-and-restart when a
  // watch ends; it doesn't restore the rest of 7deafde (the startup list, the
  // 410 re-list, failure backoff and per-object POST ordering stay).
  var resume_opts = {
    exitOnEnd: process.env.MULTIENV_WATCH_EXIT_ON_END == '1',
    backoffMs: parseInt(process.env.MULTIENV_WATCH_BACKOFF_MS || '1000'),
    maxBackoffMs: parseInt(process.env.MULTIENV_WATCH_MAX_BACKOFF_MS || '30000'),
    maxFailures: parseInt(process.env.MULTIENV_WATCH_MAX_FAILURES || '10'),
    maxRelistDeletes: parseInt(process.env.MULTIENV_RELIST_MAX_DELETES || '20'),
  };
  // what to list again after a 410; other endpoints exit on 410
  var WATCHED = WATCH_ENDPOINT.match(/^\/api\/v1\/namespaces\/([^/]+)\/(pods|configmaps)$/);
  var watch_opts = {
    fieldSelector: WATCH_FIELDSELECTOR
  , labelSelector: WATCH_LABELSELECTOR
  , resourceVersion: WATCH_RESOURCEVERSION
  , _continue: WATCH_CONTINUE
  , endpoint: WATCH_ENDPOINT
  , sendInitialEvents: true
  , watch: WATCH_RESOURCEVERSION
  , allowWatchBookmarks: true
  };

  var delay_opts = {
    parallel: parseInt(process.env.DELAY_CROWD_PARALLEL || '1')
  , random: process.env.DELAY_CROWD_NO_RANDOM_EXTRA == '1' ? false : true
  , randomMin: parseInt(process.env.DELAY_CROWD_EXTRA_MIN || '0')
  , randomMax: parseInt(process.env.DELAY_CROWD_EXTRA_MAX || '300')
  , delay: parseInt(process.env.DELAY_CROWD_INTERVAL_MS || '100')

  };

  var bookmark_config = {
    bookmarkName: process.env.BOOKMARK_NAME || 'dispatcher-bookmark'
  , bookmarkNamespace: WATCH_NAMESPACE
  , resourceVersion: watch_opts.resourceVersion

  }

  var filter_opts = {
    filter_none: process.env.FILTER_NONE == '1'
  };

  // F5a: e.g. 10m on the consul operator only; unset is off
  var reconcile_opts = {
    gateway: CLUSTER_GATEWAY,
    interval: require('./lib/consul-reconcile').parse_duration(process.env.MULTIENV_CONSUL_RECONCILE_INTERVAL) || 0,
    timeout: 5 * 60 * 1000,
  };

  function businessStreamsFor (controller) {
    switch(controller) {
      case 'deployment':
        return [ syncPostToController(gateway_opts) ];
      case 'consul':
        // return [ syncDeploymentToConsul(gateway_opts) ];
        return [ syncPostToController(gateway_opts) ];
      case 'default':
      case 'runner':
      default:
        return [ naivePostToGateway(gateway_opts), naiveGetFromGateway(gateway_opts) ];
    }
  }

  var boot = require('bootevent')( );
  boot.acquire(function k8s (ctx, next) {
    var my = this;
    ctx.k8s = require('./lib/k8s')({cluster: !k8s_local});
    ctx.kc = require('./lib/k8s').get_kc( );
    ctx.k8s.getAPIResources( ).then(function (res) {
      console.log("CONNECTED", res.body.resources.length > 0);
      next( );
    }).catch(function (err) {
      // what bootevent's fail does, without the raw error
      console.error(k8s_safe.summary(err));
      process.exit(1);
    });
  })
  .acquire(function list_watched (ctx, next) {
    // everything the watch selects, for the first resourceVersion and to
    // compare against after a 410 (F2)
    ctx.list = WATCHED && function list ( ) {
      var ns = WATCHED[1];
      var call = WATCHED[2] == 'pods' ? ctx.k8s.listNamespacedPod : ctx.k8s.listNamespacedConfigMap;
      return call.call(ctx.k8s, ns, false, false, undefined, WATCH_FIELDSELECTOR, WATCH_LABELSELECTOR).then(function (result) {
        return result.body;
      });
    };
    next( );
  })
  .acquire(async function describe_latest_resource_version (ctx, next) {

    // Get latest resourceVersion, along with a count of active changes
    ctx.seed = [ ];
    if (INIT_WITH_FULL_AUDIT) {
      // the first watch starts without a resourceVersion: every object
      // arrives as ADDED
      watch_opts.resourceVersion = '';
      console.log("FULL AUDIT: watching from the start");
      return next( );
    }
    let body;
    try {
      if (ctx.list) {
        body = await ctx.list( );
        ctx.seed = body.items || [ ];
      } else {
        body = (await ctx.k8s.listNamespacedConfigMap(WATCH_NAMESPACE, false, false, undefined, WATCH_FIELDSELECTOR, WATCH_LABELSELECTOR, 1, undefined, undefined, undefined,  undefined, undefined, {})).body;
      }
    } catch (err) {
      // was an unhandled rejection: Node printed the whole HttpError (token
      // included) and exited
      console.error(k8s_safe.summary(err));
      return process.exit(1);
    }
    console.log("FOUND LATEST", body.metadata.resourceVersion, (body.items || [ ]).length, 'objects');
    watch_opts.resourceVersion = body.metadata.resourceVersion;
    next( );

  })
  .boot(function booted (ctx) {
    startReconcileTimer(reconcile_opts);
    var watcher = resumableWatch(_.extend({ }, resume_opts, {
      watch: new k8slib.Watch(ctx.kc),
      list: ctx.list,
      endpoint: WATCH_ENDPOINT,
      params: _.pick(watch_opts, 'fieldSelector', 'labelSelector'),
      resourceVersion: watch_opts.resourceVersion,
      seed: ctx.seed,
      onFatal: function (code, reason) {
        console.log(reason, watcher && watcher.counters);
        process.exit(code);
      },
    }));
    console.log('started watch', _.omit(watch_opts, 'watch'));
    var events = watcher.source;
    emit_init(events);
    events.once('initialized', console.log.bind(console, "INITED!!"));
    var control = stream.pipeline(events,
      // inspectBookmarks(bookmark_config, ctx.k8s),
      // saveBookMark(bookmark_config, ctx.k8s),
      ignoreBookMark(bookmark_config, ctx.k8s),
      pre(filter_opts),
      slowRateStream(delay_opts),
      ...businessStreamsFor(SYNC_CONTROLLER),
      // naivePostToGateway(gateway_opts),
      // naiveGetFromGateway(gateway_opts),
      post( ),
      function ended (err) {
        // the event stream only ends on a fatal watch error, which exits
        console.log('STREAM ENDED', err && k8s_safe.summary(err));
        process.exit(err ? 1 : 0);
      }
      );
  });
}
