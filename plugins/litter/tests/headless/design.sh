#!/bin/sh
# Tier 4: phase 4's design runs (docs/litter-design/SCOPE.md section 3), on
# the real workflows/design.js and skills/design.
#
#   sh tests/headless/design.sh basic     # a design approved, delivered, and handed over in plan mode
#   sh tests/headless/design.sh drift     # the checkout changes mid-round: source_changed, nothing delivered
#   sh tests/headless/design.sh compare [both|litter|deepwork]   # by hand only: litter's design beside deepwork DESIGN
#
# compare's deepwork comes from the legacy-3.8 tag (lib.sh's h_deepwork).
#
# basic and drift: lib.sh's repo (HEAD ahead of origin/main, so a prober's
# worktree at origin would lack the fixture) plus fixtures/design-compare's
# repo, a small sh project (tally). One interactive session through
# drive.exp types /litter:design with a goal whose mechanism a live test
# settles (does printf pad a 3-byte sign by characters?), and answers the
# interview as answer.sh does: Launch by label, else the recommended
# option; if the skill ends its turn without launching, Launch is typed.
# maxRounds is 2 (the litter option). Then the run, to its run.end.
# - basic: the run should end approved, delivered as plan.md (the approved
#   proposal's bytes), with summary.md's Stop and Delivery saying so; then
#   the skill enters plan mode, writes plan.md's bytes to the plan file and
#   calls ExitPlanMode, whose dialogs planpick.sh answers: a Yes that
#   neither accepts edits, bypasses permissions nor clears the context.
#   The roles only read, so the checkout is left as it was.
# - drift: once the first investigator's report is recorded, the steps add
#   a line to lib/amount.sh. The critic's verdict then carries
#   source_changed (its snapshot against base), the run halts with
#   source-changed, nothing is delivered, and plan mode isn't used.
#
# compare: fixtures/design-compare in two scratch repos, one per side, each
# lib.sh's with its remote and worktree pin taken out (as S0 and T4-1 ran),
# the goal expect.json's. litter's commits the vendor ban as an accepted
# project rule; deepwork gets it through --guardrail. Both run interactive
# at medium effort in auto mode, for at most 3 hours each, their questions
# answered as answer.sh does; deepwork's team-size question takes the full
# team. litter's side ends when its skill's turn is over after the run
# (plan mode answered as in basic); deepwork's when it records its halt
# (S0-D: its ExitPlanMode is refused outside plan mode, so its phase stays
# deliver), or on a question no one answers. Each side's texts/ then holds
# what design-compare.sh scores: litter's delivered plan.md and its gates'
# files, deepwork's approved final proposal (T4-RESULTS.md, S0-D).
# H_COMPARE names an earlier case folder to add a side to.
#
# H_CHECKS=<case folder> reruns the checks (or, for compare, the texts and
# the table) on an earlier run's files. H_DRY=1 sets up the case and exits.
# Exit 0 when every check passes, 1 when one fails, 3 when the session
# couldn't run the case (litter's tool server never connected).

. "$(dirname "$0")/lib.sh"

mode=${1:-}
which=${2:-both}
case $mode in
basic | drift | compare) ;;
*)
  echo "usage: $0 basic | drift | compare [both|litter|deepwork]" >&2
  exit 2
  ;;
esac

EXPECT=$H_FIX/design-compare/ground/expect.json
BAN=$H_FIX/compare/P-vendor-as-shipped.md
GOAL='Design how the report should keep its amount column lined up whatever sign an amount carries, a 3-byte euro sign included, under dash and BusyBox sh as CI runs them.'
[ "$mode" = compare ] && GOAL=$(jq -r .goal "$EXPECT")
case $GOAL in '' | *"'"*) echo "$0: the goal is empty or holds a quote" >&2; exit 2 ;; esac
# The interview's labels to pick ahead of the recommended ones (answer.sh: jq, case-insensitive).
ANSWERS='^launch|^run (the|a) design|design run'

runs() { ls "$1" 2>/dev/null | grep -E '^[0-9]{8}-' | head -n 1; }

