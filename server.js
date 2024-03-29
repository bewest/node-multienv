
var restify = require('restify');
var fs = require('fs');
var path = require('path');
var tmp = require('tmp');
var mv = require('mv');
var Readable = require('stream').Readable;
var bunyan = require('bunyan');
var escapeshell = require('shell-escape');
var shellquote = escapeshell;

function createServer (opts) {
  var cluster = opts.cluster;
  var master = opts.create;
  if (opts) {
    opts.handleUpgrades = true;
  }
  var server = restify.createServer(opts);
  server.on('after', restify.plugins.auditLogger({
    log: bunyan.createLogger({
      name: 'audit',
      stream: process.stdout
    })
    , event: 'after'
  }));

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

  server.get('/stats/active', function (req, res, next) {
    var stats = {
      name: master.stats.name,
      total: {
        active: Object.keys(cluster.workers).length,
        expected: master.stats.expected,
        max: master.env.MAX_TENANT_LIMIT
      }
    };
    res.send(stats);
    next( );
  });

  server.get('/resolve/:id', function (req, res, next) {
    var id = parseInt(req.params.id);
    var worker = cluster.workers[id] || {custom_env: { }, state: 'missing'};
    // console.log('worker', worker);
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
    // console.log('worker', port, worker);
    var v = {
      id: id
    , state: worker.state
    , envfile: worker.custom_env.envfile
    , name: path.basename(worker.custom_env.envfile, '.env')
    , port: port
    , url: "http://" + [ 'localhost', port ].join(':') + '/'
    , status_url: "http://" + [ 'localhost', port ].join(':') + '/api/v1/status.json'
    };
    // console.log(req.url, req.headers);
    res.header('X-Backend-State', v.state);
    res.header('X-Backend-Name', v.name);
    res.header('X-Backend', v.url);
    res.header('X-Backend-Port', v.port);
    // var internal = '/x-accel-redirect/' + v.port + '/api/v1/status.json';
    var internal = '@proxy/' + v.port + '/' + v.id;
    console.log('internal!', internal);
    res.header('x-accel-redirect', internal);
    res.end( );
    next( );
  });

  server.get('/cluster/:id', function (req, res, next) {
    var id = parseInt(req.params.id);
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

    res.header('content-type', 'application/json');
    res.send(v);
    next( );
    
  });

  // server.get(/^\/environs\/(.*)\/resolver\/(.*)?$/, function (req, res, next) { })
  function resolverA (req, res, next) {
      req.params.name = req.params[0];
      req.params.target = req.params[1] || '';
      console.log('found target', req.params.target);
      next( );
  }

  function resolverB (req, res, next) {
    var file = path.resolve(master.env.WORKER_ENV, path.basename(req.params.name + '.env'));
    var name = req.params.name;
    var frontend = req.params.frontend;
    var hostname = req.header('host');
    var scheme = req.isSecure( ) ? 'https' : 'http';
    var handler = master.handlers[file];
    var worker = handler
        ? ( cluster.workers[handler.worker.id]
          ? cluster.workers[handler.worker.id]
          : handler.worker
          )
        : { }
        ;
    var port = worker.custom_env.PORT || 80;
    var missing_url = scheme + '://' + hostname + '/';
    // console.log('LIVE WORKER', worker);
    console.log('PORT WORKER', port);
    var v = {
      id: worker.id || 'missing'
    , custom_env: worker.custom_env
    , port: port
    , state: worker.state || 'missing'
    , isDead: worker.isDead && worker.isDead( )
    // , url: "http://" + [ 'localhost', worker.custom_env.PORT ].join(':') + '/'
    // , status_url: "http://" + [ 'localhost', worker.custom_env.PORT ].join(':') + '/api/v1/status.json'
    };

    var internal = '@proxy/' + v.port + '/' + v.id + '/' + req.params.target;
    // var internal = '@proxy/' + v.port + '/' + v.id;
    console.log('internal!', internal, v);
    res.header('x-accel-redirect', internal);
    res.end( );
    next( );

  }

  /*
  server.get(/^\/environs\/(.*)\/resolver\/(.*)?$/, resolverA, resolverB);
  server.del(/^\/environs\/(.*)\/resolver\/(.*)?$/, resolverA, resolverB);
  server.post(/^\/environs\/(.*)\/resolver\/(.*)?$/, resolverA, resolverB);
  server.put(/^\/environs\/(.*)\/resolver\/(.*)?$/, resolverA, resolverB);
  server.head(/^\/environs\/(.*)\/resolver\/(.*)?$/, resolverA, resolverB);
  server.opts(/^\/environs\/(.*)\/resolver\/(.*)?$/, resolverA, resolverB);
  server.patch(/^\/environs\/(.*)\/resolver\/(.*)?$/, resolverA, resolverB);

  */
  server.use(restify.plugins.queryParser( ));
  server.use(restify.plugins.bodyParser( ));


  server.del('/environs/:name', function (req, res, next) {
    var file = path.resolve(master.env.WORKER_ENV, path.basename(req.params.name + '.env'));

    console.log("DELETING", req.params.name, file);
    fs.unlink(file, function (ev) {
      console.log('OK', arguments);
      res.status(204);
      res.send("");
      // next( );
    });

  });

  server.get('/environs/:name/env', function (req, res, next) {
    var file = path.resolve(master.env.WORKER_ENV, path.basename(req.params.name + '.env'));
    var handler = master.handlers[file];
    var worker = handler ? handler.worker : { };

    res.send(worker.custom_env);
    next( );
    
  });

  server.get('/environs/:name/assigned/:field/:value', function (req, res, next) {
    var file = path.resolve(master.env.WORKER_ENV, path.basename(req.params.name + '.env'));
    var handler = master.handlers[file];
    var worker = handler ? handler.worker : { custom_env: { } };

    var found = worker.custom_env[req.params.field];
    var valid = req.params.value == found;

    res.send(valid ? 200 : 500, found);
    next( );
    
  });


  /*
  server.get('/environs/:name/worker', function (req, res, next) {
    var file = path.resolve(master.env.WORKER_ENV, path.basename(req.params.name + '.env'));
    var worker = master.handlers[file].worker || { };
    res.json(worker);

    next( );
  });
  */

  server.get('/environs/:name/env/:field', function (req, res, next) {
    var file = path.resolve(master.env.WORKER_ENV, path.basename(req.params.name + '.env'));
    var worker = master.handlers[file].worker || { };

    var field = worker.custom_env[req.params.field];
    console.log(req.params.field, field);
    if (typeof field !== 'undefined') {
      res.status(200);
      res.json(field);
    } else {
      res.status(404);
      res.send({msg: "field unknown", field: req.params.field});
    }
    next( );
    
  });

  server.post('/environs/:name/env/:field', function (req, res, next) {
    var file = path.resolve(master.env.WORKER_ENV, path.basename(req.params.name + '.env'));
    var env = master.read(file);

    var field = req.params.field;
    env[req.params.field] = req.params[req.params.field] || req.body[field] || '';
    var tmpname = tmp.tmpNameSync( );
    var out = fs.createWriteStream(tmpname);
    // if (fs.existsSync(file)) { fs.unlinkSync(file); }
    out.on('close', function (ev) {
      mv(tmpname, file, function (err) {
        console.error(err);
        if (err) return next(err);
          res.status(201);
          res.header('Location', '/environs/' + req.params.name);
          res.json(env[req.params.field]);
        // setTimeout(function ( ) { }, 800);
      });
    });

    var text = [ ];

    for (x in env) {
      text.push([x, env[x] ].join('='));
    }

    text.push('');
    Readable.from(text.join("\n")).pipe(out);

    // out.write(text.join("\n"));
    // out.write("\n");
    // out.end( );
    // next( );

  });

  server.del('/environs/:name/env/:field', function (req, res, next) {
    var file = path.resolve(master.env.WORKER_ENV, path.basename(req.params.name + '.env'));
    var env = master.read(file);
    delete env[req.params.field];
    var tmpname = tmp.tmpNameSync( );
    var out = fs.createWriteStream(tmpname);
    out.on('close', function (ev) {
      mv(tmpname, file, function (err) {
        res.status(204);
        res.json(env[req.params.field]);
        next(err);
      });
    });

    var text = [ ];

    for (x in env) {
      text.push([x, shellquote([env[x]]) ].join('='));
    }

    text.push('');
    Readable.from(text.join("\n")).pipe(out);

    // if (fs.existsSync(file)) { fs.unlinkSync(file); }

    // out.write(text.join("\n"));
    // out.write("\n");
    // out.end( );
    // res.status(201);
    // res.header('Location', '/environs/' + req.params.name);
    // next( );

  });

  server.post('/environs/:name', function (req, res, next) {
    var file = path.resolve(master.env.WORKER_ENV, path.basename(req.params.name + '.env'));
    var tmpname = tmp.tmpNameSync( );
    var text = [ ];
    var item = { };
    var out = fs.createWriteStream(tmpname);
    // if (fs.existsSync(file)) { fs.unlinkSync(file); }
    out.on('close', function (ev) {
      mv(tmpname, file, function (err) {
          res.status(201);
          res.header('Location', '/environs/' + req.params.name);
          res.send(item);
          next(err);
        // setTimeout(function ( ) { },  800);
      });
    });

    console.log('query', req.query);
    console.log('input', req.body);
    var x;
    text.push(['WEB_NAME', req.params.name ].join('='));
    item['WEB_NAME'] = req.params.name;
    for (x in req.query) {
      text.push([x, shellquote([req.query[x]]) ].join('='));
      item[x] = req.query[x];
    }
    for (x in req.body) {
      text.push([x, shellquote([req.body[x]]) ].join('='));
      item[x] = req.body[x];
    }

    console.log('writing', file);
    text.push('');
    Readable.from(text.join("\n")).pipe(out);
    // out.write(text.join("\n"));

    // out.write("\n");
    // out.end( );
  });

  return server;
}

exports = module.exports = createServer;

