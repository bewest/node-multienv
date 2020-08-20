var k8slib = require("@kubernetes/client-node");

function configure (opts) {
  var k8s = opts.k8s;
  var kc = opts.kc;
  var watch = new k8slib.Watch(kc);
  return watch.watch('/api/v1/namespaces/default/configmaps', 
    // optional query parameters can go here.
    {
        allowWatchBookmarks: true
    },
    // callback is called for each received object.
    function (type, apiObj, watchObj) {
      console.log('watching OBJ', arguments);
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
      console.log("finished init?");
    });
  });
}
