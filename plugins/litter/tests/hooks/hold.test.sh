# Tier 3: hold.sh on SubagentStop (plan 15.4, "A worker that ends its turn
# while its children run", option C): who is held, the poll and its release,
# once per child under stop_hook_active, the cap, letting go, done/ at a stop
# it lets go, and its failures, none of which blocks a stop.

. "$(dirname "$0")/testlib.sh"

FIXER=litter:sw-s-fixer
BLOCK='{"decision":"block","reason":"your workers have finished; their results are in your messages. Read them, then deliver your report."}'

# Swarm s live, orchestrator a1, and worker w1 under it: worker [node filter] [policy filter].
worker() {
  swarm_setup '.' "${2:-.}"
  node_policy w1 ".kind = \"worker\" | .node = \"fixer\" | .type = \"$FIXER\" | .parent = \"a1\" | ${1:-.}"
}

# child <id> [parent]: a node's child bound under <parent> (w1).
child() {
  node_policy "$1" ".kind = \"child\" | .node = \"fixer\" | .type = \"$FIXER\" | .n = 0 | .of = \"${2:-w1}\" | .parent = \"${2:-w1}\""
}

done_file() { printf '%s\n' "$(hooks_dir)/done/$1"; }
mark_done() {
  mkdir -p "$(hooks_dir)/done"
  printf '{"v":1,"at":1,"via":"handback"}\n' >|"$(done_file "$1")"
}

w1_stop() { stop_input w1 "$FIXER" "${1:-.}" | run_hook hold.sh; }

# The stop went ahead: exit 0, nothing on stdout.
assert_goes() {
  assert_code 0
  assert_stdout_empty
}

hold_lines() { spool_lines | jq -r 'select(.ev == "hold") | "\(.phase) \(.children | join(","))"' | paste -sd '|' -; }

# --- who is held ---------------------------------------------------------------

case_not_bound() {
  worker
  child c1
  stop_input x1 general-purpose | run_hook hold.sh
  assert_goes
  assert_no_file "$(done_file x1)"
  # A run's task binding has no node: nothing to hold or mark.
  printf '{"v":1,"run":"r","task":{"id":"t1"}}\n' >|"$(hooks_dir)/agents/x2.json"
  stop_input x2 litter:executor | run_hook hold.sh
  assert_goes
  assert_no_file "$(done_file x2)"
}

case_not_held() {
  for nh_case in orchestrator child stopping stopped unadmitted generation launch; do
    rm -rf "$(hooks_dir)"
    case $nh_case in
      orchestrator) worker; child c1 a1; nh_id=a1; nh_ty=litter:sw-s-lead ;;
      child) worker; child c0; child c1 c0; nh_id=c0; nh_ty=general-purpose ;;
      stopping) worker '.' '.swarm.swarms.s.state = "stopping"'; child c1; nh_id=w1; nh_ty=$FIXER ;;
      stopped) worker '.stopped = "browser"'; child c1; nh_id=w1; nh_ty=$FIXER ;;
      unadmitted) worker '.admitted = false'; child c1; nh_id=w1; nh_ty=$FIXER ;;
      generation) worker '.' '.swarm.swarms.s.owner.generation = 2'; child c1; nh_id=w1; nh_ty=$FIXER ;;
      # A policy left from an earlier launch of the same swarm (R4).
      launch) worker '.launch = "20261002-090000"'; child c1; nh_id=w1; nh_ty=$FIXER ;;
    esac
    stop_input "$nh_id" "$nh_ty" | run_hook hold.sh
    ( assert_goes ) || fail "$nh_case was held"
    # A child of its own is still running: not done.
    assert_no_file "$(done_file "$nh_id")"
    assert_no_file "$(hooks_dir)/hold/$nh_id"
    assert_eq '' "$(hold_lines)" "$nh_case hold lines"
  done
}

