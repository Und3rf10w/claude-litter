#!/bin/sh
# output.sh: PreToolUse on StructuredOutput (plan section 9, "Observed facts
# beat claimed ones"). For a litter agent it fills the fields the mod observed
# from out/<agent_id>.json, merged over the input's top-level fields with
# updatedInput, and spools the result, so the mod records it once. Anyone
# else's StructuredOutput passes untouched.
#
# Which roles need an out file (sections 7 and 9): the gate critic and the
# fanout verifier for their verify_id (tests_green), a relay for its verify
# (exit_code, signal, timed_out, green), its land (landed, commit, reason,
# retry) or its integrate (the mod's answer, by integrate_id), the author for
# its version (proposal) and the design critic for its version
# (source_changed). Without one, or with one for another verify_id, version
# or integrate_id, the call is denied with what to record first.
#
# A fanout writer (section 7, fanout.js step 2) needs none. Unbound (no
# agents/<agent_id>.json with its task), it may only report that it is
# blocked, and gets the observed unbound: true and, from an out file with an
# empty `for`, the task.bind refusal the mod recorded. Bound, it gets the out
# file's fields if there is one, but for those two. Either way the result is
# spooled.

set -u
case $0 in */*) lt_here=${0%/*} ;; *) lt_here=. ;; esac
if [ ! -r "$lt_here/lib.sh" ]; then
  # hooks/ is the checkout top's, the first folder up with a .git (lib.sh's lt_locate).
  lt_d=${CLAUDE_PROJECT_DIR:-/nonexistent}
  lt_d=${lt_d%/}
  lt_t=$lt_d
  while [ -n "$lt_t" ] && [ ! -e "$lt_t/.git" ]; do lt_t=${lt_t%/*}; done
  [ -z "$lt_t" ] || lt_d=$lt_t
  [ -f "$lt_d/.claude/litter/hooks/active" ] || exit 0
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
# out file only has to say it is for a land (for.land_of). An integrate relay
# result carries the integrate_id the mod gave it.
OUTPUT_JQ='
. as $in
| ($in.agent_id | str) as $id
| ($in.agent_type | str | ltrimstr("litter:")) as $role
| ($in.tool_input | if type == "object" then . else null end) as $ti
| readj($out) as $o
| readj($pol) as $p
| readj($agent) as $a
| ($role == "executor" and ($p | ok1) and ($p.run | type) == "object" and ($p.run.workflow | str) == "fanout") as $fw
| ($fw and ($a | ok1) and ($a.task | type) == "object" and ($a.task.id | str) != ""
    and ($a.run == null or ($a.run | str) == ($p.run.run | str))) as $bound
| (if $ti == null then ""
   elif $role == "gate-critic" or $role == "verifier" then "verify_id"
   elif $role == "relay" then (if $ti | has("landed") then "land_of" elif $ti | has("integrate_id") then "integrate_id" else "verify_id" end)
   elif $role == "author" or $role == "design-critic" then "version"
   else "" end) as $need
| ($ti // {} | .[$need] // "" | if type == "string" then . else tojson end) as $claimed
| (if $need == "land_of" then "no land recorded by you yet: call mcp__litter__record with kind land, the gate and the verify_id first, then return the mod answer"
   elif $need == "integrate_id" then "no integrate recorded by you for integrate_id \($claimed | tojson): call mcp__litter__record with kind integrate first, then return the mod answer"
   elif $role == "gate-critic" then "no verify recorded by you for verify_id \($claimed | tojson): call mcp__litter__record with kind verify, the gate and the attempt first, then return the verify_id it gives"
   elif $role == "verifier" then "no verify recorded by you for verify_id \($claimed | tojson): call mcp__litter__record with kind verify, gate integration and attempt 1 first, then return the verify_id it gives"
   elif $role == "relay" then "no verify recorded by you for verify_id \($claimed | tojson): make the record call your instruction names first, then return the mod answer"
   elif $role == "author" then "no proposal recorded by you for version \($claimed | tojson): record kind proposal first, then return the version it gives"
   else "no verdict recorded by you for version \($claimed | tojson): record kind verdict first, then return" end) as $missing
| def outline($input): {v: 1, ev: "output", ts: ts, session_id: ($in.session_id | str), agent_id: $id,
    agent_type: ($in.agent_type | str), tool_use_id: ($in.tool_use_id | str), input: $input} | tojson;
  def fill($new): ["fill", ({hookSpecificOutput: {hookEventName: "PreToolUse", updatedInput: $new}} | tojson), sid($in), outline($new)] | join("\n");
  def outok: ($o | ok1) and ($o.agent_id | str) == $id and ($o.for | type) == "object" and ($o.fields | type) == "object";
  def badout: deny($in; "out/\($id).json is unreadable (\(if ($o | ok1) then "not this agent, or no for or fields" else why($out; $o) end)), so the observed fields cannot be filled; refusing");
  if $ti == null then deny($in; "StructuredOutput needs an object as its input")
  elif $role == "executor" and ($p | ok1 | not) then
    deny($in; "policy.json is unreadable (\(why($pol; $p))), so this result cannot be checked; refusing until the mod rewrites it")
  elif $fw and $agent != "" and ($a | ok1 | not) then
    deny($in; "agents/\($id).json is unreadable (\(why($agent; $a))), so the task this writer is bound to cannot be read; refusing")
  elif $fw and ($bound | not) then
    # Unbound: a blocked result alone, so it cannot claim any task work (section 7, fanout.js step 2).
    if $ti.status == "blocked" and $ti.files == [] and $ti.checks == [] and (($ti.summary | str | gsub("\\s"; "")) != "") then
      if $out != "" and (outok | not) then badout
      else (if $out != "" and ([$o.for[] | str] | all(. == "")) then ($o.fields.bind_refusal | str) else "" end) as $refusal
        | fill(($ti | del(.bind_refusal)) + {unbound: true} + (if $refusal != "" then {bind_refusal: $refusal} else {} end))
      end
    else deny($in; "bind first; only a blocked result is accepted unbound: return status blocked, files [], checks [] and the task.bind refusal as the summary") end
  elif $fw then
    # Bound: unbound and bind_refusal are observed, never claimed, and a
    # refusal left from before the bind no longer holds.
    if $out != "" and (outok | not) then badout
    else (($ti | del(.unbound, .bind_refusal)) + (if $out == "" then {} else $o.fields | del(.unbound, .bind_refusal) end)) as $new
      | if $new == $ti then ["spool", "-", sid($in), outline($ti)] | join("\n") else fill($new) end
    end
  elif $out == "" then
    (if $need == "" then ["spool", "-", sid($in), outline($ti)] | join("\n") else deny($in; $missing) end)
  elif (outok | not) then badout
  elif $need != "" and ($o.for[$need] | str) == "" then deny($in; $missing)
  else
    [("verify_id", "version", "integrate_id") as $k | select(($o.for[$k] | str) != "" and ($o.for[$k] | str) != ($ti[$k] | if type == "string" then . else tojson end)) | $k] as $bad
    | if ($bad | length) > 0 then
        deny($in; "your result gives \($bad[0]) \($ti[$bad[0]] | tojson), but your latest record is for \($o.for[$bad[0]] | tojson): return that \($bad[0]), or record again first")
      else fill($ti + $o.fields) end
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
  echo "step reading out/$lt_id.json, policy.json and agents/$lt_id.json"
  lt_file "$LT_DIR/out/$lt_id.json"
  lt_of=$LT_FF lt_ov=$LT_FV
  lt_file "$LT_DIR/policy.json"
  lt_pf=$LT_FF lt_pv=$LT_FV
  lt_file "$LT_DIR/agents/$lt_id.json"
  printf '%s' "$LT_IN" | jq -r --arg GP "$LT_PREFIX" "$lt_of" out "$lt_ov" "$lt_pf" pol "$lt_pv" "$LT_FF" agent "$LT_FV" \
    "$LT_JQ_DEFS$OUTPUT_JQ" || return 1
}

lt_begin
lt_run output_work
lt_finish
