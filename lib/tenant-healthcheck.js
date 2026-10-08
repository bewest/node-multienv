
// Tenant health checks (t1dpalsys ops D-011).
//
// Consul check definitions for tenant pods, and the optional pod-local
// "pod-healthcheck" sidecar that answers ValidPodName without a trip through
// the deployment controller and cluster DNS.
//
// Defaults reproduce 7deafde: legacy ValidPodName URL, 10s/20s and 5s/5s
// timings, no sidecar.  The pod-local URL is chosen per pod, only when that
// pod's spec actually has the sidecar, never from configuration alone
// (OPS-003).
//
// Pure functions only, so they can be unit tested without a cluster.

var url = require('url');

var SIDECAR_NAME = 'pod-healthcheck';
var PORT_NAME = 'healthcheck';
var VOLUME_NAME = 'pod-healthcheck-www';
var WEB_ROOT = '/www';
var NIGHTSCOUT_PORT = 1337;
var STATUSES = ['passing', 'warning', 'critical'];

// Writes the one path that should answer 200, then serves it.  Any other
// tenant or pod UID is a 404; a pod without the sidecar refuses the
// connection.  Exits (and crash-loops visibly) if the Downward API values are
// missing rather than serving a path that can never match.
var SIDECAR_SCRIPT = [
  '[ -n "$TENANT" ] && [ -n "$POD_UID" ] || { echo "pod-healthcheck: TENANT and POD_UID required" >&2; exit 1; }',
  'd="' + WEB_ROOT + '/healthchecks/pod/$TENANT/assigned/POD_UID"',
  'mkdir -p "$d" && echo ok > "$d/$POD_UID"',
  'exec httpd -f -p "$PORT" -h ' + WEB_ROOT
].join('\n');

function config (env) {
  env = env || { };
  var style = String(env.MULTIENV_TENANT_HEALTHCHECK || 'legacy').toLowerCase( );
  if (style != 'pod' && style != 'legacy') {
    console.log('MULTIENV_TENANT_HEALTHCHECK', JSON.stringify(style), 'is not legacy|pod, using legacy');
    style = 'legacy';
  }
  var port = parseInt(env.MULTIENV_TENANT_HEALTHCHECK_PORT || '1338', 10);
  if (!(port > 0 && port < 65536) || port == NIGHTSCOUT_PORT) {
    throw new Error('MULTIENV_TENANT_HEALTHCHECK_PORT must be a port other than ' + NIGHTSCOUT_PORT);
  }
  var status = env.MULTIENV_CONSUL_VALIDPOD_INITIAL_STATUS || '';
  if (status && STATUSES.indexOf(status) < 0) {
    throw new Error('MULTIENV_CONSUL_VALIDPOD_INITIAL_STATUS must be one of ' + STATUSES.join('|'));
  }
  return {
    style: style,
    image: env.MULTIENV_TENANT_HEALTHCHECK_IMAGE || 'busybox:1.36.1',
    port: port,
    resources: {
      requests: {
        cpu: env.MULTIENV_TENANT_HEALTHCHECK_CPU_REQUEST || '1m',
        memory: env.MULTIENV_TENANT_HEALTHCHECK_MEM_REQUEST || '4Mi'
      },
      limits: {
        cpu: env.MULTIENV_TENANT_HEALTHCHECK_CPU_LIMIT || '20m',
        memory: env.MULTIENV_TENANT_HEALTHCHECK_MEM_LIMIT || '16Mi'
      }
    },
    endpoint: {
      interval: env.MULTIENV_CONSUL_ENDPOINT_INTERVAL || '10s',
      timeout: env.MULTIENV_CONSUL_ENDPOINT_TIMEOUT || '',
      deregister: env.MULTIENV_CONSUL_ENDPOINT_DEREGISTER_AFTER || '20s'
    },
    validpod: {
      interval: env.MULTIENV_CONSUL_VALIDPOD_INTERVAL || '5s',
      timeout: env.MULTIENV_CONSUL_VALIDPOD_TIMEOUT || '',
      deregister: env.MULTIENV_CONSUL_VALIDPOD_DEREGISTER_AFTER || '5s',
      status: status
    }
  };
}

function sidecar_container (cfg) {
  return {
    name: SIDECAR_NAME,
    image: cfg.image,
    imagePullPolicy: 'IfNotPresent',
    command: ['sh', '-c', SIDECAR_SCRIPT],
    env: [
      { name: 'PORT', value: String(cfg.port) },
      { name: 'TENANT', valueFrom: { fieldRef: { fieldPath: "metadata.labels['tenant']" } } },
      { name: 'POD_UID', valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } } }
    ],
    // no envFrom: the sidecar never sees the tenant's secrets or configmap
    ports: [ { containerPort: cfg.port, name: PORT_NAME } ],
    resources: cfg.resources,
    securityContext: {
      runAsNonRoot: true,
      runAsUser: 65534,
      runAsGroup: 65534,
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] }
    },
    volumeMounts: [ { name: VOLUME_NAME, mountPath: WEB_ROOT } ]
  };
}

function sidecar_volume ( ) {
  return { name: VOLUME_NAME, emptyDir: { sizeLimit: '1Mi' } };
}

// Port the pod's sidecar listens on, or null if the pod has no usable sidecar.
function sidecar_port (podSpec) {
  var containers = (podSpec && podSpec.containers) || [ ];
  for (var i = 0; i < containers.length; i++) {
    if (containers[i].name != SIDECAR_NAME) continue;
    var ports = containers[i].ports || [ ];
    for (var j = 0; j < ports.length; j++) {
      if (ports[j].name == PORT_NAME && ports[j].containerPort) return ports[j].containerPort;
    }
  }
  return null;
}