case_no_children() {
  worker
  child c9 a1
  w1_stop
  assert_goes
  assert_file "$(done_file w1)"
  assert_eq 'stop' "$(jq -r .via "$(done_file w1)")" via
  assert_eq '' "$(hold_lines)" "hold lines"
}

case_all_done() {
  worker
  child c1
  child c2
  mark_done c1
  # A binding the mod removed is finished too.
  rm -f "$(hooks_dir)/agents/c2.json"
  child c3
  mark_done c3
  w1_stop
  assert_goes
  assert_file "$(done_file w1)"
  assert_no_file "$(hooks_dir)/hold/w1"
}

# --- the hold ------------------------------------------------------------------

# A child's done/ lands after 3 s: the hold lets the worker's turn go on.
case_poll_releases() {
  worker
  child c1
  child c2
  mark_done c2
  (sleep 3 && mkdir -p "$(hooks_dir)/done" && printf '{"v":1,"at":1,"via":"stop"}\n' >|"$(done_file c1)") &
  pr_bg=$!
  pr_t0=$(date +%s)
  w1_stop
  pr_t1=$(date +%s)
  wait "$pr_bg"
  assert_code 0
  assert_eq "$BLOCK" "$(cat "$T_DIR/out")" "the block"
  [ $((pr_t1 - pr_t0)) -ge 2 ] || fail "released after $((pr_t1 - pr_t0)) s, before the child was done"
  assert_eq '{"v":1,"children":["c1"]}' "$(cat "$(hooks_dir)/hold/w1")" hold/w1
  assert_eq 'held c1|released c1' "$(hold_lines)" "hold lines"
  assert_eq 'number s1 w1' "$(spool_lines | jq -r 'select(.ev == "hold") | "\(.ts | type) \(.session_id) \(.agent_id)"' | sort -u)" "line fields"
  # A stop it held, or released, writes no done/: the turn goes on.
  assert_no_file "$(done_file w1)"
}

# stop_hook_active: only the children not yet in hold/<agent_id> are waited for.
case_once_per_child() {
  worker
  child c1
  mkdir -p "$(hooks_dir)/hold"
  printf '{"v":1,"children":["c1"]}\n' >|"$(hooks_dir)/hold/w1"
  w1_stop '.stop_hook_active = true'
  assert_goes
  assert_eq '' "$(hold_lines)" "no hold for c1 again"
  # c1 still runs: not done.
  assert_no_file "$(done_file w1)"
  # A new child is waited for, once; the cap at 0 ends the wait at once.
  child c2
  LT_HOLD_CAP=0
  export LT_HOLD_CAP
  w1_stop '.stop_hook_active = true'
  assert_goes
  assert_eq '{"v":1,"children":["c1","c2"]}' "$(cat "$(hooks_dir)/hold/w1")" hold/w1
  assert_eq 'held c2|timeout c2' "$(hold_lines)" "hold lines"
  # A new turn's stop waits for every child still running.
  w1_stop
  assert_eq 'held c2|timeout c2|held c1,c2|timeout c1,c2' "$(hold_lines)" "hold lines"
}

case_cap() {
  worker
  child c1
  LT_HOLD_CAP=1
  export LT_HOLD_CAP
  w1_stop
  assert_goes
  assert_eq 'held c1|timeout c1' "$(hold_lines)" "hold lines"
  assert_no_file "$(done_file w1)"
  # A cap that isn't a number is the default's, 570 s: here the child is
  # already done, so no wait.
  LT_HOLD_CAP=soon
  mark_done c1
  w1_stop
  assert_goes
  assert_file "$(done_file w1)"
}

# The swarm starts stopping during the hold: the worker is let go.
case_lets_go() {
  worker
  child c1
  (sleep 1 && swarm_policy '.swarm.swarms.s.state = "stopping"') &
  lg_bg=$!
  w1_stop
  wait "$lg_bg"
  assert_goes
  assert_eq 'held c1' "$(hold_lines)" "hold lines"
  assert_no_file "$(done_file w1)"
}

# --- done/ ---------------------------------------------------------------------

