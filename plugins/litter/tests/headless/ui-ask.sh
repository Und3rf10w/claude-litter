#!/bin/sh
# Tier 4: phase 5's permission ask line (COMMON step 3, decision 1), in an
# interactive session drive.exp types into:
#
#   sh tests/headless/ui-ask.sh
#
# The run is land.sh's: fixtures/execute.js, whose executor runs Bash pwd,
# then writes a.txt, on a one-gate plan. litter's roles run in auto mode, so
# a litter agent's call asks you only when the classifier isn't what decides
# it: the repo's .claude/settings.json holds the ask rule Bash(pwd), which
# the engine shows as a dialog in auto mode too. While the executor's dialog
# is open (the tool log's PermissionRequest line, fixtures/toollog) the band
# shows `⚑ asking · executor wants Bash: pwd · authorized: …`; Enter takes
# the dialog's first option (Yes), and once the call has run the row is gone.
# ask.sh's `ask` line is read from the spool as it's written (a watcher
# copies each into ask-seen.jsonl before the mod's drain takes it), and the
# debug log has the hooks' run. The screens are read through ui.sh
# (fixtures/screen.ts) at each mark: asking, answered (marks/).
#
# On 2.1.290 the check on the dialog's screen fails: the engine doesn't draw
# the prompt area, the band in it, while a dialog that hides the prompt is up
# (cli_formatted_2.1.290.js:1477851, the prompt area's `visible` is
# `!vP() && …`; vP, :1454610, is a dialog hiding the prompt; the band is
# mounted in that area, :1436199). The ask row shows only once the dialog
# has closed, until the call's end is drained.
#
# H_DRY=1 stops once the repo and the steps are made. H_CHECKS=<case folder>
# runs the checks again on a folder an earlier run left. Needs expect and bun.
# UI_MODEL sets the session's model (--model).

set -u
. "$(dirname "$0")/lib.sh"

command -v expect >/dev/null || { echo "$0: needs expect" >&2; exit 2; }
command -v bun >/dev/null || { echo "$0: needs bun" >&2; exit 2; }

