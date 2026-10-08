# Tenant health checks

Audience: contributors and operators.

The deployment controller (`k8s-deployment-controller.js`) registers each running tenant pod in
Consul as a `backends` service with two HTTP checks. The logic is in `lib/tenant-healthcheck.js`.
The design and its reasoning, including the review findings, are in t1dpalsys
`ops/decisions/D-011-tenant-health-checks.md`.

| check | URL |
|---|---|
| EndpointAvailable | `http://<podIP>:1337/api/v1/status.txt` |
| ValidPodName, legacy | `$MULTIENV_HEALTH_CHECK_SERVICE/healthchecks/pod/<tenant>/assigned/podIP/<podIP>` (the controller answers it with a cluster DNS lookup) |
| ValidPodName, pod-local | `http://<podIP>:<sidecar port>/healthchecks/pod/<tenant>/assigned/POD_UID/<pod uid>` |

The pod-local URL is used **only for pods whose spec has a `pod-healthcheck` container with a
port named `healthcheck`**, and the port comes from that spec. Every other pod gets the legacy
URL, whatever the settings say, so no setting can point checks at a sidecar that isn't there.
Gen4 pods with the Node sidecar on port 3000 are recognised the same way.

## With every variable unset

With every variable unset, the Consul check payloads, the Deployment template and the restart
patch are identical to `7deafde`; tests check all three. Deliberate differences:

- **Pods are not registered when they have no `tenant` label, or when they are terminating.**
  `7deafde` registered unlabelled pods with the tag "undefined". Re-registering a terminating
  pod could revive an entry its deletion had already removed.
- **Errors from `/sync/additions` and `/sync/updates` pass through `lib/k8s-safe`**, the
  OPS-039 hotfix this branch is based on: same status code, the k8s Status body only, never the
  client objects that carry the service-account token. Two paths that used to hang the request
  (a create error without `.response`, or a missing deployment on update) now answer instead of
  becoming unhandled rejections.
- **There are new routes**, `POST`/`DELETE /healthchecks/pod/:name/adopt`, in every mode.
- **A malformed `MULTIENV_TENANT_HEALTHCHECK_PORT`, or 1337, stops the controller at boot.** It
  fails fast instead of injecting a broken sidecar.

## Settings (controller environment)

| variable | default | meaning |
|---|---|---|
| `MULTIENV_TENANT_HEALTHCHECK` | `legacy` | `pod`: new tenant Deployments get the sidecar, and existing ones get it inside their next rolling restart (update or re-addition). `legacy` injects nothing and leaves existing sidecars alone. |
| `MULTIENV_TENANT_HEALTHCHECK_IMAGE` | `busybox:1.36.1` | Sidecar image. Pin it by digest, mirrored into the DO registry, in deployment config. |
| `MULTIENV_TENANT_HEALTHCHECK_PORT` | `1338` | Sidecar port. Digits only, and not 1337. |
| `MULTIENV_TENANT_HEALTHCHECK_{CPU,MEM}_{REQUEST,LIMIT}` | `1m`, `4Mi` / `20m`, `32Mi` | Sidecar resources. |
| `MULTIENV_CONSUL_ENDPOINT_INTERVAL` | `10s` | |
| `MULTIENV_CONSUL_ENDPOINT_TIMEOUT` | unset | Unset means the Consul default (10s). |
| `MULTIENV_CONSUL_ENDPOINT_DEREGISTER_AFTER` | `20s` | Consul raises anything below 1m to 1m. |
| `MULTIENV_CONSUL_VALIDPOD_INTERVAL` | `5s` | Keep it at 5–10s; see below. |
| `MULTIENV_CONSUL_VALIDPOD_TIMEOUT` | unset | |
| `MULTIENV_CONSUL_VALIDPOD_DEREGISTER_AFTER` | `5s` | Consul raises anything below 1m to 1m. |

`MULTIENV_CONSUL_VALIDPOD_INITIAL_STATUS` is **not supported** and is ignored with a log line.
An initially passing `ValidPodName`, or a long interval, leaves a stale registration routable to
whichever pod now holds the IP until the next probe. `EndpointAvailable` doesn't identify the
tenant, so it can't catch that.

The `consul` client (0.34.1) sends only `http`, `interval`, `timeout`, `status` and
`deregister_critical_service_after`. It drops check `name`, so in Consul both checks are named
"Service 'backends' check": `:1` is EndpointAvailable and `:2` is ValidPodName.

Timing applies when a pod is (re)registered, which happens on that pod's next watch event.

## Adoption and concurrency

Adoption rides inside the rolling-restart patch, guarded by a JSON patch `test` of the
Deployment's `resourceVersion`. If another replica or request changed the Deployment in the
meantime, the patch fails. The controller then re-reads and retries once, and after that falls
back to the plain restart, so the change that triggered the restart is never dropped and no
Deployment gets two sidecars.

Only Deployments whose pod template is labelled `tenant=<name>` are adopted.

## The sidecar

The sidecar is busybox `httpd` serving a single file:
`/www/healthchecks/pod/$TENANT/assigned/POD_UID/$POD_UID`.

- `TENANT` and `POD_UID` come from the Downward API.
- It has no `envFrom`, so it never sees tenant secrets.
- It runs non-root (65534), with a read-only root filesystem, no capabilities and no probes.
- It uses about 1MiB of memory.
- The shell stays PID 1 and forwards SIGTERM, so pods stop promptly.

It answers:
- 200 for its own path.
- 404 for any other tenant or UID.
- Connection refused when the pod has no sidecar.

**Known risks** (D-011, t1dpalsys REGISTER):

- **If the sidecar dies, a healthy tenant becomes unroutable** within one `ValidPodName` interval,
  and is deregistered about 1–1.5 minutes later unless the sidecar comes back.
- **busybox httpd forks one process per connection, with no cap.** About 300 idle connections from
  any pod in the cluster exhaust a 32Mi limit (OPS-047).

## Per-tenant control (canary and rollback)

These routes work regardless of `MULTIENV_TENANT_HEALTHCHECK`. Each one restarts that tenant
once, and repeating one changes nothing.

```
POST   /healthchecks/pod/<tenant>/adopt     # add the sidecar
DELETE /healthchecks/pod/<tenant>/adopt     # remove it
```

| response | when |
|---|---|
| 200 `{ok:true, name, changed:true, ops}` | patched |
| 200 `{ok:true, name, changed:false}` | nothing to do |
| 422 `{ok:false, name, reason:'not a tenant deployment'}` | the template isn't labelled `tenant=<name>` |
| `<k8s status>` `{ok:false, name, status}` | the k8s read or patch failed; never the raw k8s result or error |

With `MULTIENV_TENANT_HEALTHCHECK=pod`, a `DELETE` is undone at that tenant's next update or
re-addition.

## Tests

```sh
docker run --rm --network none -v "$PWD":/app:ro -w /app node:16-bullseye-slim npm test
test/pod-healthcheck-sidecar.sh                       # docker: runs the sidecar as specified and probes it
SIDECAR_CONTROL=1 test/pod-healthcheck-sidecar.sh     # negative control, must fail
```

- Use the image's Node 16, because restify 8 doesn't load on Node 24.
- The negative controls for the unit suite are listed in the test file's header.
- `test/fixtures/template-7deafde.json` is what `7deafde` sends to `createNamespacedDeployment`,
  captured by running `7deafde` itself.
