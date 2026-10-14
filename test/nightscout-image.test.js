'use strict';
var test = require('node:test');
var assert = require('assert');
var ni = require('../lib/nightscout-image');

var DIGEST = 'sha256:' + 'ab12'.repeat(16);
var CANARY = 'nightscout/cgm-remote-monitor:latest_dev@' + DIGEST;

function tenant (annotations) {
  return { metadata: { name: 'tenant-a', annotations: annotations } };
}
function capture ( ) {
  var lines = [ ];
  function log (msg, detail) { lines.push({ msg: msg, detail: detail }); }
  log.lines = lines;
  return log;
}
function deployment (image, recorded) {
  var annotations = { 'managed-by': 'multienv/k8s-deployment-controller' };
  if (recorded) annotations[ni.ANNOTATION] = recorded;
  return { spec: { template: {
    metadata: { annotations: annotations },
    spec: { containers: [ { name: 'nightscout', image: image } ] }
  } } };
}

test('default is unchanged', function ( ) {
  assert.strictEqual(ni.DEFAULT_IMAGE, 'nightscout/cgm-remote-monitor:latest');
  var log = capture( );
  assert.deepStrictEqual(ni.resolve({ }, undefined, log), { image: ni.DEFAULT_IMAGE, source: 'default' });
  assert.deepStrictEqual(ni.resolve({ }, tenant(undefined), log), { image: ni.DEFAULT_IMAGE, source: 'default' });
  assert.strictEqual(log.lines.length, 0);
});

test('env override', function ( ) {
  var r = ni.resolve({ MULTIENV_NIGHTSCOUT_IMAGE: 'nightscout/cgm-remote-monitor:15.0.7', MULTIENV_NIGHTSCOUT_IMAGE_PULL_POLICY: 'IfNotPresent' }, tenant({ }));
  assert.deepStrictEqual(r, { image: 'nightscout/cgm-remote-monitor:15.0.7', source: 'env', imagePullPolicy: 'IfNotPresent' });
});

test('per-tenant annotation takes precedence over env', function ( ) {
  var env = { MULTIENV_NIGHTSCOUT_IMAGE: 'nightscout/cgm-remote-monitor:15.0.7' };
  var annotations = { };
  annotations[ni.ANNOTATION] = CANARY;
  assert.deepStrictEqual(ni.resolve(env, tenant(annotations)), { image: CANARY, source: 'annotation' });
});

test('invalid values fall back with a log line', function ( ) {
  var log = capture( );
  var bad = { };
  bad[ni.ANNOTATION] = 'nightscout/cgm-remote-monitor:latest"; rm -rf /';
  var r = ni.resolve({ MULTIENV_NIGHTSCOUT_IMAGE: 'nightscout/cgm-remote-monitor:15.0.7' }, tenant(bad), log);
  assert.deepStrictEqual(r, { image: 'nightscout/cgm-remote-monitor:15.0.7', source: 'env' });
  assert.strictEqual(log.lines.length, 1);
  assert.match(log.lines[0].msg, /IGNORED ns\.mdn\.io\/nightscout-image/);
  assert.strictEqual(JSON.stringify(log.lines[0].detail).indexOf('rm -rf'), -1);
  assert.strictEqual(JSON.stringify(log.lines[0].detail).indexOf('tenant-a'), -1);

  log = capture( );
  r = ni.resolve({ MULTIENV_NIGHTSCOUT_IMAGE: 'has space:latest', MULTIENV_NIGHTSCOUT_IMAGE_PULL_POLICY: 'sometimes' }, undefined, log);
  assert.deepStrictEqual(r, { image: ni.DEFAULT_IMAGE, source: 'default' });
  assert.strictEqual(log.lines.length, 2);
  assert.match(log.lines[0].msg, /INVALID MULTIENV_NIGHTSCOUT_IMAGE/);
  assert.match(log.lines[1].msg, /PULL_POLICY/);
});

test('image reference validation', function ( ) {
  [ 'nightscout/cgm-remote-monitor', 'nightscout/cgm-remote-monitor:latest', CANARY,
    'nightscout/cgm-remote-monitor@' + DIGEST, 'ghcr.io/nightscout/cgm-remote-monitor:15.0.7',
    'registry.example.org:5000/ns/cgm-remote-monitor:v15_0.7-rc1', 'busybox'
  ].forEach(function (v) { assert.ok(ni.is_valid_image(v), v); });
  [ '', ' ', 'nightscout/cgm remote', "nightscout/cgm-remote-monitor:'latest'", 'nightscout/"x"',
    'nightscout/cgm-remote-monitor:latest\n', 'Nightscout/CGM', 'nightscout/cgm-remote-monitor@sha256:abc',
    'nightscout/cgm-remote-monitor:', ':latest', 'nightscout//cgm', undefined, null, 42
  ].forEach(function (v) { assert.ok(!ni.is_valid_image(v), JSON.stringify(v)); });
});

test('update_patch leaves unannotated tenants alone', function ( ) {
  assert.deepStrictEqual(ni.update_patch(deployment(ni.DEFAULT_IMAGE), tenant({ }), { MULTIENV_NIGHTSCOUT_IMAGE: 'nightscout/cgm-remote-monitor:15.0.7' }), [ ]);
});

