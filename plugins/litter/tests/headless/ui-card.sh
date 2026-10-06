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
# <sha>`), and [ Board ], with the engine's own row (the workflow's summary,
# `Dynamic workflow "<description>" completed`) not drawn. ctrl+o (the
# engine's transcript view, where UserMessage's isExpanded is true) shows the
# card above the engine's own row (WP-CK); Esc leaves it, and the card is
# back alone. The session runs with verbose off (in --settings).
#
# H_VERBOSE=1 runs the same session with verbose on, where every row is drawn
# expanded (cli_formatted_2.1.290.js:1200609): with no key pressed, the card
# above the engine's own row. Its case folder is ui-card-verbose-<time>.
#
# The screens are read through ui.sh (fixtures/screen.ts) at each mark: card,
# expanded, back (marks/); with H_VERBOSE=1, card alone.
#
# H_DRY=1 stops once the repo and the steps are made. H_CHECKS=<case folder>
# runs the checks again on a folder an earlier run left (its mode from the
# folder's name). Needs expect and bun. UI_MODEL sets the session's model
# (--model).

set -u
. "$(dirname "$0")/lib.sh"

command -v expect >/dev/null || { echo "$0: needs expect" >&2; exit 2; }
command -v bun >/dev/null || { echo "$0: needs bun" >&2; exit 2; }

if [ -n "${H_CHECKS:-}" ]; then
  H_DIR=$(cd -P "$H_CHECKS" && pwd -P) || exit 2
  H_CASE=${H_DIR##*/}
  H_REPO=$H_DIR/repo
  case $H_CASE in ui-card-verbose-*) VERBOSE=1 ;; *) VERBOSE=0 ;; esac
else
  VERBOSE=0
  [ "${H_VERBOSE:-}" = 1 ] && VERBOSE=1
  if [ "$VERBOSE" = 1 ]; then h_scratch "ui-card-verbose-$(date +%Y%m%d-%H%M%S)"; else h_scratch "ui-card-$(date +%Y%m%d-%H%M%S)"; fi
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
  {
    h_tool_steps "$H_DIR/debug.txt"
    cat <<EOF
wait 1800 ls $LD/2*/ledger/*-run.end.json
# The notification row, as litter's card.
wait 300 $UI shows $H_DIR '$TITLE'
sleep 5
until $UI mark $H_DIR card
EOF
    # Verbose: every row is expanded already, so the card mark is the case's one screen.
    [ "$VERBOSE" = 1 ] || cat <<EOF
# ctrl+o: the engine's transcript view, the card above its own row.
key ctrl-o
wait 30 $UI shows $H_DIR 'Showing detailed transcript'
sleep 3
until $UI mark $H_DIR expanded
key esc
wait 30 ! $UI shows $H_DIR 'Showing detailed transcript'
sleep 3
until $UI mark $H_DIR back
EOF
    echo exit
  } >|"$H_DIR/steps.txt"
  [ "${H_DRY:-}" = 1 ] && { echo "$H_CASE: dry run, files in $H_DIR"; exit 0; }

  START=$(jq -cn '{kind: "run.start", workflow: "execute", authorized: ["tier-4 card probe"], planPath: "plan.md", repair: "off"}') || exit 1
  FIRST="You are running a scripted test. Do exactly these steps, in order, and nothing else.
1. Call mcp__litter__record with exactly this input: $START
2. Call the Workflow tool with name \"litter:execute-run\" and args set to the args object step 1 returned, unchanged.
3. Wait for the workflow task notification. Then reply with the single word finished, and nothing else.
If a step is refused, note the refusal verbatim and stop."
  # With verbose on (a user setting), every row is drawn expanded (isExpanded is the engine's
  # verbose || transcript view, cli_formatted_2.1.290.js:1200609); set either way, so the user's own doesn't leak in.
  if [ "$VERBOSE" = 1 ]; then V=true; else V=false; fi
  SETTINGS=$(jq -cn --argjson v "$V" '{verbose: $v, pluginConfigs: {litter: {options: {verify: ["sh", "test.sh"]}}}}') || exit 1
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
CARD_TITLE="✓ done · litter · execute $RUN( |\$)"
ENGINE_ROW="$ENGINE[^\"]*\" completed"
# The card's rows on a screen: its title row and the two under it.
card_at() { $UI screen "$H_DIR" "$1" | grep -E -A 2 "$CARD_TITLE"; }
# The first screen row (1-based) matching an ERE, on the screen at a mark.
row_of() { $UI screen "$H_DIR" "$1" | grep -nE -- "$2" | head -n 1 | cut -d: -f1; }
# Both drawn on the screen at a mark, the card's title above the engine's own row (WP-CK).
above() {
  t=$(row_of "$1" "$CARD_TITLE")
  g=$(row_of "$1" "$ENGINE_ROW")
  [ -n "$t" ] || { echo "no card for $RUN on the $1 screen:"; $UI screen "$H_DIR" "$1" | tail -n 20; return 1; }
  [ -n "$g" ] || { echo "no engine row for the workflow on the $1 screen:"; $UI screen "$H_DIR" "$1" | tail -n 20; return 1; }
  [ "$t" -lt "$g" ] || { echo "the card (row $t) isn't above the engine's row (row $g) on the $1 screen"; return 1; }
}

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
  if [ "$VERBOSE" = 1 ]; then
    above card
  else
    $UI shows "$H_DIR" "$ENGINE" card && { echo "the engine's own row is drawn beside the compact card"; return 1; }
    return 0
  fi
}
c_expanded() {
  marked expanded || return 1
  above expanded || return 1
  card_at expanded | grep -Eq '2/2 gates landed' || { echo "ctrl+o's card doesn't say 2/2 gates landed:"; card_at expanded; return 1; }
}
c_back() {
  marked back || return 1
  card_at back >/dev/null || { echo "after Esc the card isn't drawn again:"; $UI screen "$H_DIR" back | tail -n 20; return 1; }
  $UI shows "$H_DIR" "$ENGINE" back && { echo "after Esc the engine's own row is still drawn beside the card"; return 1; }
  return 0
}

h_expect "run.start and the launch made a run, which ended done" c_run
if [ "$VERBOSE" = 1 ]; then
  h_expect "verbose: the run's notification row is litter's card (done, execute and the run, 2/2 gates landed with the last land, [ Board ]) above the engine's own row, no key pressed" c_card
else
  h_expect "the run's notification row is litter's card alone: done, execute and the run, 2/2 gates landed with the last land, [ Board ]" c_card
  h_expect "ctrl+o shows the card above the engine's own row for the workflow" c_expanded
  h_expect "out of ctrl+o's view, the card is drawn alone again" c_back
fi
h_done