case_done_marker() {
  worker
  # A shell or a monitor of its own in flight (watch.sh listed it in shells/w1): not done.
  mkdir -p "$(hooks_dir)/shells"
  printf 'b0\nb1\n' >|"$(hooks_dir)/shells/w1"
  for dm_ty in shell monitor; do
    w1_stop ".background_tasks += [{id: \"b1\", type: \"$dm_ty\", status: \"running\", description: \"d\"}]"
    assert_goes
    assert_no_file "$(done_file w1)"
  done
  # Another subagent in flight is not this one's: done.
  w1_stop '.background_tasks += [{id: "a9", type: "subagent", status: "running", description: "d", agent_type: "x"}]'
  assert_goes
  assert_file "$(done_file w1)"
  assert_eq 'number' "$(jq -r '.at | type' "$(done_file w1)")" at
  # An orchestrator and a child are marked as well.
  stop_input a1 litter:sw-s-lead | run_hook hold.sh
  assert_file "$(done_file a1)"
}

# R3: background_tasks is the whole session's, with no owner. The lead's dev
# server, or another node's shell, must not keep this agent from done/.
case_done_others_shells() {
  worker
  child c1
  mkdir -p "$(hooks_dir)/shells"
  printf 'b7\n' >|"$(hooks_dir)/shells/a1"
  stop_input c1 general-purpose '.background_tasks += [
    {id: "b1", type: "shell", status: "running", description: "npm run dev", command: "npm run dev"},
    {id: "b7", type: "shell", status: "running", description: "the lead node", command: "sleep 99"},
    {id: "m1", type: "monitor", status: "pending", description: "an MCP monitor"}]' | run_hook hold.sh
  assert_goes
  assert_file "$(done_file c1)"
  # The worker's hold on c1 lets go at once.
  w1_stop '.background_tasks += [{id: "b1", type: "shell", status: "running", description: "d"}]'
  assert_goes
  assert_file "$(done_file w1)"
  assert_eq '' "$(hold_lines)" "hold lines"
  # Its own file names b9, which is no longer running: done again.
  rm -f "$(done_file w1)"
  printf 'b9\nnot an id\n\n' >|"$(hooks_dir)/shells/w1"
  w1_stop '.background_tasks += [{id: "b1", type: "shell", status: "running", description: "d"}]'
  assert_file "$(done_file w1)"
}

# --- the listing of children (R11) ------------------------------------------------

# A malformed sibling binding fails the listing: a worker is still held, the
# listing tried again on each poll, here until the bad file is gone.
case_listing_retried() {
  worker
  child c1
  mark_done c1
  printf '{"v":1,"node":' >|"$(hooks_dir)/agents/x9.json"
  (sleep 3 && rm -f "$(hooks_dir)/agents/x9.json") &
  lr_bg=$!
  lr_t0=$(date +%s)
  w1_stop
  lr_t1=$(date +%s)
  wait "$lr_bg"
  # Its one child was done already: once the listing reads, the stop goes ahead, marked done.
  assert_goes
  [ $((lr_t1 - lr_t0)) -ge 2 ] || fail "went ahead after $((lr_t1 - lr_t0)) s, before the listing could read"
  assert_file "$(done_file w1)"
  assert_eq '' "$(hold_lines)" "hold lines"
}

# The same with an open child, and the bad file staying: on the cap it's the cap.
case_listing_cap() {
  worker
  child c1
  : >|"$(hooks_dir)/agents/x9.json"
  LT_HOLD_CAP=1
  export LT_HOLD_CAP
  w1_stop
  assert_goes
  assert_eq 'timeout ' "$(hold_lines)" "hold lines"
  assert_no_file "$(done_file w1)"
  assert_stderr_contains 'agents/x9.json'
  # An orchestrator, never held, goes ahead at once, unmarked: an open child can't be ruled out.
  stop_input a1 litter:sw-s-lead | run_hook hold.sh
  assert_goes
  assert_no_file "$(done_file a1)"
  # A binding that vanished (a dangling name) is no failure: the mod removed it.
  rm -f "$(hooks_dir)/agents/x9.json"
  ln -s "$T_DIR/gone.json" "$(hooks_dir)/agents/x8.json"
  mark_done c1
  w1_stop
  assert_goes
  assert_file "$(done_file w1)"
}

