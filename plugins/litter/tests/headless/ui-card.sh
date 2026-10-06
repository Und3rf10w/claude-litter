#!/bin/sh
# Tier 4: phase 5's finished-run card (COMMON step 2, decision 8), in an
# interactive session drive.exp types into, on the real workflows/execute.js:
#
#   sh tests/headless/ui-card.sh
#
# The run is ui-band.sh's (execute.sh basic's repo and first prompt). Once it
# has ended, the run's task-notification row is drawn as litter's card: the
# outcome's glyph and word, the workflow and the run (`✓ done · litter ·
# execute <run> · 2m 5s`), what the ledger says (`2/2 gates landed · last land
# <sha>`), and [ Board ]. ctrl+o (the engine's transcript view, where
# UserMessage's isExpanded is true) shows the engine's own row instead, the
# workflow's summary (`Dynamic workflow "<description>" completed`); Esc
# leaves it, and the card is back. The session runs with verbose off (in
# --settings), since verbose draws every row expanded. The screens are read
# through ui.sh (fixtures/screen.ts) at each mark: card, expanded, back
# (marks/).
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
  h_scratch "ui-card-$(date +%Y%m%d-%H%M%S)"
  cp "$LITTER_ROOT/workflows/execute.js" "$H_DIR/litter/workflows/execute.js" || exit 1
  cp -R "$H_FIX/execute-basic/." "$H_REPO/" || exit 1
  h_git -C "$H_REPO" add -A
  h_git -C "$H_REPO" commit -q -m 'the basic fixture: its code, test.sh and plan.md' || exit 1
fi
R=$H_REPO
LD=$R/.claude/litter
UI="sh $H_HERE/ui.sh"
# The engine's own row for a workflow's notification (2.1.290): its meta.description, quoted.
ENGINE='Dynamic workflow "Implement an approved plan gate by gate'
TITLE='✓ done · litter · execute [0-9]{8}-[a-z0-9-]+'

if [ -z "${H_CHECKS:-}" ]; then
  cat >|"$H_DIR/steps.txt" <<EOF
$(h_tool_steps "$H_DIR/debug.txt")
wait 1800 ls $LD/2*/ledger/*-run.end.json
# The notification row, as litter's card.
wait 300 $UI shows $H_DIR '$TITLE'
sleep 5
until $UI mark $H_DIR card
# ctrl+o: the engine's transcript view, and its own row.
key ctrl-o
wait 30 $UI shows $H_DIR 'Showing detailed transcript'
sleep 3
until $UI mark $H_DIR expanded
key esc
wait 30 ! $UI shows $H_DIR 'Showing detailed transcript'
sleep 3
until $UI mark $H_DIR back
exit
EOF
  [ "${H_DRY:-}" = 1 ] && { echo "$H_CASE: dry run, files in $H_DIR"; exit 0; }

  START=$(jq -cn '{kind: "run.start", workflow: "execute", authorized: ["tier-4 card probe"], planPath: "plan.md", repair: "off"}') || exit 1
  FIRST="You are running a scripted test. Do exactly these steps, in order, and nothing else.
1. Call mcp__litter__record with exactly this input: $START
2. Call the Workflow tool with name \"litter:execute-run\" and args set to the args object step 1 returned, unchanged.
3. Wait for the workflow task notification. Then reply with the single word finished, and nothing else.
If a step is refused, note the refusal verbatim and stop."
  # verbose off: with it on (a user setting), every row is drawn expanded (isExpanded is the engine's
  # verbose || transcript view, cli_formatted_2.1.290.js:1200609), and the card always yields to the engine's row.
  SETTINGS=$(jq -cn '{verbose: false, pluginConfigs: {litter: {options: {verify: ["sh", "test.sh"]}}}}') || exit 1
  echo "$H_CASE: driving the session in $R"
  (
    cd "$R" || exit 1
    # Fullscreen (CLAUDE_CODE_NO_FLICKER=1), where the transcript view is the engine's screen of its own.
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
marked() { [ -f "$H_DIR/marks/$1" ] || { echo "no mark $1: the steps didn't get that far (drive.txt)"; return 1; }; }
# The card's rows on a screen: its title row and the two under it.
card_at() { $UI screen "$H_DIR" "$1" | grep -E -A 2 "✓ done · litter · execute $RUN( |\$)"; }

c_run() {
  [ -n "$RUN" ] && [ -f "$RD/run.json" ] || { echo "no run in $LD"; return 1; }
  s=$(ledger run.end | jq -s -r 'map(.body.status) | last // "none"')
  [ "$s" = done ] || { echo "the run ended '$s', not done"; return 1; }
}
c_card() {
  marked card || return 1
  c=$(card_at card) || { echo "no card for $RUN on the screen:"; $UI screen "$H_DIR" card | tail -n 20; return 1; }
  sha=$(ledger land | jq -s -r 'sort_by(.seq) | last | .body.commit // empty' | cut -c1-7)
  printf '%s\n' "$c" | grep -Eq "2/2 gates landed · last land $sha" || { echo "the card doesn't say 2/2 gates landed, last land ${sha:-?}:"; printf '%s\n' "$c"; return 1; }
  printf '%s\n' "$c" | grep -Fq '[ Board ]' || { echo "the card has no [ Board ]:"; printf '%s\n' "$c"; return 1; }
  $UI shows "$H_DIR" "$ENGINE" card && { echo "the engine's own row is drawn beside the card"; return 1; }
  return 0
}
c_expanded() {
  marked expanded || return 1
  $UI shows "$H_DIR" "$ENGINE[^\"]*\" completed" expanded || { echo "ctrl+o's view has no engine row for the workflow:"; $UI screen "$H_DIR" expanded | tail -n 20; return 1; }
  c=$(card_at expanded) && { echo "ctrl+o's view still draws the card: $c"; return 1; }
  return 0
}
c_back() {
  marked back || return 1
  card_at back >/dev/null || { echo "after Esc the card isn't drawn again:"; $UI screen "$H_DIR" back | tail -n 20; return 1; }
}

h_expect "run.start and the launch made a run, which ended done" c_run
h_expect "the run's notification row is litter's card: done, execute and the run, 2/2 gates landed with the last land, [ Board ]" c_card
h_expect "ctrl+o shows the engine's own row for the workflow, not the card" c_expanded
h_expect "out of ctrl+o's view, the card is drawn again" c_back
h_done
