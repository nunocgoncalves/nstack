#!/usr/bin/env bash
# Wait for every check on a PR's current head to finish. Run it with background
# Bash (run_in_background) so no tool call blocks on CI.
#   ci-wait.sh <pr> [repo] [expected-head-sha]
# Exit 0 = all checks passed on the expected head; 1 = a check failed or was
# cancelled; 2 = the head moved or no checks appeared; 3 = timed out (60 min).
set -uo pipefail
pr="$1"; repo="${2:-}"; want="${3:-}"
R=(); [ -n "$repo" ] && R=(--repo "$repo")
deadline=$(( $(date +%s) + 3600 )); nochecks=$(( $(date +%s) + 180 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  head=$(gh pr view "$pr" "${R[@]}" --json headRefOid -q .headRefOid 2>/dev/null) || { sleep 30; continue; }
  if [ -n "$want" ] && [ "${head#"$want"}" = "$head" ]; then echo "head moved: $head (expected $want)"; exit 2; fi  # accepts a short sha
  json=$(gh pr checks "$pr" "${R[@]}" --json name,bucket,state,link 2>/dev/null || true)
  if [ -z "$json" ] || [ "$json" = "[]" ]; then
    [ "$(date +%s)" -gt "$nochecks" ] && { echo "no checks on $head after 3 minutes"; exit 2; }
    sleep 20; continue
  fi
  failed=$(jq -r '.[] | select(.bucket=="fail" or .bucket=="cancel") | "\(.name): \(.state) \(.link)"' <<<"$json")
  if [ -n "$failed" ]; then echo "CI failed on $head:"; echo "$failed"; exit 1; fi
  if jq -e 'all(.bucket!="pending")' <<<"$json" >/dev/null; then
    echo "CI passed on $head ($(jq length <<<"$json") checks)"; exit 0
  fi
  sleep 30
done
echo "timed out after 60 minutes on $head"; exit 3
