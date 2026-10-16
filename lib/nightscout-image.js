'use strict';

// Selects the container image used for tenant Nightscout Deployments created
// by k8s-deployment-controller.js.
//
// Precedence (first valid value wins):
//   1. tenant ConfigMap annotation `ns.mdn.io/nightscout-image`
//   2. env MULTIENV_NIGHTSCOUT_IMAGE
//   3. DEFAULT_IMAGE ('nightscout/cgm-remote-monitor:latest')
//
// MULTIENV_NIGHTSCOUT_IMAGE is the operator's setting: check_config( ) refuses
// to boot when it is set but invalid, rather than falling back to :latest.
// The annotation can be written by anyone who can edit a tenant ConfigMap, and
// the image it names runs with the tenant's envFrom secrets, so it must be
// pinned by digest (@sha256:<64 lowercase hex>) and its repository must be in
// MULTIENV_NIGHTSCOUT_IMAGE_REPOS (comma separated, default
// nightscout/cgm-remote-monitor). An annotation that fails either test is
// ignored with a counts-only log line, and the env/default image is used.
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
var DEFAULT_REPOS = [ 'nightscout/cgm-remote-monitor' ];
var REPO_RE = new RegExp('^' + HOST + REPO + '$');
var PINNED_RE = new RegExp('^(' + HOST + REPO + ')' + TAG + '@sha256:[a-f0-9]{64}$');
var ignored_annotations = 0;

function is_valid_image (value) {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= MAX_LENGTH && IMAGE_RE.test(value);
}

// Allowed annotation repositories, from MULTIENV_NIGHTSCOUT_IMAGE_REPOS.
// Returns null when the setting is malformed (check_config refuses that).
function repos_of (env) {
  var text = env && env.MULTIENV_NIGHTSCOUT_IMAGE_REPOS;
  if (text === undefined || text === '') return DEFAULT_REPOS;
  var list = String(text).split(',').map(function (r) { return r.trim( ); });
  for (var i = 0; i < list.length; i++) {
    if (!REPO_RE.test(list[i])) return null;
  }
  return list;
}

// Why an annotation can't be used, or null when it can.
function annotation_problem (value, env) {
  if (!is_valid_image(value)) return 'malformed';
  var m = value.match(PINNED_RE);
  if (!m) return 'not pinned by digest';
  var repos = repos_of(env) || DEFAULT_REPOS;
  if (repos.indexOf(m[1]) < 0) return 'repository not allowed';
  return null;
}

// Boot check: throws when an image setting is present but unusable.
function check_config (env) {
  env = env || { };
  var configured = env.MULTIENV_NIGHTSCOUT_IMAGE;
  if (configured !== undefined && configured !== '' && !is_valid_image(configured)) {
    throw new Error('MULTIENV_NIGHTSCOUT_IMAGE is set but is not a valid image reference');
  }
  if (repos_of(env) === null) {
    throw new Error('MULTIENV_NIGHTSCOUT_IMAGE_REPOS must be a comma-separated list of repositories (no tag or digest)');
  }
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
    var problem = annotation_problem(annotated, env);
    if (!problem) {
      result = { image: annotated, source: 'annotation' };
    } else {
      // Counts only: the value is untrusted and the tenant name is PII.
      ignored_annotations++;
      log('IGNORED ' + ANNOTATION + ' annotation', { reason: problem, ignored_total: ignored_annotations, fallback: result.source });
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
  DEFAULT_REPOS: DEFAULT_REPOS,
  is_valid_image: is_valid_image,
  annotation_problem: annotation_problem,
  check_config: check_config,
  resolve: resolve,
  update_patch: update_patch
};
