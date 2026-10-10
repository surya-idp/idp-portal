# ${{ values.name }}

${{ values.description }}

Created from the **idp python-service golden path** (Backstage template).

| What | Where |
|---|---|
| Code | `app/` (FastAPI): `main.py` routes, `config.py` settings, `health.py` probes, `logs.py` JSON logs |
| Tests | `tests/` (pytest, coverage gate 80% in `pyproject.toml`) |
| Dependencies | `pyproject.toml` + `uv.lock` (change with `uv add <package>`, commit both) |
| CI | `.github/workflows/ci.yml` calls the shared workflow in `surya-idp/idp-platform` |
| Image | ECR `svc/${{ values.name }}`, tagged with the commit SHA |
| Deployment | `idp-gitops` -> `apps/${{ values.name }}` (Argo CD, automated sync) |
| URL | `http://<ALB>/${{ values.name }}/` (API docs at `/${{ values.name }}/docs`) |
| Docs | `docs/` (TechDocs), including the runbook |

## Work on it

```bash
make install   # once
make check     # lint, format check, types, tests: exactly what CI runs
make run       # http://localhost:8000/${{ values.name }}/docs
```

## How a change reaches the cluster

1. Push to `main` (or merge a PR). CI runs lint, type check and tests, builds the arm64 image,
   scans it with Trivy, and pushes it to ECR.
2. Argo CD Image Updater sees the new image and commits its tag to `idp-gitops`.
3. Argo CD rolls it out with zero downtime.

Nobody merges or clicks anything. A red CI run stops at step 1, so a broken build is never deployed.

## Configuration

Settings are environment variables (`app/config.py`). Set them in
`idp-gitops/apps/${{ values.name }}/base/deployment.yaml` through a pull request.
