# idp-portal

The developer portal of the IDP: a [Backstage](https://backstage.io) app (release 1.54, new
frontend system) with this platform's software templates, scaffolder actions and permission
policy. A developer fills in a form here and gets a tested, deployed service a few minutes
later, without touching AWS, Kubernetes or the deploy repository.

It is one of five repositories of the platform:

| Repository | Role |
|---|---|
| [idp-infra](https://github.com/surya-idp/idp-infra) | Terraform for AWS, `make up` / `make down`, the end-to-end test |
| [idp-gitops](https://github.com/surya-idp/idp-gitops) | What runs in the cluster; Argo CD deploys from it |
| **idp-portal** (this one) | Backstage, the templates, the custom actions |
| [idp-platform](https://github.com/surya-idp/idp-platform) | The CI workflow every template service calls |
| [feature-flag-service](https://github.com/surya-idp/feature-flag-service) | The platform's first application, the flag API |

## What is in the portal

| Feature | How it is set up here |
|---|---|
| Catalog | Every repository of the `surya-idp` organisation with a `catalog-info.yaml` on `main` is found by a scan every 5 minutes. No list to maintain; an archived repository drops out by itself |
| Sign-in | GitHub only (the OAuth client of the Backstage GitHub App). Guest sign-in exists only when running locally |
| Permissions | Everyone signed in may read and create. Destructive actions need the group `platform-admins` (`packages/backend/src/permissions/policy.ts`) |
| Templates | Four, below. Read from this repository on GitHub, so changing one is a git push, not an image rebuild |
| Docs tab | TechDocs, read-only: each service's CI builds its `docs/` folder and uploads it to an S3 bucket; Backstage reads it with its IAM role |
| Kubernetes tab | Pods, deployments, services and ingresses of a service, read live as Backstage's own ServiceAccount (read-only cluster role, no Secrets) |
| CI tab | GitHub Actions runs of a service (`@backstage-community/plugin-github-actions` 1.4.0, the release built for Backstage 1.54) |

Not installed, on purpose: the Argo CD and Grafana plugins. Argo CD's would need one more
stored credential to show what the Kubernetes tab already shows, and Grafana has no address a
browser can reach (the platform has no domain; its tools are reached through `kubectl port-forward`).

## The templates

All four are listed in `templates/all-templates.yaml`. The contract between them is in
[templates/README.md](templates/README.md).

| Template | Kind | What it does |
|---|---|---|
| `python-service` | creates | A FastAPI service: repository, CI, deploy files, route on the shared load balancer, docs, catalog entry. Optional own PostgreSQL database. Live with zero clicks after the form |
| `add-postgres-database` | day-2 | Gives an existing service its own database and login, as environment variables |
| `add-feature-flag` | day-2 | Creates a feature flag for a service in the flag API. Changes no repository |
| `decommission-service` | day-2 | Removes a service everywhere: deployment, route, database, images, flags, docs, catalog entry. Archives the repository, or deletes it if the box is ticked |

The day-2 templates work for a service from **any** creation template. They never assume what
was created; they read it from annotations that the creation template wrote into the service's
catalog entry (`idp.surya-idp/template-version`, `idp.surya-idp/gitops-path`,
`idp.surya-idp/ecr-repository`, `github.com/project-slug`). A new creation template (Go, Node)
needs no new day-2 template.

What `python-service` hands to a developer (`templates/python-service/skeleton/`): tests with
a coverage gate, typed settings, JSON logs with request and trace ids, liveness and readiness
endpoints, Prometheus metrics, OpenTelemetry tracing, a feature flag helper (`app/flags.py`), a
two-stage non-root image, docs, and a 15-line CI file that calls the shared workflow.

## The custom scaffolder actions

Backstage's built-in actions cannot wait for another repository's CI, edit one line of a
Kustomize file, or clean up after a service. Eleven actions do that, in
`packages/backend/src/scaffolder/`. Each handler in `module.ts` is thin wiring; the behaviour is
in plain functions with unit tests.

| Action | Used by | Logic in |
|---|---|---|
| `idp:github:await-ci-auto-merge` | python-service, add-postgres-database, decommission-service | `awaitCiAndAutoMerge.ts` |
| `idp:gitops:add-component` | add-postgres-database | `kustomize.ts` |
| `idp:flags:create` | add-feature-flag | `flags.ts` |
| `idp:guard:platform-admin` | decommission-service (first step) | `module.ts` |
| `idp:github:list-files` | decommission-service | `decommission.ts` |
| `idp:aws:ecr:delete-repository` | decommission-service | `decommission.ts` |
| `idp:flags:delete-for-service` | decommission-service | `flags.ts` |
| `idp:aws:s3:delete-docs` | decommission-service | `decommission.ts` |
| `idp:github:archive-repo` | decommission-service | `decommission.ts` |
| `idp:github:delete-repo` | decommission-service, only when the form asks | `decommission.ts` |
| `idp:catalog:unregister` | decommission-service | `decommission.ts` |

Three things worth knowing before changing them:

- **`await-ci-auto-merge` never bypasses the deploy repository's rules.** It waits for the new
  service's CI (the run that builds the image the deploy pull request pins), then enables
  GitHub auto-merge and waits. GitHub's own runs for the same commit (Dependabot, code scanning)
  are not counted as CI.
- **Schema defaults are not applied by the scaffolder.** An optional input arrives as
  `undefined`; defaults are set in the handler.
- **The scaffolder checks whether a user may run an action when its step starts**, not all
  steps up front. That is why `decommission-service` begins with the admin-only no-op
  `idp:guard:platform-admin`: without it, a user who is not allowed would be stopped halfway
  through a removal.

## Permissions

`packages/backend/src/permissions/policy.ts`, enabled in the deployed portal only
(`permission.enabled: true` in `app-config.production.yaml`).

| Who | May |
|---|---|
| Any signed-in user | Read everything; run the creating templates; delete catalog entries they own |
| Members of `group:default/platform-admins` (`examples/org.yaml`) | Everything, including the destructive actions and removing catalog locations |

The policy allows unless listed. A deny-by-default policy has to classify every permission of
every plugin and breaks a feature silently when a plugin adds one; here the dangerous operations
are few and named (`ADMIN_ONLY_ACTIONS`).

## Run it locally

Needs Node 22 or 24 and Yarn 4 (via Corepack).

```sh
corepack enable
yarn install
export GITHUB_TOKEN=<a token that can read the repositories you want in the catalog>
yarn start              # frontend on http://localhost:3000, backend on http://localhost:7007
```

Locally it uses `app-config.yaml` only: an in-memory database, guest sign-in, permissions off.
The actions that talk to the cluster or AWS (`idp:flags:*`, `idp:aws:*`) need the deployed
portal; in a local run and in a dry run they refuse or do nothing.

## Test it

```sh
yarn tsc                                  # types
yarn workspace backend test               # 102 unit tests: actions and the permission policy
yarn lint:all
./scripts/test-template.sh                # template CI, below
```

`scripts/test-template.sh` is the important one. It starts a throwaway backend on port 7107,
renders `python-service` through the real scaffolder (dry-run API) with a deliberately hostile
description, runs the rendered service's own checks (lock file, lint, format, types, tests,
image build), puts its deploy files into a checkout of `idp-gitops` and runs that repository's
`validate.sh` on them, including the admission policies. It then dry-runs the three day-2
templates against a stand-in catalog entry. A template change that would hand developers a
broken service fails here, before merge. It needs `uv`, `docker`, `kubectl`, `kubeconform`,
`helm` and the Kyverno CLI; `SKIP_IMAGE=1` skips the image build, `GITOPS_REF=<branch>` tests
against a paired branch of `idp-gitops`.

## How it is built and deployed

```
push to main ─> CI (.github/workflows/ci.yml)
                  build     typecheck, unit tests, backend bundle
                            then on main: build the arm64 image, scan it with Trivy,
                            push it to ECR `idp-portal:<commit SHA>` (only for main's newest commit)
                  template  scripts/test-template.sh
             ─> Argo CD Image Updater (in the cluster) sees the new tag, commits it to
                idp-gitops/apps/idp-portal/overlays/dev
             ─> Argo CD rolls the Deployment out
```

- **No deploy credential in this repository.** CI logs in to AWS with OIDC and only pushes an
  image. The tag commit is made by the Image Updater in the cluster.
- **The scan runs before the push.** Whatever is in ECR gets deployed, so an image with a
  HIGH or CRITICAL finding that has a fix never reaches ECR. Accepted findings are in
  `.trivyignore`, each with a reason and an **expiry date** (currently 2026-12-10); after that
  date CI fails until the entry is reviewed.
- **Only the newest commit is pushed.** The Image Updater deploys the image that was built
  last. Builds run one at a time, and a build whose commit is no longer the head of `main`
  skips the push, so the older of two quick merges can never end up deployed.
- With the cluster down, a merge builds and pushes an image; the deploy repository is updated
  at the next `make up`.

In the cluster (namespace `backstage`, files in `idp-gitops/apps/idp-portal`):

| Need | Where it comes from |
|---|---|
| PostgreSQL | Its own database and login on the shared RDS instance, created by the database operator. One schema per plugin (`pluginDivisionMode: schema`), TLS verified against `rds-ca-global-bundle.pem` |
| GitHub App credentials | Secrets Manager -> External Secrets -> the pod's environment. Never in git |
| AWS access | The IAM role `idp-portal` through EKS Pod Identity: delete ECR repositories under `svc/*`, read the docs bucket and delete under `default/component/*` |
| Flag API access | A projected ServiceAccount token valid for the flag API only; the flag API lists this ServiceAccount as an admin |
| Reaching it | `kubectl -n backstage port-forward svc/idp-portal 7007:7007`, then http://localhost:7007. There is no public address |

After the portal redeploys, an open browser tab still holds the old page and asks for files
that no longer exist ("Loading chunk ... failed"): reload it.

## Layout

```
app-config.yaml               local development
app-config.production.yaml    the deployed portal (loaded on top of app-config.yaml)
examples/org.yaml             users and groups: who can sign in, who is a platform admin
packages/app/                 frontend: createApp, sign-in page, sidebar, home page
packages/backend/src/
  index.ts                    which backend plugins and modules are installed
  scaffolder/                 the eleven actions and their tests
  permissions/                the permission policy and its tests
  Dockerfile (in packages/backend/)   the image CI builds
templates/                    the four templates, the skeleton, the contract (README.md)
scripts/                      template CI: test-template.sh and what it needs
.trivyignore                  accepted scan findings, with expiry dates
catalog-info.yaml             this repository's own catalog entry
```

## Known limits

- The permission policy's refusal of a non-admin is covered by unit tests but was never
  exercised with a second real user.
- The "delete the repository" option of `decommission-service` is unit-tested and dry-run
  tested; it has not been run for real yet.
- An archived repository keeps its name taken. Creating a service with the name of a
  decommissioned, archived one fails at "Create GitHub repository".
- The Name field of `python-service` is a repository picker with autocomplete: check the name
  on the review page before pressing Create.
- Backstage 1.54 is pinned; plugins were chosen at the versions built for it. An upgrade is its
  own change.

The full history of the platform, every decision and every bug, is in
[idp-infra/HANDOVER_DOC.md](https://github.com/surya-idp/idp-infra/blob/main/HANDOVER_DOC.md).
