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

## Logs

```bash
kubectl -n ${{ values.name }} logs deploy/${{ values.name }} --tail=100
```

One JSON object per line. Every request line has `request_id`, `method`, `path`, `status`
and `duration_ms`. To follow one request, filter on its `request_id` (the value of the
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
