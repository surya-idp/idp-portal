#!/usr/bin/env bash
# Regenerate skeleton/uv.lock after changing the dependencies in skeleton/pyproject.toml.
#
# The skeleton is a template: its project name is the placeholder ${{ values.name }}, which
# uv cannot read. So: copy pyproject.toml with a stand-in name, lock it, and put the
# placeholder back. Template CI then proves that a rendered service passes `uv sync --locked`.
#   ./relock.sh            (needs uv, the version pinned in the idp-platform workflow)
set -euo pipefail
cd "$(dirname "$0")/skeleton"

STAND_IN=golden-path-service
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

sed -e "s/\${{ values.name }}/$STAND_IN/g" -e 's/\${{ values.description }}/placeholder/g' \
  pyproject.toml > "$work/pyproject.toml"
(cd "$work" && uv lock)
sed "s/^name = \"$STAND_IN\"$/name = \"\${{ values.name }}\"/" "$work/uv.lock" > uv.lock

grep -q '^name = "\${{ values.name }}"$' uv.lock || { echo "placeholder not restored in uv.lock" >&2; exit 1; }
echo "skeleton/uv.lock updated ($(grep -c '^\[\[package\]\]' uv.lock) packages)"
