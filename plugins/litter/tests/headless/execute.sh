#!/bin/sh
# Tier 4: phase 3's execute runs (WP-T4's T4-4 and T4-3), on the real
# workflows/execute.js.
#
#   sh tests/headless/execute.sh basic         # a two-gate plan lands gate by gate, headless; /litter-board then shows both landed
#   sh tests/headless/execute.sh bridge auto   # G2 halts on a gap the plan's contract settles; a plan-template swarm lands G2 and G3
#   sh tests/headless/execute.sh bridge off    # the same halt under repair: off stops, keeps the attempt and offers the routes
#
# basic: lib.sh's repo (HEAD ahead of origin/main) plus fixtures/execute-basic:
# lib/math.sh with add and sub, test.sh running every tests/test_*.sh, and a
# two-gate plan.md, each gate adding one function and its test. One headless
# session records run.start (repair: off) and launches litter:execute with
# its args, as land.sh does, with the verify and trailers options set. Then
# an interactive session types /litter-board <run>, and its screen must show
# both gates landed.
#
# bridge: fixtures/execute-bridge: lib/greet.sh, tests/expected.txt holding
# "Hello, world", and test.sh comparing greet's output with it. plan.md's
# preamble holds the contract "every output string follows
# tests/expected.txt", and G2's Done when says greet prints "Hello, World": a
# gap the plan's own contract settles. G1 and G3 are plain, and run.start sets
# maxAttempts: 1, so generation 1 should halt at G2, on a plan gap or on its
# one attempt. Under auto the bridge opens generation 2 with no ask, and the
# plan-template swarm starts on the lead's next turn and lands G2 and G3;
# once G3 has landed the session ends the swarm (if the lead hasn't). Under
# off nothing starts, the attempt stays in the tree, and summary.md offers
# the routes. Interactive through drive.exp, as repair.sh, since the swarm
# starts on the lead's next turn.
#
# The bridge case is valid only if generation 1 halts at G2 that way. If G2
# landed in generation 1, or generation 1 halted at G2 before any verdict on
# it (the executor blocked, or returned nothing: a halt the bridge declines by
# design), it prints INCONCLUSIVE and exits 3: run it again, and count it as
# neither a pass nor a fail.
#
# H_DRY=1 stops once the repo and the steps are made, with no session.
# H_CHECKS=<case folder> skips the repo and the session and runs the checks
# on a folder an earlier run left in $H_OUT. Needs expect. EXECUTE_MODEL sets
# the sessions' model (--model).

set -u
. "$(dirname "$0")/lib.sh"

usage() { echo "usage: $0 basic | bridge auto|off" >&2; exit 2; }
mode=${1:-basic}
repair=${2:-}
case $mode in
basic) [ -z "$repair" ] || usage ;;
bridge) case $repair in auto | off) ;; *) usage ;; esac ;;
*) usage ;;
esac
[ -n "${H_CHECKS:-}" ] || command -v expect >/dev/null || { echo "$0: needs expect" >&2; exit 2; }

if [ -n "${H_CHECKS:-}" ]; then
  H_DIR=$(cd -P "$H_CHECKS" && pwd -P) || exit 2
  H_CASE=${H_DIR##*/}
  H_REPO=$H_DIR/repo
else
  # A fresh path each run: $.store keeps ledger heads by their absolute paths.
  h_scratch "execute-$mode${repair:+-$repair}-$(date +%Y%m%d-%H%M%S)"
  cp "$LITTER_ROOT/workflows/execute.js" "$H_DIR/litter/workflows/execute.js" || exit 1
  cp -R "$H_FIX/execute-$mode/." "$H_REPO/" || exit 1
  h_git -C "$H_REPO" add -A
  h_git -C "$H_REPO" commit -q -m "the $mode fixture: its code, test.sh and plan.md" || exit 1
fi
R=$H_REPO
LD=$R/.claude/litter
SETTINGS=$(jq -cn --arg m "$mode" '{pluginConfigs: {litter: {options: ({verify: ["sh", "test.sh"]}
  + if $m == "basic" then {trailers: ["Co-Authored-By: tier4 <tier4@example.invalid>"]} else {summaryModel: "haiku"} end)}}}') || exit 1