test('update_patch applies and then reverts a canary', function ( ) {
  var annotations = { };
  annotations[ni.ANNOTATION] = CANARY;
  var ops = ni.update_patch(deployment(ni.DEFAULT_IMAGE), tenant(annotations), { });
  assert.deepStrictEqual(ops, [
    { op: 'replace', path: '/spec/template/spec/containers/0/image', value: CANARY },
    { op: 'add', path: '/spec/template/metadata/annotations/ns.mdn.io~1nightscout-image', value: CANARY }
  ]);
  // already applied: no-op
  assert.deepStrictEqual(ni.update_patch(deployment(CANARY, CANARY), tenant(annotations), { }), [ ]);
  // annotation removed: back to env/default, record dropped
  ops = ni.update_patch(deployment(CANARY, CANARY), tenant({ }), { });
  assert.deepStrictEqual(ops, [
    { op: 'replace', path: '/spec/template/spec/containers/0/image', value: ni.DEFAULT_IMAGE },
    { op: 'remove', path: '/spec/template/metadata/annotations/ns.mdn.io~1nightscout-image' }
  ]);
});

test('boot refuses an image pin that is set but invalid (no fallback to :latest)', function ( ) {
  var bad = [ 'has space:latest', 'nightscout/cgm-remote-monitor@sha256:' + 'AB12'.repeat(16),
    'nightscout/cgm-remote-monitor@sha256:' + 'ab12'.repeat(15), 'Nightscout/CGM' ];
  bad.forEach(function (value) {
    assert.throws(function ( ) { ni.check_config({ MULTIENV_NIGHTSCOUT_IMAGE: value }); }, /MULTIENV_NIGHTSCOUT_IMAGE/, value);
  });
  assert.doesNotThrow(function ( ) { ni.check_config({ }); });
  assert.doesNotThrow(function ( ) { ni.check_config({ MULTIENV_NIGHTSCOUT_IMAGE: '' }); });
  assert.doesNotThrow(function ( ) { ni.check_config({ MULTIENV_NIGHTSCOUT_IMAGE: 'nightscout/cgm-remote-monitor@' + DIGEST }); });
  assert.throws(function ( ) { ni.check_config({ MULTIENV_NIGHTSCOUT_IMAGE_REPOS: 'nightscout/cgm-remote-monitor:latest' }); }, /REPOS/);
  assert.throws(function ( ) { ni.check_config({ MULTIENV_NIGHTSCOUT_IMAGE_REPOS: 'ok/repo,,' }); }, /REPOS/);
  assert.doesNotThrow(function ( ) { ni.check_config({ MULTIENV_NIGHTSCOUT_IMAGE_REPOS: 'nightscout/cgm-remote-monitor, registry.example.org/t1pal/nightscout' }); });
});

test('annotation must be pinned by digest and from an allowed repository', function ( ) {
  var env = { MULTIENV_NIGHTSCOUT_IMAGE: 'nightscout/cgm-remote-monitor@' + DIGEST };
  var cases = [
    [ 'nightscout/cgm-remote-monitor:15.0.9', 'not pinned by digest' ],
    [ 'nightscout/cgm-remote-monitor:latest', 'not pinned by digest' ],
    [ 'nightscout/cgm-remote-monitor@sha256:' + 'AB12'.repeat(16), 'malformed' ],
    [ 'nightscout/cgm-remote-monitor@sha256:' + 'ab12'.repeat(15), 'malformed' ],
    [ 'someone/else@' + DIGEST, 'repository not allowed' ],
    [ 'docker.io/nightscout/cgm-remote-monitor@' + DIGEST, 'repository not allowed' ]
  ];
  cases.forEach(function (c) {
    var log = capture( );
    var annotations = { }; annotations[ni.ANNOTATION] = c[0];
    var r = ni.resolve(env, tenant(annotations), log);
    assert.deepStrictEqual(r, { image: env.MULTIENV_NIGHTSCOUT_IMAGE, source: 'env' }, c[0]);
    assert.strictEqual(log.lines.length, 1, c[0]);
    assert.strictEqual(log.lines[0].detail.reason, c[1], c[0]);
    assert.strictEqual(JSON.stringify(log.lines[0].detail).indexOf(c[0]), -1, 'value not logged');
  });
  var ok = { }; ok[ni.ANNOTATION] = 'nightscout/cgm-remote-monitor:15.0.9@' + DIGEST;
  assert.strictEqual(ni.resolve(env, tenant(ok)).source, 'annotation');
  var other = { }; other[ni.ANNOTATION] = 'registry.example.org/t1pal/nightscout@' + DIGEST;
  assert.strictEqual(ni.resolve(env, tenant(other)).source, 'env');
  assert.strictEqual(ni.resolve(Object.assign({ MULTIENV_NIGHTSCOUT_IMAGE_REPOS: 'registry.example.org/t1pal/nightscout' }, env), tenant(other)).source, 'annotation');
});

test('update_patch ignores an unpinned annotation and keeps the current image', function ( ) {
  var annotations = { }; annotations[ni.ANNOTATION] = 'attacker/image:latest';
  assert.deepStrictEqual(ni.update_patch(deployment(ni.DEFAULT_IMAGE), tenant(annotations), { }, capture( )), [ ]);
});
