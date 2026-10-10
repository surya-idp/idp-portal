#!/usr/bin/env bash
# Template CI: prove that the python-service template still produces a working service.
#
#   1. start a throwaway Backstage backend (scripts/template-ci.app-config.yaml: in-memory DB, no network)
#   2. render the template with the real scaffolder (dry-run API)
#   3. run the rendered service's own checks: lock file, lint, format, types, tests
#   4. build its image                                    (skip with SKIP_IMAGE=1)
#   5. put its deploy files into idp-gitops and run that repo's validate.sh
#
# A template change that would hand developers a broken service fails here, before merge.
#
#   ./scripts/test-template.sh
# Needs: node + yarn install, uv, docker, kubectl, kubeconform, python3 + PyYAML, git.
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
print(f"backend ready; all {len(template['spec']['steps'])} template steps use installed actions")
PY

step "[2/5] Rendering $TEMPLATE with the scaffolder (dry run)"
OUT="$WORK/$SERVICE"
node scripts/template-dry-run.mjs "$TEMPLATE" "$TEMPLATE/test-values.json" "$OUT"
kill -- -"$BACKEND_PID" 2>/dev/null || true
BACKEND_PID=""
if grep -rIl '\${{' "$OUT" --exclude-dir=.github; then
  echo "unrendered template expressions in the files above"; exit 1
fi
grep -q 'backstage.io/source-template' "$OUT/catalog-info.yaml" \
  || { echo "catalog-info.yaml has no backstage.io/source-template annotation"; exit 1; }

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
"$WORK/idp-gitops/scripts/validate.sh" | grep -A2 "apps/$SERVICE/"
# validate.sh's exit code, not grep's
[ "${PIPESTATUS[0]}" -eq 0 ] || { echo "idp-gitops validate.sh failed"; exit 1; }

echo
echo "Template OK: rendered, checked, built and validated."
