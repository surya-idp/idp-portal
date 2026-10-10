#!/usr/bin/env bash
# Template CI: prove that the templates still work.
#
# python-service (creates a service):
#   1. start a throwaway Backstage backend (scripts/template-ci.app-config.yaml: in-memory DB, no network)
#   2. render the template with the real scaffolder (dry-run API)
#      and dry-run decommission-service against a stand-in catalog entry
#   3. run the rendered service's own checks: lock file, lint, format, types, tests
#   4. build its image                                    (skip with SKIP_IMAGE=1)
#   5. put its deploy files into idp-gitops and run that repo's validate.sh, which also
#      applies the platform's admission policies to them
#
# A template change that would hand developers a broken service fails here, before merge.
#
#   ./scripts/test-template.sh
# Needs: node + yarn install, uv, docker, kubectl, kubeconform, helm, kyverno CLI,
# python3 + PyYAML, git.
# RENDER_TO=<folder> keeps a copy of the rendered service.
# GITOPS_REF picks the idp-gitops branch; default: the branch named like this one if it
# exists there (paired pull requests), else main.
set -euo pipefail
cd "$(dirname "$0")/.."

TEMPLATE=templates/python-service
SERVICE=template-ci                      # repo name in $TEMPLATE/test-values.json
WORK="$(mktemp -d)"
export TEMPLATE_CI_TOKEN="${TEMPLATE_CI_TOKEN:-$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9')}"
export BACKSTAGE_URL="${BACKSTAGE_URL:-http://localhost:7107}"
BACKEND_PID=""

