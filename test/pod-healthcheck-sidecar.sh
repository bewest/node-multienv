#!/usr/bin/env bash
# Runs the pod-healthcheck sidecar exactly as lib/tenant-healthcheck.js
# specifies it (image, script, uid, read-only root, no capabilities, memory
# limit) in docker, and probes it from a second container in the same network
# namespace, the way a Consul agent would reach podIP:<port>.
#
#   test/pod-healthcheck-sidecar.sh [image]     # default: the lib's default image
#
# Needs docker and node; no cluster.  Negative control: SIDECAR_CONTROL=1
# expects a 200 for another pod's UID, which must fail.
set -euo pipefail
cd "$(dirname "$0")/.."

spec=$(node -e '
  var hc = require("./lib/tenant-healthcheck");
  var c = hc.sidecar_container(hc.config(process.env));
  console.log(JSON.stringify({ image: process.argv[1] || c.image, script: c.command[2], port: c.ports[0].containerPort,
    user: c.securityContext.runAsUser, mem: c.resources.limits.memory }));
' "${1:-}")
image=$(node -e 'console.log(JSON.parse(process.argv[1]).image)' "$spec")
script=$(node -e 'console.log(JSON.parse(process.argv[1]).script)' "$spec")
port=$(node -e 'console.log(JSON.parse(process.argv[1]).port)' "$spec")
user=$(node -e 'console.log(JSON.parse(process.argv[1]).user)' "$spec")
mem=$(node -e 'console.log(JSON.parse(process.argv[1]).mem.replace(/Mi$/, "m"))' "$spec")

tenant=tenant-a
uid=0b6c2a8e-1111-4c2d-9e7f-aaaaaaaaaaaa
name=pod-hc-sidecar-test-$$
fail=0
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$name" --network none --read-only --tmpfs /www:size=1m,uid=$user,gid=$user \
  --user "$user:$user" --cap-drop ALL --security-opt no-new-privileges --memory "$mem" \
  -e PORT="$port" -e TENANT="$tenant" -e POD_UID="$uid" \
  "$image" sh -c "$script" >/dev/null
sleep 1

probe() {  # probe <expect> <path>
  local got
  got=$(docker run --rm --network "container:$name" "$image" \
    sh -c "wget -S -q -O /dev/null http://127.0.0.1:$port$2 2>&1 | awk '/HTTP\\//{print \$2; exit}' || true")
  got=${got:-none}
  if [ "$got" = "$1" ]; then echo "ok   $1 $2"; else echo "FAIL $2: expected $1, got $got"; fail=1; fi
}

probe 200 "/healthchecks/pod/$tenant/assigned/POD_UID/$uid"
if [ "${SIDECAR_CONTROL:-}" = 1 ]; then
  probe 200 "/healthchecks/pod/$tenant/assigned/POD_UID/ffffffff-0000-0000-0000-000000000000"
else
  probe 404 "/healthchecks/pod/$tenant/assigned/POD_UID/ffffffff-0000-0000-0000-000000000000"
fi
probe 404 "/healthchecks/pod/tenant-b/assigned/POD_UID/$uid"
probe 404 "/healthchecks/pod/$tenant/assigned/podIP/10.244.1.7"
probe 404 "/"

running=$(docker inspect -f '{{.State.Running}}' "$name")
[ "$running" = true ] && echo "ok   still running" || { echo "FAIL sidecar exited"; fail=1; }
docker stats --no-stream --format 'info mem {{.MemUsage}}' "$name"
docker image inspect -f 'info image {{.RepoTags}} {{.Size}} bytes' "$image"

# Missing Downward API values: must exit non-zero instead of serving a path
# that can never match.
if docker run --rm --network none --read-only --tmpfs /www:size=1m,uid=$user,gid=$user --user "$user:$user" \
     -e PORT="$port" -e TENANT= -e POD_UID="$uid" "$image" sh -c "$script" >/dev/null 2>&1; then
  echo "FAIL started without TENANT"; fail=1
else
  echo "ok   refuses to start without TENANT"
fi

[ $fail = 0 ] && echo "sidecar: all checks passed" || { echo "sidecar: FAILED"; exit 1; }
