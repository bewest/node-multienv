# Pod Health Check Sidecar

## Overview

The pod health check sidecar is a lightweight Node.js service that runs alongside each Nightscout container to provide fast, localhost-based validation of pod identity for Consul health checks. This architecture eliminates DNS queries and API calls to the k8s-deployment-controller, removing critical bottlenecks at scale.

## Architecture

### Problem Statement

In the original architecture, Consul agents performed health checks by making HTTP requests to the k8s-deployment-controller, which then:
1. Performed DNS lookups to CoreDNS to validate pod IPs
2. Made API calls to Kubernetes to verify pod metadata
3. Created resource contention under heavy load (1300+ tenants)
4. Contributed to DNS timeout errors and image pull backoff issues

### Solution: Sidecar Pattern

The health check sidecar moves validation logic into the pod itself:
- **No DNS queries**: All validation is localhost-based
- **No API calls**: Pod metadata is injected via Downward API
- **Minimal resources**: 10m CPU, 32Mi RAM per sidecar
- **Parameterized checks**: Consul specifies which field to validate in the health check URL

## Implementation

### Sidecar Container

The sidecar runs as a second container in the Nightscout pod:

```yaml
containers:
  - name: nightscout
    image: nightscout/cgm-remote-monitor:latest
    ports:
      - containerPort: 1337
        name: http
  
  - name: pod-healthcheck
    image: pod-healthcheck:latest
    ports:
      - containerPort: 3000
        name: healthcheck
    env:
      - name: PORT
        value: "3000"
      - name: POD_UID
        valueFrom:
          fieldRef:
            fieldPath: metadata.uid
      - name: POD_IP
        valueFrom:
          fieldRef:
            fieldPath: status.podIP
      - name: POD_NAME
        valueFrom:
          fieldRef:
            fieldPath: metadata.name
      - name: POD_NAMESPACE
        valueFrom:
          fieldRef:
            fieldPath: metadata.namespace
      - name: NODE_NAME
        valueFrom:
          fieldRef:
            fieldPath: spec.nodeName
```

### Downward API

The Kubernetes Downward API injects pod metadata as environment variables, making them available to the sidecar without any API calls:

- `POD_UID`: Unique pod identifier (best for identity validation)
- `POD_IP`: Pod IP address
- `POD_NAME`: Pod name
- `POD_NAMESPACE`: Namespace
- `NODE_NAME`: Node where pod is scheduled

## Health Check Endpoint

### Basic Health Check

```bash
curl http://localhost:3000/health
```

Response:
```json
{
  "status": "ok",
  "message": "Health check endpoint ready",
  "available_fields": ["pod_uid", "pod_ip", "pod_name", "pod_namespace", "node_name"],
  "metadata": {
    "pod_uid": "abc-123-def-456",
    "pod_ip": "10.244.1.5",
    "pod_name": "tenant001-nightscout-7d8f9c-xyz",
    "pod_namespace": "hosted-tenants",
    "node_name": "worker-node-3"
  }
}
```

### Parameterized Validation

Consul can specify which field to validate by passing query parameters:

```bash
curl "http://localhost:3000/health?field=pod_uid&expected=abc-123-def-456"
```

Success response (HTTP 200):
```json
{
  "status": "ok",
  "field": "pod_uid",
  "actual": "abc-123-def-456",
  "expected": "abc-123-def-456",
  "match": true,
  "timestamp": "2025-10-29T12:34:56.789Z"
}
```

Mismatch response (HTTP 503):
```json
{
  "status": "mismatch",
  "field": "pod_uid",
  "actual": "abc-123-def-456",
  "expected": "different-value",
  "match": false,
  "timestamp": "2025-10-29T12:34:56.789Z"
}
```

### Query Without Expected Value

Get the actual value without validation:

```bash
curl "http://localhost:3000/health?field=pod_ip"
```

Response:
```json
{
  "status": "ok",
  "field": "pod_ip",
  "actual": "10.244.1.5",
  "message": "No expected value provided, returning actual value only"
}
```

## Consul Integration

### Registration Pattern

When registering a service with Consul, encode the expected pod UID in the health check URL:

```json
{
  "ID": "nightscout-tenant001-abc-123",
  "Name": "nightscout",
  "Tags": ["tenant001", "nightscout"],
  "Address": "10.244.1.5",
  "Port": 1337,
  "Check": {
    "HTTP": "http://10.244.1.5:3000/health?field=pod_uid&expected=abc-123-def-456",
    "Interval": "10s",
    "Timeout": "2s"
  }
}
```

### Why pod_uid is Best for Identity Validation

**Recommended**: Use `pod_uid` as the primary validation field because:
- Guaranteed unique across the cluster and time
- Never reused even if pod is deleted and recreated with same name
- Persists throughout pod lifecycle
- Not affected by pod rescheduling or IP changes

**Alternative fields**:
- `pod_ip`: Can be recycled quickly when pods are replaced
- `pod_name`: Not guaranteed unique if deployments scale rapidly
- `pod_namespace`: Too broad for per-pod validation
- `node_name`: Identifies node, not individual pod

### Lifecycle Example

1. **Pod Creation**: Webhook renders Nightscout pod with sidecar, captures `pod_uid`
2. **Consul Registration**: Register service with health check URL containing `pod_uid`
3. **Health Checks**: Consul queries `http://POD_IP:3000/health?field=pod_uid&expected=VALUE`
4. **Pod Replacement**: New pod gets new `pod_uid`, old registration naturally fails health checks
5. **Cleanup**: Consul marks old service unhealthy, deregisters, registers new pod

