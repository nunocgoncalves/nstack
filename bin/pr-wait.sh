#!/usr/bin/env bash
# After Ready: wait for a human to merge. Run with background Bash.
#   pr-wait.sh <pr> [repo]
# Exit 0 = merged (prints the merge commit), 1 = closed without merge,
# 4 = ejected from the merge queue (was queued, now neither queued nor merged),
# 5 = the PR could not be read 10 times in a row (prints the last error).
set -uo pipefail
pr="$1"; repo="${2:-}"
[ -n "$repo" ] || repo=$(gh repo view --json nameWithOwner -q .nameWithOwner) || { echo "cannot resolve the repository"; exit 5; }
# gh pr view --json has no merge-queue field; GraphQL does.
# shellcheck disable=SC2016 # GraphQL variables, not shell ones
query='query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){state isInMergeQueue mergeCommit{oid}}}}'
read_pr() { gh api graphql -f query="$query" -F o="${repo%%/*}" -F n="${repo#*/}" -F p="$pr" -q .data.repository.pullRequest 2>&1; }
queued=false; failures=0
while true; do
  if ! s=$(read_pr) || ! state=$(jq -er .state <<<"$s" 2>/dev/null); then
    failures=$((failures + 1))
    [ "$failures" -ge 10 ] && { echo "cannot read $repo#$pr: $s"; exit 5; }
    sleep 60; continue
  fi
  failures=0
  case "$state" in
    MERGED) echo "merged $(jq -r '.mergeCommit.oid // ""' <<<"$s")"; exit 0 ;;
    CLOSED) echo "closed without merge"; exit 1 ;;
  esac
  if [ "$(jq -r .isInMergeQueue <<<"$s")" = "true" ]; then queued=true
  elif $queued; then
    sleep 20
    [ "$(read_pr | jq -r .state 2>/dev/null)" = "MERGED" ] && continue
    echo "ejected from the merge queue"; exit 4
  fi
  sleep 60
done
