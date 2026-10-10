# Templates

| Template | Kind | What it does |
|---|---|---|
| `python-service` | creates | a FastAPI service: repo, shared CI, deploy config, route, docs, catalog entry |
| `decommission-service` | day-2 | removes any golden-path service everywhere and archives its repo |

All are listed in `all-templates.yaml`, the one file Backstage reads. Adding a template is a
git push; no image rebuild.

## The contract between creation templates and day-2 templates

Day-2 templates (decommission today; add-database, add-feature-flag later) must work for
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

**Adding a new kind of resource** (for example a database): choose an annotation for it, have
the creating template write it, and add one conditional step to `decommission-service`. That
is one step in one template, not one removal template per creation template.

Template CI (`scripts/test-template.sh`) checks both sides: the rendered `python-service`
catalog entry must carry the annotations, and `decommission-service` is dry-run against a
stand-in entry that has them.
