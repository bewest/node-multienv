
var restify = require('restify');

function createServer (opts) {
  var cluster = opts.cluster;
  var master = opts.create;
  var server = restify.createServer(opts);

  server.get('/cluster', function (req, res, next) {
    var h = { };
    var worker;
    for (var id in cluster.workers) {
      worker = cluster.workers[id];
      var v = {
        id: id
      , custom_env: worker.custom_env
      , state: worker.state
      , isDead: worker.isDead && worker.isDead( )
      , url: "http://" + [ 'localhost', worker.custom_env.PORT ].join(':') + '/'
      , status_url: "http://" + [ 'localhost', worker.custom_env.PORT ].join(':') + '/api/v1/status.json'
      };
      
      // console.log(worker);
      h[id] = v;
    }
    res.send(h);
    next( );
    
  });

  server.get('/history', function (req, res, next) {
    var h = { };
    var worker;
    for (var file in master.handlers) {
      worker = master.handlers[file].worker;
      // console.log(worker);
      var v = {
        id: worker.id
      , custom_env: worker.custom_env
      , state: worker.state
      , isDead: worker.isDead && worker.isDead( )
      // , url: "http://" + [ 'localhost', worker.custom_env.PORT ].join(':') + '/'
      // , status_url: "http://" + [ 'localhost', worker.custom_env.PORT ].join(':') + '/api/v1/status.json'
      };
      
      h[file] = v;
    }
    res.send(h);
    next( );
    
  });

  server.get('/environs', function (req, res, next) {
    master.scan(master.env, function iter (err, environs) {
      var h = { };
      var worker;
      for (var i in environs) {
        var environ = environs[i];
        var file = environ.envfile;
        worker = master.handlers[file].worker || { };
        // console.log(worker);
        var v = {
          id: worker.id || null
        , custom_env: worker.custom_env || environ
        , state: worker.state || 'missing'
        , isDead: worker.isDead && worker.isDead( )
        // , url: "http://" + [ 'localhost', worker.custom_env.PORT ].join(':') + '/'
        // , status_url: "http://" + [ 'localhost', worker.custom_env.PORT ].join(':') + '/api/v1/status.json'
        };
        
        h[file] = v;
      }
      res.send(h);
      next( );
    });
  });

  return server;
}

exports = module.exports = createServer;

