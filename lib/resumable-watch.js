'use strict';
// One long-lived stream of watch events across many watch requests
// (OPS-036, OPS-071, OPS-073; Q-OPERATOR-WATCH F1, F2).
//
// The apiserver ends every watch after its request timeout (30-60 min). The
// dispatcher used to exit then, and its next run started watching from "now",
// so events in between were lost. Here a watch that ends is resumed from the
// newest resourceVersion seen (events and BOOKMARKs). When that version has
// expired (410), the objects are listed again and only the differences from
// what this process has already seen are sent on: MODIFIED for a changed
// resourceVersion, ADDED for a new object, DELETED for a missing one. An
// unchanged object sends nothing, so a re-list never looks like every tenant
// being added again.
//
// Events are { type, object } as the apiserver sends them. BOOKMARK and ERROR
// events are not passed on.

var stream = require('stream');

function key (obj) {
  var m = obj.metadata || { };
  return (m.namespace || '') + '/' + m.name;
}

function is_expired (status) {
  return !!status && (status.code == 410 || status.statusCode == 410 || status.reason == 'Expired' || status.reason == 'Gone');
}

// opts:
//   watch          object with watch(path, params, callback, done) -> Promise<req>
//                  (@kubernetes/client-node Watch)
//   list           async () -> { metadata: { resourceVersion }, items: [ ] }; without
//                  it an expired watch is fatal
//   endpoint       watch path, e.g. /api/v1/namespaces/default/pods
//   params         query params (labelSelector, fieldSelector)
//   resourceVersion  where the first watch starts; '' means the apiserver sends
//                  every existing object as ADDED first (INIT_WITH_FULL_AUDIT)
//   seed           objects already known (from the list that gave resourceVersion)
//   backoffMs, maxBackoffMs, maxFailures
//   maxRelistDeletes  more synthesized deletions than this are not sent
//   exitOnEnd      old behaviour: a watch that ends normally is fatal
//   onFatal(code, reason)
//   log
function resumableWatch (opts) {
  var log = opts.log || console.log;
  var backoffMs = opts.backoffMs === undefined ? 1000 : opts.backoffMs;
  var maxBackoffMs = opts.maxBackoffMs || 30000;
  var maxFailures = opts.maxFailures || 10;
  var maxRelistDeletes = opts.maxRelistDeletes === undefined ? 20 : opts.maxRelistDeletes;
  var onFatal = opts.onFatal || function (code, reason) { log('WATCH FATAL', reason); process.exit(code); };

  var source = new stream.PassThrough({ objectMode: true, highWaterMark: 16 });
  var cache = { };
  (opts.seed || [ ]).forEach(function (obj) { cache[key(obj)] = obj; });
  var lastRV = opts.resourceVersion || '';
  var failures = 0;
  var stopped = false;
  var current = null;
  var timer = null;
  var counters = { sessions: 0, rewatches: 0, relists: 0, failures: 0, events: 0,
    relist_added: 0, relist_modified: 0, relist_deleted: 0, relist_deletes_skipped: 0 };

  function write (ev) {
    counters.events++;
    return source.write(ev);
  }

  function retryLater (fn, why) {
    failures++;
    counters.failures++;
    if (failures >= maxFailures) {
      return onFatal(1, 'WATCH GAVE UP after ' + failures + ' failures: ' + why);
    }
    var delay = Math.min(maxBackoffMs, backoffMs * Math.pow(2, failures - 1));
    log('WATCH RETRY', failures, 'of', maxFailures, 'in', delay, 'ms:', why);
    timer = setTimeout(fn, delay);
  }

  function startSession ( ) {
    if (stopped) { return; }
    counters.sessions++;
    var session = { req: null, events: 0, expired: false, ended: false, paused: false };
    current = session;
    var params = Object.assign({ }, opts.params, { allowWatchBookmarks: true });
    if (lastRV) { params.resourceVersion = lastRV; }

    function onEvent (type, obj, raw) {
      if (session.ended || stopped) { return; }
      session.events++;
      if (type == 'ERROR') {
        if (is_expired(obj)) {
          session.expired = true;
        }
        log('WATCH ERROR EVENT', obj && obj.code, obj && obj.reason, obj && obj.message);
        return;
      }
      if (obj && obj.metadata && obj.metadata.resourceVersion) {
        lastRV = obj.metadata.resourceVersion;
      }
      if (type == 'BOOKMARK') { return; }
      if (type == 'DELETED') { delete cache[key(obj)]; } else { cache[key(obj)] = obj; }
      var ok = write(raw && raw.type ? { type: raw.type, object: raw.object } : { type: type, object: obj });
      if (!ok && session.req && !session.paused) {
        session.paused = true;
        session.req.pause( );
        source.once('drain', function ( ) {
          session.paused = false;
          if (!session.ended) { session.req.resume( ); }
        });
      }
    }

    function onDone (err) {
      if (session.ended) { return; }
      session.ended = true;
      if (current === session) { current = null; }
      if (stopped) { return; }
      if (session.expired || (err && is_expired(err))) {
        log('WATCH EXPIRED at resourceVersion', lastRV, '- listing again');
        return relist( );
      }
      if (err) {
        return retryLater(startSession, 'watch error ' + (err.statusCode || err.code || err.message));
      }
      if (opts.exitOnEnd) {
        return onFatal(0, 'WATCH ENDED (exit on end)');
      }
      if (session.events > 0) { failures = 0; }
      counters.rewatches++;
      log('WATCH ENDED after', session.events, 'events; resuming from resourceVersion', lastRV);
      if (session.events == 0) {
        return retryLater(startSession, 'watch ended with no events');
      }
      timer = setTimeout(startSession, Math.min(backoffMs, 1000));
    }

    var started;
    try {
      started = opts.watch.watch(opts.endpoint, params, onEvent, onDone);
    } catch (err) {
      return onDone(err);
    }
    Promise.resolve(started).then(function (req) {
      session.req = req;
      if (session.ended && req && req.abort) { req.abort( ); }
    }, onDone);
  }

  function relist ( ) {
    if (stopped) { return; }
    if (!opts.list) {
      return onFatal(1, 'WATCH EXPIRED and this endpoint has no re-list');
    }
    counters.relists++;
    Promise.resolve( ).then(opts.list).then(function (result) {
      if (stopped) { return; }
      var seen = { };
      var added = 0, modified = 0, deletes = [ ];
      (result.items || [ ]).forEach(function (obj) {
        var k = key(obj);
        seen[k] = true;
        var before = cache[k];
        cache[k] = obj;
        if (!before) {
          added++;
          write({ type: 'ADDED', object: obj });
        } else if (before.metadata.resourceVersion != obj.metadata.resourceVersion) {
          modified++;
          write({ type: 'MODIFIED', object: obj });
        }
      });
      Object.keys(cache).forEach(function (k) {
        if (!seen[k]) { deletes.push(cache[k]); delete cache[k]; }
      });
      if (deletes.length > maxRelistDeletes) {
        // A short or empty list must never turn into mass deletions.
        counters.relist_deletes_skipped += deletes.length;
        log('RELIST SKIPPED DELETIONS', deletes.length, 'over the limit of', maxRelistDeletes);
      } else {
        deletes.forEach(function (obj) { write({ type: 'DELETED', object: obj }); });
        counters.relist_deleted += deletes.length;
      }
      counters.relist_added += added;
      counters.relist_modified += modified;
      lastRV = result.metadata && result.metadata.resourceVersion || '';
      log('RELIST', (result.items || [ ]).length, 'objects:', added, 'added,', modified, 'modified,', deletes.length, 'deleted; watching from', lastRV);
      failures = 0;
      startSession( );
    }).catch(function (err) {
      retryLater(relist, 'list failed ' + (err && (err.statusCode || err.code || err.message)));
    });
  }

  function stop ( ) {
    stopped = true;
    clearTimeout(timer);
    if (current && current.req && current.req.abort) { current.req.abort( ); }
    source.end( );
  }

  startSession( );
  return { source: source, stop: stop, counters: counters,
    resourceVersion: function ( ) { return lastRV; } };
}

module.exports = resumableWatch;
resumableWatch.key = key;
resumableWatch.is_expired = is_expired;
