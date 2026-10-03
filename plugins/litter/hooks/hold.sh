#!/bin/sh
# hold.sh (SubagentStop, timeout 600): holds a swarm worker's stop while a
# child bound under it hasn't finished (plan 15.4, "A worker that ends its
# turn while its children run", option C), so the worker reads its children's
# results in the same turn instead of reporting early.
#
#  - Held: a bound `worker` whose swarm is live (not stopping), under the
#    owner's generation, not stopped and admitted, with a child (a binding in
#    agents/*.json whose parent is this agent) that has no done/<child>. It
#    polls every 2 s, up to LT_HOLD_CAP s (570, under the hook's 600), and
#    lets go at once if the swarm starts stopping or the worker is stopped.
#    Once they're all done it answers {"decision":"block",…} and the worker's
#    turn goes on (spike 18). A stop with stop_hook_active waits only for
#    children not yet in hold/<agent_id>, so a worker is held once per child.
#  - Done: at a stop it lets go, for any bound agent with no shell or monitor
#    in background_tasks and no child unfinished, it writes done/<agent_id>
#    (via: stop). That list is the session's, so a child can wait for a
#    shell that isn't its own: the hold can over-wait, never under-wait. A
#    stop it holds, or lets go at the cap, writes nothing.
#  - Spooled: `hold` lines, `held` when it starts waiting, `released` with the
#    block, `timeout` at the cap (the mod records worker-ended-early).
#
# The command hooks for one event run concurrently on 2.1.288: every matched
# hook starts at once, whatever its place in hooks.json, a block from one
# doesn't stop the others, and the engine waits for all of them. So this
# script never depends on identity.sh having run, and done/<agent_id> at a
# stop is this script's to write.
#
# A SubagentStop hook never blocks on its own error: exit 2 would keep the
# agent running. Every failure, jq missing included, lets the stop go ahead
# with a note on stderr and exit 0.