function has_sidecar (podSpec) {
  return ((podSpec && podSpec.containers) || [ ]).some(function (c) { return c.name == SIDECAR_NAME; });
}

// Adds the sidecar to a pod template spec built by template_deployment.
function inject (podSpec, cfg) {
  if (has_sidecar(podSpec)) return podSpec;
  podSpec.containers = (podSpec.containers || [ ]).concat([ sidecar_container(cfg) ]);
  podSpec.volumes = (podSpec.volumes || [ ]).concat([ sidecar_volume( ) ]);
  return podSpec;
}

// JSON patch op that forces a rolling restart, as 7deafde already does.
function restart_op (now) {
  return {
    op: 'add',
    path: '/spec/template/metadata/annotations/updated-at',
    value: (now || new Date( )).toISOString( )
  };
}

// JSON patch ops adding the sidecar to an existing Deployment; [] if present.
function adopt_ops (deployment, cfg) {
  var spec = deployment.spec.template.spec;
  if (has_sidecar(spec)) return [ ];
  var ops = [ { op: 'add', path: '/spec/template/spec/containers/-', value: sidecar_container(cfg) } ];
  var volumes = spec.volumes;
  if (!Array.isArray(volumes)) {
    ops.push({ op: 'add', path: '/spec/template/spec/volumes', value: [ sidecar_volume( ) ] });
  } else if (!volumes.some(function (v) { return v.name == VOLUME_NAME; })) {
    ops.push({ op: 'add', path: '/spec/template/spec/volumes/-', value: sidecar_volume( ) });
  }
  return ops;
}

// JSON patch ops removing the sidecar and its volume; [] if absent.  Each
// remove is guarded by a test op so a concurrent edit fails the patch
// instead of removing the wrong element.
function unadopt_ops (deployment) {
  var spec = deployment.spec.template.spec;
  var ops = [ ];
  (spec.containers || [ ]).forEach(function (c, i) {
    if (c.name != SIDECAR_NAME) return;
    ops.push({ op: 'test', path: '/spec/template/spec/containers/' + i + '/name', value: SIDECAR_NAME });
    ops.push({ op: 'remove', path: '/spec/template/spec/containers/' + i });
  });
  (spec.volumes || [ ]).forEach(function (v, i) {
    if (v.name != VOLUME_NAME) return;
    ops.push({ op: 'test', path: '/spec/template/spec/volumes/' + i + '/name', value: VOLUME_NAME });
    ops.push({ op: 'remove', path: '/spec/template/spec/volumes/' + i });
  });
  return ops;
}

function legacy_validpod_url (healthCheckService, tenantName, host) {
  var svc = url.parse(healthCheckService);
  return url.format({ protocol: svc.protocol, hostname: svc.hostname, port: svc.port, pathname: ('/healthchecks/pod/' + tenantName + '/assigned/podIP/' + host) });
}

function validpod_url (pod, healthCheckService) {
  var tenantName = pod.metadata.labels.tenant;
  var host = pod.status.podIP;
  var port = sidecar_port(pod.spec);
  if (!port) return legacy_validpod_url(healthCheckService, tenantName, host);
  return url.format({ protocol: 'http', hostname: host, port: port, pathname: ('/healthchecks/pod/' + tenantName + '/assigned/POD_UID/' + pod.metadata.uid) });
}

// Checks for a running tenant pod.  The consul client (0.34.1) sends only
// http, interval, timeout, status and deregister_critical_service_after; it
// drops name, ttl and failures_before_critical, so those are not set here.
function consul_checks (pod, cfg, healthCheckService) {
  var host = pod.status.podIP;
  var endpoint = {
    name: 'EndpointAvailable',
    interval: cfg.endpoint.interval,
    http: url.format({ protocol: 'http', hostname: host, port: NIGHTSCOUT_PORT, pathname: '/api/v1/status.txt' }),
    deregister_critical_service_after: cfg.endpoint.deregister
  };
  if (cfg.endpoint.timeout) endpoint.timeout = cfg.endpoint.timeout;
  var validpod = {
    name: 'ValidPodName',
    interval: cfg.validpod.interval,
    http: validpod_url(pod, healthCheckService),
    deregister_critical_service_after: cfg.validpod.deregister
  };
  if (cfg.validpod.timeout) validpod.timeout = cfg.validpod.timeout;
  if (cfg.validpod.status) validpod.status = cfg.validpod.status;
  return [ endpoint, validpod ];
}

// Safe summary of the resolved config for boot logs.
function describe (cfg) {
  return {
    style: cfg.style, image: cfg.image, port: cfg.port,
    endpoint: cfg.endpoint, validpod: cfg.validpod
  };
}

module.exports = {
  SIDECAR_NAME: SIDECAR_NAME,
  PORT_NAME: PORT_NAME,
  VOLUME_NAME: VOLUME_NAME,
  SIDECAR_SCRIPT: SIDECAR_SCRIPT,
  config: config,
  sidecar_container: sidecar_container,
  sidecar_volume: sidecar_volume,
  sidecar_port: sidecar_port,
  has_sidecar: has_sidecar,
  inject: inject,
  restart_op: restart_op,
  adopt_ops: adopt_ops,
  unadopt_ops: unadopt_ops,
  legacy_validpod_url: legacy_validpod_url,
  validpod_url: validpod_url,
  consul_checks: consul_checks,
  describe: describe
};
