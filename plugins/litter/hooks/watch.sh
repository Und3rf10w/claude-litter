#!/bin/sh
# watch.sh: UserPromptSubmit (`prompt`), PostToolUse and PostToolUseFailure
# (`post`) (plan section 9, "The mode is read live"; section 14).
#  - prompt: records the main thread's permission_mode into `mode` with one
#    sed and no jq, even with nothing active, so run.start can check it. While
#    a run is active, a change is spooled as well.
#  - post, while a run is active: the same for the main thread's calls; and
#    for a litter agent whose result carries the engine's refusal ("the
#    working-directory isolation context for this agent was lost"), an
#    isolation-lost line (source: watch), which halts the run. guard.sh
#    catches the same failure from the other side.
#  - post, for a litter agent, a swarm node or a node's child (phase 2b): the
#    `call` end of every call guard.sh spooled a start for, with `failed` on
#    PostToolUseFailure and the background task's id in `shell` (a Bash
#    result's backgroundTaskId, a Monitor's taskId), so the mod can tell what
#    is still in flight (plan 15.4, "Ending", step 2). A bound agent's
#    SubagentHandback that was delivered spools its message as `handback`,
#    then writes done/<agent_id>, which hold.sh waits on ("A worker that ends
#    its turn while its children run").
# Neither is ever refused: exit 2 on UserPromptSubmit would drop the prompt,
# and its stdout becomes context, so nothing is printed.

set -u
case $0 in */*) lt_here=${0%/*} ;; *) lt_here=. ;; esac
if [ ! -r "$lt_here/lib.sh" ]; then
  [ -f "${CLAUDE_PROJECT_DIR:-/nonexistent}/.claude/litter/hooks/active" ] || exit 0
  printf 'litter: watch.sh failed: loading lib.sh\n' >&2
  exit 1
fi
. "$lt_here/lib.sh"

LT_REFUSAL='isolation context for this agent was lost'

# A litter agent's or a bound agent's result: `spool` (or `handback`), the
# session id, the agent id, the call end, and the isolation-lost or handback
# line, or nothing. The isolation-lost line is a litter agent's, and only
# when the refusal is in the call's result, not its input.
WATCH_JQ_POST='
. as $in
| readj($bind) as $b
| readj($agent) as $a
| ($in.agent_type | str) as $type
| ($in.tool_name | str) as $tool
| ($in.tool_response) as $r
| (($a | ok1) and ($a.node | type) == "object") as $bound
| if $agent != "" and ($a | ok1 | not) and ($type | startswith("litter:") | not) then
    "who litter\nfail\nagents/\($in.agent_id | str).json is unreadable (\(why($agent; $a))), so its call is not recorded"
  elif (($type | startswith("litter:")) or $bound) | not then "who other\npass"
  elif ($in.agent_id | okid | not) then "who litter\nfail\nthe result carries no usable agent_id"
  else
    (if $tool == "Bash" and ($r | type) == "object" and ($r.backgroundTaskId | str) != "" then $r.backgroundTaskId
     elif $tool == "Monitor" and ($r | type) == "object" and ($r.taskId | str) != "" then $r.taskId
     else null end) as $shell
    | ({v: 1, ev: "call", ts: ts, session_id: ($in.session_id | str), agent_id: $in.agent_id, agent_type: $type, tool: $tool,
        tool_use_id: ($in.tool_use_id | str), phase: "end", failed: (($in.hook_event_name | str) == "PostToolUseFailure")}
       + (if $shell == null then {} else {shell: $shell} end) | tojson) as $call
    | (($type | startswith("litter:")) and ((($in.error | str) + "\n" + ($r | if type == "string" then . else tojson end))
        | contains($refusal))) as $lost
    | ($bound and $tool == "SubagentHandback" and ($in.hook_event_name | str) == "PostToolUse"
        and ($r | type) == "object" and $r.success == true) as $handback
    | "who litter\n" + (if $handback then "handback" else "spool" end) + "\n" + sid($in) + "\n" + $in.agent_id + "\n" + $call + "\n"
      + (if $lost then
           {v: 1, ev: "isolation-lost", ts: ts, session_id: ($in.session_id | str), agent_id: $in.agent_id,
            agent_type: $type, tool: $tool, cwd: ($in.cwd | str),
            expected: (if $b | ok1 then $b.cwd | str | orNull else null end), source: "watch"} | tojson
         elif $handback then
           {v: 1, ev: "handback", ts: ts, session_id: ($in.session_id | str), agent_id: $in.agent_id, agent_type: $type,
            tool_use_id: ($in.tool_use_id | str),
            message: ($in.tool_input | if type == "object" then .message else null end | str)} | tojson
         else "" end)
  end
'

# The main thread's mode, from its own input, into `mode` when it changed;
# spooled when a run is active. The engine writes the base fields first, so
# the first key wins over one a tool's input or result may carry: sed swaps
# the first match for a newline, which no input line holds. The values sed
# lets through are letters and id characters only, so the spool line is
# built with printf.
watch_mode() {
  lt_ms=$(printf '%s\n' "$LT_IN" | sed -n \
    -e 'h' -e 's/"permission_mode":"/\
/' -e 's/.*\n\([A-Za-z]*\)".*/m \1/p' \
    -e 'g' -e 's/"session_id":"/\
/' -e 's/.*\n\([A-Za-z0-9_-]*\)".*/s \1/p') || return 1
  lt_mode=
  lt_sid=
  lt_rest=$lt_ms
  while [ -n "$lt_rest" ]; do
    lt_take
    case $lt_t in
      'm '*) [ -n "$lt_mode" ] || lt_mode=${lt_t#m } ;;
      's '*) [ -n "$lt_sid" ] || lt_sid=${lt_t#s } ;;
    esac
  done
  [ -n "$lt_mode" ] || return 0
  lt_old=
  if [ -r "$LT_DIR/mode" ]; then
    IFS= read -r lt_old <"$LT_DIR/mode"
  fi
  [ "$lt_old" != "$lt_mode" ] || return 0
  lt_write "$LT_DIR/mode" "$lt_mode" || return 1
  [ -f "$LT_DIR/active" ] || return 0
  lt_spool "$lt_sid" "{\"v\":1,\"ev\":\"mode\",\"ts\":$(date +%s),\"session_id\":\"$lt_sid\",\"agent_id\":null,\"mode\":\"$lt_mode\"}"
}