runs() { ls "$LD" 2>/dev/null | grep -E '^[0-9]{8}-' | head -n 1; }
# The terminal log as text: a cursor-forward move as a space; every other
# escape (CSI, OSC, charset, two-byte) and each carriage return dropped.
screen() {
  e=$(printf '\033')
  b=$(printf '\007')
  LC_ALL=C sed -e "s#${e}\[[0-9]*C# #g" -e "s#${e}\[[0-9:;<=>?]*[ -/]*[@-~]##g" -e "s#${e}][^${b}${e}]*${b}##g" \
    -e "s#${e}][^${b}${e}]*${e}[\\\\]##g" -e "s#${e}[()][A-Za-z0-9]##g" -e "s#${e}[^][]##g" "$1" | tr -d '\r'
}
c_lock_free() {
  git -C "$R" rev-parse -q --verify refs/litter-active >/dev/null && { echo "refs/litter-active is still held"; return 1; }
  [ ! -f "$LD/hooks/policy.json" ] && return 0
  r=$(jq -r '.run // "none"' "$LD/hooks/policy.json") || { echo "policy.json doesn't parse"; return 1; }
  [ "$r" = none ] || { echo "policy.json still has run $r"; return 1; }
}

# ---------------------------------------------------------------------------
# basic (T4-4)

if [ "$mode" = basic ]; then
  [ "${H_DRY:-}" = 1 ] && { echo "$H_CASE: dry run, files in $H_DIR"; exit 0; }
  if [ -z "${H_CHECKS:-}" ]; then
    START=$(jq -cn '{kind: "run.start", workflow: "execute", authorized: ["tier-4 execute probe"], planPath: "plan.md", repair: "off"}') || exit 1
    PROMPT="You are running a scripted test. Do exactly these steps, in order, and nothing else.
1. Call mcp__litter__record with exactly this input: $START
2. Call the Workflow tool with name \"litter:execute\" and args set to the args object step 1 returned, unchanged.
3. Wait for the workflow task notification. Then reply with each step result and the workflow result, verbatim.
If a step is refused, note the refusal verbatim and stop."
    # shellcheck disable=SC2086
    h_claude "$PROMPT" ${EXECUTE_MODEL:+--model "$EXECUTE_MODEL"} --settings "$SETTINGS" \
      --allowedTools mcp__litter__record Workflow Read Glob Grep Write Edit 'Bash(git:*)' 'Bash(sh:*)' 'Bash(cat:*)' 'Bash(ls:*)'

    # Then the board, interactive: hooks/mode is rewritten by the new session's first prompt (watch.sh), so its reply has begun.
    BRUN=$(runs)
    rm -f "$LD/hooks/mode"
    cat >|"$H_DIR/board-steps.txt" <<EOF
