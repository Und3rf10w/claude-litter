#!/bin/sh
# Tier 4: phase 5's band (COMMON step 1, decision 7), in an interactive
# session drive.exp types into, on the real workflows/execute.js:
#
#   sh tests/headless/ui-band.sh
#
# The repo is execute.sh basic's (fixtures/execute-basic: a two-gate plan, each
# gate adding one function to lib/math.sh with its test). The first prompt
# records run.start (repair: off) and launches litter:execute-run with its
# args, as execute.sh basic's does. While the run's generation is open the
# band shows its row with the gate count (`▸ running · litter · execute <run>
# · gate 1/2 …  [ Board ] [ Hide ]`); a click on [ Hide ] hides it; at the
# run's end the row is back with its outcome (`✓ done · litter · execute <run>
# · 2/2 landed`), and a minute later it's gone: the case sets the bandEndedMinutes
# option to 1. A plugin loaded with --plugin-dir takes its options from the
# settings' pluginConfigs.<name>.options, here through --settings, as every
# tier-4 case sets verify.
#
# [Hide] is pressed with the pointer: drive.exp's click sends an SGR mouse
# report where ui.sh finds the label on the screen (in fullscreen, which the
# case sets with CLAUDE_CODE_NO_FLICKER=1, the engine turns SGR mouse
# reporting on, and a click on a band Button presses it). The screens
# are read through ui.sh (fixtures/screen.ts), as they stood at each mark:
# running, hidden, ended, gone (marks/ in the case folder).
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
  # A fresh path each run: $.store keeps ledger heads by their absolute paths.
  h_scratch "ui-band-$(date +%Y%m%d-%H%M%S)"
  cp "$LITTER_ROOT/workflows/execute.js" "$H_DIR/litter/workflows/execute.js" || exit 1
  cp -R "$H_FIX/execute-basic/." "$H_REPO/" || exit 1
  h_git -C "$H_REPO" add -A
  h_git -C "$H_REPO" commit -q -m 'the basic fixture: its code, test.sh and plan.md' || exit 1
fi
R=$H_REPO
LD=$R/.claude/litter
UI="sh $H_HERE/ui.sh"
# A run's band row: its status glyph and word, then litter's name, as the card in the transcript reads ("✓ done · litter · …", WP-DB).
# Alternatives, not a bracket: in the C locale a bracket of these glyphs is a set of their bytes.
GLYPH='(▸|✓|⚑|✕|−|!|↻) [a-z ]+'
ROW="$GLYPH · litter · execute [0-9]{8}-[a-z0-9-]+"

if [ -z "${H_CHECKS:-}" ]; then
  cat >|"$H_DIR/steps.txt" <<EOF
