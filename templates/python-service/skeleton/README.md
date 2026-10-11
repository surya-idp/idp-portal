# ${{ values.name }}

${{ values.description }}

Created from the **idp python-service golden path** (Backstage template).

| What | Where |
|---|---|
| Code | `app/` (FastAPI): `main.py` routes, `config.py` settings, `health.py` probes, `logs.py` JSON logs, `metrics.py` request metrics, `tracing.py` traces |
| Observability | Grafana dashboard "IDP / Service overview" (rate, errors, latency), logs by `{service="${{ values.name }}"}`, a trace per request |
| Tests | `tests/` (pytest, coverage gate 80% in `pyproject.toml`) |
| Dependencies | `pyproject.toml` + `uv.lock` (change with `uv add <package>`, commit both) |
| CI | `.github/workflows/ci.yml` calls the shared workflow in `surya-idp/idp-platform` |
| Image | ECR `svc/${{ values.name }}`, tagged with the commit SHA |
| Deployment | `idp-gitops` -> `apps/${{ values.name }}` (Argo CD, automated sync) |
| URL | `http://<ALB>/${{ values.name }}/` (API docs at `/${{ values.name }}/docs`) |
| Docs | `docs/` (TechDocs), including the runbook. CI builds them on every push (a broken page fails the pull request) and publishes them on `main`; read them in Backstage on this service's **Docs** tab |

## Work on it

```bash
make install   # once
make check     # lint, format check, types, tests: exactly what CI runs
make run       # http://localhost:8000/${{ values.name }}/docs
```

## A database

If the service was created with "Needs a PostgreSQL database", or after running the
"Add a PostgreSQL database" template in Backstage, the container has `DATABASE_URL` and
`DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD`. The
login owns the database, so the service creates its own tables. To use it: add a driver
(`uv add "psycopg[binary]"`), add a field `database_url: str | None = None` to `app/config.py`,
and register a readiness check in `app/health.py` so the pod only takes traffic when the
database answers.

## Feature flags

Ship code switched off, then switch it on without a deploy.

1. Backstage -> Create -> **Add a feature flag**, pick this service, name the flag.
2. Check it where the behaviour changes:

   ```python
   from app.flags import is_enabled

   if await is_enabled("new-checkout", user_id=user_id):
       ...
   ```

`is_enabled` never raises and never waits long: if the flag service cannot be reached, or the
flag does not exist, it returns `False` (or the `default=` you pass). The service proves who it
is with a token Kubernetes mounts into the pod; there is nothing to configure. Locally and in
tests every flag is its default.

## How a change reaches the cluster

1. Push to `main` (or merge a PR). CI runs lint, type check and tests, builds the arm64 image,
   scans it with Trivy, pushes it to ECR, and attaches signed build provenance and an SBOM.
2. Argo CD Image Updater sees the new image and commits its tag to `idp-gitops`.
3. Argo CD rolls it out with zero downtime.

Nobody merges or clicks anything. A red CI run stops at step 1, so a broken build is never deployed.

## Configuration

Settings are environment variables (`app/config.py`). Set them in
`idp-gitops/apps/${{ values.name }}/base/deployment.yaml` through a pull request.

## Where did this image come from?

Every image CI pushes carries a signed statement of which workflow built it from which commit,
and a list of every package inside it. To check one (needs read access to ECR):

```bash
gh attestation verify oci://693906847772.dkr.ecr.ap-south-1.amazonaws.com/svc/${{ values.name }}@sha256:<digest> \
  --owner surya-idp \
  --signer-workflow surya-idp/idp-platform/.github/workflows/python-service.yml
```