until [ -f $LD/hooks/mode ]
sleep 10
send /litter-board $BRUN
sleep 15
exit
EOF
    echo "$H_CASE: opening the board in $R"
    (
      cd "$R" || exit 1
      # shellcheck disable=SC2086
      expect "$H_HERE/drive.exp" "$H_DIR/board-steps.txt" "$H_DIR/tty.txt" claude ${EXECUTE_MODEL:+--model "$EXECUTE_MODEL"} \
        --settings "$SETTINGS" --plugin-dir "$H_DIR/litter" --plugin-dir "$H_DIR/toollog" --debug-file "$H_DIR/board-debug.txt" \
        'Reply with the single word ready, and nothing else.' >|"$H_DIR/drive.txt" 2>&1
    )
    printf '%s: drive exited %s\n' "$H_CASE" "$?"
  fi

  RUN=$(runs)
  RD=$LD/$RUN
  ledger() { cat "$RD"/ledger/*-"$1".json 2>/dev/null; }

  c_run() { [ -n "$RUN" ] && [ -f "$RD/run.json" ] || { echo "no run in $LD"; return 1; }; }
  c_done() {
    s=$(ledger run.end | jq -s -r 'map(.body.status) | last // "none"') || { echo "a run.end record doesn't parse"; return 1; }
    [ "$s" = done ] || { echo "the run ended '$s', not done"; return 1; }
  }
  # Each gate's land, in order on litter/<run> from base, with the trailers land.ts's commitMessage writes (Litter-Run: <run> <gate> <verify_id>, then run.json's trailers).
  c_lands() {
    base=$(jq -r .base "$RD/run.json") || { echo "run.json doesn't parse"; return 1; }
    want=$(ledger land | jq -s -r 'sort_by(.seq) | map("\(.body.gate) \(.body.commit) \(.body.verify_id)") | .[]') || { echo "a land record doesn't parse"; return 1; }
    [ "$(printf '%s\n' "$want" | cut -d' ' -f1 | tr '\n' ' ')" = 'G1 G2 ' ] || { echo "the lands are for '$(printf '%s' "$want" | cut -d' ' -f1 | tr '\n' ' ')', not G1 then G2"; return 1; }
    got=$(git -C "$R" rev-list --reverse "$base..refs/heads/litter/$RUN" 2>&1) || { echo "litter/$RUN can't be listed: $got"; return 1; }
    [ "$got" = "$(printf '%s\n' "$want" | cut -d' ' -f2)" ] || { echo "litter/$RUN holds [$(echo $got)] past base, the lands are [$(printf '%s\n' "$want" | cut -d' ' -f2 | tr '\n' ' ')]"; return 1; }
    printf '%s\n' "$want" | while read -r g c v; do
      t=$(git -C "$R" log -1 --format='%(trailers:key=Litter-Run,valueonly)' "$c")
      [ "$t" = "$RUN $g $v" ] || { echo "$g's commit $c has Litter-Run '$t', not '$RUN $g $v'"; exit 1; }
      a=$(git -C "$R" log -1 --format='%(trailers:key=Co-Authored-By,valueonly)' "$c")
      [ "$a" = 'tier4 <tier4@example.invalid>' ] || { echo "$g's commit $c has Co-Authored-By '$a', not the trailers option's"; exit 1; }
    done
  }
  # execsummary.ts's Attempts part: "- G1 (<title>): N attempt(s); the last verdict (attempt k) …: <runDir>/verdicts/G1-k.md".
  c_summary() {
    [ -f "$RD/summary.md" ] || { echo "no summary.md"; return 1; }
    part=$(awk '/^## Attempts$/ { on = 1; next } /^## / { on = 0 } on' "$RD/summary.md")
    for g in G1 G2; do
      line=$(printf '%s\n' "$part" | grep "^- $g[ :]")
      case $line in *' attempt'*) ;; *) echo "summary.md's Attempts part has no attempts for $g: '${line:-no line}'"; return 1 ;; esac
      f=${line##*: }
      case $f in */verdicts/$g-*.md) ;; *) echo "summary.md's line for $g names no verdict file: '$line'"; return 1 ;; esac
      [ -f "$f" ] || { echo "summary.md names $f for $g, which isn't there"; return 1; }
    done
  }
  # verdicts.ts's renderVerdict: "- Verdict: approved" and "## <dimension>: pass" for each of the four.
  c_verdict_files() {
    for g in G1 G2; do
      f=$RD/verdicts/$g-1.md
      [ -f "$f" ] || { echo "no $f"; return 1; }
      grep -qx -- '- Verdict: approved' "$f" || { echo "$g-1.md: $(grep -- '^- Verdict:' "$f")"; return 1; }
      for d in plan_adherence tests_green no_regressions rules; do
        grep -qx "## $d: pass" "$f" || { echo "$g-1.md: $(grep "^## $d:" "$f" || echo "no $d")"; return 1; }
      done
    done
  }
  c_no_rules() {
    r=$(jq -c .rules "$RD/run.json") || { echo "run.json doesn't parse"; return 1; }
    [ "$r" = '[]' ] || { echo "run.json's rules are $r"; return 1; }
  }
  c_no_worktree() {
    n=$(git -C "$R" worktree list --porcelain | grep -c '^worktree ')
    [ "$n" = 1 ] || { echo "$n worktrees: $(git -C "$R" worktree list | tr '\n' ';')"; return 1; }
    [ -z "$(ls "$R/.claude/worktrees" 2>/dev/null)" ] || { echo ".claude/worktrees holds $(ls "$R/.claude/worktrees" | tr '\n' ' ')"; return 1; }
  }
  # board/gates.tsx draws a row as the gate id, then "✓ landed".
  c_board() {
    [ -f "$H_DIR/tty.txt" ] || { echo "no tty.txt: the board session didn't run"; return 1; }
    s=$(screen "$H_DIR/tty.txt")
    for g in G1 G2; do
      printf '%s\n' "$s" | LC_ALL=C grep -Eq "$g[[:space:]]*(✓[[:space:]]*)?landed" || { echo "the board shows no $g row landed (tty.txt)"; return 1; }
    done
  }

  h_expect "run.start and the launch made a run" c_run
  h_expect "the run ended done" c_done
  h_expect "G1 then G2 landed on litter/<run>, each commit with its Litter-Run trailer and the trailers option's line" c_lands
  h_expect "summary.md lists both gates with their attempts and verdict files" c_summary
  h_expect "verdicts/G1-1.md and verdicts/G2-1.md pass all four dimensions" c_verdict_files
  h_expect "run.json's rules are []" c_no_rules
  h_expect "no worktree was left behind" c_no_worktree
  h_expect "the lock is released" c_lock_free
  h_expect "/litter-board <run> shows both gates landed" c_board
  h_done
  exit
fi

# ---------------------------------------------------------------------------
# bridge (T4-3)

# Generation 1's ending at G2, from the run's records (slurped), the way
# repair.ts's classifyExecute reads it: a verdict's gate is its own `gate`
# (a plan-template one's) or its cited verify's (an execute critic's).
#   landed     G2 landed in generation 1: INCONCLUSIVE
#   noverdict  it halted at G2 with no verdict on G2 (blocked, or nothing returned): INCONCLUSIVE
#   gap        G2's latest verdict names a plan gap
#   attempts   G2 has $max verdicts and no land
#   none, status, nog1, other: not the halt the case needs
cat >|"$H_DIR/gen1.jq" <<'EOF'
sort_by(.seq) as $r
| ([$r[] | select(.kind == "verify" and (.body.verify_id | type) == "string") | {key: .body.verify_id, value: .body.gate}] | from_entries) as $vg
| ([$r[] | select(.kind == "run.end")] | first) as $e1
| if $e1 == null then "none"
  else [$r[] | select(.seq < $e1.seq)] as $g1
  | if any($g1[]; .kind == "land" and .body.gate == "G2") then "landed"
    elif $e1.body.status != "halted" then "status"
    elif (any($g1[]; .kind == "land" and .body.gate == "G1") | not) then "nog1"
    else [$g1[] | select(.kind == "verdict" and ((.body.gate // $vg[.body.verify_id // ""]) == "G2"))] as $v
    | if ($v | length) == 0 then "noverdict"
      elif (($v | last | .body.plan_gap // "") | test("\\S")) then "gap"
      elif ($v | length) >= $max then "attempts"
      else "other" end
    end
  end
EOF

# The steps' waits (drive.exp runs each until it exits 0). Each also ends once
# nothing more can come: generation 1 not the halt the case needs, the bridge
# declined, or generation 2 ended.
if [ -z "${H_CHECKS:-}" ]; then
  cat >|"$H_DIR/until.sh" <<EOF
#!/bin/sh
# The waits of $H_CASE's steps: sh until.sh <what> exits 0 once it holds.
LD=$LD
GEN1=$H_DIR/gen1.jq
EOF
  cat >>"$H_DIR/until.sh" <<'EOF'
rd=$(ls -d "$LD"/2*/ 2>/dev/null | head -n 1)
rd=${rd%/}
[ -n "$rd" ] || exit 1
records() { cat "$rd"/ledger/*.json 2>/dev/null | jq -s 'sort_by(.seq)'; }
over() {
  w=$(records | jq -r --argjson max 1 -f "$GEN1") || return 1
  case $w in gap | attempts) ;; none) return 1 ;; *) return 0 ;; esac
  ls "$rd"/ledger/*-repair.declined.json >/dev/null 2>&1 && return 0
  records | jq -e '[.[] | select(.kind == "run.end")] | length >= 2' >/dev/null
}
case $1 in
ended1) ls "$rd"/ledger/*-run.end.json >/dev/null 2>&1 ;;
landed3) over || records | jq -e '(map(select(.kind == "run.repair")) | first | .seq) as $s | $s != null and any(.[]; .kind == "land" and .body.gate == "G3" and .seq > $s)' >/dev/null ;;
swarm_ended) over || ls "$LD"/swarms/repair-*/launches/*/ledger/*-swarm.end.json >/dev/null 2>&1 ;;
ends2) over ;;
*) exit 2 ;;
esac
EOF

  # Under auto, once G3 has landed: the end command, unless the swarm has ended (scratch paths hold no spaces or quotes).
  end_cmd="[ -d $LD/swarms ] && ! ls $LD/swarms/repair-*/launches/*/ledger/*-swarm.end.json >/dev/null 2>&1 && for d in $LD/swarms/repair-*; do echo \"/litter:swarm end \${d##*/}\"; done"
  if [ "$repair" = auto ]; then
    cat >|"$H_DIR/steps.txt" <<EOF
# The first prompt starts the run. Generation 1 halts at G2: a plan gap, or its one attempt rejected.
wait 2400 sh $H_DIR/until.sh ended1
# The bridge opens generation 2, and the plan-template swarm runs on the lead's next turns until G3 lands.
wait 3600 sh $H_DIR/until.sh landed3
# The lead ends the swarm on the gate-runner's report; if it hasn't, the session says to.
wait 600 sh $H_DIR/until.sh swarm_ended
sendsh $end_cmd
wait 900 sh $H_DIR/until.sh ends2
sleep 20
exit
EOF
  else
    cat >|"$H_DIR/steps.txt" <<EOF
wait 2400 sh $H_DIR/until.sh ended1
# Long enough for a bridge that wrongly started anything to have made its swarm.
sleep 90
exit
EOF
  fi
fi

[ "${H_DRY:-}" = 1 ] && { echo "$H_CASE: dry run, files in $H_DIR"; exit 0; }

if [ -z "${H_CHECKS:-}" ]; then
  START=$(jq -cn --arg m "$repair" '{kind: "run.start", workflow: "execute", authorized: ["tier-4 bridge probe"], planPath: "plan.md", maxAttempts: 1, repair: $m}') || exit 1
  FIRST="You are running a scripted test. Do exactly these steps, in order.
1. Call mcp__litter__record with exactly this input: $START
2. Call the Workflow tool with name \"litter:execute\" and args set to the args object step 1 returned, unchanged.
3. Wait for the workflow task notification, then reply with each step result and the workflow result, verbatim.
After that, if litter starts a repair swarm, follow the litter swarm skill for it, and don't push anything."
  echo "$H_CASE: driving the session in $R"
  (
    cd "$R" || exit 1
    # Auto mode, as repair.sh: the classifier answers the lead's and the nodes' asks, and the swarm's start needs no ask.
    # shellcheck disable=SC2086
    H_DRIVE_MAX=${H_DRIVE_MAX:-7200} LITTER_TIER4_GUARD=$H_DIR/litter/hooks/guard.sh expect "$H_HERE/drive.exp" "$H_DIR/steps.txt" "$H_DIR/tty.txt" \
      claude ${EXECUTE_MODEL:+--model "$EXECUTE_MODEL"} --permission-mode auto --settings "$SETTINGS" \
      --allowedTools ToolSearch Agent Workflow Read Glob Grep Write Edit mcp__litter__record mcp__litter__swarm_read \
      mcp__litter__swarm_propose mcp__litter__swarm_send 'Bash(git:*)' 'Bash(sh:*)' 'Bash(cat:*)' 'Bash(ls:*)' \
      --plugin-dir "$H_DIR/litter" --plugin-dir "$H_DIR/toollog" --debug-file "$H_DIR/debug.txt" "$FIRST" >|"$H_DIR/drive.txt" 2>&1
  )
  printf '%s: drive exited %s\n' "$H_CASE" "$?"
fi

RUN=$(runs)
RD=$LD/$RUN
ledger() { cat "$RD"/ledger/*-"$1".json 2>/dev/null; }
records() { cat "$RD"/ledger/*.json 2>/dev/null | jq -s 'sort_by(.seq)'; }
swarm_dir() { ls -d "$LD"/swarms/repair-* 2>/dev/null | head -n 1; }
sledger() { cat "$(swarm_dir)"/launches/*/ledger/*-"$1".json 2>/dev/null; }
tip() { git -C "$R" rev-parse -q --verify "refs/heads/litter/$RUN"; }
# The seq of the run.repair that opened generation 2: everything after it is the swarm's.
repair_seq() { ledger run.repair | jq -s -r 'map(.seq) | first // empty'; }
# The agents a node of the swarm was bound as, from its launch ledger's swarm.node records: a JSON list.
agents_of() { sledger swarm.node | jq -s -c --arg n "$1" '[.[] | select(.body.node == $n) | .body.agentId] | unique'; }

max=$(jq -r '.args.maxAttempts // 3' "$RD/run.json" 2>/dev/null) || max=3
gen1=$(records | jq -r --argjson max "${max:-3}" -f "$H_DIR/gen1.jq") || gen1=unreadable
end1() { ledger run.end | jq -s -r 'sort_by(.seq) | first | "\(.body.status): \(.body.reason // "no reason")"'; }
case $gen1 in
landed)
  echo 'INCONCLUSIVE: G2 landed in generation 1'
  echo "$H_CASE: run it again; this run is neither a pass nor a fail (files in $H_DIR)"
  exit 3
  ;;
noverdict)
  echo "INCONCLUSIVE: generation 1 halted at G2 with no verdict on it ($(end1))"
  echo "$H_CASE: a halt the bridge declines by design; run it again (files in $H_DIR)"
  exit 3
  ;;
esac

c_run() { [ -n "$RUN" ] && [ -f "$RD/run.json" ] || { echo "no run in $LD"; return 1; }; }
c_setting() {
  s=$(jq -r '"\(.repair.mode // "unset") \(.args.maxAttempts // "unset")"' "$RD/run.json") || { echo "run.json doesn't parse"; return 1; }
  [ "$s" = "$repair 1" ] || { echo "run.json's repair mode and maxAttempts are '$s', not '$repair 1'"; return 1; }
}
c_gen1() {
  case $gen1 in
  gap | attempts) return 0 ;;
  none) echo "the run never ended" ;;
  status) echo "generation 1 ended $(end1), not halted" ;;
  nog1) echo "G1 didn't land in generation 1 ($(end1))" ;;
  other) echo "generation 1 halted at G2 with fewer than $max verdicts and no plan gap ($(end1))" ;;
  *) echo "the run's ledger couldn't be read" ;;
  esac
  return 1
}
# The tool log holds the lead's asks and the mod's $.ui.ask (an AskUserQuestion call too).
c_no_ask() {
  [ -f "$H_DIR/tool-log.jsonl" ] || { echo "no tool-log.jsonl"; return 1; }
  n=$(jq -s '[.[] | select(.ev == "PreToolUse" and .tool == "AskUserQuestion")] | length' "$H_DIR/tool-log.jsonl") || { echo "tool-log.jsonl doesn't parse"; return 1; }
  [ "$n" = 0 ] || { echo "$n AskUserQuestion call(s) after the launch"; return 1; }
}
# repair.ts's planSpecOf: the swarm repair-<hex>, its orchestrator `runner` in the run's checkout (worktree existing: json.checkout).
c_repair_opened() {
  g=$(ledger run.repair | jq -s -r 'map(.body.generation) | first // "none"') || { echo "run.repair doesn't parse"; return 1; }
  [ "$g" = 2 ] || { echo "no run.repair opening generation 2 (got '$g')"; return 1; }
  [ -n "$(swarm_dir)" ] || { echo "no swarms/repair-* folder"; return 1; }
  c=$(sledger swarm.start | jq -s -r 'map(.body.confirmedBy.run // empty) | first // empty') || { echo "swarm.start doesn't parse"; return 1; }
  [ "$c" = "$RUN" ] || { echo "the swarm's swarm.start is confirmed by '${c:-nothing}', not run $RUN"; return 1; }
  cwd=$(sledger swarm.node | jq -s -r 'map(select(.body.node == "runner" and .body.kind == "orchestrator") | .body.cwd) | first // empty') || { echo "swarm.node doesn't parse"; return 1; }
  [ -n "$cwd" ] || { echo "the gate-runner never spawned"; return 1; }
  co=$(jq -r .checkout "$RD/run.json") || { echo "run.json doesn't parse"; return 1; }
  [ "$(cd -P "$cwd" 2>/dev/null && pwd -P)" = "$(cd -P "$co" 2>/dev/null && pwd -P)" ] || { echo "the gate-runner ran in $cwd, not the run's checkout $co"; return 1; }
}
# Generation 2's verdicts (swarm/gate.ts, planJudged): each a plan gate's, with `gate` and `approved`, by a critic node's agent.
# Its verifies (planVerify, decision 15): numbered past every earlier verify of their gate, none repeated.
c_plan_verdicts() {
  rs=$(repair_seq) || return 1
  [ -n "$rs" ] || { echo "no run.repair"; return 1; }
  critics=$(agents_of critic) || { echo "swarm.node doesn't parse"; return 1; }
  [ "$critics" != '[]' ] || { echo "no critic node was bound"; return 1; }
  n=$(records | jq --argjson rs "$rs" '[.[] | select(.seq > $rs and .kind == "verdict")] | length') || { echo "the run's ledger doesn't parse"; return 1; }
  [ "$n" -ge 2 ] || { echo "generation 2 recorded $n verdict(s), fewer than one each for G2 and G3"; return 1; }
  bad=$(records | jq -r --argjson rs "$rs" --argjson c "$critics" '.[] | select(.seq > $rs and .kind == "verdict")
    | select((.body.gate == "G2" or .body.gate == "G3" | not) or (.body.approved | type) != "boolean" or (.by.agentId as $a | any($c[]; . == $a) | not))
    | "seq \(.seq): gate \(.body.gate), approved \(.body.approved), by \(.by.agentId // .by.source)"') || { echo "the run's ledger doesn't parse"; return 1; }
  [ -z "$bad" ] || { echo "generation 2 verdicts that aren't a critic node's plan-gate verdict: $bad"; return 1; }
  bad=$(records | jq -r --argjson rs "$rs" '[.[] | select(.kind == "verify" and (.body.gate == "G2" or .body.gate == "G3"))] as $v
    | ($v | map(select(.seq < $rs))) as $old | ($v | map(select(.seq > $rs))) as $new
    | (if ($new | map(.body.gate) | unique) != ["G2", "G3"] then "generation 2 verified \($new | map(.body.gate) | unique), not G2 and G3" else empty end),
      ($new | group_by([.body.gate, .body.attempt]) | map(select(length > 1) | "\(.[0].body.gate) attempt \(.[0].body.attempt) twice") | .[]),
      ($new[] | . as $x | ([$old[] | select(.body.gate == $x.body.gate) | .body.attempt] | max // 0) as $m
        | select($x.body.attempt <= $m) | "\($x.body.gate) attempt \($x.body.attempt), not past generation 1'"'"'s \($m)")') || { echo "the run's ledger doesn't parse"; return 1; }
  [ -z "$bad" ] || { echo "$bad"; return 1; }
}
# G2 and G3 land in generation 2 through the runner's land (its launch ledger's gate event, swarm/gate.ts's mirror), with their Litter-Run
# trailers, each on an approving verdict by a critic node's agent, never the executor's; the tip keeps the contract and test.sh passes.
c_landed() {
  rs=$(repair_seq) || return 1
  [ -n "$rs" ] || { echo "no run.repair"; return 1; }
  critics=$(agents_of critic) || { echo "swarm.node doesn't parse"; return 1; }
  executors=$(agents_of executor) || { echo "swarm.node doesn't parse"; return 1; }
  last=
  for g in G2 G3; do
    l=$(records | jq -r --arg g "$g" --argjson rs "$rs" 'map(select(.kind == "land" and .body.gate == $g and .seq > $rs)) | first | if . == null then "" else "\(.body.commit) \(.body.verify_id)" end') ||
      { echo "the run's ledger doesn't parse"; return 1; }
    [ -n "$l" ] || { echo "$g has no land in generation 2"; return 1; }
    c=${l%% *}
    v=${l#* }
    e=$(sledger swarm.event | jq -s -r --arg g "$g" --arg v "$v" 'map(.body | select(.kind == "gate" and .record == "land" and .result == "landed" and .gate == $g and .verify_id == $v) | .node) | first // empty') ||
      { echo "swarm.event doesn't parse"; return 1; }
    [ "$e" = runner ] || { echo "$g's land isn't the gate-runner's (its gate event names '${e:-no node}')"; return 1; }
    t=$(git -C "$R" log -1 --format='%(trailers:key=Litter-Run,valueonly)' "$c")
    [ "$t" = "$RUN $g $v" ] || { echo "$g's commit $c has Litter-Run '$t', not '$RUN $g $v'"; return 1; }
    by=$(records | jq -r --arg v "$v" --argjson rs "$rs" 'map(select(.kind == "verdict" and .seq > $rs and .body.verify_id == $v and .body.approved == true) | .by.agentId // "") | first // empty') ||
      { echo "the run's ledger doesn't parse"; return 1; }
    [ -n "$by" ] || { echo "$g's land cites $v, which no approving verdict of generation 2 judges"; return 1; }
    printf '%s' "$executors" | jq -e --arg a "$by" 'any(.[]; . == $a) | not' >/dev/null || { echo "$g's land follows a verdict by the executor node ($by)"; return 1; }
    printf '%s' "$critics" | jq -e --arg a "$by" 'any(.[]; . == $a)' >/dev/null || { echo "$g's land follows a verdict by $by, not a critic node's agent"; return 1; }
    last=$c
  done
  [ "$(tip)" = "$last" ] || { echo "litter/$RUN is at $(tip), not G3's land $last"; return 1; }
  [ "$(git -C "$R" show "$last:tests/expected.txt")" = 'Hello, world' ] || { echo "the landed tests/expected.txt isn't 'Hello, world'"; return 1; }
  out=$(cd "$R" && sh test.sh 2>&1) || { echo "test.sh fails in the checkout after the lands: $out"; return 1; }
}
c_gen2_done() {
  s=$(records | jq -r '(map(select(.kind == "land" and .body.gate == "G3")) | first | .seq // infinite) as $l
    | map(select(.kind == "run.end" and .body.generation == 2)) | first | if . == null then "none" elif .seq > $l then .body.status else "before G3 landed: \(.body.status)" end') ||
    { echo "the run's ledger doesn't parse"; return 1; }
  [ "$s" = done ] || { echo "generation 2 ended '$s', not done after G3's land"; return 1; }
}
# Decision 1: a round is a rejecting verdict; repairAgents counts the workers' spawns (not the orchestrator's, nor an adopted one).
c_budget() {
  rs=$(repair_seq) || return 1
  b=$(jq -r '"\(.repair.rounds) \(.repair.agents)"' "$RD/run.json") || { echo "run.json doesn't parse"; return 1; }
  rej=$(records | jq --argjson rs "${rs:-0}" '[.[] | select(.seq > $rs and .kind == "verdict" and .body.approved == false)] | length') || { echo "the run's ledger doesn't parse"; return 1; }
  sp=$(sledger swarm.node | jq -s '[.[] | .body | select(.kind != "orchestrator" and .adopted != true) | .agentId] | unique | length') || { echo "swarm.node doesn't parse"; return 1; }
  [ "$rej" -le "${b%% *}" ] || { echo "$rej rejected attempts, past repairRounds ${b%% *}"; return 1; }
  [ "$sp" -le "${b#* }" ] || { echo "$sp agents spawned, past repairAgents ${b#* }"; return 1; }
}
c_nothing_started() {
  [ -z "$(ledger run.repair)" ] || { echo "a run.repair was recorded"; return 1; }
  d=$(ledger repair.declined | jq -s -r 'map(.body.reason) | first // empty') || { echo "repair.declined doesn't parse"; return 1; }
  [ "$d" = 'repair is off for this run' ] || { echo "repair.declined's reason is '${d:-none}'"; return 1; }
  [ -z "$(swarm_dir)" ] || { echo "a repair swarm was made: $(swarm_dir)"; return 1; }
  [ -z "$(git -C "$R" for-each-ref refs/litter-swarm/)" ] || { echo "a swarm ref exists"; return 1; }
}
# The working tree, snapshotted as the mod does (a temporary index, the real one untouched), is the tree G2's last verify ran on.
c_attempt_kept() {
  t=$(records | jq -r '(map(select(.kind == "run.end")) | first | .seq) as $e | map(select(.kind == "verify" and .body.gate == "G2" and .seq < $e)) | last | .body.tree_before // empty') ||
    { echo "the run's ledger doesn't parse"; return 1; }
  [ -n "$t" ] || { echo "no verify of G2 in generation 1"; return 1; }
  idx=$H_DIR/snapshot.index
  rm -f "$idx"
  now=$(GIT_INDEX_FILE=$idx git -C "$R" read-tree HEAD && GIT_INDEX_FILE=$idx git -C "$R" add -A -- . && GIT_INDEX_FILE=$idx git -C "$R" write-tree) || { echo "the working tree couldn't be snapshotted"; return 1; }
  rm -f "$idx"
  [ "$now" != "$(git -C "$R" rev-parse 'HEAD^{tree}')" ] || { echo "the tree is HEAD's: no attempt in it"; return 1; }
  [ "$now" = "$t" ] || { echo "the working tree is $now, not $t, the tree G2's last verify ran on"; return 1; }
}
# repair.ts's planSummary: "The ways on: continue as a plan-template swarm (/litter:swarm repair <run>), amend the gate (/litter:amend G2 …), or stop".
c_routes() {
  [ -f "$RD/summary.md" ] || { echo "no summary.md"; return 1; }
  part=$(awk '/^## Repair$/ { on = 1; next } /^## / { on = 0 } on' "$RD/summary.md")
  [ -n "$part" ] || { echo "summary.md has no Repair part"; return 1; }
  for w in 'continue as a plan-template swarm' "/litter:swarm repair $RUN" '/litter:amend G2' 'or stop'; do
    case $part in *"$w"*) ;; *) echo "the Repair part doesn't offer '$w'"; return 1 ;; esac
  done
}
c_not_landed() {
  l=$(records | jq -r 'map(select(.kind == "land") | .body.gate) | join(" ")') || { echo "the run's ledger doesn't parse"; return 1; }
  [ "$l" = G1 ] || { echo "the lands are for '$l', not G1 alone"; return 1; }
  c=$(ledger land | jq -s -r 'map(.body.commit) | first // empty') || { echo "a land record doesn't parse"; return 1; }
  [ "$(tip)" = "$c" ] || { echo "litter/$RUN is at $(tip), not G1's land $c"; return 1; }
}

h_expect "run.start and the launch made a run" c_run
h_expect "run.json holds repair: $repair and maxAttempts: 1" c_setting
h_expect "generation 1 landed G1 and halted at G2, on a plan gap or its one attempt" c_gen1
if [ "$repair" = auto ]; then
  h_expect "run.repair opened generation 2, and the swarm, confirmed by the run, bound its gate-runner in the run's checkout" c_repair_opened
  h_expect "no ask after the launch" c_no_ask
  h_expect "generation 2's verdicts are critic-node verdict records with gate set, and its verifies number on from generation 1's" c_plan_verdicts
  h_expect "G2 and G3 landed through the runner's land, with their trailers, never on an executor's verdict; the contract holds" c_landed
  h_expect "generation 2 ended done, after G3's land" c_gen2_done
  h_expect "within repairRounds rejections and repairAgents spawns" c_budget
else
  h_expect "nothing started: no run.repair, no repair swarm, no swarm ref" c_nothing_started
  h_expect "the halted attempt is still in the tree" c_attempt_kept
  h_expect "summary.md's Repair part offers the swarm, an amend, or stopping" c_routes
  h_expect "only G1 landed" c_not_landed
fi
h_expect "the lock is released" c_lock_free
h_done
