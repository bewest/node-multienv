var k8slib = require("@kubernetes/client-node");
var ndjson = require('ndjson');
var _ = require('underscore');
var through = require('through2');
var transform = require('parallel-transform');

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

function emit_init (s) {
  function emit (data) {
    s.emit('initialized');
  }
  s.on('data', _.debounce(emit, 500));
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
  var greatestResource = 0;
  var lastSeen = null;
  return watch.watch('/api/v1/namespaces/default/configmaps', 
    // optional query parameters can go here.
    {
        allowWatchBookmarks: true
    },
    // callback is called for each received object.
    function (type, apiObj, watchObj) {
      console.log('latest', greatestResource, 'watching OBJ', arguments);
      if (type == 'ADDED') {
        var c = parseInt(apiObj.metadata.resourceVersion);
        if (c >  greatestResource) {
          console.log('new latest', c);
          greatestResource = c;
          lastSeen = apiObj;
        }
      }
    },
    // done callback is called if the watch terminates normally
    function (err) {
      console.log(err);
    }
  );
}

if (!module.parent) {
  var port = parseInt(process.env.PORT || '2929');
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
    var monitor = configure({ k8s: ctx.k8s, kc: ctx.kc });
    monitor.then(function (req) {
      console.log('req', req);
      req.on('end', console.log.bind(console, 'ENDED'));
      var jsonStream = toJSONStream( );
      emit_init(jsonStream);
      jsonStream.on('initialized', console.log.bind(console, "INITED!!"));
      var control = stream.pipeline(req,
        pre( ),
        jsonStream,
        takesTimeStream( ),
        post( ), console.log.bind(console, 'STREAM ENDED'));
    });
  });
}
