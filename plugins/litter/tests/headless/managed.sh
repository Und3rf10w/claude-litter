#!/bin/sh
# Tier 4, managed settings (plan section 12). It writes
# /etc/claude-code/managed-settings.json, so it runs only in the box that
# container/container.sh builds:
#
#   seated  a managed file with no policy litter meets: cc-plugin-sec-default
#           is seated, and the fanout and execute stand-ins still go through
#           (isolation.sh alone, land.sh clean)
#   mcp     a managed allowedMcpServers list, even one naming litter: the
#           record tool is refused, and a litter launch is denied naming
#           allowedMcpServers, with no workflow started and no run written
#   mods    allowManagedModsOnly: litter's mod isn't loaded, and a litter launch
#           starts no litter agent and writes no run

set -u
. "$(dirname "$0")/lib.sh"

[ "${LITTER_TIER4_CONTAINER:-}" = 1 ] || { echo "managed.sh writes /etc/claude-code: run it through container/container.sh" >&2; exit 2; }
MANAGED=/etc/claude-code/managed-settings.json

mode=${1:-seated}
case $mode in
  seated) policy='{ "cleanupPeriodDays": 30 }' ;;
  mcp) policy='{ "allowedMcpServers": [{ "serverName": "litter" }] }' ;;
  mods) policy='{ "pluginConfigs": { "cc-plugin-sec-default@builtin": { "options": { "allowManagedModsOnly": true } } } }' ;;
  *) echo "usage: $0 seated|mcp|mods" >&2; exit 2 ;;
esac
printf '%s\n' "$policy" >|"$MANAGED" || exit 1

seated_in() {
  grep -q 'plugin.register: litter .*judged by cc-plugin-sec-default' "$H_OUT/$1/debug.txt" ||
    { echo "no sign of cc-plugin-sec-default judging litter in $1's debug log"; return 1; }
}

if [ "$mode" = seated ]; then
  failed=0
  sh "$H_HERE/isolation.sh" alone || failed=1
  sh "$H_HERE/land.sh" clean || failed=1
  H_CASE=managed-seated
  H_DIR=$H_OUT
  h_expect "cc-plugin-sec-default was seated for the fanout run" seated_in isolation-alone
  h_expect "cc-plugin-sec-default was seated for the execute run" seated_in land-clean
  h_done && [ "$failed" -eq 0 ]
  exit
fi

PROMPT='You are running a scripted test. Call the Workflow tool once, with name "litter:fanout-run" and args {"run": "20261002-probe"}, then reply with its result verbatim. Do nothing else.'
h_scratch "managed-$mode"
h_claude "$PROMPT" --allowedTools Workflow

# Every tool result the session got, as text.
tool_results() {
  h_transcripts | while IFS= read -r f; do
    jq -r 'select(.type == "user") | .message.content[]? | select(.type == "tool_result")
      | .content | if type == "array" then map(.text // "") | join("") else tostring end' "$f"
  done
}
c_debug() {
  grep -q "$1" "$H_DIR/debug.txt" || { echo "the debug log has no '$1'"; return 1; }
}
c_no_record_tool() {
  ! grep -q 'mcp__litter__record visible' "$H_DIR/debug.txt" || { echo "mcp__litter__record was registered"; return 1; }
}
c_denied_naming() {
  r=$(tool_results)
  case $r in *"$1"*) ;; *) echo "no tool result names $1: $r"; return 1 ;; esac
}
c_no_workflow() {
  ! h_transcripts | grep -q '/workflows/' || { echo "a workflow ran: $(h_transcripts | grep '/workflows/' | head -n 1)"; return 1; }
}
c_no_litter_agent() {
  a=$(jq -r 'select(.ev == "SubagentStart" and ((.agent_type // "") | startswith("litter:"))) | .agent_type' "$H_DIR/tool-log.jsonl" 2>/dev/null | head -n 1)
  [ -z "$a" ] || { echo "a $a agent started"; return 1; }
}
c_no_run() {
  r=$(ls "$H_REPO/.claude/litter" 2>/dev/null | grep -E '^[0-9]{8}-' | head -n 1)
  [ -z "$r" ] || { echo "run $r was written"; return 1; }
}

h_expect "cc-plugin-sec-default judged litter" seated_in "managed-$mode"
if [ "$mode" = mcp ]; then
  h_expect "the record tool was refused under allowedMcpServers" c_debug 'allowedMcpServers (managed): plugins outside policy may not add tools'
  h_expect "mcp__litter__record never appeared" c_no_record_tool
  h_expect "the litter launch was denied, naming allowedMcpServers" c_denied_naming allowedMcpServers
  h_expect "no workflow ran" c_no_workflow
else
  h_expect "litter's mod wasn't loaded, naming allowManagedModsOnly" c_debug 'allowManagedModsOnly); litter was not loaded'
  h_expect "mcp__litter__record never appeared" c_no_record_tool
  h_expect "no litter agent started" c_no_litter_agent
fi
h_expect "no run was written" c_no_run
h_done
