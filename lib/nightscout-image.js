'use strict';

// Selects the container image used for tenant Nightscout Deployments created
// by k8s-deployment-controller.js.
//
// Precedence (first valid value wins):
//   1. tenant ConfigMap annotation `ns.mdn.io/nightscout-image`
//   2. env MULTIENV_NIGHTSCOUT_IMAGE
//   3. DEFAULT_IMAGE ('nightscout/cgm-remote-monitor:latest')
//
// An invalid value is ignored with a log line and the next source is used.
// MULTIENV_NIGHTSCOUT_IMAGE_PULL_POLICY optionally sets imagePullPolicy.

var DEFAULT_IMAGE = 'nightscout/cgm-remote-monitor:latest';
var ANNOTATION = 'ns.mdn.io/nightscout-image';
var CONTAINER_NAME = 'nightscout';
var PULL_POLICIES = [ 'Always', 'IfNotPresent', 'Never' ];

// repo[:tag][@sha256:<64 hex>], with an optional registry[:port]/ prefix.
// Repository path components follow the OCI distribution grammar
// (lowercase, separated by '.', '_', '__' or '-'); anything else, including
// whitespace or quotes, is rejected.
var HOST = '(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*(?::[0-9]+)?/)?';
var COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
var REPO = COMPONENT + '(?:/' + COMPONENT + ')*';
var TAG = '(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?';
var DIGEST = '(?:@sha256:[a-f0-9]{64})?';
var IMAGE_RE = new RegExp('^' + HOST + REPO + TAG + DIGEST + '$');
var MAX_LENGTH = 512;

function is_valid_image (value) {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= MAX_LENGTH && IMAGE_RE.test(value);
}

function default_log (msg, detail) {
  console.log(msg, detail);
}

function annotations_of (object) {
  return (object && object.metadata && object.metadata.annotations) || { };
}

// env: object holding MULTIENV_NIGHTSCOUT_IMAGE(_PULL_POLICY), usually
//      process.env or the controller config.
// object: the tenant ConfigMap (the watch event's `object`), may be absent.
// Returns { image, source: 'annotation'|'env'|'default', imagePullPolicy? }.
function resolve (env, object, log) {
  env = env || { };
  log = log || default_log;
  var result = { image: DEFAULT_IMAGE, source: 'default' };
  var name = object && object.metadata && object.metadata.name;

  var configured = env.MULTIENV_NIGHTSCOUT_IMAGE;
  if (configured !== undefined && configured !== '') {
    if (is_valid_image(configured)) {
      result = { image: configured, source: 'env' };
    } else {
      log('INVALID MULTIENV_NIGHTSCOUT_IMAGE, using default', { value: configured, fallback: result.image });
    }
  }

  var annotated = annotations_of(object)[ANNOTATION];
  if (annotated !== undefined && annotated !== '') {
    if (is_valid_image(annotated)) {
      result = { image: annotated, source: 'annotation' };
    } else {
      log('INVALID ' + ANNOTATION + ' annotation, ignoring', { tenant: name, value: annotated, fallback: result.image });
    }
  }

  var policy = env.MULTIENV_NIGHTSCOUT_IMAGE_PULL_POLICY;
  if (policy !== undefined && policy !== '') {
    if (PULL_POLICIES.indexOf(policy) > -1) {
      result.imagePullPolicy = policy;
    } else {
      log('INVALID MULTIENV_NIGHTSCOUT_IMAGE_PULL_POLICY, ignoring', { value: policy, allowed: PULL_POLICIES });
    }
  }
  return result;
}

// JSON patch ops for an existing Deployment when a tenant ConfigMap changes.
// Only acts when the tenant carries the annotation, or when the Deployment
// records a previously applied override (so removing the annotation reverts
// the tenant to the env/default image). Tenants never annotated are left
// untouched, so changing MULTIENV_NIGHTSCOUT_IMAGE does not roll existing
// Deployments; it applies when a Deployment is created.
function update_patch (deployment, object, env, log) {
  var ops = [ ];
  var tmpl = deployment && deployment.spec && deployment.spec.template;
  var containers = (tmpl && tmpl.spec && tmpl.spec.containers) || [ ];
  var index = -1;
  containers.forEach(function (c, i) { if (index < 0 && c.name === CONTAINER_NAME) index = i; });
  if (index < 0) return ops;

  var recorded = ((tmpl.metadata && tmpl.metadata.annotations) || { })[ANNOTATION];
  var requested = annotations_of(object)[ANNOTATION];
  if (requested === undefined && recorded === undefined) return ops;

  var resolved = resolve(env, object, log);
  var container = containers[index];
  if (container.image !== resolved.image) {
    ops.push({ op: 'replace', path: '/spec/template/spec/containers/' + index + '/image', value: resolved.image });
  }
  if (resolved.imagePullPolicy && container.imagePullPolicy !== resolved.imagePullPolicy) {
    ops.push({ op: 'add', path: '/spec/template/spec/containers/' + index + '/imagePullPolicy', value: resolved.imagePullPolicy });
  }
  var key = '/spec/template/metadata/annotations/' + ANNOTATION.replace(/~/g, '~0').replace(/\//g, '~1');
  if (resolved.source === 'annotation') {
    if (recorded !== resolved.image) ops.push({ op: 'add', path: key, value: resolved.image });
  } else if (recorded !== undefined) {
    ops.push({ op: 'remove', path: key });
  }
  return ops;
}

module.exports = {
  DEFAULT_IMAGE: DEFAULT_IMAGE,
  ANNOTATION: ANNOTATION,
  CONTAINER_NAME: CONTAINER_NAME,
  is_valid_image: is_valid_image,
  resolve: resolve,
  update_patch: update_patch
};