if [ -n "${H_CHECKS:-}" ]; then
  H_DIR=$(cd -P "$H_CHECKS" && pwd -P) || exit 2
  H_CASE=${H_DIR##*/}
  H_REPO=$H_DIR/repo
else
  h_scratch "ui-ask-$(date +%Y%m%d-%H%M%S)"
  printf '# Probe plan\n\n## Gates\n\n### G1: Write a.txt\nFiles: a.txt\nChecks: grep -q done a.txt\nDone when: a.txt holds done\n' >|"$H_REPO/plan.md"
  printf '{ "worktree": { "baseRef": "fresh" }, "permissions": { "ask": ["Bash(pwd)"] } }\n' >|"$H_REPO/.claude/settings.json"
  h_git -C "$H_REPO" add plan.md .claude/settings.json
  h_git -C "$H_REPO" commit -q -m 'the plan, and an ask rule on pwd' || exit 1
fi
R=$H_REPO
LD=$R/.claude/litter
UI="sh $H_HERE/ui.sh"
LOG=$H_DIR/tool-log.jsonl

if [ -z "${H_CHECKS:-}" ]; then
  cat >|"$H_DIR/steps.txt" <<EOF
$(h_tool_steps "$H_DIR/debug.txt")
# The executor's pwd: its dialog, and the band's ask row.
wait 900 jq -e 'select(.ev == "PermissionRequest" and .tool == "Bash" and .input.command == "pwd")' $LOG >/dev/null 2>&1
wait 60 $UI shows $H_DIR '⚑ asking · executor wants Bash: pwd'
sleep 3
until $UI mark $H_DIR asking
# Yes: the dialog's first option, under its cursor.
key enter
wait 60 ! $UI shows $H_DIR '⚑ asking'
sleep 3
until $UI mark $H_DIR answered
wait 900 ls $LD/2*/ledger/*-run.end.json
sleep 10
exit
EOF
  [ "${H_DRY:-}" = 1 ] && { echo "$H_CASE: dry run, files in $H_DIR"; exit 0; }

  # Every ask line ask.sh spools, copied before the drain renames the spool aside and reads it.
  (
    while [ ! -f "$H_DIR/drive-done" ]; do
      cat "$LD"/hooks/spool/*.jsonl* 2>/dev/null | grep '"ev":"ask"' >>"$H_DIR/ask-seen.jsonl"
      sleep 0.2
    done
  ) &
  watcher=$!

  START=$(jq -cn '{kind: "run.start", workflow: "execute", authorized: ["tier-4 ask probe"], planPath: "plan.md", repair: "off"}') || exit 1
  FIRST="You are running a scripted test. Do exactly these steps, in order, and nothing else.
1. Call mcp__litter__record with exactly this input: $START
2. Call the Workflow tool with name \"litter:execute-run\" and args set to the args object step 1 returned, unchanged.
3. Wait for the workflow task notification. Then reply with the single word finished, and nothing else.
If a step is refused, note the refusal verbatim and stop."
  SETTINGS=$(jq -cn '{pluginConfigs: {litter: {options: {verify: ["grep", "-q", "done", "a.txt"]}}}}') || exit 1
  echo "$H_CASE: driving the session in $R"
  (
    cd "$R" || exit 1
    # shellcheck disable=SC2086
    CLAUDE_CODE_NO_FLICKER=1 H_PERSIST=1 expect "$H_HERE/drive.exp" "$H_DIR/steps.txt" "$H_DIR/tty.txt" claude ${UI_MODEL:+--model "$UI_MODEL"} \
      --permission-mode auto --settings "$SETTINGS" --allowedTools mcp__litter__record Workflow \
      --plugin-dir "$H_DIR/litter" --plugin-dir "$H_DIR/toollog" --debug-file "$H_DIR/debug.txt" "$FIRST" >|"$H_DIR/drive.txt" 2>&1
  )
  rc=$?
  : >|"$H_DIR/drive-done"
  wait "$watcher" 2>/dev/null
  printf '%s: drive exited %s\n' "$H_CASE" "$rc"
  h_tool_down "$rc"
fi

RUN=$(ls "$LD" 2>/dev/null | grep -E '^[0-9]{8}-' | head -n 1)
RD=$LD/$RUN
marked() { [ -f "$H_DIR/marks/$1" ] || { echo "no mark $1: the steps didn't get that far (drive.txt)"; return 1; }; }
executor_id() { jq -r 'select(.ev == "PermissionRequest" and .tool == "Bash" and .input.command == "pwd") | .agent_id' "$LOG" 2>/dev/null | head -n 1; }

c_run() { [ -n "$RUN" ] && [ -f "$RD/run.json" ] || { echo "no run in $LD"; return 1; }; }
c_dialog() {
  a=$(jq -c 'select(.ev == "PermissionRequest" and .tool == "Bash" and .input.command == "pwd") | {agent_type, mode}' "$LOG" 2>/dev/null | head -n 1)
  case $a in *'"agent_type":"litter:executor"'*) ;; *) echo "no PermissionRequest for the executor's pwd in the tool log (${a:-none})"; return 1 ;; esac
}
c_ask_line() {
  id=$(executor_id)
  jq -e --arg id "$id" 'select(.ev == "ask" and .agent_id == $id and .tool == "Bash" and .detail == "pwd" and .agent_type == "litter:executor")' \
    "$H_DIR/ask-seen.jsonl" >/dev/null 2>&1 || { echo "no ask line for agent ${id:-?}'s pwd in the spool (ask-seen.jsonl: $(wc -l <"$H_DIR/ask-seen.jsonl" 2>/dev/null | tr -d ' ') lines)"; return 1; }
  # The engine logs the hooks' run, not each command (2.1.290).
  grep -q 'executePermissionRequestHooks called for tool: Bash' "$H_DIR/debug.txt" || { echo "the debug log has no PermissionRequest hooks run for Bash"; return 1; }
}
c_asking() {
  marked asking || return 1
  r=$($UI screen "$H_DIR" asking | grep -E '⚑ asking · executor wants Bash: pwd') || { echo "no ask row on the screen:"; $UI screen "$H_DIR" asking | tail -n 20; return 1; }
  printf '%s\n' "$r" | grep -q 'authorized: ' || { echo "the ask row names nothing authorized: $r"; return 1; }
}
c_answered() {
  marked answered || return 1
  $UI shows "$H_DIR" '⚑ asking' answered && { echo "the ask row is still drawn after the answer"; return 1; }
  id=$(executor_id)
  jq -e --arg id "$id" 'select(.ev == "PostToolUse" and .agent_id == $id and .tool == "Bash" and .input.command == "pwd")' "$LOG" >/dev/null 2>&1 ||
    { echo "the executor's pwd never ran: the answer wasn't Yes"; return 1; }
}

# Where the ask row was drawn, between the asking and answered marks, every 500 bytes of tty.txt: an info line, not a check.
ask_seen() {
  a=$(cut -d' ' -f1 "$H_DIR/marks/asking" 2>/dev/null)
  b=$(cut -d' ' -f1 "$H_DIR/marks/answered" 2>/dev/null)
  [ -n "$a" ] && [ -n "$b" ] || return 0
  o=$a
  with=0
  after=0
  while [ "$o" -le "$b" ]; do
    s=$(bun "$H_FIX/screen.ts" "$H_DIR/tty.txt" "$o" 2>/dev/null)
    if printf '%s\n' "$s" | grep -q '⚑ asking'; then
      if printf '%s\n' "$s" | grep -q 'Do you want to proceed'; then with=$((with + 1)); else after=$((after + 1)); fi
    fi
    o=$((o + 500))
  done
  echo "$H_CASE: the ask row was on $with screen(s) with the dialog up, and on $after after it closed"
}
ask_seen

h_expect "run.start and the launch made a run" c_run
h_expect "the executor's pwd raised a permission dialog (PermissionRequest)" c_dialog
h_expect "ask.sh spooled its ask line, and the debug log has its run" c_ask_line
h_expect "while the dialog was open the band showed the ask row, with what's authorized" c_asking
h_expect "once answered (Yes) and run, the ask row was gone" c_answered
h_done
