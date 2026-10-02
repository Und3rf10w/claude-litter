#!/bin/sh
# Tier 4: phase 1's land check, headless (plan section 13).
#
#   sh tests/headless/land.sh edit    # an out-of-band edit after the verdict: the land is refused
#   sh tests/headless/land.sh clean   # no edit: the land commits the verified tree
#
# One session launches an execute run of fixtures/execute.js. Its gate critic
# records a verify, and its verdict comes from its StructuredOutput through
# output.sh and the spool. For `edit`, this script appends to a.txt in the
# checkout once the verdict is in the ledger, while the run pauses, so the
# relay's land must be refused with a retry and move nothing.

set -u
. "$(dirname "$0")/lib.sh"

mode=${1:-edit}
case $mode in edit | clean) ;; *) echo "usage: $0 edit|clean" >&2; exit 2 ;; esac

PROMPT='You are running a scripted test. Do exactly these steps, in order, and nothing else.
1. Call mcp__litter__record with exactly this input: {"kind": "run.start", "workflow": "execute", "authorized": ["tier-4 land probe"], "planPath": "plan.md"}
2. Call the Workflow tool with name "litter:execute" and args set to the args object step 1 returned, unchanged.
3. Wait for the workflow task notification. Then reply with each step result and the workflow result, verbatim.
If a step is refused, note the refusal verbatim and stop.'

h_scratch "land-$mode"
printf '# Probe plan\n\n## Gates\n\n### G1: Write a.txt\nFiles: a.txt\nChecks: grep -q done a.txt\nDone when: a.txt holds done\n' >|"$H_REPO/plan.md"
h_git -C "$H_REPO" add plan.md
h_git -C "$H_REPO" commit -q -m plan || exit 1
LD=$H_REPO/.claude/litter

# The out-of-band edit, once the verdict is recorded: at most 20 minutes.
if [ "$mode" = edit ]; then
  (
    i=0
    while [ "$i" -lt 600 ]; do
      if ls "$LD"/*/ledger/*-verdict.json >/dev/null 2>&1; then
        printf 'edited out of band\n' >>"$H_REPO/a.txt"
        : >|"$H_DIR/edited"
        exit 0
      fi
      sleep 2
      i=$((i + 1))
    done
  ) &
  watcher=$!
fi

h_claude "$PROMPT" \
  --settings '{"pluginConfigs": {"litter": {"options": {"verify": ["grep", "-q", "done", "a.txt"]}}}}' \
  --allowedTools mcp__litter__record Workflow
[ "$mode" = edit ] && kill "$watcher" 2>/dev/null

RUN=$(ls "$LD" 2>/dev/null | grep -E '^[0-9]{8}-' | head -n 1)
ledger() { cat "$LD/$RUN"/ledger/*-"$1".json 2>/dev/null; }
# The record tool's replies, from the transcripts.
replies() {
  h_transcripts | while IFS= read -r f; do
    jq -r 'select(.type == "user") | .message.content[]? | select(.type == "tool_result") | .content | if type == "array" then map(.text // "") | join("") else . end' "$f"
  done | grep '"landed"'
}

c_run() { [ -n "$RUN" ] || { echo "no run in $LD"; return 1; }; }
c_verify_green() {
  g=$(ledger verify | jq -r 'select(.by.source == "agent") | .body.exit_code' | tail -n 1)
  [ "$g" = 0 ] || { echo "the agent's verify exit code is '${g:-none}'"; return 1; }
}
c_verdict() {
  v=$(ledger verdict | jq -r '.body.verify_id' | tail -n 1)
  w=$(ledger verify | jq -r 'select(.by.source == "agent") | .body.verify_id' | tail -n 1)
  [ -n "$v" ] && [ "$v" = "$w" ] || { echo "verdict cites '${v:-nothing}', the verify is '${w:-none}'"; return 1; }
}
c_refused() {
  [ -f "$H_DIR/edited" ] || { echo "the out-of-band edit never happened"; return 1; }
  r=$(replies | tail -n 1)
  case $r in *'"landed":false'*'tree changed after verify'*'"retry":true'* | *'tree changed after verify'*) ;;
    *) echo "the land's reply: ${r:-none}"; return 1 ;; esac
  [ -z "$(ledger land.intent)$(ledger land)" ] || { echo "the ledger has a land"; return 1; }
  tip=$(git -C "$H_REPO" rev-parse "refs/heads/litter/$RUN")
  base=$(jq -r .base "$LD/$RUN/run.json")
  [ "$tip" = "$base" ] || { echo "litter/$RUN moved to $tip from $base"; return 1; }
}
c_landed() {
  c=$(ledger land | jq -r '.body.commit')
  [ -n "$c" ] || { echo "no land record; reply: $(replies | tail -n 1)"; return 1; }
  tip=$(git -C "$H_REPO" rev-parse "refs/heads/litter/$RUN")
  [ "$tip" = "$c" ] || { echo "litter/$RUN is at $tip, not the land's $c"; return 1; }
  [ "$(git -C "$H_REPO" show "$c:a.txt")" = done ] || { echo "the landed a.txt isn't the verified one"; return 1; }
}

h_expect "run.start and the launch made a run" c_run
h_expect "the gate critic's verify is green" c_verify_green
h_expect "its verdict, from its StructuredOutput, cites that verify" c_verdict
if [ "$mode" = edit ]; then
  h_expect "after an out-of-band edit the land is refused, with a retry, and nothing moved" c_refused
else
  h_expect "the land committed the verified tree to the run branch" c_landed
fi
h_done
