#!/usr/bin/env bash
# Validate the Candidate B model and run every fixture. Exit non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")"
FGA="${FGA:-fga}"
"$FGA" model validate --file model.fga
rc=0
for t in balt.fga.yaml contextual.fga.yaml extensions.fga.yaml; do
  [ -f "$t" ] || continue
  echo "== $t"
  out="$("$FGA" model test --tests "$t" 2>&1)" || rc=1
  echo "$out" | tail -4
  echo "$out" | grep -Eq 'Tests [0-9]+/[0-9]+ passing' || rc=1
  echo "$out" | grep -Eq 'Tests ([0-9]+)/\1 passing' || rc=1
done
exit $rc