# --- failures --------------------------------------------------------------------

case_no_jq() {
  worker
  child c1
  stop_input w1 "$FIXER" >|"$T_DIR/in"
  PATH=$(path_without_jq)
  run_hook hold.sh <"$T_DIR/in"
  assert_goes
  assert_stderr_contains 'litter: hold.sh: jq not found; no hold; the stop goes ahead'
  assert_no_file "$(done_file w1)"
}

case_fast_path() {
  worker
  child c1
  rm -f "$(hooks_dir)/active" "$(hooks_dir)"/agents/*.json
  w1_stop
  assert_goes
  assert_eq '' "$(cat "$T_DIR/err")" stderr
  assert_no_file "$(hooks_dir)/hold"
}

# R5: `active` gone while bindings remain (a node removed it): the hold still holds.
case_no_active_bound() {
  worker
  child c1
  rm -f "$(hooks_dir)/active"
  LT_HOLD_CAP=0
  export LT_HOLD_CAP
  w1_stop
  assert_goes
  assert_eq 'held c1|timeout c1' "$(hold_lines)" "hold lines"
}

case_failures_go_ahead() {
  worker
  child c1
  printf '{"v":1,"node":' >|"$(hooks_dir)/agents/w1.json"
  w1_stop
  assert_goes
  assert_stderr_contains 'agents/w1.json is unreadable (it does not parse); the stop goes ahead'
  # No lib.sh while a swarm is active: a note, never a block.
  mkdir -p "$T_DIR/plugin/hooks"
  cp "$LITTER_ROOT/hooks/hold.sh" "$T_DIR/plugin/hooks/"
  # shellcheck disable=SC2086
  stop_input w1 "$FIXER" | CLAUDE_PLUGIN_ROOT=$T_DIR/plugin ${SHELL_UNDER_TEST:-sh} "$T_DIR/plugin/hooks/hold.sh" >|"$T_DIR/out" 2>|"$T_DIR/err"
  printf '%s\n' "$?" >|"$T_DIR/code"
  assert_goes
  assert_stderr_contains 'loading lib.sh; the stop goes ahead'
  # The hold folder can't be written: the stop goes ahead.
  node_policy w1 ".kind = \"worker\" | .parent = \"a1\" | .type = \"$FIXER\""
  printf 'x\n' >|"$(hooks_dir)/hold"
  w1_stop
  assert_goes
  assert_stderr_contains "couldn't write hold/w1"
}

t "an agent with no node binding is never held or marked" case_not_bound
t "an orchestrator, a child, and a worker stopping, stopped, unadmitted, handed over or of another launch are not held" case_not_held
t "a worker with no children goes ahead, marked done" case_no_children
t "a worker whose children are all done or gone goes ahead, marked done" case_all_done
t "a child done after 3 s releases the hold with the block" case_poll_releases
t "under stop_hook_active a worker is held once per child" case_once_per_child
t "the hold ends at LT_HOLD_CAP, and the stop goes ahead" case_cap
t "a swarm that starts stopping lets the held worker go" case_lets_go
t "done/ at a stop it lets go, unless a shell or monitor of its own runs" case_done_marker
t "the session's other shells and monitors don't keep an agent from done/" case_done_others_shells
t "a listing a malformed binding fails is tried again on the next poll" case_listing_retried
t "a listing that keeps failing ends at the cap; a vanished binding is no failure" case_listing_cap
t "without jq there is no hold" case_no_jq
t "with nothing active and no binding it exits at once" case_fast_path
t "with active gone while bindings remain it still holds" case_no_active_bound
t "a broken binding, a missing lib.sh or an unwritable hold folder never blocks" case_failures_go_ahead
done_testing
