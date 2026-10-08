# Tenant health checks

Audience: contributors and operators.

The deployment controller (`k8s-deployment-controller.js`) registers each running tenant pod in
Consul as a `backends` service with two HTTP checks. The logic is in `lib/tenant-healthcheck.js`.
The design and its reasoning are in t1dpalsys `ops/decisions/D-011-tenant-health-checks.md`.

| check | URL |
|---|---|
| EndpointAvailable | `http://<podIP>:1337/api/v1/status.txt` |
| ValidPodName, legacy | `$MULTIENV_HEALTH_CHECK_SERVICE/healthchecks/pod/<tenant>/assigned/podIP/<podIP>` (the controller answers it with a cluster DNS lookup) |
| ValidPodName, pod-local | `http://<podIP>:<sidecar port>/healthchecks/pod/<tenant>/assigned/POD_UID/<pod uid>` |

The pod-local URL is used **only for pods whose spec has a `pod-healthcheck` container with a
port named `healthcheck`**. The port comes from that spec. Every other pod gets the legacy URL,
whatever the settings say, so no setting can point checks at a sidecar that isn't there.

With every variable unset, the controller behaves like `7deafde`.

## Settings (controller environment)

| variable | default | meaning |
|---|---|---|
| `MULTIENV_TENANT_HEALTHCHECK` | `legacy` | `pod`: new tenant Deployments get the sidecar, and existing ones get it inside their next rolling-restart patch (update or re-addition). `legacy` injects nothing and leaves existing sidecars alone. |
| `MULTIENV_TENANT_HEALTHCHECK_IMAGE` | `busybox:1.36.1` | Sidecar image. Pin it by digest in deployment config. |
| `MULTIENV_TENANT_HEALTHCHECK_PORT` | `1338` | Sidecar port. Must not be 1337. |
| `MULTIENV_TENANT_HEALTHCHECK_{CPU,MEM}_{REQUEST,LIMIT}` | `1m`, `4Mi` / `20m`, `16Mi` | Sidecar resources. |
| `MULTIENV_CONSUL_ENDPOINT_INTERVAL` | `10s` | |
| `MULTIENV_CONSUL_ENDPOINT_TIMEOUT` | unset | Unset means the Consul default (10s). |
| `MULTIENV_CONSUL_ENDPOINT_DEREGISTER_AFTER` | `20s` | |
| `MULTIENV_CONSUL_VALIDPOD_INTERVAL` | `5s` | |
| `MULTIENV_CONSUL_VALIDPOD_TIMEOUT` | unset | |
| `MULTIENV_CONSUL_VALIDPOD_DEREGISTER_AFTER` | `5s` | Consul enforces at least about 1 minute regardless. |
| `MULTIENV_CONSUL_VALIDPOD_INITIAL_STATUS` | unset (critical) | Set `passing` with a long interval. Consul's first probe can come up to one interval after registration. |

The `consul` client (0.34.1) sends only `http`, `interval`, `timeout`, `status` and
`deregister_critical_service_after`. It drops check `name`, `ttl` and `failures_before_critical`.

Timing applies when a pod is (re)registered, which happens on that pod's next watch event.

## The sidecar

The sidecar is busybox `httpd` serving a single file:
`/www/healthchecks/pod/$TENANT/assigned/POD_UID/$POD_UID`.

- `TENANT` and `POD_UID` come from the Downward API.
- It has no `envFrom`, so it never sees tenant secrets.
- It runs non-root, with a read-only root filesystem and no capabilities.
- It uses about 0.6MiB of memory.

It answers:
- 200 for its own path.
- 404 for any other tenant or UID.
- Connection refused when the pod has no sidecar.

## Per-tenant control (canary and rollback)

These routes work regardless of `MULTIENV_TENANT_HEALTHCHECK`. Each one restarts that tenant
once, and repeating one changes nothing.

```
POST   /healthchecks/pod/<tenant>/adopt     # add the sidecar
DELETE /healthchecks/pod/<tenant>/adopt     # remove it
```

They respond with `{ok, name, changed, ops}` only, never the k8s result or error.

## Tests

```sh
npm test                               # Node 16 (the image's Node), fakes only
test/pod-healthcheck-sidecar.sh        # docker: runs the sidecar as specified and probes it
SIDECAR_CONTROL=1 test/pod-healthcheck-sidecar.sh   # negative control, must fail
```

On Node 24 the restify 8 routes don't load. Run the suite in `node:16`:

```sh
docker run --rm --network none -v "$PWD":/app:ro -w /app node:16-bullseye-slim npm test
```
