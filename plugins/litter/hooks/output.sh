#!/bin/sh
# output.sh: PreToolUse on StructuredOutput (plan section 9, "Observed facts
# beat claimed ones"). For a litter agent it fills the fields the mod observed
# from out/<agent_id>.json, merged over the input's top-level fields with
# updatedInput, and spools the result, so the mod records it once. Anyone
# else's StructuredOutput passes untouched.
#
# Which roles need an out file (sections 7 and 9): the gate critic for its
# verify_id (tests_green), a relay for its verify (exit_code, signal,
# timed_out, green) or its land (landed, commit, reason, retry), the author
# for its version (proposal) and the design critic for its version
# (source_changed). Without one, or with one for another verify_id or
# version, the call is denied with what to record first.

set -u
case $0 in */*) lt_here=${0%/*} ;; *) lt_here=. ;; esac
if [ ! -r "$lt_here/lib.sh" ]; then
  [ -f "${CLAUDE_PROJECT_DIR:-/nonexistent}/.claude/litter/hooks/active" ] || exit 0
  printf 'litter guard failed: loading lib.sh; refusing\n' >&2
  exit 2
fi
. "$lt_here/lib.sh"

OUTPUT_JQ_HEAD='
(.agent_id | str) as $id
| if (.agent_type | str | startswith("litter:")) then
    "who litter\n" + (if $id | okid then "next\n" + $id
      else deny(.; "this StructuredOutput carries no usable agent_id, so litter cannot tell whose result it is; refusing") end)
  else "who other\npass" end
'

# A land relay result (LANDED) has no id of its own to compare, so for it the
# out file only has to say it is for a land (for.land_of).
OUTPUT_JQ='
. as $in
| ($in.agent_id | str) as $id
| ($in.agent_type | str | ltrimstr("litter:")) as $role
| ($in.tool_input | if type == "object" then . else null end) as $ti
| readj($out) as $o
| (if $ti == null then ""
   elif $role == "gate-critic" then "verify_id"
   elif $role == "relay" then (if $ti | has("landed") then "land_of" else "verify_id" end)
   elif $role == "author" or $role == "design-critic" then "version"
   else "" end) as $need
| ($ti // {} | .[$need] // "" | if type == "string" then . else tojson end) as $claimed
| (if $need == "land_of" then "no land recorded by you yet: call mcp__litter__record with kind land, the gate and the verify_id first, then return the mod answer"
   elif $role == "gate-critic" then "no verify recorded by you for verify_id \($claimed | tojson): call mcp__litter__record with kind verify, the gate and the attempt first, then return the verify_id it gives"
   elif $role == "relay" then "no verify recorded by you for verify_id \($claimed | tojson): make the record call your instruction names first, then return the mod answer"
   elif $role == "author" then "no proposal recorded by you for version \($claimed | tojson): record kind proposal first, then return the version it gives"
   else "no verdict recorded by you for version \($claimed | tojson): record kind verdict first, then return" end) as $missing
| def outline($input): {v: 1, ev: "output", ts: ts, session_id: ($in.session_id | str), agent_id: $id,
    agent_type: ($in.agent_type | str), tool_use_id: ($in.tool_use_id | str), input: $input} | tojson;
  if $ti == null then deny($in; "StructuredOutput needs an object as its input")
  elif $out == "" then
    (if $need == "" then ["spool", "-", sid($in), outline($ti)] | join("\n") else deny($in; $missing) end)
  elif ($o | ok1 | not) or ($o.agent_id | str) != $id or ($o.for | type) != "object" or ($o.fields | type) != "object" then
    deny($in; "out/\($id).json is unreadable (\(if ($o | ok1) then "not this agent, or no for or fields" else why($out; $o) end)), so the observed fields cannot be filled; refusing")
  elif $need != "" and ($o.for[$need] | str) == "" then deny($in; $missing)
  else
    [("verify_id", "version") as $k | select(($o.for[$k] | str) != "" and ($o.for[$k] | str) != ($ti[$k] | if type == "string" then . else tojson end)) | $k] as $bad
    | if ($bad | length) > 0 then
        deny($in; "your result gives \($bad[0]) \($ti[$bad[0]] | tojson), but your latest record is for \($o.for[$bad[0]] | tojson): return that \($bad[0]), or record again first")
      else ($ti + $o.fields) as $new
        | ["fill", ({hookSpecificOutput: {hookEventName: "PreToolUse", updatedInput: $new}} | tojson), sid($in), outline($new)] | join("\n")
      end
  end
'

output_work() {
  echo 'step finding the hooks folder'
  if [ -n "$LT_DIR_ERR" ]; then
    lt_cant "$LT_PREFIX can't find litter's hooks folder ($LT_DIR_ERR); refusing"
    return 0
  fi
  echo 'step checking for jq'
  if ! lt_have_jq; then
    lt_cant "$LT_NOJQ"
    return 0
  fi
  echo 'step reading the hook input'
  lt_h=$(printf '%s' "$LT_IN" | jq -r --arg GP "$LT_PREFIX" "$LT_JQ_DEFS$OUTPUT_JQ_HEAD") || return 1
  lt_rest=$lt_h
  lt_take
  printf '%s\n' "$lt_t"
  lt_take
  if [ "$lt_t" != next ]; then
    printf '%s\n%s\n' "$lt_t" "$lt_rest"
    return 0
  fi
  lt_id=$lt_rest
  echo "step reading out/$lt_id.json"
  lt_file "$LT_DIR/out/$lt_id.json"
  printf '%s' "$LT_IN" | jq -r --arg GP "$LT_PREFIX" "$LT_FF" out "$LT_FV" "$LT_JQ_DEFS$OUTPUT_JQ" || return 1
}

lt_begin
lt_run output_work
lt_finish
