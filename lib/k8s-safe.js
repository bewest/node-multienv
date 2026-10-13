'use strict';
// OPS-039 / D-009: what may leave this process from a @kubernetes/client-node
// call.
//
// The 0.x client resolves { response, body } and rejects with
// HttpError(response, body, statusCode). `response` is the `request` library's
// IncomingMessage: its toJSON() carries request.headers.Authorization, and
// util.inspect shows req._header, both "Bearer <service-account token>". The
// same holds for a kubeconfig and for the in-cluster token file
// (KubeConfig.applyAuthorizationHeader / FileAuth.applyAuthentication).
//
// So responses get the API body only, errors get a fresh Error with
// { name, statusCode, code, message, body: <k8s Status> }, and logs get
// summary(err) / summary_result(result). Never send or log the client objects.

// fields of a Kubernetes Status object (meta/v1)
var STATUS_FIELDS = [ 'kind', 'apiVersion', 'metadata', 'status', 'message', 'reason', 'details', 'code' ];

function pick (obj, fields) {
  var out = { };
  fields.forEach(function (f) { if (obj[f] !== undefined) { out[f] = obj[f]; } });
  return out;
}

function status_body (body) {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return pick(body, STATUS_FIELDS);
  }
  // non-JSON answers (proxies, HTML error pages): keep a short string only
  if (typeof body === 'string') { return body.slice(0, 512); }
  return undefined;
}

function is_http_error (err) {
  return !!err && typeof err === 'object' && typeof err.statusCode === 'number';
}

// the API object of a resolved client call, nothing else
function body (result) {
  return result ? result.body : result;
}

// the same { body } wrapper callers of /deployments, /configmaps,
// /configmaps/:name/metadata/... and /sync/* already read, minus `response`
function wrapped (result) {
  return { body: body(result) };
}

function enumerable (obj, key, value) {
  Object.defineProperty(obj, key, { value: value, enumerable: true, writable: true, configurable: true });
}

// An Error that is safe to hand to restify's next(err) or res.send(err).
// HttpError: same status code as before, JSON body
//   { name, statusCode, code, message, body: <k8s Status> }.
// Anything else (connection errors): no statusCode, so restify still answers
//   500 { code: 'Internal', message: String(err) } as before.
function error (err) {
  if (!err || typeof err !== 'object') {
    return new Error(String(err));
  }
  if (is_http_error(err)) {
    var st = status_body(err.body);
    var reason = (st && st.reason) || err.name || 'HttpError';
    var message = (st && st.message) || err.message || 'HTTP request failed';
    var out = new Error(message);
    enumerable(out, 'name', err.name || 'HttpError');
    enumerable(out, 'statusCode', err.statusCode);
    enumerable(out, 'code', reason);
    enumerable(out, 'message', message);
    if (st !== undefined) { enumerable(out, 'body', st); }
    return out;
  }
  var plain = new Error(err.message || String(err));
  if (err.name) { plain.name = err.name; }
  if (err.code) { plain.code = err.code; }
  return plain;
}

// for console.log: code, message and status only
function summary (err) {
  if (!err || typeof err !== 'object') { return { message: String(err) }; }
  var st = is_http_error(err) ? status_body(err.body) : undefined;
  var out = {
    name: err.name,
    code: (st && st.reason) || err.code,
    statusCode: err.statusCode,
    message: (st && st.message) || err.message,
  };
  if (err.type && err.object) {
    // a watch ERROR event: { type, object: <Status> }
    out.code = out.code || err.object.reason;
    out.message = out.message || err.object.message;
    out.statusCode = out.statusCode || err.object.code;
  }
  Object.keys(out).forEach(function (k) { if (out[k] === undefined) { delete out[k]; } });
  return out;
}

// for console.log: what a resolved client call did, not what it carried
function summary_result (result) {
  var b = body(result) || { };
  var md = b.metadata || { };
  return {
    statusCode: result && result.response && result.response.statusCode,
    kind: b.kind,
    name: md.name,
    resourceVersion: md.resourceVersion,
  };
}

// .catch(fail(next)) in place of .catch(next)
function fail (next) {
  return function (err) { next(error(err)); };
}

exports.body = body;
exports.wrapped = wrapped;
exports.error = error;
exports.summary = summary;
exports.summary_result = summary_result;
exports.fail = fail;
exports.status_body = status_body;