# litter_steps <dir> <repo> <edit: 0|1>: the side's until.sh and steps.txt.
litter_steps() {
  ld=$2/.claude/litter
  cat >|"$1/until.sh" <<EOF
#!/bin/sh
# The waits of this side's steps: sh until.sh <what> exits 0 once it holds.
LD=$ld
R=$2
LOG=$1/tool-log.jsonl
DIR=$1
HERE=$H_HERE
EOF
  cat >>"$1/until.sh" <<'EOF'
records() { cat "$LD"/2*/ledger/*.json 2>/dev/null | jq -s 'sort_by(.seq)'; }
quiet() { [ -f "$LOG" ] && [ -z "$(find "$LOG" -mmin -"$1" 2>/dev/null)" ]; }
ended() { ls "$LD"/2*/ledger/*-run.end.json >/dev/null 2>&1; }
case $1 in
# drift: once an investigator's report is in, a line added to lib/amount.sh, once.
edit)
  [ -f "$DIR/edited" ] && exit 0
  records | jq -e 'any(.[]; .kind == "finding" or .kind == "coverage" or .kind == "mechanism")' >/dev/null 2>&1 || { ended && exit 0; exit 1; }
  printf '# changed mid-round by the tier-4 steps\n' >>"$R/lib/amount.sh"
  date +%s >|"$DIR/edited"
  ;;
ended) ended ;;
# The skill's turn after the run is over: ExitPlanMode answered, or three quiet minutes.
settled)
  ended || exit 1
  jq -nRe '[inputs | fromjson? | select(.tool == "ExitPlanMode" and (.ev == "PostToolUse" or .ev == "PostToolUseFailure"))] | length > 0' "$LOG" >/dev/null 2>&1 && exit 0
  quiet 3
  ;;
# deliver: the keys for a waiting plan-mode dialog; exit 1 once settled. A
# question after the run (a new run, more rounds) is declined with esc, the
# round after it shows, so the case runs once (design.sh drift, 2026-10-05:
# answering the recommended "New run from this one" started a second run).
deliver)
  sh "$DIR/until.sh" settled && exit 1
  k=$(sh "$HERE/planpick.sh" "$DIR/tty.txt" "$LOG" "$DIR/plan-mark" '^yes') || exit 1
  [ -n "$k" ] && { echo "$k"; exit 0; }
  sh "$HERE/asking.sh" "$LOG" "$DIR/ask-mark" || { rm -f "$DIR/ask-seen"; exit 0; }
  [ -f "$DIR/ask-seen" ] || { : >|"$DIR/ask-seen"; exit 0; }
  rm -f "$DIR/ask-seen"
  wc -l <"$LOG" | tr -d ' ' >|"$DIR/ask-mark"
  echo esc
  ;;
*) exit 2 ;;
esac
EOF
  {
    echo '# The prompt box is up once drive.exp has answered the trust dialog.'
    echo 'sleep 8'
    h_tool_steps "$1/debug.txt"
    echo "send /litter:design $GOAL"
    echo "# The interview, answered until run.start has made run.json; if the skill ends its turn first, Launch is typed."
    echo "keysh 900 5 ! ls $ld/2*/run.json >/dev/null 2>&1 && QUIET_MIN=2 sh $H_HERE/answer.sh $1/tool-log.jsonl '$ANSWERS' $1/answer-mark"
    echo "sendsh ls $ld/2*/run.json >/dev/null 2>&1 || sh $H_HERE/asking.sh $1/tool-log.jsonl || echo Launch"
    echo "keysh 300 5 ! ls $ld/2*/run.json >/dev/null 2>&1 && sh $H_HERE/answer.sh $1/tool-log.jsonl '$ANSWERS' $1/answer-mark"
    [ "$3" = 1 ] && echo "wait 3600 sh $1/until.sh edit"
    echo '# The run, to its run.end or the cap (H_DRIVE_MAX).'
    echo "wait 10800 sh $1/until.sh ended"
    echo '# The skill reads summary.md; plan mode, for an approved plan, with its dialogs answered.'
    echo "keysh 1200 5 sh $1/until.sh deliver"
    echo 'sleep 20'
    echo '# One esc declines a question still waiting, so /exit is not typed into it.'
    echo "press 6 6 esc ! sh $H_HERE/asking.sh $1/tool-log.jsonl $1/ask-mark"
    echo 'exit'
  } >|"$1/steps.txt"
}