## Configuration

### Enable/Disable Sidecar

Set in ConfigMap (compute composite parent):

```yaml
data:
  POD_HEALTHCHECK_ENABLED: "true"  # default: true
```

### Custom Image

```yaml
data:
  POD_HEALTHCHECK_IMAGE: "registry.example.com/pod-healthcheck:v1.0"
  POD_HEALTHCHECK_IMAGE_PULL_POLICY: "IfNotPresent"
```

### Custom Port

```yaml
data:
  POD_HEALTHCHECK_PORT: "3000"  # default: 3000
```

### Resource Limits

```yaml
data:
  POD_HEALTHCHECK_CPU_REQUEST: "10m"
  POD_HEALTHCHECK_CPU_LIMIT: "50m"
  POD_HEALTHCHECK_MEM_REQUEST: "32Mi"
  POD_HEALTHCHECK_MEM_LIMIT: "64Mi"
```

## Performance Impact

### Before (k8s-deployment-controller)

For 1300 tenants with 10s health check interval:
- **Requests**: ~7,800 requests/minute to deployment controller
- **DNS queries**: ~7,800 CoreDNS queries/minute
- **API calls**: ~7,800 Kubernetes API calls/minute
- **Bottlenecks**: DNS timeout errors, image pull backoff, resource contention

### After (Pod Sidecar)

For 1300 tenants with 10s health check interval:
- **Requests**: ~7,800 localhost requests/minute (no network hops)
- **DNS queries**: 0 (eliminated)
- **API calls**: 0 (eliminated)
- **Resource overhead**: 13 mCPU, 41.6 MiB total (1300 * 10m/32Mi)

### Scaling Potential

With DNS/API bottlenecks removed:
- **10,000 tenants**: 100 mCPU, 320 MiB for sidecars
- **50,000 tenants**: 500 mCPU, 1.6 GiB for sidecars

The sidecar pattern scales linearly with tenant count, unlike the centralized controller pattern which creates quadratic load on shared infrastructure (DNS, etcd).

## Multi-Cluster Considerations

### Network Segmentation

The sidecar pattern works seamlessly across network segments because:
- Health checks are localhost-only (no cross-segment traffic)
- Consul agents run on each node (local to pods)
- Service discovery uses Consul (not DNS)

### Cluster Federation

When federating multiple Kubernetes clusters:
1. Each cluster deploys Nightscout pods with sidecars
2. Consul agents in each cluster register local services
3. Consul federation enables cross-cluster service discovery
4. Health checks remain localhost, no cross-cluster health traffic

### Geographic Distribution

For geo-distributed deployments:
- Each region runs independent Kubernetes cluster
- Consul datacenters federated across regions
- Health checks stay within local pods (no latency impact)
- Service routing uses Consul's geo-aware features

## Troubleshooting

### Sidecar Not Starting

Check if sidecar is enabled:
```bash
kubectl get deployment tenant001-nightscout -o json | jq '.spec.template.spec.containers[] | select(.name=="pod-healthcheck")'
```

Check sidecar logs:
```bash
kubectl logs tenant001-nightscout-xyz-123 -c pod-healthcheck
```

### Health Check Failures

Test sidecar directly from within pod:
```bash
kubectl exec tenant001-nightscout-xyz-123 -c nightscout -- curl http://localhost:3000/health
```

Verify environment variables:
```bash
kubectl exec tenant001-nightscout-xyz-123 -c pod-healthcheck -- env | grep POD_
```

### Consul Registration Issues

Check Consul catalog:
```bash
consul catalog services -tags
consul catalog nodes -service=nightscout
```

Inspect health check URL:
```bash
consul catalog service nightscout | jq '.[].Checks[] | select(.Name=="Service health check")'
```

## Migration Path

### Phase 1: Deploy Sidecar (No Consul Changes)

1. Update ConfigMap templates to include `POD_HEALTHCHECK_ENABLED: "true"`
2. Deploy updated webhook handler
3. Sidecars deploy with new pods, existing pods unchanged
4. Verify sidecars respond to health checks

### Phase 2: Dual Health Checks

1. Update Consul registration to include both old and new health checks
2. Monitor both for comparison
3. Validate new sidecar-based checks are working

### Phase 3: Cut Over

1. Update Consul registration to use only sidecar health checks
2. Remove old k8s-deployment-controller health check logic
3. Monitor for issues

### Phase 4: Scale Down Controller

1. Reduce k8s-deployment-controller replicas (less health check traffic)
2. Monitor DNS and API server load improvements
3. Reallocate resources

## Security Considerations

- Sidecar binds to `0.0.0.0:3000` but only accessible within pod network
- No authentication required (localhost trust model)
- No secrets or credentials exposed (metadata only)
- Read-only access to Downward API fields
- Minimal attack surface (stateless, no external connections)

## Future Enhancements

### Custom Validation Logic

Add custom validators for application-specific health:
```bash
curl "http://localhost:3000/health?field=custom&validator=mongo_connection"
```

### Prometheus Metrics

Expose health check metrics:
```
pod_healthcheck_requests_total{field="pod_uid",status="match"}
pod_healthcheck_response_time_seconds
```

### Multi-Field Validation

Support multiple field checks in one request:
```bash
curl "http://localhost:3000/health?fields=pod_uid,node_name&expected_uid=abc&expected_node=worker-1"
```