set -u
case $0 in */*) lt_here=${0%/*} ;; *) lt_here=. ;; esac
if [ ! -r "$lt_here/lib.sh" ]; then
  [ -f "${CLAUDE_PROJECT_DIR:-/nonexistent}/.claude/litter/hooks/active" ] || exit 0
  printf 'litter: hold.sh failed: loading lib.sh; the stop goes ahead\n' >&2
  exit 0
fi
. "$lt_here/lib.sh"

HOLD_POLL=2
HOLD_BLOCK='{"decision":"block","reason":"your workers have finished; their results are in your messages. Read them, then deliver your report."}'

# The stopping agent, from its input and its binding: whether it may be held,
# the session id, stop_hook_active, whether a shell or monitor is in flight,
# then the children it was already held for, one per line. `skip` for an
# agent with no node binding.
HOLD_JQ_STOP='
. as $in
| readj($pol) as $p
| readj($me) as $m
| readj($held) as $h
| if $me != "" and ($m | ok1 | not) then "bad\nagents/\($in.agent_id | str).json is unreadable (\(why($me; $m)))"
  elif ($m | type) != "object" or ($m.node | type) != "object" then "skip"
  else $m.node as $n
  | (if ($p | ok1) and ($p.swarm | type) == "object" and ($p.swarm.swarms | type) == "object"
     then $p.swarm.swarms[$n.swarm | str] else null end) as $e
  | (($e | type) == "object" and $e.state == "live" and ($e.owner | type) == "object"
      and $e.owner.generation == $n.generation and $n.kind == "worker" and $n.stopped == null and $n.admitted == true) as $holdable
  | ([$in.background_tasks | if type == "array" then .[] else empty end
      | select(type == "object" and ((.type | str) as $t | $t == "shell" or $t == "monitor"))] | length > 0) as $shells
  | ([(if ($h | ok1) and ($h.children | type) == "array" then $h.children[] else empty end) | str | select(okid)]) as $was
  | ([(if $holdable then "hold" else "go" end), sid($in), (if $in.stop_hook_active == true then "1" else "0" end),
      (if $shells then "1" else "0" end)] + $was) | join("\n")
  end
'

# hold_note <text>: the stop goes ahead, and says why on stderr.
hold_note() {
  printf 'litter: hold.sh: %s; the stop goes ahead\n' "$1" >&2
  exit 0
}

# hold_has <id> <list>: <id> is one of the newline-separated <list>.
hold_has() {
  case "$LT_NL$2$LT_NL" in *"$LT_NL$1$LT_NL"*) return 0 ;; esac
  return 1
}

# A child is finished once it handed back or stopped (done/), or its
# binding is gone (the mod removed it).
hold_finished() {
  [ -f "$LT_DIR/done/$1" ] || [ ! -f "$LT_DIR/agents/$1.json" ]
}

# hold_line <phase> <children…>: the `hold` spool line (hookfiles.ts). Every
# value is an id lt_id_ok passed, or a number.
hold_line() {
  hl_phase=$1
  shift
  hl_kids=
  for hl_c in "$@"; do hl_kids="$hl_kids${hl_kids:+,}\"$hl_c\""; done
  hl_ts=$(date +%s 2>/dev/null) || hl_ts=0
  case $hl_ts in '' | *[!0-9]*) hl_ts=0 ;; esac
  lt_spool "$hold_sid" "{\"v\":1,\"ev\":\"hold\",\"ts\":$hl_ts,\"session_id\":\"$hold_sid\",\"agent_id\":\"$hold_id\",\"phase\":\"$hl_phase\",\"children\":[$hl_kids]}" ||
    printf 'litter: hold.sh: couldn'\''t spool hold %s\n' "$hl_phase" >&2
}

# The policy as it is now: still a worker the hold applies to.
hold_still() {
  lt_file "$LT_DIR/policy.json"
  hs_pf=$LT_FF hs_pv=$LT_FV
  lt_file "$LT_DIR/agents/$hold_id.json"
  hs_d=$(printf '%s' "$LT_IN" | jq -r "$hs_pf" pol "$hs_pv" "$LT_FF" me "$LT_FV" --arg held '' "$LT_JQ_DEFS$HOLD_JQ_STOP") || return 1
  [ "${hs_d%%"$LT_NL"*}" = hold ]
}

# Prints the block when the hold ends with every child done; prints nothing
# when the stop goes ahead.
hold_work() {
  lt_begin
  [ -z "$LT_DIR_ERR" ] || exit 0
  # Not bound to a swarm node: nothing to hold or mark, and no jq.
  hold_id=$(lt_raw_agent_id) || exit 0
  [ -f "$LT_DIR/agents/$hold_id.json" ] || exit 0
  lt_have_jq || hold_note 'jq not found; no hold'

  lt_file "$LT_DIR/policy.json"
  hw_pf=$LT_FF hw_pv=$LT_FV
  lt_file "$LT_DIR/agents/$hold_id.json"
  hw_mf=$LT_FF hw_mv=$LT_FV
  lt_file "$LT_DIR/hold/$hold_id"
  hw_d=$(printf '%s' "$LT_IN" | jq -r "$hw_pf" pol "$hw_pv" "$hw_mf" me "$hw_mv" "$LT_FF" held "$LT_FV" \
    "$LT_JQ_DEFS$HOLD_JQ_STOP") || hold_note 'reading the stop failed'
  lt_rest=$hw_d
  lt_take
  case $lt_t in
    skip) exit 0 ;;
    bad) hold_note "$lt_rest" ;;
    hold | go) hw_verb=$lt_t ;;
    *) hold_note 'reading the stop failed' ;;
  esac
  lt_take; hold_sid=$lt_t
  lt_take; hw_again=$lt_t
  lt_take; hw_shells=$lt_t
  hw_was=$lt_rest

  # Its children, from every binding.
  hw_kids=$(jq -rn --arg id "$hold_id" '
    inputs | select(type == "object" and .v == 1 and (.node | type) == "object" and .node.parent == $id)
    | input_filename | split("/") | last | rtrimstr(".json") | select(test("^[A-Za-z0-9_-]{1,128}$"))' \
    "$LT_DIR"/agents/*.json 2>/dev/null) || hold_note 'reading the bindings failed'
  hw_open=
  hw_wait=
  for hw_c in $hw_kids; do
    [ "$hw_c" != "$hold_id" ] || continue
    hold_finished "$hw_c" && continue
    hw_open="$hw_open $hw_c"
    if [ "$hw_again" = 1 ] && hold_has "$hw_c" "$hw_was"; then continue; fi
    hw_wait="$hw_wait $hw_c"
  done

  if [ "$hw_verb" != hold ] || [ -z "$hw_wait" ]; then
    if [ "$hw_shells" = 0 ] && [ -z "$hw_open" ]; then
      lt_done "$hold_id" stop || printf 'litter: hold.sh: couldn'\''t write done/%s\n' "$hold_id" >&2
    fi
    exit 0
  fi

  # Held: hold/<agent_id> first, so a stop after the release knows these.
  # shellcheck disable=SC2086
  set -- $hw_wait
  hw_all=$hw_was
  for hw_c in "$@"; do
    hold_has "$hw_c" "$hw_all" || hw_all="$hw_all${hw_all:+$LT_NL}$hw_c"
  done
  hw_json=
  for hw_c in $hw_all; do hw_json="$hw_json${hw_json:+,}\"$hw_c\""; done
  lt_mkdir "$LT_DIR/hold" && lt_write "$LT_DIR/hold/$hold_id" "{\"v\":1,\"children\":[$hw_json]}" ||
    hold_note "couldn't write hold/$hold_id"
  hold_line held "$@"

  hw_cap=${LT_HOLD_CAP:-570}
  case $hw_cap in '' | *[!0-9]*) hw_cap=570 ;; esac
  hw_t0=$(date +%s 2>/dev/null) || hw_t0=
  case $hw_t0 in *[!0-9]*) hw_t0= ;; esac
  hw_ticks=0
  while :; do
    hw_left=
    for hw_c in "$@"; do hold_finished "$hw_c" || hw_left=1; done
    if [ -z "$hw_left" ]; then
      hold_line released "$@"
      printf '%s\n' "$HOLD_BLOCK"
      exit 0
    fi
    hw_now=$(date +%s 2>/dev/null) || hw_now=
    case $hw_now in *[!0-9]*) hw_now= ;; esac
    if [ -n "$hw_t0" ] && [ -n "$hw_now" ]; then hw_spent=$((hw_now - hw_t0)); else hw_spent=$((hw_ticks * HOLD_POLL)); fi
    if [ "$hw_spent" -ge "$hw_cap" ]; then
      hold_line timeout "$@"
      exit 0
    fi
    # A swarm that starts stopping, or a worker stopped meanwhile, isn't waited on.
    hold_still || exit 0
    sleep "$HOLD_POLL" || exit 0
    hw_ticks=$((hw_ticks + 1))
  done
}

# The work runs in a subshell, so set -u or a failed step ends only that, and
# the stop is blocked only by the one answer the hold prints.
hold_out=$(hold_work)
case $hold_out in "$HOLD_BLOCK") printf '%s\n' "$hold_out" ;; esac
exit 0
