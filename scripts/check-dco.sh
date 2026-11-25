#!/bin/sh
# Verifies that every commit carries a `Signed-off-by:` trailer (DCO 1.1).
# Usage: scripts/check-dco.sh [base-ref]
#   base-ref  when given, only commits in base..HEAD are checked (e.g. origin/main)
set -eu
cd "$(dirname "$0")/.."

base="${1:-}"
range="HEAD"
[ -n "$base" ] && range="${base}..HEAD"

missing=0
for sha in $(git rev-list "$range"); do
  if [ -z "$(git log -1 --format='%(trailers:key=Signed-off-by,valueonly)' "$sha")" ]; then
    echo "missing Signed-off-by: $sha $(git log -1 --format=%s "$sha")"
    missing=1
  fi
done

if [ "$missing" -ne 0 ]; then
  echo "DCO check failed: use 'git commit -s'." >&2
  exit 1
fi
echo "DCO check passed."
