# ${{ values.name }}

${{ values.description }}

## What it is

A FastAPI service created from the idp `python-service` golden path. It runs in the dev
cluster in namespace `${{ values.name }}` and is reachable through the shared load balancer
at `/${{ values.name }}/`.

## API

Interactive API documentation is served by the service itself at `/${{ values.name }}/docs`
(OpenAPI document at `/${{ values.name }}/openapi.json`).

## How it is built and deployed

| Step | Where | Who acts |
|---|---|---|
| Lint, types, tests, image build, vulnerability scan | GitHub Actions, shared workflow from `surya-idp/idp-platform` | automatic on every push |
| Image stored | ECR `svc/${{ values.name }}`, tag = commit SHA | CI, on `main` only |
| New tag written to `idp-gitops` | Argo CD Image Updater | automatic |
| Rollout | Argo CD, rolling update with no dropped requests | automatic |

## What the platform gives this service

- at least 2 replicas spread over zones, autoscaling on CPU, a disruption budget
- restricted pod security: non-root, read-only root filesystem, no capabilities
- its own ServiceAccount with no API token mounted
- JSON logs with a request id on every line