cleanup() {
  if [ -n "$BACKEND_PID" ]; then
    # The CLI starts the backend as a child process: stop the whole process group.
    kill -- -"$BACKEND_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { echo; echo "==> $*"; }

step "[1/5] Starting a throwaway backend"
setsid yarn workspace backend start \
  --config ../../app-config.yaml --config ../../scripts/template-ci.app-config.yaml > "$WORK/backend.log" 2>&1 &
BACKEND_PID=$!
actions="$WORK/actions.json"
for _ in $(seq 1 90); do
  if curl -sf -H "Authorization: Bearer $TEMPLATE_CI_TOKEN" \
       "$BACKSTAGE_URL/api/scaffolder/v2/actions" -o "$actions"; then
    break
  fi
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "backend exited:"; tail -40 "$WORK/backend.log"; exit 1
  fi
  sleep 2
done
[ -s "$actions" ] || { echo "backend not ready after 180s:"; tail -40 "$WORK/backend.log"; exit 1; }
# Every action the template uses must be installed in this backend.
python3 - "$TEMPLATE/template.yaml" "$actions" <<'PY'
import json, sys, yaml
template = yaml.safe_load(open(sys.argv[1]))
installed = {a["id"] for a in json.load(open(sys.argv[2]))}
missing = [s["action"] for s in template["spec"]["steps"] if s["action"] not in installed]
if missing:
    sys.exit(f"template uses actions this backend does not have: {missing}")
print(f"backend ready; all {len(template['spec']['steps'])} steps of {sys.argv[1]} use installed actions")
PY

step "[2/5] Rendering $TEMPLATE with the scaffolder (dry run)"
OUT="$WORK/$SERVICE"
node scripts/template-dry-run.mjs "$TEMPLATE" "$TEMPLATE/test-values.json" "$OUT"

echo
echo "    python-service with the database option"
node scripts/template-dry-run.mjs "$TEMPLATE" "$TEMPLATE/test-values-postgres.json" "$WORK/$SERVICE-postgres"
grep -q 'components/postgres' "$WORK/$SERVICE-postgres/env-config-change/apps/$SERVICE/base/kustomization.yaml" \
  || { echo "postgres: true did not add the postgres component"; exit 1; }
if grep -q 'components/postgres' "$OUT/env-config-change/apps/$SERVICE/base/kustomization.yaml"; then
  echo "the postgres component was added although the option was off"; exit 1
fi

echo
echo "    add-postgres-database (dry run against the stand-in catalog entry)"
ADDPG=templates/add-postgres-database
python3 - "$ADDPG/template.yaml" "$actions" <<'PY'
import json, sys, yaml
template = yaml.safe_load(open(sys.argv[1]))
installed = {a["id"] for a in json.load(open(sys.argv[2]))}
missing = [s["action"] for s in template["spec"]["steps"] if s["action"] not in installed]
if missing:
    sys.exit(f"{sys.argv[1]} uses actions this backend does not have: {missing}")
PY
for _ in $(seq 1 30); do
  curl -sf -H "Authorization: Bearer $TEMPLATE_CI_TOKEN" -o /dev/null \
    "$BACKSTAGE_URL/api/catalog/entities/by-name/component/default/template-ci" && break
  sleep 2
done
node scripts/template-dry-run.mjs "$ADDPG" "$ADDPG/test-values.json" "$WORK/add-postgres"
# The pull request must change exactly one file: the service's base kustomization.
changed="$(cd "$WORK/add-postgres" && find . -type f ! -name .dry-run-output.json | sort)"
[ "$changed" = "./apps/template-ci/base/kustomization.yaml" ] \
  || { echo "add-postgres-database should change only the base kustomization, got:"; echo "$changed"; exit 1; }
grep -q 'components/postgres' "$WORK/add-postgres/apps/template-ci/base/kustomization.yaml" \
  || { echo "the postgres component was not added"; exit 1; }

echo
echo "    decommission-service (dry run against the stand-in catalog entry)"
DECOM=templates/decommission-service
python3 - "$DECOM/template.yaml" "$actions" <<'PY'
import json, sys, yaml
template = yaml.safe_load(open(sys.argv[1]))
installed = {a["id"] for a in json.load(open(sys.argv[2]))}
missing = [s["action"] for s in template["spec"]["steps"] if s["action"] not in installed]
if missing:
    sys.exit(f"{sys.argv[1]} uses actions this backend does not have: {missing}")
PY
# The catalog reads its file location a few seconds after start.
for _ in $(seq 1 30); do
  curl -sf -H "Authorization: Bearer $TEMPLATE_CI_TOKEN" -o /dev/null \
    "$BACKSTAGE_URL/api/catalog/entities/by-name/component/default/template-ci" && break
  sleep 2
done
node scripts/template-dry-run.mjs "$DECOM" "$DECOM/test-values.json" "$WORK/decommission"
# The pull-request step sends every file in the workspace as an addition. A removal must
# therefore leave the workspace empty, or the PR would add files to idp-gitops.
extra="$(find "$WORK/decommission" -type f ! -name .dry-run-output.json)"
if [ -n "$extra" ]; then
  echo "decommission-service left files in the workspace; its PR would ADD them:"; echo "$extra"; exit 1
fi


echo
echo "    decommission-service on a service from another template (no deployment, no image)"
for _ in $(seq 1 30); do
  curl -sf -H "Authorization: Bearer $TEMPLATE_CI_TOKEN" -o /dev/null \
    "$BACKSTAGE_URL/api/catalog/entities/by-name/component/default/template-ci-library" && break
  sleep 2
done
python3 -c "
import json,sys
d=json.load(open(sys.argv[1])); d['values']['entity']='component:default/template-ci-library'
json.dump(d,open(sys.argv[2],'w'))" "$DECOM/test-values.json" "$WORK/other-values.json"
node scripts/template-dry-run.mjs "$DECOM" "$WORK/other-values.json" "$WORK/decommission-other" | tee "$WORK/other.log"
# One removal template for every creation template: what a service did not record is skipped,
# and what it did record (here only the repository) is still handled.
for step in files pr merge ecr; do
  grep -q "^\[$step\] (skipped) .*condition" "$WORK/other.log" \
    || { echo "step '$step' was not skipped for a service without that annotation"; exit 1; }
done
grep -q '^\[archive\] (skipped) Skipping because .* does not support dry-run' "$WORK/other.log" \
  || { echo "the archive step should still apply to a service that only has a repository"; exit 1; }

kill -- -"$BACKEND_PID" 2>/dev/null || true
BACKEND_PID=""
if grep -rIl '\${{' "$OUT" --exclude-dir=.github; then
  echo "unrendered template expressions in the files above"; exit 1
fi
# The contract in templates/README.md: day-2 templates find a service's resources through these.
for annotation in backstage.io/source-template idp.surya-idp/template-version \
    github.com/project-slug idp.surya-idp/gitops-path idp.surya-idp/ecr-repository; do
  grep -q "$annotation" "$OUT/catalog-info.yaml" \
    || { echo "catalog-info.yaml has no $annotation annotation"; exit 1; }
done
# ... and they must point at what the template really wrote.
gitops_path="$(python3 -c "import yaml,sys; print(yaml.safe_load(open(sys.argv[1]))['metadata']['annotations']['idp.surya-idp/gitops-path'])" "$OUT/catalog-info.yaml")"
[ -d "$OUT/env-config-change/$gitops_path" ] \
  || { echo "annotation gitops-path=$gitops_path, but the template wrote no such folder"; exit 1; }

# RENDER_TO=<folder>: keep a copy of the rendered service, to look at it or to work on the
# skeleton (run its checks there, then carry the fix back into the template).
if [ -n "${RENDER_TO:-}" ]; then
  rm -rf "$RENDER_TO" && mkdir -p "$RENDER_TO" && cp -r "$OUT/." "$RENDER_TO/"
  echo "rendered service copied to $RENDER_TO"
fi

step "[3/5] The rendered service's own checks (what the shared CI workflow runs)"
(
  cd "$OUT"
  uv sync --locked
  uv run ruff check .
  uv run ruff format --check .
  uv run mypy
  uv run pytest -q
)

step "[4/5] Building the rendered service's image"
if [ -n "${SKIP_IMAGE:-}" ]; then
  echo "skipped (SKIP_IMAGE is set)"
else
  docker build --quiet --build-arg GIT_SHA=template-ci -t "$SERVICE:template-ci" "$OUT"
fi

step "[5/5] Validating the rendered deploy files inside idp-gitops"
GITOPS_URL=https://github.com/surya-idp/idp-gitops
if [ -z "${GITOPS_REF:-}" ]; then
  branch="${GITHUB_HEAD_REF:-${GITHUB_REF_NAME:-$(git branch --show-current)}}"
  if [ -n "$branch" ] && git ls-remote --exit-code --heads "$GITOPS_URL" "$branch" >/dev/null 2>&1; then
    GITOPS_REF="$branch"
  else
    GITOPS_REF=main
  fi
fi
echo "idp-gitops ref: $GITOPS_REF"
git clone --quiet --depth 1 --branch "$GITOPS_REF" "$GITOPS_URL" "$WORK/idp-gitops"
cp -r "$OUT/env-config-change/." "$WORK/idp-gitops/"
# The variant with a database is validated too, under its own name.
mkdir -p "$WORK/idp-gitops/apps/$SERVICE-pg"
cp -r "$WORK/$SERVICE-postgres/env-config-change/apps/$SERVICE/." "$WORK/idp-gitops/apps/$SERVICE-pg/"
grep -rl "$SERVICE" "$WORK/idp-gitops/apps/$SERVICE-pg" | xargs sed -i "s/$SERVICE/$SERVICE-pg/g"
"$WORK/idp-gitops/scripts/validate.sh" | grep -E -A2 "apps/$SERVICE(-pg)?/|FAIL"
# validate.sh's exit code, not grep's
[ "${PIPESTATUS[0]}" -eq 0 ] || { echo "idp-gitops validate.sh failed"; exit 1; }

echo
echo "Templates OK: python-service (with and without a database) rendered, checked, built and validated;"
echo "              add-postgres-database and decommission-service dry runs clean."
