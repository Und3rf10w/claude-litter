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

# Builds the isolation-lost line, or passes: only a litter agent counts, and
# only when the refusal is in the call's result, not its input.
WATCH_JQ_LOST='
. as $in
| readj($bind) as $b
| if ($in.agent_type | str | startswith("litter:")) | not then "who other\npass"
  elif ((($in.error | str) + "\n" + ($in.tool_response | if type == "string" then . else tojson end))
        | contains($refusal)) | not then "who litter\npass"
  else "who litter\nspool\n-\n" + sid($in) + "\n"
    + ({v: 1, ev: "isolation-lost", ts: ts, session_id: ($in.session_id | str), agent_id: ($in.agent_id | str),
        agent_type: $in.agent_type, tool: ($in.tool_name | str), cwd: ($in.cwd | str),
        expected: (if $b | ok1 then $b.cwd | str | orNull else null end), source: "watch"} | tojson)
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

watch_lost() {
  echo 'step checking for jq'
  if ! lt_have_jq; then
    lt_raw_litter && printf 'who litter\nfail\n%s\n' "$LT_NOJQ"
    return 0
  fi
  echo 'step reading the hook input'
  lt_id=$(printf '%s' "$LT_IN" | jq -r "$LT_JQ_DEFS"'.agent_id | if okid then . else "" end') || return 1
  lt_file "$LT_DIR/bind/$lt_id"
  [ -n "$lt_id" ] || { LT_FF=--arg; LT_FV=; }
  printf '%s' "$LT_IN" | jq -r --arg refusal "$LT_REFUSAL" "$LT_FF" bind "$LT_FV" "$LT_JQ_DEFS$WATCH_JQ_LOST" || return 1
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
  case $LT_IN in *"$LT_REFUSAL"*) ;; *) exit 0 ;; esac
  lt_run watch_lost
  case $LT_L1 in
    pass) ;;
    fail) lt_note "watch.sh post: $LT_L2" ;;
    spool) lt_spool "$LT_L3" "$LT_L4" || lt_note 'watch.sh post: couldn'\''t spool a lost isolation context' ;;
    *)
      if [ "$LT_WHO" = litter ] || { [ -z "$LT_WHO" ] && lt_raw_litter; }; then
        lt_note "watch.sh post failed: $LT_STEP"
      fi
      ;;
  esac
  exit 0
}

case ${1:-} in
  prompt) watch_prompt ;;
  post) watch_post ;;
  *) lt_note "watch.sh needs prompt or post, not '${1:-}'" ;;
esac
