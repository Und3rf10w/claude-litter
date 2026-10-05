# Tier 3: tests/headless/startfill.sh (WP-AS), the tier-4 steps' view of a
# repair swarm's start, on a fake litter folder: Enter once on a fill the box
# took, the stall after 10 minutes with no orchestrator, and which way it
# started. Nothing goes to stderr, which drive.exp reads as a failure.

. "$(dirname "$0")/testlib.sh"

SF=$LITTER_ROOT/tests/headless/startfill.sh

# The fake litter folder: a run with run.repair at <repair_at> (epoch s, or
# none), and the repair swarm's launch ledger with the records given.
ld() { printf '%s\n' "$T_DIR/litter"; }
run_repair() {
  mkdir -p "$(ld)/20261004-run/ledger" || fail mkdir
  printf '{"v":1,"seq":5,"kind":"run.repair","at":%s,"body":{"generation":2}}\n' "$(($1 * 1000))" >|"$(ld)/20261004-run/ledger/000005-run.repair.json"
}
# launch_rec <seq> <kind> <at epoch s> <body json>
launch_rec() {
  d=$(ld)/swarms/repair-abc123/launches/20261004-120000/ledger
  mkdir -p "$d" || fail mkdir
  printf '{"v":1,"seq":%s,"kind":"%s","at":%s,"body":%s}\n' "$1" "$2" "$(($3 * 1000))" "$4" >|"$d/$(printf '%06d' "$1")-$2.json"
}
started() { launch_rec 1 swarm.start "$1" '{"swarm":"repair-abc123"}'; }
filled() { launch_rec "$1" swarm.event "$2" "{\"kind\":\"start-filled\",\"filled\":$3}"; }
bound() { launch_rec "$1" swarm.node "$2" '{"node":"runner","kind":"orchestrator","agentId":"a-1"}'; }

# sf <args...>: runs it under the shell being tested; out, err, code in $T_DIR.
sf() {
  # shellcheck disable=SC2086
  ${SHELL_UNDER_TEST:-sh} "$SF" "$@" >|"$T_DIR/out" 2>|"$T_DIR/err"
  printf '%s\n' "$?" >|"$T_DIR/code"
  [ ! -s "$T_DIR/err" ] || fail "stderr: $(cat "$T_DIR/err")"
}

case_enter_once() {
  now=$(date +%s)
  # No swarm yet, then one with no fill: nothing to press.
  sf enter "$(ld)" "$T_DIR/mark"
  assert_code 0
  assert_stdout_empty
  started "$now"
  sf enter "$(ld)" "$T_DIR/mark"
  assert_code 0
  assert_stdout_empty
  # A fill the box took: Enter, once.
  filled 2 "$now" true
  sf enter "$(ld)" "$T_DIR/mark"
  assert_code 0
  assert_eq enter "$(cat "$T_DIR/out")" "the keys"
  assert_file "$T_DIR/mark"
  # Pressed: nothing more to press, so the keysh ends.
  sf enter "$(ld)" "$T_DIR/mark"
  assert_code 1
  assert_stdout_empty
}

case_enter_not_on_a_refused_fill() {
  now=$(date +%s)
  started "$now"
  filled 2 "$now" false
  sf enter "$(ld)" "$T_DIR/mark"
  assert_code 0
  assert_stdout_empty
  assert_no_file "$T_DIR/mark"
}

case_enter_ends_once_started() {
  now=$(date +%s)
  started "$now"
  bound 2 "$now"
  sf enter "$(ld)" "$T_DIR/mark"
  assert_code 1
  assert_stdout_empty
  assert_no_file "$T_DIR/mark"
}

case_stalled() {
  now=$(date +%s)
  # Before run.repair: not stalled.
  sf stalled "$(ld)"
  assert_code 1
  # run.repair 5 minutes ago, no fill: not yet; 11 minutes ago: stalled.
  run_repair $((now - 300))
  sf stalled "$(ld)"
  assert_code 1
  run_repair $((now - 660))
  sf stalled "$(ld)"
  assert_code 0
  # A fill a minute ago counts from the fill, not from run.repair.
  started $((now - 650))
  filled 2 $((now - 60)) true
  sf stalled "$(ld)"
  assert_code 1
  # 11 minutes after the fill, still no orchestrator: stalled.
  filled 2 $((now - 660)) true
  sf stalled "$(ld)"
  assert_code 0
  # An orchestrator bound: never stalled.
  bound 3 $((now - 600))
  sf stalled "$(ld)"
  assert_code 1
  # H_STALL_S sets the 10 minutes (exported in a subshell: a prefix assignment on a function isn't, under every sh).
  rm -f "$(ld)"/swarms/repair-abc123/launches/20261004-120000/ledger/000003-swarm.node.json
  (H_STALL_S=3600 && export H_STALL_S && sf stalled "$(ld)") || exit 1
  assert_code 1
}

case_how() {
  now=$(date +%s)
  sf how "$(ld)"
  assert_eq 'no repair swarm was made' "$(cat "$T_DIR/out")" how
  started "$now"
  sf how "$(ld)"
  assert_eq 'the swarm never started: no orchestrator was spawned, and litter filled no start line' "$(cat "$T_DIR/out")" how
  bound 2 "$now"
  sf how "$(ld)"
  assert_eq "the swarm started on the lead's turn" "$(cat "$T_DIR/out")" how
  # The fill before the orchestrator's swarm.node: your Enter started it.
  rm -f "$(ld)"/swarms/repair-abc123/launches/20261004-120000/ledger/000002-swarm.node.json
  filled 2 "$now" true
  sf how "$(ld)"
  assert_eq 'the swarm never started: litter filled the start line (filled: true), and no orchestrator was spawned' "$(cat "$T_DIR/out")" how
  bound 3 "$now"
  sf how "$(ld)"
  assert_eq "the swarm started on your Enter, after litter filled the start line (the lead's start was refused)" "$(cat "$T_DIR/out")" how
  assert_code 0
}

case_usage() {
  sf
  assert_code 2
  sf nope "$(ld)"
  assert_code 2
  sf enter "$(ld)"
  assert_code 2
}

t "enter: Enter once on a fill the box took, then nothing more to press" case_enter_once
t "enter: no Enter on a fill the box refused" case_enter_not_on_a_refused_fill
t "enter: nothing more to press once an orchestrator is spawned" case_enter_ends_once_started
t "stalled: 10 minutes with no orchestrator, from the fill or else run.repair" case_stalled
t "how: on the lead's turn, on your Enter after the fill, or never started" case_how
t "a missing or unknown argument exits 2" case_usage
done_testing
