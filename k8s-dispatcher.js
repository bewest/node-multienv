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
  s.on('data', console.log.bind(console, 'parsed'));
  return s;
}

function takesTimeStream (opts) {
  function operation (update, callback) {
    var object = update.object;
    console.log('incoming', object.metadata.name, object.metadata.resourceVersion);
    setTimeout( function ( ) {
      console.log('outgoing', object.metadata.name, object.metadata.resourceVersion);
      callback(null, update);
    }, Math.random( ) * 1500);
  }

  var tr = transform(3, operation);
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
    var data = object.data;
    if (update.type == 'BOOKMARK') return callback(null);
    data.internal_name = name;
    console.log('posting to gateway', name, api, object.metadata.name, object.metadata.resourceVersion, object.data);
    got.post(api, {json: data}).json( ).then( function (body) {
      console.log('SUCCESSFUL POST', name, api, body);
      update.gateway = {err: null, success: body};
      callback(null, update);
    }).catch(function (err) {
      console.log("ERROR POST", name, api, arguments);
      update.gateway = {err: err};
      callback(null, update);
    });
  }

  var tr = transform(3, operation);
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
    console.log('getting health from gateway', api, object.metadata.name, object.metadata.resourceVersion, object.data);
    got(api).json( ).then( function (body) {
      console.log('SUCCESSFUL GET', name, api, body);
      update.health = {err: null, success: body};
      callback(null, update);
    }).catch(function (err) {
      console.log("ERROR GET", name, api, arguments);
      update.health = {err: err};
      callback(null, update);
    });
  }

  var tr = transform(3, operation);
  return tr;
}


function emit_init (s) {
  function emit (data) {
    s.emit('initialized');
    s.off('data', emitter);
  }
  var emitter = _.debounce(emit, 500);
  s.on('data', emitter);
}

function pre ( ) {
  var tr = through.obj(function (chunk, enc, callback) {
    callback(null, chunk);
  });
  tr.on('flush', console.log.bind(console, 'flush'));
  tr.on('drain', console.log.bind(console, 'DRAINED'));
  return tr;
}

function post ( ) {
  var tr = through.obj(function (chunk, enc, callback) {
    callback(null, chunk);
  });
  tr.on('flush', console.log.bind(console, 'flush'));
  tr.on('drain', console.log.bind(console, 'DRAINED'));
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
      console.log(type, apiObj.metadata.name, apiObj.metadata.resourceVersion);
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
  var CLUSTER_GATEWAY = process.env.CLUSTER_GATEWAY || 'http://localhost:2831';
  var WATCH_ENDPOINT = process.env.WATCH_ENDPOINT || '/api/v1/namespaces/default/configmaps';
  var WATCH_FIELDSELECTOR = process.env.WATCH_FIELDSELECTOR || '';
  var WATCH_LABELSELECTOR = process.env.WATCH_LABELSELECTOR || '';
  var WATCH_RESOURCEVERSION = process.env.WATCH_RESOURCEVERSION || '';
  var WATCH_CONTINUE = process.env.WATCH_CONTINUE || '';
  var gateway_opts = {
    gateway: CLUSTER_GATEWAY
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
    ctx.k8s = require('./lib/k8s')( );
    ctx.kc = require('./lib/k8s').get_kc( );
    ctx.k8s.listNamespace( ).then(function (res) {
      next( );
    }).catch(my.fail);
  })
  .boot(function booted (ctx) {
    var monitor = configure({ k8s: ctx.k8s, kc: ctx.kc, watch: watch_opts });
    monitor.then(function (req) {
      console.log('req', req);
      req.on('end', console.log.bind(console, 'ENDED'));
      var jsonStream = toJSONStream( );
      emit_init(jsonStream);
      jsonStream.once('initialized', console.log.bind(console, "INITED!!"));
      var control = stream.pipeline(req,
        pre( ),
        jsonStream,
        // takesTimeStream( ),
        naivePostToGateway(gateway_opts),
        naiveGetFromGateway(gateway_opts),
        post( ), console.log.bind(console, 'STREAM ENDED'));
    });
  });
}