# litter_drive <dir> <repo> <settings>: the session, interactive.
litter_drive() {
  date +%s >|"$1/start"
  (
    cd "$2" || exit 1
    CLAUDE_CODE_EFFORT_LEVEL=medium H_PERSIST=1 H_DRIVE_MAX=${H_DRIVE_MAX:-10800} expect "$H_HERE/drive.exp" "$1/steps.txt" "$1/tty.txt" \
      claude --effort medium --permission-mode auto --settings "$3" --plugin-dir "$1/litter" --plugin-dir "$1/toollog" \
      --debug-file "$1/debug.txt" >|"$1/drive.txt" 2>&1
  )
  ld_rc=$?
  date +%s >|"$1/end"
  printf '%s: drive exited %s\n' "${1##*/}" "$ld_rc"
  return $ld_rc
}

# keep_transcripts <dir> <repo>: the session's transcripts and its agents', kept with the side.
keep_transcripts() {
  kp=$(printf '%s' "$2" | sed 's#[^A-Za-z0-9]#-#g')
  mkdir -p "$1/transcripts"
  for d in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$kp"*; do
    [ -d "$d" ] && cp -R "$d" "$1/transcripts/"
  done
}

# ---------------------------------------------------------------------------
# compare

# litter_texts <side>: texts/ from the side's run (design-compare.sh's input).
litter_texts() {
  sd=$1
  ld=$sd/repo/.claude/litter
  mkdir -p "$sd/texts"
  : >|"$sd/texts/plan.md"
  run=$(runs "$ld")
  if [ -z "$run" ] || [ ! -f "$ld/$run/run.json" ]; then
    printf '{"ran": false, "name": "no run", "ended": "no run.json"}\n' >|"$sd/texts/meta.json"
    return 0
  fi
  rd=$ld/$run
  recs=$(cat "$rd"/ledger/*.json | jq -s -c 'sort_by(.seq)') || return 1
  dv=$(printf '%s' "$recs" | jq -c '[.[] | select(.kind == "design.deliver")] | last // null')
  dver=$(printf '%s' "$dv" | jq -r 'if . != null and .body.path != null then .body.version else "" end')
  same=null
  if [ -n "$dver" ] && [ -f "$rd/plan.md" ]; then
    cp "$rd/plan.md" "$sd/texts/plan.md"
    printf '%s' "$recs" | jq -r --arg v "$dver" '[.[] | select(.kind == "proposal" and .body.version == $v)] | last | .body.gates // [] | .[].files[]?' \
      | LC_ALL=C sort -u >|"$sd/texts/files.txt"
    # The plan ExitPlanMode put up for review: the plan file as it read it (c_planmode).
    if [ -f "$sd/tool-log.jsonl" ]; then
      jq -nRj '[inputs | fromjson? | select(.agent_id == null and .tool == "ExitPlanMode" and .ev == "PreToolUse") | .input.plan // empty] | last // empty' \
        "$sd/tool-log.jsonl" >|"$sd/texts/reviewed.md"
      if [ -s "$sd/texts/reviewed.md" ]; then
        cmp -s "$sd/texts/reviewed.md" "$rd/plan.md" && same=true || same=false
      fi
    fi
  fi
  printf '%s' "$recs" | jq -c --arg run "$run" --arg v "$dver" --argjson same "$same" '
    ([.[] | select(.kind == "run.end")] | last) as $e
    | ([.[] | select(.kind == "verdict" and .body.version == $v)] | last) as $vd
    | {ran: true, name: "run \($run)",
       ended: (if $e == null then "never ended" else "\($e.body.status) \($e.body.reason // ($e.body.payload.outcome // ""))" end),
       delivered: ($v != ""), approved: (if $v == "" then null else ($vd != null and $vd.body.overall == "APPROVED") end),
       same_bytes: $same, versions: ([.[] | select(.kind == "proposal")] | length),
       rounds: ([.[] | select(.kind == "verdict")] | length)}' >|"$sd/texts/meta.json"
}

# deepwork_texts <side>: texts/ from its instance: the approved final proposal, as its halt names it.
deepwork_texts() {
  sd=$1
  mkdir -p "$sd/texts"
  : >|"$sd/texts/plan.md"
  inst=$(ls -d "$sd"/repo/.claude/deepwork/*/ 2>/dev/null | head -n 1)
  if [ -z "$inst" ]; then
    printf '{"ran": false, "name": "no instance", "ended": "no state"}\n' >|"$sd/texts/meta.json"
    return 0
  fi
  st=$inst/state.archived.json
  [ -f "$st" ] || st=$inst/state.json
  fin=$(ls -t "$inst"/proposals/*-final.md 2>/dev/null | head -n 1)
  [ -n "$fin" ] && cp "$fin" "$sd/texts/plan.md"
  jq -c --arg fin "${fin##*/}" --argjson v "$(ls "$inst"/proposals/v*.md 2>/dev/null | wc -l | tr -d ' ')" \
    --argjson r "$(ls "$inst"/critique.v*.md 2>/dev/null | wc -l | tr -d ' ')" '
    {ran: true, name: "instance \(.instance_id // "?")", ended: "phase \(.phase // "none")\(if .halt_reason.summary then ": \(.halt_reason.summary)" else "" end)",
     delivered: ($fin != ""), approved: (if $fin == "" then null else ((.halt_reason.summary // "") | test("approved"; "i")) end),
     same_bytes: null, versions: $v, rounds: $r}' "$st" >|"$sd/texts/meta.json" 2>/dev/null ||
    printf '{"ran": true, "name": "instance", "ended": "state unreadable", "delivered": %s}\n' "$([ -n "$fin" ] && echo true || echo false)" >|"$sd/texts/meta.json"
}

compare_side() {
  H_CASE=$C/$1
  h_scratch "$H_CASE"
  h_git -C "$H_REPO" remote remove origin || exit 1
  h_git -C "$H_REPO" rm -q .claude/settings.json || exit 1
  h_git -C "$H_REPO" commit -q -m 'no remote and no worktree pin, as S0 ran' || exit 1
  cp -R "$H_FIX/design-compare/repo/." "$H_REPO/" || exit 1
  h_git -C "$H_REPO" add -A
  h_git -C "$H_REPO" commit -q -m 'the design-compare fixture: tally' || exit 1
  if [ "$1" = litter ]; then
    cp "$LITTER_ROOT/workflows/design.js" "$H_DIR/litter/workflows/design.js" || exit 1
    mkdir -p "$H_REPO/.litter/rules"
    cp "$BAN" "$H_REPO/.litter/rules/${BAN##*/}" || exit 1
    h_git -C "$H_REPO" add .litter
    h_git -C "$H_REPO" commit -q -m 'the vendor ban, an accepted project rule' || exit 1
    litter_steps "$H_DIR" "$H_REPO" 0
    [ "${H_DRY:-}" = 1 ] && return 0
    echo "$H_CASE: driving the session in $H_REPO"
    litter_drive "$H_DIR" "$H_REPO" '{}'
    h_tool_down $?
  else
    h_deepwork "$H_DIR/deepwork-plugin"
    cat >|"$H_DIR/until.sh" <<EOF
#!/bin/sh
# deepwork's end (T4-RESULTS.md, S0-D): its halt recorded (halt_reason, the
# phase left at deliver), its state archived, or phase halt; or a question
# waiting with no one to answer it. NOASK=1: the end alone.
R=$H_REPO
LOG=$H_DIR/tool-log.jsonl
EOF
    cat >>"$H_DIR/until.sh" <<'EOF'
ls "$R"/.claude/deepwork/*/state.archived.json >/dev/null 2>&1 && exit 0
for s in "$R"/.claude/deepwork/*/state.json; do
  [ -f "$s" ] && jq -e '.phase == "halt" or .halt_reason != null' "$s" >/dev/null 2>&1 && exit 0
  # Delivered in chat and waiting on the user, no halt recorded (compare run 1,
  # 2026-10-05): the phase at deliver, a final proposal, and 3 quiet minutes.
  [ -f "$s" ] && jq -e '.phase == "deliver"' "$s" >/dev/null 2>&1 && ls "${s%/state.json}"/proposals/*-final.md >/dev/null 2>&1 &&
    [ -f "$LOG" ] && [ -z "$(find "$LOG" -mmin -3 2>/dev/null)" ] && exit 0
done
[ -z "${NOASK:-}" ] || exit 1
[ -f "$LOG" ] || exit 1
jq -nRe '[inputs | fromjson? | select(.tool == "AskUserQuestion") | .ev]
  | (map(select(. == "PreToolUse")) | length) > (map(select(. == "PostToolUse" or . == "PostToolUseFailure")) | length)' "$LOG" >/dev/null 2>&1
EOF
    bt=$(sed -n '/^## Rule$/{n;p;}' "$BAN")
    case $bt in '' | *"'"*) echo "$0: $BAN's rule is empty or holds a quote" >&2; exit 2 ;; esac
    cat >|"$H_DIR/steps.txt" <<EOF
sleep 8
send /deepwork $GOAL --guardrail '$bt'
# To its end, its questions answered as litter's are (answer.sh), the full team taken (S0-D run 1).
keysh 10800 5 ! NOASK=1 sh $H_DIR/until.sh && sh $H_HERE/answer.sh $H_DIR/tool-log.jsonl 'full deepwork team|full team' $H_DIR/answer-mark
sleep 30
key esc
sleep 3
exit
EOF
    [ "${H_DRY:-}" = 1 ] && return 0
    echo "$H_CASE: driving the session in $H_REPO"
    date +%s >|"$H_DIR/start"
    (
      cd "$H_REPO" || exit 1
      CLAUDE_CODE_EFFORT_LEVEL=medium CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 H_PERSIST=1 H_DRIVE_MAX=${H_DRIVE_MAX:-10800} \
        expect "$H_HERE/drive.exp" "$H_DIR/steps.txt" "$H_DIR/tty.txt" \
        claude --effort medium --permission-mode auto --plugin-dir "$H_DIR/deepwork-plugin" --plugin-dir "$H_DIR/toollog" \
        --debug-file "$H_DIR/debug.txt" >|"$H_DIR/drive.txt" 2>&1
    )
    printf '%s: drive exited %s\n' "$H_CASE" "$?"
    date +%s >|"$H_DIR/end"
  fi
  keep_transcripts "$H_DIR" "$H_REPO"
}

if [ "$mode" = compare ]; then
  if [ -n "${H_CHECKS:-}" ]; then
    CD=$(cd -P "$H_CHECKS" && pwd -P) || exit 2
  else
    C=${H_COMPARE:-design-compare-$(date +%Y%m%d-%H%M%S)}
    C=${C##*/}
    case $which in both) set -- litter deepwork ;; *) set -- "$which" ;; esac
    for side in "$@"; do compare_side "$side"; done
    CD=$(cd -P "$H_OUT/$C" && pwd -P) || exit 2
    [ "${H_DRY:-}" = 1 ] && { echo "$C: dry run, files in $CD"; exit 0; }
  fi
  if [ ! -d "$CD/litter/repo" ] || [ ! -d "$CD/deepwork/repo" ]; then
    echo "${CD##*/}: one side so far, in $CD; run the other with H_COMPARE=${CD##*/}"
    exit 0
  fi
  litter_texts "$CD/litter" || { echo "$0: litter's texts can't be read" >&2; exit 2; }
  deepwork_texts "$CD/deepwork" || { echo "$0: deepwork's texts can't be read" >&2; exit 2; }
  sh "$H_HERE/design-compare.sh" "$CD" >|"$CD/table.txt"
  rc=$?
  cat "$CD/table.txt"
  exit $rc
fi

# ---------------------------------------------------------------------------
# basic and drift

if [ -n "${H_CHECKS:-}" ]; then
  H_DIR=$(cd -P "$H_CHECKS" && pwd -P) || exit 2
  H_CASE=${H_DIR##*/}
  H_REPO=$H_DIR/repo
else
  # A fresh path each run: $.store keeps ledger heads by their absolute paths.
  h_scratch "design-$mode-$(date +%Y%m%d-%H%M%S)"
  cp "$LITTER_ROOT/workflows/design.js" "$H_DIR/litter/workflows/design.js" || exit 1
  cp -R "$H_FIX/design-compare/repo/." "$H_REPO/" || exit 1
  h_git -C "$H_REPO" add -A
  h_git -C "$H_REPO" commit -q -m 'the design fixture: tally' || exit 1
  [ "$mode" = drift ] && edit=1 || edit=0
  litter_steps "$H_DIR" "$H_REPO" "$edit"
  [ "${H_DRY:-}" = 1 ] && { echo "$H_CASE: dry run, files in $H_DIR"; exit 0; }
  echo "$H_CASE: driving the session in $H_REPO"
  litter_drive "$H_DIR" "$H_REPO" "$(jq -cn '{pluginConfigs: {litter: {options: {maxRounds: 2}}}}')"
  h_tool_down $?
  keep_transcripts "$H_DIR" "$H_REPO"
fi
R=$H_REPO
LD=$R/.claude/litter
LOG=$H_DIR/tool-log.jsonl
RUN=$(runs "$LD")
RD=$LD/$RUN
recs() { cat "$RD"/ledger/*.json 2>/dev/null | jq -s -c 'sort_by(.seq)'; }
last_of() { recs | jq -c --arg k "$1" '[.[] | select(.kind == $k)] | last // empty'; }
main_tool() { jq -nRc --arg t "$1" --arg e "$2" '[inputs | fromjson? | select(.agent_id == null and .tool == $t and .ev == $e)] | length' "$LOG" 2>/dev/null; }

c_run() {
  [ -n "$RUN" ] && [ -f "$RD/run.json" ] || { echo "no run in $LD"; return 1; }
  w=$(jq -r .workflow "$RD/run.json") || { echo "run.json doesn't parse"; return 1; }
  [ "$w" = design ] || { echo "the run is a $w run"; return 1; }
}
# The bar as launched: at least 6 criteria and a ban of the user's own (COMMON decision 5).
c_bar() {
  jq -e '[.args.bar[] | select(.rule == null and .rules == null) | .id] | (map(select(startswith("C"))) | length >= 6) and (map(select(startswith("B"))) | length >= 1)' \
    "$RD/run.json" >/dev/null || { echo "the bar: $(jq -c '[.args.bar[].id]' "$RD/run.json")"; return 1; }
}
# Approved and done: decision 2's done payload.
c_done() {
  e=$(last_of run.end)
  [ -n "$e" ] || { echo "no run.end"; return 1; }
  printf '%s' "$e" | jq -e '.body.status == "done" and .body.payload.outcome == "approved"' >/dev/null ||
    { echo "run.end: $(printf '%s' "$e" | jq -c '.body | {status, reason, payload}')"; return 1; }
}
c_verdict() {
  v=$(last_of run.end | jq -r '.body.payload.version // empty')
  d=$(recs | jq -c --arg v "$v" '[.[] | select(.kind == "verdict" and .body.version == $v)] | last // empty')
  [ -n "$d" ] || { echo "no verdict on '$v'"; return 1; }
  printf '%s' "$d" | jq -e '.body.overall == "APPROVED" and all(.body.criteria[]; .verdict == "PASS") and .body.source_changed == false' >/dev/null ||
    { echo "the verdict on $v: $(printf '%s' "$d" | jq -c '.body | {overall, source_changed, open: [.criteria[] | select(.verdict != "PASS") | .id]}')"; return 1; }
  [ -f "$RD/verdicts/$v.md" ] || { echo "no verdicts/$v.md"; return 1; }
}
# design.deliver after run.end, and plan.md the approved proposal's bytes.
c_deliver() {
  d=$(last_of design.deliver)
  [ -n "$d" ] || { echo "no design.deliver"; return 1; }
  v=$(printf '%s' "$d" | jq -r '.body.version // empty')
  p=$(printf '%s' "$d" | jq -r '.body.path // empty')
  [ -n "$p" ] || { echo "refused: $(printf '%s' "$d" | jq -r '.body.refused')"; return 1; }
  [ "$p" = "$RD/plan.md" ] || { echo "delivered to $p, not $RD/plan.md"; return 1; }
  cmp -s "$RD/plan.md" "$RD/proposals/$v.md" || { echo "plan.md isn't proposals/$v.md's bytes"; return 1; }
  s=$(shasum -a 256 "$RD/plan.md" | cut -d' ' -f1)
  [ "$s" = "$(printf '%s' "$d" | jq -r .body.sha256)" ] || { echo "plan.md's sha256 is $s, the record's $(printf '%s' "$d" | jq -r .body.sha256)"; return 1; }
  es=$(last_of run.end | jq -r .seq)
  ds=$(printf '%s' "$d" | jq -r .seq)
  [ "$ds" -gt "$es" ] || { echo "design.deliver (seq $ds) before run.end (seq $es)"; return 1; }
}
# summary.ts's Stop and Delivery lines.
c_summary() {
  [ -f "$RD/summary.md" ] || { echo "no summary.md"; return 1; }
  stop=$(awk '/^## Stop$/ { on = 1; next } /^## / { on = 0 } on && NF' "$RD/summary.md")
  dl=$(awk '/^## Delivery$/ { on = 1; next } /^## / { on = 0 } on && NF' "$RD/summary.md")
  case $1 in
  approved)
    case $stop in Approved:*) ;; *) echo "Stop: ${stop:-none}"; return 1 ;; esac
    case $dl in Delivered:*) ;; *) echo "Delivery: ${dl:-none}"; return 1 ;; esac
    ;;
  drift)
    case $stop in *'(source-changed)'*) ;; *) echo "Stop: ${stop:-none}"; return 1 ;; esac
    case $dl in 'Not delivered:'*) ;; *) echo "Delivery: ${dl:-none}"; return 1 ;; esac
    ;;
  esac
}
# Plan mode: entered, ExitPlanMode answered, and the plan it put up for review is
# plan.md's bytes. That plan is the plan file as ExitPlanMode read it, however the
# skill wrote the file (design.sh basic, 2026-10-04: it copied plan.md with cp).
c_planmode() {
  [ "$(main_tool EnterPlanMode PostToolUse)" -ge 1 ] || { echo "EnterPlanMode never returned (pre: $(main_tool EnterPlanMode PreToolUse))"; return 1; }
  [ "$(main_tool ExitPlanMode PostToolUse)" -ge 1 ] || { echo "ExitPlanMode never returned (pre: $(main_tool ExitPlanMode PreToolUse), failed: $(main_tool ExitPlanMode PostToolUseFailure))"; return 1; }
  jq -nRj '[inputs | fromjson? | select(.agent_id == null and .tool == "ExitPlanMode" and .ev == "PreToolUse") | .input.plan // empty] | last // empty' "$LOG" >|"$H_DIR/reviewed.md"
  cmp -s "$H_DIR/reviewed.md" "$RD/plan.md" || { echo "the plan ExitPlanMode put up isn't plan.md's bytes ($(wc -c <"$H_DIR/reviewed.md" | tr -d ' ') bytes against $(wc -c <"$RD/plan.md" | tr -d ' '))"; return 1; }
}
c_no_planmode() {
  n=$(($(main_tool EnterPlanMode PreToolUse) + $(main_tool ExitPlanMode PreToolUse)))
  [ "$n" = 0 ] || { echo "$n plan-mode calls"; return 1; }
}
# A probe names its unknown and gives a verdict (decision 18); a prober never works in the checkout.
c_probes() {
  recs | jq -e 'all(.[] | select(.kind == "probe"); (.body.unknown_id | test("^U[1-9][0-9]*$")) and (.body.verdict | IN("confirmed", "refuted", "untested")))' >/dev/null ||
    { echo "probes: $(recs | jq -c '[.[] | select(.kind == "probe") | .body | {unknown_id, verdict}]')"; return 1; }
  cw=$(jq -nRr --arg r "$R" 'inputs | fromjson? | select(.ev == "SubagentStart" and ((.agent_type // "") | endswith("prober"))) | select(.cwd == $r) | .cwd' "$LOG" 2>/dev/null)
  [ -z "$cw" ] || { echo "a prober started in the checkout"; return 1; }
}
# The roles only read: nothing tracked changed, nothing new outside .claude/ (drift's own edit aside).
c_tree() {
  st=$(git -C "$R" status --porcelain --untracked-files=all | grep -v '^?? \.claude/' | grep -v "$1")
  [ -z "$st" ] || { echo "the checkout changed: $(printf '%s' "$st" | tr '\n' ';')"; return 1; }
}
c_lock_free() {
  git -C "$R" rev-parse -q --verify refs/litter-active >/dev/null && { echo "refs/litter-active is still held"; return 1; }
  [ ! -f "$LD/hooks/policy.json" ] && return 0
  r=$(jq -r '.run // "none"' "$LD/hooks/policy.json") || { echo "policy.json doesn't parse"; return 1; }
  [ "$r" = none ] || { echo "policy.json still has run $r"; return 1; }
}
c_one_run() {
  n=$(ls "$LD" 2>/dev/null | grep -cE '^[0-9]{8}-')
  [ "$n" = 1 ] || { echo "$n runs: the skill started another"; return 1; }
}
c_edited() { [ -f "$H_DIR/edited" ] || { echo "the steps never made their edit (no investigator report before the run ended?)"; return 1; }; }
c_source_changed() {
  recs | jq -e 'any(.[]; .kind == "verdict" and .body.source_changed == true)' >/dev/null ||
    { echo "no verdict with source_changed: $(recs | jq -c '[.[] | select(.kind == "verdict") | .body | {version, source_changed}]')"; return 1; }
  last_of run.end | jq -e '.body.status == "halted" and .body.reason == "source-changed"' >/dev/null ||
    { echo "run.end: $(last_of run.end | jq -c '.body | {status, reason}')"; return 1; }
}
c_refused() {
  last_of design.deliver | jq -e '.body.refused != null and .body.path == null' >/dev/null ||
    { echo "design.deliver: $(last_of design.deliver | jq -c .body)"; return 1; }
  [ ! -f "$RD/plan.md" ] || { echo "plan.md was written"; return 1; }
}

# What the run says, reported and not scored: the unknowns as they arrived, the versions, the probes, the stop.
# The run.start record keeps no unknowns; run.json's args holds them as the run took them.
if [ -n "$RUN" ]; then
  u=$(jq -r '.args.empiricalUnknowns // [] | map(type) | unique | join(",")' "$RD/run.json" 2>/dev/null)
  recs | jq -r --arg u "$u" '"the unknowns arrived as: \(if $u == "" then "none" else $u end); versions \([.[] | select(.kind == "proposal")] | length); verdicts \([.[] | select(.kind == "verdict")] | length); probes \([.[] | select(.kind == "probe")] | length)"'
fi
h_expect "a design run was launched" c_run
h_expect "its bar has 6 criteria and a ban of the user's own" c_bar
h_expect "no lock is left held" c_lock_free
h_expect "the skill started no other run" c_one_run
h_expect "each probe names its unknown and a verdict, and no prober worked in the checkout" c_probes
if [ "$mode" = basic ]; then
  h_expect "the run ended done, approved" c_done
  h_expect "the latest verdict approves every item, the checkout unchanged" c_verdict
  h_expect "design.deliver followed run.end, and plan.md is the approved proposal's bytes" c_deliver
  h_expect "summary.md: Stop says approved, Delivery says delivered" c_summary approved
  h_expect "plan mode: entered, plan.md's bytes written to the plan file, ExitPlanMode answered" c_planmode
  h_expect "the roles left the checkout as it was" c_tree '^$'
else
  h_expect "the steps changed lib/amount.sh mid-round" c_edited
  h_expect "a verdict saw the change, and the run halted source-changed" c_source_changed
  h_expect "nothing was delivered" c_refused
  h_expect "summary.md: Stop says source-changed, Delivery says not delivered" c_summary drift
  h_expect "plan mode wasn't used" c_no_planmode
  h_expect "the roles left the checkout as it was, but the steps' edit" c_tree ' lib/amount\.sh$'
fi
h_done
