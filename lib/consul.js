

var EventEmitter = require('events').EventEmitter;
var util = require('util');
var noop = function (){};
var url = require('url');
var Hashids = require('hashids');
var qs = require('querystring');
var ip = require('ip');

function consul_url_to_opts (input) {
  var u = url.parse(input);
  var q = qs.parse(u.query);
  var protos = { consul: 'http', consuls: 'https' };
  var scheme = protos[u.protocol] || u.protocol;
  var o = {
    host: u.hostname,
    port: u.port,
    url: url.format({protocol: scheme, host: u.host})
  };
  if (u.search && 'https' == scheme) {
    if (q.promisify) {
      o.promisify = true;
    }
    // TODO: security
  }
  return o;
}

function create (server, cluster) {
  Storage.server = server;
  Storage.cluster = cluster;
  return Storage;
}
module.exports = create;

function Storage (options, fn) {
  EventEmitter.call(this);
  if (options && options.call && options.apply) {
    fn = options;
    options = { };
  }
  options = options || { };
  options.url = options.url || 'consul://consul.service.consul:8500';

  this.options = options;
  this.config = {

    cluster_id: options.cluster_id || 'internal:cluster',
    backends_id: options.backends_id || 'internal:backends',
    consul: consul_url_to_opts(options.url)
  };
  this.service = options.service || "cluster";
  console.log('INIT CONSUL WITH', options);
  this.hashids = new Hashids(this.config.hashids || "some salt tbd");


  fn = fn || noop;
  if (true || !options.delay_autoconnect) {
    // Storage.server.once('listening', this.capture_server);
    if (Storage.server) {
      var self = this;
      Storage.server.once('listening', function (worker, address ) {
        console.log("LISTEN ON SERVER", arguments, this.url);
        var port = url.parse(this.url).port;
        var host = url.parse(this.url).hostname;
        host = '::' == host ? ip.address( ) : host;
        self.host = host;
        self.port = parseInt(port);
        self.register_self( );
      });
    }
    var self = this;
    var cluster = Storage.cluster;

    connect(this.config.consul, function (err, client, data, res) {

      // console.log("CONNECTED", data);
      if (err) throw err;
      self.consul = client;
      if (cluster) {
        cluster.on('listening', self.handleSiteUp.bind(self));
        cluster.on('disconnect', self.handleSiteDown.bind(self));
        cluster.on('exit', self.handleSiteDown.bind(self));
      }
      self.emit('connect');
      fn( );
      // self._client

    });
  }
  this.on('connect', this._on_connect);
}





function connect (opts, fn) {
  console.log('connecting to consul', opts);
  var client = require('consul')(opts);
  client.agent.self( function (err, data, res) {
    // client.agent.self(console.log.bind(console, "DEBUG CONSUL"));
    // console.log("CONNECTED TO CONSUL", client, arguments);
    if (err) throw err;
    fn(err, client, data, res);
  });
  // client.agent.self(console.log.bind(console, "DEBUG CONSUL"));
  return client;
}

util.inherits(Storage, EventEmitter);

Storage.prototype.register_foo = function ( ) { }

Storage.prototype.register_self = function ( ) {
  var address = {host: this.host, port: this.port};
  var consul = this.consul;
  var allows_mesh = this.options.allows_mesh;
  var search = {
    cluster: 'cluster', // .service.consul',
    backend: 'backends' // .service.consul'
  };
  var insert = {
    cluster: {
      name: 'cluster',
      id: this.config.cluster_id, // 'internal:cluster'
      address: address.host,
      port: address.port,
      tags: ['core', 'api' ],
      checks: [ {
        name: 'Clusters API',
        ttl: '10s',
        interval: '5s',
        http: url.format({protocol: 'http', hostname: address.host, port: address.port,  pathname: '/cluster'}),
        deregister_critical_service_after: '1m'
      } ]
    },
    backends: {
      name: 'backends',
      id: this.config.backends_id, // 'internal:backends',
      address: address.host,
      port: address.port,
      tags: ['core', 'resolver' ],
      checks: [ {
        name: 'Clusters API',
        ttl: '10s',
        interval: '5s',
        http: url.format({protocol: 'http', hostname: address.host, port: address.port,  pathname: '/consul-status'}),
        deregister_critical_service_after: '1m'
      } ]
    }
  };
  var insertion = insert[this.service];

  function do_insert ( ) {
    consul.agent.service.register(insertion, function (err, resp) { console.log("CREATED BACKBONE CLUSTER", insertion); });
  }
  consul.agent.service.list(function (err, resp) {
    // console.log("FOUND SERVICES", resp);
    // get by id
    var found = resp[insertion.id];
    if (!found || allows_mesh) {
      console.log('cluster not found, will add');
      do_insert( );
    } else {
      console.log('cluster not found, will delete');
      console.log('found', found);
      consul.agent.service.deregister(found.id, function (err, resp) {
        console.log("REMOVED BACKEND SITE", found, "re-adding self now");
        do_insert( );
      });
    }
  });
  // find self: 'cluster'

}

Storage.prototype.capture_server = function (worker, address) {
  console.log("SERVER ADDRESS", worker, address);
  // this.register_self( );
  
}
Storage.prototype._on_connect = function ( ) {
  // this.register_self( );
  if (this.cluster && this.server) {
  }
}
Storage.prototype.findOneOrCreate = function ( ) {
  var HOST, PORT;
  var insert = {
		name: 'data',
		address: HOST,
		port: PORT,
		// id: CONSUL_ID,
		check: {
      name: "Status Endpoint",
			ttl: '10s',
      http: '/api/v1/status.txt',
			deregister_critical_service_after: '1m'
		}
  };

}


Storage.prototype.handleSiteUp = function (worker, address) {
  console.log("SITE UP AT ADDRESS", address);
  // address = address || {port: this.port, host: this.host};
  // var insert = { id: worker.id, state: worker.state, WEB_NAME: worker.custom_env.WEB_NAME, internal_name: worker.custom_env.internal_name, url: '', port: address.port };
  // var port = url.parse(this.url).port;
  // var host = url.parse(this.url).hostname;
  var host = this.host;
  var port = address.port;
  var ts = Date.now( );
  var alias = this.hashids.encode(worker.id, port, ts);
  // consider intentionally collidering without ts
  // var alias = this.hashids.encode(worker.id, port);
  var name = worker.custom_env.WEB_NAME;
  var internal_name = worker.custom_env.internal_name;
  var id = [worker.custom_env.WEB_NAME, this.config.backends_id].join(':');
  var insert = {
		name: 'backends',
		address: host,
		port: port,
		id: id,
    tags: [ internal_name, name, alias, 'tenant' ],
		checks: [ {
      name: "Status Endpoint",
			ttl: '10s',
      interval: '5s',
      http: url.format({protocol: 'http', hostname: host, port: port,  pathname: '/api/v1/status.txt'}),
			deregister_critical_service_after: '1m'
		} ]
  };
  console.log("SITE UP register", insert, address);

  if (!this.consul) { console.log("SKIPPING", address, "no CONSUL", this); return }
  var consul = this.consul;
  consul.agent.service.register(insert, function (err, resp) { console.log("CREATED BACKEND SITE"); });
}

Storage.prototype.handleSiteDown = function (worker, code, signal) {
  var id = [worker.custom_env.WEB_NAME, 'backend', worker.id].join(':');
  console.log("SITE DOWN deregister", id, worker.id, worker.failures, worker.remove, code, signal);
  var consul = this.consul;
  consul.agent.service.deregister(id, function (err, resp) { console.log("REMOVED BACKEND SITE", id, err); });
  if (!worker.remove) { return; }

}


