
var restify = require('restify');
var fs = require('fs');
var path = require('path');

function createServer (opts) {
  var cluster = opts.cluster;
  var master = opts.create;
  var server = restify.createServer(opts);

  server.use(restify.queryParser( ));
  server.use(restify.bodyParser( ));

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

  server.get('/resolve/:id', function (req, res, next) {
    var id = parseInt(req.params.id);
    var worker = cluster.workers[id] || {custom_env: { }, state: 'missing'};
    console.log('worker', worker);
    var v = {
      id: id
    , state: worker.state
    , name: path.basename(worker.custom_env.envfile, '.env')
    , url: "http://" + [ 'localhost', worker.custom_env.PORT ].join(':') + '/'
    , port: worker.custom_env.PORT
    , status_url: "http://" + [ 'localhost', worker.custom_env.PORT ].join(':') + '/api/v1/status.json'
    };

    console.log(req.url, req.headers);
    res.header('X-Backend-State', v.state);
    res.header('X-Backend-Name', v.name);
    res.header('X-Backend', v.url);
    res.end( );
    next( );
  });

  server.get('/resolve/:id/test', function (req, res, next) {
    var id = parseInt(req.params.id);
    var worker = cluster.workers[id] || {custom_env: { }, state: 'missing'};
    var port = worker.custom_env.PORT;
    console.log('worker', port, worker);
    var v = {
      id: id
    , state: worker.state
    , envfile: worker.custom_env.envfile
    , name: path.basename(worker.custom_env.envfile, '.env')
    , port: port
    , url: "http://" + [ 'localhost', port ].join(':') + '/'
    , status_url: "http://" + [ 'localhost', port ].join(':') + '/api/v1/status.json'
    };
    console.log(req.url, req.headers);
    res.header('X-Backend-State', v.state);
    res.header('X-Backend-Name', v.name);
    res.header('X-Backend', v.url);
    // var internal = '/x-accel-redirect/' + v.port + '/api/v1/status.json';
    var internal = '@proxy/' + v.port + '/' + v.id;
    console.log('internal!', internal);
    res.header('x-accel-redirect', internal);
    res.end( );
    next( );
  });

  server.get('/cluster/:id', function (req, res, next) {
    var h = { };
    var worker = cluster.workers[req.params.id];
    var v = {
      id: id
    , custom_env: worker.custom_env
    , state: worker.state
    , isDead: worker.isDead && worker.isDead( )
    , url: "http://" + [ 'localhost', worker.custom_env.PORT ].join(':') + '/'
    , status_url: "http://" + [ 'localhost', worker.custom_env.PORT ].join(':') + '/api/v1/status.json'
    };

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
        var handler = master.handlers[file];
        var worker = handler ? handler.worker : { };
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

  server.get('/environs/:name', function (req, res, next) {
    var file = path.resolve(master.env.WORKER_ENV, path.basename(req.params.name + '.env'));
    var handler = master.handlers[file];
    var worker = handler ? handler.worker : { };
    var v = {
      id: worker.id || null
    , custom_env: worker.custom_env
    , state: worker.state || 'missing'
    , isDead: worker.isDead && worker.isDead( )
    // , url: "http://" + [ 'localhost', worker.custom_env.PORT ].join(':') + '/'
    // , status_url: "http://" + [ 'localhost', worker.custom_env.PORT ].join(':') + '/api/v1/status.json'
    };

    res.send(v);
    next( );
    
  });

  server.get(/^\/environs\/(.*)\/resolver\/(.*)?$/, function (req, res, next) {
      req.params.name = req.params[0];
      req.params.target = req.params[1] || '';
      console.log('found target', req.params.target);
      next( );
    }, function (req, res, next) {
    var file = path.resolve(master.env.WORKER_ENV, path.basename(req.params.name + '.env'));
    var name = req.params.name;
    var frontend = req.params.frontend;
    var hostname = req.header('host');
    var scheme = req.isSecure( ) ? 'https' : 'http';
    var handler = master.handlers[file];
    var worker = handler ? handler.worker : { };
    var port = worker.custom_env.PORT || 80;
    var missing_url = scheme + '://' + hostname + '/';
    var v = {
      id: worker.id || 'missing'
    , custom_env: worker.custom_env
    , port: port
    , state: worker.state || 'missing'
    , isDead: worker.isDead && worker.isDead( )
    // , url: "http://" + [ 'localhost', worker.custom_env.PORT ].join(':') + '/'
    // , status_url: "http://" + [ 'localhost', worker.custom_env.PORT ].join(':') + '/api/v1/status.json'
    };

    var internal = '@proxy/' + v.port + '/' + v.id + '/' + encodeURIComponent(req.params.target);
    // var internal = '@proxy/' + v.port + '/' + v.id;
    console.log('internal!', internal, v);
    res.header('x-accel-redirect', internal);
    res.end( );
    next( );

  });

  server.del('/environs/:name', function (req, res, next) {
    var file = path.resolve(master.env.WORKER_ENV, path.basename(req.params.name + '.env'));

    fs.unlink(file, function (ev) {
      res.status(204);
      res.send("");
      next( );
    });

  });

  server.get('/environs/:name/env', function (req, res, next) {
    var file = path.resolve(master.env.WORKER_ENV, path.basename(req.params.name + '.env'));
    var handler = master.handlers[file];
    var worker = handler ? handler.worker : { };

    res.send(worker.custom_env);
    next( );
    
  });

  server.get('/environs/:name/env/:field', function (req, res, next) {
    var file = path.resolve(master.env.WORKER_ENV, path.basename(req.params.name + '.env'));
    var worker = master.handlers[file].worker || { };

    var field = worker.custom_env[req.params.field];
    if (typeof field !== 'undefined') {
      res.send(field);
    } else {
      res.status(404);
    }
    next( );
    
  });

  server.post('/environs/:name', function (req, res, next) {
    var file = path.resolve(master.env.WORKER_ENV, path.basename(req.params.name + '.env'));
    var text = [ ];
    var item = { };
    var out = fs.createWriteStream(file);
    out.on('close', function (ev) {
      console.log('closed done');
      res.send(item);
      next( );
    });

    console.log("FILE", file);
    console.log('query', req.query);
    console.log('input', req.body);
    var x;
    text.push(['WEB_NAME', req.params.name ].join('='));
    item['WEB_NAME'] = req.params.name;
    for (x in req.query) {
      text.push([x, req.query[x] ].join('='));
      item[x] = req.query[x];
    }
    for (x in req.body) {
      text.push([x, req.body[x] ].join('='));
      item[x] = req.body[x];
    }
    console.log('writing', out);
    out.write(text.join("\n"));

    res.status(201);
    res.header('Location', '/environs/' + req.params.name);
    out.end( );
  });

  return server;
}

exports = module.exports = createServer;