watch_prompt() {
  lt_locate || exit 0
  lt_read_input
  # The mode is recorded before any run starts, so the folder may not exist
  # yet. Only the session's own is made here: lt_locate already refused a
  # pointer to a folder that doesn't exist.
  if [ ! -d "$LT_DIR" ]; then
    [ -d "$CLAUDE_PROJECT_DIR" ] || exit 0
    lt_mkdir "$LT_DIR" || lt_note "watch.sh prompt: couldn't make $LT_DIR"
  fi
  watch_mode || lt_note 'watch.sh prompt: couldn'\''t record the mode'
  exit 0
}

watch_agent() {
  echo 'step checking for jq'
  if ! lt_have_jq; then
    printf 'who litter\nfail\n%s\n' "$LT_NOJQ"
    return 0
  fi
  echo 'step reading the hook input'
  lt_id=$(printf '%s' "$LT_IN" | jq -r "$LT_JQ_DEFS"'.agent_id | if okid then . else "" end') || return 1
  lt_file "$LT_DIR/bind/$lt_id"
  lt_bf=$LT_FF lt_bv=$LT_FV
  lt_file "$LT_DIR/agents/$lt_id.json"
  lt_af=$LT_FF lt_av=$LT_FV
  if [ -z "$lt_id" ]; then lt_bf=--arg lt_bv= lt_af=--arg lt_av=; fi
  printf '%s' "$LT_IN" | jq -r --arg refusal "$LT_REFUSAL" "$lt_bf" bind "$lt_bv" "$lt_af" agent "$lt_av" \
    "$LT_JQ_DEFS$WATCH_JQ_POST" || return 1
}

watch_post() {
  lt_begin
  [ -z "$LT_DIR_ERR" ] || exit 0
  case $LT_IN in
    *'"agent_id":"'*) ;;
    *)
      watch_mode || lt_note 'watch.sh post: couldn'\''t record the mode'
      exit 0
      ;;
  esac
  # Only a litter agent, or one the mod bound to a swarm node, has anything
  # to spool: anyone else's result is left alone, without jq.
  lt_raw_litter || lt_raw_node || exit 0
  lt_run watch_agent
  lt_err=
  case $LT_L1 in
    pass) ;;
    fail) lt_note "watch.sh post: $LT_L2" ;;
    spool | handback)
      lt_spool "$LT_L2" "$LT_L4" || lt_err="couldn't spool the end of a call"
      if [ -n "$LT_L5" ] && ! lt_spool "$LT_L2" "$LT_L5"; then
        if [ "$LT_L1" = handback ]; then lt_err="couldn't spool a hand-back"; else lt_err="couldn't spool a lost isolation context"; fi
      fi
      # done/ even when the line didn't go out: a worker held on this agent waits on it.
      if [ "$LT_L1" = handback ] && ! lt_done "$LT_L3" handback; then
        lt_err="couldn't write done/$LT_L3"
      fi
      ;;
    *)
      if [ "$LT_WHO" = litter ] || { [ -z "$LT_WHO" ] && { lt_raw_litter || lt_raw_node; }; }; then
        lt_note "watch.sh post failed: $LT_STEP"
      fi
      ;;
  esac
  [ -z "$lt_err" ] || lt_note "watch.sh post: $lt_err"
  exit 0
}

case ${1:-} in
  prompt) watch_prompt ;;
  post) watch_post ;;
  *) lt_note "watch.sh needs prompt or post, not '${1:-}'" ;;
esac
