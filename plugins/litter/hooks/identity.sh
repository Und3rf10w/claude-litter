#!/bin/sh
# identity.sh: SubagentStart (`start`) and SubagentStop (`stop`) for litter
# agents (plan section 9, "Guard"; section 10). `start` writes bind/<agent_id>
# from the start's input, whose cwd is the agent's worktree when it runs
# isolated, and spools the start for the mod's agent map. `stop` spools the
# stop, which settles a stopping run ("Run lifecycle"). Other agents are left
# alone.
#
# Neither event can be refused here: SubagentStart doesn't stop the agent, and
# SubagentStop's exit 2 would keep it running. A failure is reported (exit 1),
# and an agent left without a binding is refused by guard.sh instead. The stop
# has a 5 s limit, so it does one jq call and one append.

set -u
case $0 in */*) lt_here=${0%/*} ;; *) lt_here=. ;; esac
if [ ! -r "$lt_here/lib.sh" ]; then
  [ -f "${CLAUDE_PROJECT_DIR:-/nonexistent}/.claude/litter/hooks/active" ] || exit 0
  printf 'litter: identity.sh failed: loading lib.sh\n' >&2
  exit 1
fi
. "$lt_here/lib.sh"

IDENTITY_JQ_START='
. as $in
| if ($in.agent_type | str | startswith("litter:")) | not then "who other\npass"
  elif ($in.agent_id | okid | not) then "who litter\nfail\nthe start carries no usable agent_id"
  else "who litter\nbind\n" + $in.agent_id + "\n"
    + ({v: 1, agent_id: $in.agent_id, agent_type: $in.agent_type, cwd: ($in.cwd | str),
        session_id: ($in.session_id | str), transcript_path: ($in.transcript_path | str)} | tojson) + "\n"
    + sid($in) + "\n"
    + ({v: 1, ev: "start", ts: ts, session_id: ($in.session_id | str), agent_id: $in.agent_id, agent_type: $in.agent_type,
        cwd: ($in.cwd | str), transcript_path: ($in.transcript_path | str)} | tojson)
  end
'

IDENTITY_JQ_STOP='
. as $in
| if ($in.agent_type | str | startswith("litter:")) | not then "who other\npass"
  else "who litter\nspool\n-\n" + sid($in) + "\n"
    + ({v: 1, ev: "stop", ts: ts, session_id: ($in.session_id | str), agent_id: ($in.agent_id | str),
        agent_type: $in.agent_type, transcript_path: ($in.transcript_path | str),
        stop_hook_active: ($in.stop_hook_active == true),
        background_tasks: ($in.background_tasks | if type == "array" then length else 0 end)} | tojson)
  end
'

identity_work() {
  echo 'step finding the hooks folder'
  if [ -n "$LT_DIR_ERR" ]; then
    lt_raw_litter && printf 'who litter\nfail\n%s\n' "can't find litter's hooks folder ($LT_DIR_ERR)"
    return 0
  fi
  echo 'step checking for jq'
  if ! lt_have_jq; then
    lt_raw_litter && printf 'who litter\nfail\n%s\n' 'jq not found; install it, or stop the run'
    return 0
  fi
  echo 'step reading the hook input'
  case $1 in
    start) lt_prog=$IDENTITY_JQ_START ;;
    *) lt_prog=$IDENTITY_JQ_STOP ;;
  esac
  printf '%s' "$LT_IN" | jq -r "$LT_JQ_DEFS$lt_prog" || return 1
}

case ${1:-} in
  start | stop) ;;
  *) lt_note "identity.sh needs start or stop, not '${1:-}'" ;;
esac
lt_begin
lt_run identity_work "$1"
case $LT_L1 in
  pass) exit 0 ;;
  '')
    if [ "$LT_WHO" = litter ] || { [ -z "$LT_WHO" ] && lt_raw_litter; }; then
      lt_note "identity.sh $1 failed: $LT_STEP"
    fi
    exit 0
    ;;
  fail) lt_note "identity.sh $1: $LT_L2" ;;
  bind)
    # bind/<agent_id> first: the guard needs it before the agent's first call.
    lt_mkdir "$LT_DIR/bind" && lt_write "$LT_DIR/bind/$LT_L2" "$LT_L3" ||
      lt_note "identity.sh start: couldn't write bind/$LT_L2; the guard will refuse that agent"
    lt_spool "$LT_L4" "$LT_L5" || lt_note "identity.sh start: couldn't spool the start of $LT_L2"
    ;;
  spool) lt_spool "$LT_L3" "$LT_L4" || lt_note "identity.sh stop: couldn't spool the stop" ;;
esac
exit 0
