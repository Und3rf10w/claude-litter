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
# is open (the tool log's PermissionRequest line, fixtures/toollog) the
# transcript above it shows the ask's one row, `litter: ⚑ asking · executor
# wants Bash: pwd · authorized: …` ($.ui.log, the engine's `litter: ` first;
# WP-CK), and no screen shows a band row for it; Enter takes the dialog's
# first option (Yes), and the call runs. ask.sh's `ask` line is read from the
# spool (a watcher hard-links each spool file before the mod's drain removes
# it; ask-seen.jsonl), and the debug log has the hooks' run and the row's
# one `[litter] $.ui.log: ` line. The screens are read through ui.sh
# (fixtures/screen.ts) at each mark: asking, answered (marks/).
#
# Why the transcript (WP-CK): on 2.1.290 the engine doesn't draw the prompt
# area, the band in it, while a dialog that hides the prompt is up
# (cli_formatted_2.1.290.js:1477851, the prompt area's `visible` is
# `!vP() && …`; vP, :1454610, is a dialog hiding the prompt; the band is
# mounted in that area, :1436199). The band's ask row showed only once the
# dialog had closed, so the band draws none now.
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
# The ask's transcript row: the engine's `litter: `, then asks.ts's askLine (the gate shows when the agent list labels it).
ROW='litter: ⚑ asking · (G[0-9]+ )?executor wants Bash: pwd'
# A band row for an ask: a screen row that starts with the mark, with no `litter: ` before it.
BAND_ROW='^[[:space:]]*⚑ asking'
DIALOG='Do you want to proceed'

if [ -z "${H_CHECKS:-}" ]; then
  cat >|"$H_DIR/steps.txt" <<EOF
$(h_tool_steps "$H_DIR/debug.txt")
# The executor's pwd: its dialog, and above it the ask's transcript row.
wait 900 jq -e 'select(.ev == "PermissionRequest" and .tool == "Bash" and .input.command == "pwd")' $LOG >/dev/null 2>&1
wait 60 $UI shows $H_DIR '$ROW'
sleep 3
until $UI mark $H_DIR asking
# Yes: the dialog's first option, under its cursor.
key enter
wait 60 ! $UI shows $H_DIR '$DIALOG'
sleep 3
until $UI mark $H_DIR answered
wait 900 ls $LD/2*/ledger/*-run.end.json
sleep 10
exit
EOF
  [ "${H_DRY:-}" = 1 ] && { echo "$H_CASE: dry run, files in $H_DIR"; exit 0; }

  # Every spool file, hard-linked into spool-seen/ as it's seen, so the
  # drain's remove leaves its lines (fixtures/spoolwatch.ts). A cat of the
  # spool every 0.2 s missed the ask line under load.
  bun "$H_FIX/spoolwatch.ts" "$LD/hooks/spool" "$H_DIR/spool-seen" "$H_DIR/drive-done" &
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
  cat "$H_DIR"/spool-seen/* 2>/dev/null | grep '"ev":"ask"' >|"$H_DIR/ask-seen.jsonl"
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
  s=$($UI screen "$H_DIR" asking)
  printf '%s\n' "$s" | grep -q "$DIALOG" || { echo "the dialog isn't on the screen at the mark:"; printf '%s\n' "$s" | tail -n 20; return 1; }
  r=$(printf '%s\n' "$s" | grep -E "$ROW") || { echo "no transcript row for the ask on the dialog's screen:"; printf '%s\n' "$s" | tail -n 30; return 1; }
  printf '%s\n' "$r" | grep -q 'authorized: ' || { echo "the ask's row names nothing authorized: $r"; return 1; }
}
c_answered() {
  marked answered || return 1
  $UI shows "$H_DIR" "$DIALOG" answered && { echo "the dialog is still drawn after the answer"; return 1; }
  id=$(executor_id)
  jq -e --arg id "$id" 'select(.ev == "PostToolUse" and .agent_id == $id and .tool == "Bash" and .input.command == "pwd")' "$LOG" >/dev/null 2>&1 ||
    { echo "the executor's pwd never ran: the answer wasn't Yes"; return 1; }
}

# Every 500 bytes of tty.txt from the asking mark to its end, and its last
# screen: the screens with the ask's transcript row (with the dialog up, and
# after), with it twice, and with a band ask row.
row_dialog=0
row_after=0
twice=0
band=0
sample() {
  s=$(bun "$H_FIX/screen.ts" "$H_DIR/tty.txt" "$1" 2>/dev/null)
  n=$(printf '%s\n' "$s" | grep -cE "$ROW")
  if [ "$n" -gt 0 ]; then
    if printf '%s\n' "$s" | grep -q "$DIALOG"; then row_dialog=$((row_dialog + 1)); else row_after=$((row_after + 1)); fi
  fi
  [ "$n" -le 1 ] || twice=$((twice + 1))
  if printf '%s\n' "$s" | grep -qE "$BAND_ROW"; then band=$((band + 1)); fi
}
screens() {
  a=$(cut -d' ' -f1 "$H_DIR/marks/asking" 2>/dev/null)
  end=$(wc -c <"$H_DIR/tty.txt" 2>/dev/null | tr -dc 0-9)
  [ -n "$a" ] && [ -n "$end" ] || return 0
  o=$a
  while [ "$o" -le "$end" ]; do
    sample "$o"
    o=$((o + 500))
  done
  sample all
  echo "$H_CASE: the ask's transcript row was on $row_dialog screen(s) with the dialog up and $row_after after it closed; a band ask row on $band"
}
screens
c_no_band() {
  marked asking || return 1
  [ "$band" -eq 0 ] || { echo "$band screen(s) from the asking mark on show a band ask row (a row starting ⚑ asking)"; return 1; }
}
c_once() {
  n=$(grep -cE "\[litter\] \\\$\.ui\.log: ⚑ asking · (G[0-9]+ )?executor wants Bash: pwd" "$H_DIR/debug.txt" 2>/dev/null)
  [ "${n:-0}" -eq 1 ] || { echo "the debug log has ${n:-0} transcript rows for the ask, not 1"; return 1; }
  [ "$twice" -eq 0 ] || { echo "$twice screen(s) show the ask's row twice"; return 1; }
}

h_expect "run.start and the launch made a run" c_run
h_expect "the executor's pwd raised a permission dialog (PermissionRequest)" c_dialog
h_expect "ask.sh spooled its ask line, and the debug log has its run" c_ask_line
h_expect "while the dialog was open the transcript above it showed the ask's row (the executor, Bash, pwd), with what's authorized" c_asking
h_expect "no screen showed a band ask row" c_no_band
h_expect "the ask's transcript row was written once" c_once
h_expect "once answered (Yes), the dialog closed and the executor's pwd ran" c_answered
h_done
