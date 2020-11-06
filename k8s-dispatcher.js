var k8slib = require("@kubernetes/client-node");
var ndjson = require('ndjson');
var _ = require('underscore');
var through = require('through2');
var transform = require('parallel-transform');
var got = require('got');
var url = require('url');

var stream = require('stream');


function toJSONStream ( ) {
  var s = ndjson.parse ( );
  // s.on('data', console.log.bind(console, 'parsed'));
  return s;
}

function naivePostToGateway (opts) {
  // each element in the stream describes a tenant

  function operation (update, callback) {
    var object = update.object;
    var endpoint = url.parse(opts.gateway);
    var name = object.metadata.name;
    var pathname = '/environs/' + name;
    var api = url.format({hostname: endpoint.hostname, port: endpoint.port, protocol: endpoint.protocol, pathname: pathname });
    var data = object.data;
    if (!data) {
      console.log('WRONG?!', name, update, data);
      return callback( );
    }

    data.internal_name = name;
    console.log(name, 'to gateway', name, api, object.metadata.name, object.metadata.resourceVersion);
    got.post(api, {json: data}).json( ).then( function (body) {
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
  var WATCH_LABELSELECTOR = process.env.WATCH_LABELSELECTOR || '';
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
        pre( ),
        // takesTimeStream( ),
        naivePostToGateway(gateway_opts),
        naiveGetFromGateway(gateway_opts),
        post( ), console.log.bind(console, 'STREAM ENDED'));
    }).catch(function (err) {
       boot.fail(err);
    });
  });
}
