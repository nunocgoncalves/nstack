#!/usr/bin/env bash
# Pipe-tests for the plugin hooks: bash hooks/test.sh
set -uo pipefail
H="$(cd "$(dirname "$0")" && pwd)"
fail=0

# guard-gh: expected exit code per command.
while IFS=$'\t' read -r want c; do
  c=$(printf '%b' "$c")
  jq -cn --arg c "$c" '{tool_input:{command:$c}}' | node "$H/guard-gh.ts" >/dev/null 2>&1
  got=$?
  [ "$got" = "$want" ] || { echo "guard-gh: want $want got $got :: $c"; fail=1; }
done <"$H/guard-gh.cases.tsv"
printf 'not json' | node "$H/guard-gh.ts" 2>/dev/null; [ $? = 2 ] || { echo "guard-gh: parse error not blocked"; fail=1; }
printf '{}' | node "$H/guard-gh.ts" 2>/dev/null; [ $? = 2 ] || { echo "guard-gh: missing command not blocked"; fail=1; }

# context: nothing for a repo without config; the config summary and context.md with one.
T=$(mktemp -d)
start() { jq -cn --arg c "$1" '{hook_event_name:"SessionStart",session_id:"t",cwd:$c}' | NSTACK_HOME="$T/home" node "$H/context.ts"; }
git init -q -b main "$T/plain"
[ -z "$(start "$T/plain" | jq -r '.hookSpecificOutput.additionalContext // empty' | grep 'Repository config')" ] || { echo "context: config summary without config"; fail=1; }
git init -q -b main "$T/cfg" && mkdir "$T/cfg/.nstack"
echo '{"tracker":"linear","ticketPrefix":"ABC","base":"dev","language":"PT-PT"}' >"$T/cfg/.nstack/config.json"
echo 'REPO CONTEXT' >"$T/cfg/.nstack/context.md"
out=$(start "$T/cfg")
jq -e '.hookSpecificOutput.additionalContext | contains("Linear (ABC-<n>)") and contains("PRs target: dev") and contains("REPO CONTEXT")' <<<"$out" >/dev/null || { echo "context: config not injected: $out"; fail=1; }
git init -q -b main "$T/owned" && git -C "$T/owned" remote add origin git@github.com:acme/widgets.git
mkdir -p "$T/home/repos/acme" && echo '{"tracker":"linear","ticketPrefix":"ACME"}' >"$T/home/repos/acme/config.json"
start "$T/owned" | jq -e '.hookSpecificOutput.additionalContext | contains("Linear (ACME-<n>)")' >/dev/null || { echo "context: owner-wide config not found"; fail=1; }
echo '{"tracker":"jira"}' >"$T/cfg/.nstack/config.json"
start "$T/cfg" | jq -e '.systemMessage | contains("tracker")' >/dev/null || { echo "context: bad config not reported"; fail=1; }
printf 'garbage' | node "$H/context.ts" >/dev/null 2>&1 || { echo "context: bad input must not fail"; fail=1; }

# context: fast-forward a clean primary checkout on its default branch.
git init -q -b master "$T/origin" && git -C "$T/origin" commit -q --allow-empty -m one
git clone -q "$T/origin" "$T/clone" && git -C "$T/origin" commit -q --allow-empty -m two
jq -cn --arg c "$T/clone" '{hook_event_name:"SessionStart",session_id:"t2",cwd:$c}' | node "$H/context.ts" >/dev/null
[ "$(git -C "$T/clone" rev-parse HEAD)" = "$(git -C "$T/origin" rev-parse HEAD)" ] || { echo "context: primary checkout not fast-forwarded"; fail=1; }
git -C "$T/origin" commit -q --allow-empty -m three && git -C "$T/clone" switch -q -c topic
jq -cn --arg c "$T/clone" '{hook_event_name:"SessionStart",session_id:"t3",cwd:$c}' | node "$H/context.ts" | jq -e '.systemMessage | contains("not fast-forwarded")' >/dev/null || { echo "context: behind-off-default not warned"; fail=1; }
rm -rf "$T"

jq -e '.hooks | has("SessionStart") and has("PreToolUse")' "$H/hooks.json" >/dev/null || { echo "hooks.json: invalid"; fail=1; }
[ $fail = 0 ] && echo "hooks: all pipe-tests pass"
exit $fail
