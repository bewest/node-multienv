var k8slib = require("@kubernetes/client-node");
var ndjson = require('ndjson');
var _ = require('underscore');
var through = require('through2');
var transform = require('parallel-transform');
var got = require('got');
var url = require('url');

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
      console.log(name, "ERROR POST", name, api, arguments);
      update.gateway = {err: err};
      callback(null, update);
    });
  }

  var tr = transform(opts.parallel, operation);
  return tr;
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
      console.log(name, "ERROR GET", api, arguments);
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
        var err.bookmark = result.body;
        console.log('EXISTING BOOKMARK', result.body);
        if (deleteStaleBookmark) {
          return k8s.deleteNamespacedConfigMap(bookmarkName, bookmarkNamespace).then(function (result) {
            console.log('REMOVED BOOKMARK', result.body);
            callback(err);
          });
        }
        return callback(err);
      }).catch(function (missing) {
        console.log('NO EXISTING BOOKMARK', bookmarkName, bookmarkNamespace, missing);
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
        console.log("COULD NOT CREATE BOOKMARK CONFIGMAP", bookmark_config, err);
        return callback( );

      });
    });

  });
  return tr;
}


function pre ( ) {
  var opts = {
    highWaterMark: 32000,
  };
  var tr = through.obj(opts, function (chunk, enc, callback) {
    console.log(chunk.object.metadata.name, 'begin', chunk.type);
    var self = this;
    if (chunk.object.data) {
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
      console.log(err);
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
  var gateway_opts = {
    gateway: CLUSTER_GATEWAY,
    parallel: parseInt(process.env.PARALLEL_UPDATES || '12'),
    highWaterMark: 100,
  };
  var watch_opts = {
    fieldSelector: WATCH_FIELDSELECTOR
  , labelSelector: WATCH_LABELSELECTOR
  , resourceVersion: WATCH_RESOURCEVERSION
  , _continue: WATCH_CONTINUE
  , endpoint: WATCH_ENDPOINT
  };

  var delay_opts = {
    parallel: parseInt(process.env.DELAY_CROWD_PARALLEL || '1')
  , random: process.env.DELAY_CROWD_NO_RANDOM_EXTRA == '1' ? false : true
  , randomMin: parseInt(process.env.DELAY_CROWD_EXTRA_MIN || '0')
  , randomMax: parseInt(process.env.DELAY_CROWD_EXTRA_MAX || '300')
  , delay: parseInt(process.env.DELAY_CROWD_INTERVAL_MS || '666')

  };

  var bookmark_config = {
    bookmarkName: process.env.BOOKMARK_NAME || 'dispatcher-bookmark'
  , bookmarkNamespace: WATCH_NAMESPACE
  , resourceVersion: watch_opts.resourceVersion

  }

  function start (retried, max, errors) {
    if (retried >= max) {
      console.log("EXITING AFTER ERRORS", retried, errors);
      return process.exit(1);
    }
    if (retried) {
      console.log("RETRYING AFTER ERROR", retried, errors);
    }
    var boot = require('bootevent')( );
    boot.acquire(function k8s (ctx, next) {
      var my = this;
      ctx.k8s = require('./lib/k8s')({cluster: !k8s_local});
      ctx.kc = require('./lib/k8s').get_kc( );
      ctx.k8s.getAPIResources( ).then(function (res) {
        console.log("CONNECTED", res.body.resources.length > 0);
        next( );
      }).catch(my.fail);
    })
    .boot(function booted (ctx) {
      var monitor = configure({ k8s: ctx.k8s, kc: ctx.kc, watch: watch_opts });
      monitor.then(function (req) {
        console.log('started watch', watch_opts, req.url);
        // console.log('req', req);
        req.on('end', console.log.bind(console, 'ENDED'));
        var jsonStream = toJSONStream( );
        emit_init(jsonStream);
        jsonStream.once('initialized', console.log.bind(console, "INITED!!"));
        var control = stream.pipeline(req,
          jsonStream,
          inspectBookmarks(bookmark_config, ctx.k8s),
          saveBookMark(bookmark_config, ctx.k8s),
          pre( ),
          // takesTimeStream( ),
          slowRateStream(delay_opts),
          naivePostToGateway(gateway_opts),
          naiveGetFromGateway(gateway_opts),
          post( ),
          function ended (err) {
            console.log('STREAM ENDED', err)
            if (err) {
              if (err.type == 'ERROR' && err.object.reason == 'Expired' && watch_opts.resourceVersion != '') {
                watch_opts.resourceVersion = '';
                bookmark_config.resourceVersion = '';
                console.log("Retrying without resourceVersion", watch_opts);
              }
              errors.push(err);
            }
            console.log('restarting...');
            return start(retried + 1, max, errors);
          }
          );
      }).catch(function (err) {
        boot.fail(err);
      });
    });
  }
  start(0, 2, []);
}
