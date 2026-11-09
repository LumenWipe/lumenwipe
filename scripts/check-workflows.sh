#!/usr/bin/env bash
# Fails when a workflow or a local composite action uses an action that is not pinned to a full
# commit SHA with a version comment, or a workflow declares a job without timeout-minutes.
# Usage: scripts/check-workflows.sh [dir]. With no dir it checks .github/workflows and every
# .github/actions/*/action.yml; with a dir it checks the workflows in that dir only.
set -euo pipefail

status=0
if [ "$#" -gt 0 ]; then
  files=("$1"/*.yml "$1"/*.yaml)
else
  files=(.github/workflows/*.yml .github/workflows/*.yaml .github/actions/*/action.yml .github/actions/*/action.yaml)
fi

for file in "${files[@]}"; do
  [ -e "$file" ] || continue
  awk -v file="$file" '
    function flush() {
      if (job != "" && !reusable && !timeout) {
        printf "::error file=%s::job \"%s\" has no timeout-minutes\n", file, job
        bad = 1
      }
    }
    /^jobs:/ { injobs = 1; next }
    /^[^ #]/ { if (injobs) { flush(); job = "" } injobs = 0 }
    injobs && /^  [A-Za-z0-9_-]+:[ ]*$/ {
      flush()
      job = $1; sub(/:$/, "", job); reusable = 0; timeout = 0
      next
    }
    injobs && /^    timeout-minutes:/ { timeout = 1 }
    injobs && /^    uses:/ { reusable = 1 }
    /^[ -]*uses:[ ]/ {
      ref = $0
      sub(/^[ -]*uses:[ ]*/, "", ref)
      if (ref ~ /^\.\// || ref ~ /^docker:\/\//) next
      if (ref !~ /@[0-9a-f]{40}[ ]+# v[0-9][^ ]*[ ]*$/) {
        printf "::error file=%s,line=%d::action is not pinned to a full commit SHA with a version comment: %s\n", file, NR, ref
        bad = 1
      }
    }
    END { flush(); exit bad }
  ' "$file" || status=1
done

exit "$status"