$(h_tool_steps "$H_DIR/debug.txt")
# The run's row while its generation is open, with the gate count.
wait 900 $UI shows $H_DIR '▸ running · litter · execute [0-9]{8}-[a-z0-9-]+ · gate [0-9]+/2'
sleep 3
until $UI mark $H_DIR running
# [Hide], with the pointer; the row goes.
click $UI at $H_DIR '[ Hide ]'
wait 30 ! $UI shows $H_DIR '$ROW'
sleep 3
until $UI mark $H_DIR hidden
# The run's end: the row is back, with its outcome.
wait 1800 ls $LD/2*/ledger/*-run.end.json
wait 120 $UI shows $H_DIR '✓ done · litter · execute [0-9]{8}-[a-z0-9-]+'
sleep 3
until $UI mark $H_DIR ended
# A minute on (bandEndedMinutes: 1), the row is gone.
wait 300 ! $UI shows $H_DIR '$ROW'
sleep 3
until $UI mark $H_DIR gone
sleep 5
exit
EOF
  [ "${H_DRY:-}" = 1 ] && { echo "$H_CASE: dry run, files in $H_DIR"; exit 0; }

  START=$(jq -cn '{kind: "run.start", workflow: "execute", authorized: ["tier-4 band probe"], planPath: "plan.md", repair: "off"}') || exit 1
  FIRST="You are running a scripted test. Do exactly these steps, in order, and nothing else.
1. Call mcp__litter__record with exactly this input: $START
2. Call the Workflow tool with name \"litter:execute-run\" and args set to the args object step 1 returned, unchanged.
3. Wait for the workflow task notification. Then reply with each step result and the workflow result, verbatim.
If a step is refused, note the refusal verbatim and stop."
  SETTINGS=$(jq -cn '{pluginConfigs: {litter: {options: {verify: ["sh", "test.sh"], bandEndedMinutes: 1}}}}') || exit 1
  echo "$H_CASE: driving the session in $R"
  (
    cd "$R" || exit 1
    # Auto mode, as the other interactive cases: the classifier answers the agents' asks. Fullscreen
    # (CLAUDE_CODE_NO_FLICKER=1), where the engine reads the pointer at all (2.1.290: mouse tracking is the
    # alternate screen's, cli_formatted_2.1.290.js:1453126-1453172, and a click is dispatched only there, :690412).
    # shellcheck disable=SC2086
    CLAUDE_CODE_NO_FLICKER=1 H_PERSIST=1 expect "$H_HERE/drive.exp" "$H_DIR/steps.txt" "$H_DIR/tty.txt" claude ${UI_MODEL:+--model "$UI_MODEL"} \
      --permission-mode auto --settings "$SETTINGS" \
      --allowedTools mcp__litter__record Workflow Read Glob Grep Write Edit 'Bash(git:*)' 'Bash(sh:*)' 'Bash(cat:*)' 'Bash(ls:*)' \
      --plugin-dir "$H_DIR/litter" --plugin-dir "$H_DIR/toollog" --debug-file "$H_DIR/debug.txt" "$FIRST" >|"$H_DIR/drive.txt" 2>&1
  )
  rc=$?
  printf '%s: drive exited %s\n' "$H_CASE" "$rc"
  h_tool_down "$rc"
fi

RUN=$(ls "$LD" 2>/dev/null | grep -E '^[0-9]{8}-' | head -n 1)
RD=$LD/$RUN
ledger() { cat "$RD"/ledger/*-"$1".json 2>/dev/null; }
# The run's row on the screen at a mark: this run's id after the glyph and word.
row_at() { $UI screen "$H_DIR" "$1" | grep -E "$GLYPH · litter · execute $RUN( |\$)"; }
end_s() { ledger run.end | jq -s -r 'map(.at) | first // empty | . / 1000 | floor'; }
marked() { [ -f "$H_DIR/marks/$1" ] || { echo "no mark $1: the steps didn't get that far (drive.txt)"; return 1; }; }

c_run() {
  [ -n "$RUN" ] && [ -f "$RD/run.json" ] || { echo "no run in $LD"; return 1; }
  s=$(ledger run.end | jq -s -r 'map(.body.status) | last // "none"')
  [ "$s" = done ] || { echo "the run ended '$s', not done"; return 1; }
}
c_running() {
  marked running || return 1
  r=$(row_at running) || { echo "the screen at the mark shows no row for $RUN:"; $UI screen "$H_DIR" running | tail -n 12; return 1; }
  printf '%s\n' "$r" | grep -Eq "▸ running · litter · execute $RUN · gate [12]/2" || { echo "the row isn't the open run's with its gate count: $r"; return 1; }
  printf '%s\n' "$r" | grep -Fq '[ Board ]' && printf '%s\n' "$r" | grep -Fq '[ Hide ]' || { echo "the row has no [ Board ] and [ Hide ]: $r"; return 1; }
}
c_hidden() {
  marked hidden || return 1
  r=$(row_at hidden) && { echo "the row is still drawn after [ Hide ]: $r"; return 1; }
  $UI shows "$H_DIR" '^❯' hidden || { echo "the screen at the mark has no prompt row: not a whole screen"; return 1; }
  e=$(end_s)
  h=$($UI when "$H_DIR" hidden)
  [ -n "$e" ] && [ "$h" -lt "$e" ] || { echo "the run had ended (at ${e:-?}) when the row was gone ($h): [ Hide ] wasn't what hid it"; return 1; }
}
c_ended() {
  marked ended || return 1
  r=$(row_at ended) || { echo "no row for $RUN at the run's end:"; $UI screen "$H_DIR" ended | tail -n 12; return 1; }
  printf '%s\n' "$r" | grep -Eq "✓ done · litter · execute $RUN · 2/2 landed" || { echo "the ended row doesn't say done and 2/2 landed: $r"; return 1; }
}
c_gone() {
  marked gone || return 1
  r=$(row_at gone) && { echo "the ended row is still drawn: $r"; return 1; }
  $UI shows "$H_DIR" '^❯' gone || { echo "the screen at the mark has no prompt row: not a whole screen"; return 1; }
  e=$(end_s)
  g=$($UI when "$H_DIR" gone)
  [ -n "$e" ] || { echo "no run.end"; return 1; }
  d=$((g - e))
  # A minute's window: gone after 60 s (the tick is 2 s, the mark 3 s after), long before the default 10 minutes.
  [ "$d" -ge 55 ] && [ "$d" -le 240 ] || { echo "the row went ${d}s after the run's end, not about a minute (bandEndedMinutes: 1)"; return 1; }
}

h_expect "run.start and the launch made a run, which ended done" c_run
h_expect "while the run was open the band showed its row with its gate count, [ Board ] and [ Hide ]" c_running
h_expect "a click on [ Hide ] hid the row while the run was still open" c_hidden
h_expect "at the run's end the row was back, saying done and 2/2 landed" c_ended
h_expect "about a minute after the end (bandEndedMinutes: 1) the row was gone" c_gone
h_done
