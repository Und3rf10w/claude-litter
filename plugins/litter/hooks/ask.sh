#!/bin/sh
# ask.sh: PermissionRequest, run as the engine's permission dialog opens for
# any agent, a subagent included (phase 5; COMMON decision 1). For the call of
# a litter run agent, a swarm node or a node's child it spools one `ask` line
# (hookfiles.ts, SpoolLine), which the mod pairs with guard.sh's `call` start
# for the same agent, tool and detail (asks.ts), and the band draws. Owner: WP-CF.
#
# It never decides: it prints nothing on stdout or stderr and exits 0 on every
# path, a failure included (lib.sh or jq missing, bad input, a spool it can't
# write), so the dialog is exactly the engine's. In 2.1.289 a PermissionRequest
# hook decides only through JSON on stdout (hookSpecificOutput.decision,
# cli_formatted_2.1.289.js:488238); empty stdout with exit 0 is a plain
# success, and the dialog goes on (the handler's runHooks, :1320896).
#
# When it runs (2.1.289): after the call's PreToolUse hooks, so guard.sh's
# `call` start is spooled first (:454056, the permission check takes the
# PreToolUse result), and only for a check that ends in `ask`: never for a
# call the rules, auto mode's classifier or dontAsk decide (:1420660,
# :510313). A foreground subagent's (a workflow's) runs beside its dialog
# (:1322737); a background agent's and a teammate's before it (:740671,
# :1512120). So it stays small: one bounded read, one jq, one append.

# Nothing below prints anywhere. The work runs in a subshell, so a failure in
# lib.sh or in a step ends only that, and the script still exits 0.
exec >/dev/null 2>&1

case $0 in */*) lt_here=${0%/*} ;; *) lt_here=. ;; esac

# The session id, then the line; nothing for an input that isn't a litter
# agent's ask. `detail` is what guard.sh's callline puts in the call start for
# the same input (calldetail: a Bash or Monitor command's first 80
# characters), so the two compare equal; for a file tool, its path, cut to
# 120 characters, controls as spaces; else empty. $rid and $bound: the
# caller's raw agent_id, and whether the mod bound it (agents/<id>.json).
ASK_JQ='
. as $in
| ($in.tool_name | str) as $tool
| ($in.tool_input | if type == "object" then . else {} end) as $ti
| if ($in.agent_id | okid | not) or sid($in) == "" or $tool == "" then empty
  elif (($in.agent_type | str | startswith("litter:")) or (($in.agent_id | str) == $rid and $bound == "1")) | not then empty
  else
    (if $tool == "Bash" or $tool == "Monitor" then calldetail($in)
     else (if ($ti.file_path | type) == "string" then $ti.file_path else $ti.notebook_path end)
       | str | .[0:120] | gsub("[[:cntrl:]]"; " ") end) as $d
    | sid($in), ({v: 1, ev: "ask", ts: ts, session_id: sid($in), agent_id: $in.agent_id,
        agent_type: ($in.agent_type | str | orNull), tool: $tool, detail: $d,
        mode: ($in.permission_mode | str | orNull)} | tojson)
  end
'

ask_main() {
  [ -r "$lt_here/lib.sh" ] || return 0
  . "$lt_here/lib.sh" || return 0
  # With nothing active and no binding, this exits before the input is read.
  lt_begin
  [ -z "$LT_DIR_ERR" ] && [ -z "$LT_CUT" ] || return 0
  # The main thread's input has no agent_id; an agent that's neither litter's
  # nor bound goes too, and neither costs a jq.
  case $LT_IN in *'"agent_id":"'*) ;; *) return 0 ;; esac
  lt_raw_litter || lt_raw_node || return 0
  lt_have_jq || return 0
  ask_rid=$(lt_raw_agent_id) || ask_rid=
  ask_bound=
  if [ -n "$ask_rid" ] && [ -f "$LT_DIR/agents/$ask_rid.json" ]; then ask_bound=1; fi
  ask_out=$(printf '%s' "$LT_IN" | jq -r --arg rid "$ask_rid" --arg bound "$ask_bound" "$LT_JQ_DEFS$ASK_JQ") || return 0
  lt_rest=$ask_out
  lt_take
  ask_sid=$lt_t
  lt_take
  [ -n "$lt_t" ] || return 0
  lt_spool "$ask_sid" "$lt_t" || return 0
}

(ask_main)
exit 0
