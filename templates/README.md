# Templates

| Template | Kind | What it does |
|---|---|---|
| `python-service` | creates | a FastAPI service: repo, shared CI, deploy config, route, docs, catalog entry |
| `decommission-service` | day-2 | removes any golden-path service everywhere and archives its repo |
| `add-postgres-database` | day-2 | gives any golden-path service its own database and login |
| `add-feature-flag` | day-2 | creates a feature flag for any golden-path service in the flag API |

All are listed in `all-templates.yaml`, the one file Backstage reads. Adding a template is a
git push; no image rebuild.

## The contract between creation templates and day-2 templates

Day-2 templates (decommission, add-database, add-feature-flag) must work for
services from **every** creation template, including ones that do not exist yet. So they never
assume what a creation template made. Each creation template **records** it in the service's
catalog entry, and day-2 templates read it from there.

A creation template writes these annotations with `catalog:write`:

| Annotation | Meaning | Required |
|---|---|---|
| `idp.surya-idp/template-version` | marks a golden-path service; day-2 templates list services by it. Bump when the skeleton changes in a way existing services should adopt | yes |
| `github.com/project-slug` | `<owner>/<repo>` of the source repository | yes |
| `idp.surya-idp/gitops-path` | folder in `idp-gitops` holding the deploy files, as `apps/<name>` | if it deploys something |
| `idp.surya-idp/ecr-repository` | image repository in ECR, as `svc/<name>` | if it builds an image |

`backstage.io/source-template` is added by `catalog:write` itself and says which template made
the service.

**Adding a creation template** (Go, Node, a worker without a route ...): write the annotations
for what it creates. `decommission-service` then works for its services with no change, and
skips the steps whose annotation is absent.

**Adding a new kind of resource:** prefer declaring it **inside the service's gitops folder**,
as an opt-in component (`idp-gitops/components/`). Then it needs nothing here at all:
`decommission-service` deletes the folder and the controller behind the resource cleans up.
The database works this way (`components/postgres`: the operator drops the database when the
resources disappear). Only a resource that lives outside the folder (like the ECR repository)
needs an annotation and one conditional step in `decommission-service`. Either way it is one
change in one place, never one removal template per creation template.

**Opting an existing service into a component** is one line in its `base/kustomization.yaml`.
The action `idp:gitops:add-component` makes that edit for a pull request; `add-postgres-database`
is the first template that uses it, and a future `add-cache` would be the same template with
another component name.

Template CI (`scripts/test-template.sh`) checks both sides: the rendered `python-service`
catalog entry must carry the annotations, and `decommission-service` is dry-run against a
stand-in entry that has them.
