# Runbook

Commands assume `kubectl` access to the cluster. The namespace is `${{ values.name }}`.

## Is it healthy?

```bash
kubectl -n ${{ values.name }} get deploy,pods,hpa
kubectl -n argocd get application ${{ values.name }}
curl -s http://<ALB>/${{ values.name }}/
```

| Endpoint | Meaning | When it fails |
|---|---|---|
| `/health/live` | the process works | Kubernetes restarts the container |
| `/health/ready` | the service can take traffic | the pod leaves the load balancer, no restart |

## Dashboards, metrics and traces

```bash
kubectl -n monitoring port-forward svc/kps-grafana 3000:80     # http://localhost:3000, user admin
kubectl -n monitoring get secret grafana-admin -o jsonpath='{.data.admin-password}' | base64 -d
```

| I want to see | Where in Grafana |
|---|---|
| traffic, error share, latency of this service | Dashboards -> "IDP / Service overview" -> Service = `${{ values.name }}` |
| its logs | Explore -> Loki -> `{service="${{ values.name }}"}`; add `\| json \| status >= 500` to filter on fields |
| where one slow request spent its time | open a log line, click its `trace_id` -> the trace in Tempo |

The service exposes `/metrics` on the pod (not through the load balancer). Alerts that exist for
every service: ServiceDown, HighErrorRate (more than 5% 5xx for 5 minutes), HighLatency (p95
above 500 ms for 5 minutes), PodRestarting. Fired alerts: `kubectl -n monitoring logs deploy/alert-receiver`.

## Logs

```bash
kubectl -n ${{ values.name }} logs deploy/${{ values.name }} --tail=100
```

One JSON object per line. Every request line has `request_id`, `trace_id`, `method`, `path`,
`status` and `duration_ms`. To follow one request, filter on its `request_id` (the value of the
`X-Request-ID` response header).

## A deploy did not happen

1. Is CI green? Check the Actions tab of this repo. A red run pushes no image.
2. Did the tag reach Git? Look for a `chore(deploy)` commit by `idp-ci-bot[bot]` in `idp-gitops`.
   If it is missing: `kubectl -n argocd logs deploy/argocd-image-updater-controller`.
3. Did Argo CD sync? `kubectl -n argocd get application ${{ values.name }}`.

## Roll back

Revert the `chore(deploy)` commit in `idp-gitops` with a pull request. Argo CD rolls the
previous image out. Then fix forward in this repo: the next image pushed is deployed again.

## Pods restart or are not Ready

```bash
kubectl -n ${{ values.name }} describe pod <pod>
kubectl -n ${{ values.name }} logs <pod> --previous
```

| Symptom | Usual cause |
|---|---|
| `OOMKilled` | memory limit too low: raise it in `idp-gitops/apps/${{ values.name }}/base/deployment.yaml` |
| `ImagePullBackOff` | the tag in `idp-gitops` has no image in ECR |
| `Read-only file system` error | the code writes to disk: write under `/tmp` only |
