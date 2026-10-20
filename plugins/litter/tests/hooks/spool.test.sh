# Tier 3: the spool lines and markers the swarm reads (plan 15.4, "Ending",
# step 2; hookfiles.ts): guard.sh's `call` start and `deny`, watch.sh's `call`
# end and `handback` with done/, hold.sh's done/, for nodes, children and run
# agents only, and a spool that fails never changing a decision.

. "$(dirname "$0")/testlib.sh"

LEAD=litter:sw-s-lead

# post <agent_id or -> <agent_type> <event> <tool> [jq filter]: a PostToolUse
# (or PostToolUseFailure) input in the engine's key order, from that agent,
# or the main thread for `-`.
post() {
  jq -cn --arg id "$1" --arg ty "$2" --arg ev "$3" --arg tool "$4" '
    {session_id: "s1", transcript_path: "/p/s1.jsonl", cwd: "/p", permission_mode: "default"}
    + (if $id == "-" then {} else {agent_id: $id, agent_type: $ty} end)
    + {hook_event_name: $ev, tool_name: $tool, tool_input: {command: "ls"}, tool_use_id: "toolu_2"}
    + (if $ev == "PostToolUse" then {tool_response: {stdout: "", stderr: "", interrupted: false}}
       else {error: "Exit code 1", is_interrupt: false} end)' | jq -c "${5:-.}"
}

# The spool's lines of one kind, as "<field> <field>…": lines <ev> <jq string>.
lines() { spool_lines | jq -r --arg ev "$1" "select(.ev == \$ev) | $2" | paste -sd '|' -; }

handback_in() {
  post a1 "$LEAD" PostToolUse SubagentHandback \
    ".tool_input = {message: $(jq -cn --arg m "$1" '$m')} | .tool_response = {success: ${2:-true}, message: \"Report delivered.\"}"
}

# --- guard.sh -------------------------------------------------------------------

case_call_start() {
  swarm_setup
  node_policy c1 '.kind = "child" | .of = "a1" | .parent = "a1" | .n = 0'
  call "$LEAD" Read '{"file_path":"/x"}' | run_hook guard.sh
  assert_pass
  as_agent c1 call general-purpose Grep '{"pattern":"x"}' | run_hook guard.sh
  assert_pass
  assert_eq 'call start s1 a1 litter:sw-s-lead Read toolu_1|call start s1 c1 general-purpose Grep toolu_1' \
    "$(lines call '"\(.ev) \(.phase) \(.session_id) \(.agent_id) \(.agent_type) \(.tool) \(.tool_use_id)"')" "call lines"
  assert_eq 'number|number' "$(lines call '.ts | type')" ts
}

# A Bash start carries its command (cut, one line) for the /clear hold's ask; other tools carry none.
case_call_start_detail() {
  swarm_setup
  bash_call "$LEAD" 'npm test
  -- --watch=false' | run_hook guard.sh
  assert_pass
  call "$LEAD" Read '{"file_path":"/x"}' | run_hook guard.sh
  assert_pass
  assert_eq 'Bash npm test   -- --watch=false|Read none' "$(lines call '"\(.tool) \(.detail // "none")"')" "details"
}

case_call_start_run_agent() {
  project >/dev/null
  policy
  bind a1 litter:executor
  call litter:executor Read "$(jq -cn --arg p "$T_DIR/project/x" '{file_path: $p}')" | run_hook guard.sh
  assert_pass
  write_call litter:executor "$T_DIR/project/a.py" | run_hook guard.sh
  assert_pass
  assert_eq 'start Read|start Write' "$(lines call '"\(.phase) \(.tool)"')" "call lines"
}

# A denial spools its deny line, which closes the call: no start.
case_deny_line() {
  swarm_setup
  bash_call "$LEAD" 'git push' | run_hook guard.sh
  assert_deny 'git push is denied'
  call "$LEAD" EnterWorktree '{"name":"x"}' | run_hook guard.sh
  assert_deny
  assert_eq '' "$(lines call .phase)" "no call start"
  assert_eq 'a1 litter:sw-s-lead Bash toolu_1|a1 litter:sw-s-lead EnterWorktree toolu_1' \
    "$(lines deny '"\(.agent_id) \(.agent_type) \(.tool) \(.tool_use_id)"')" "deny lines"
  assert_contains 'litter guard: git push is denied to swarm nodes' "$(lines deny .reason)" reason
}

case_no_lines_for_others() {
  swarm_setup
  call - Read '{"file_path":"/x"}' | run_hook guard.sh
  assert_pass
  as_agent o1 bash_call general-purpose 'git push' | run_hook guard.sh
  assert_pass
  call general-purpose Read '{}' '.agent_id = "f1" | .agent_type = ""' | run_hook guard.sh
  assert_pass
  post - '' PostToolUse Bash | run_hook watch.sh post
  post o1 general-purpose PostToolUse Bash | run_hook watch.sh post
  assert_code 0
  assert_eq '' "$(lines call .phase)" "call lines"
}

# --- watch.sh -------------------------------------------------------------------

case_call_end() {
  swarm_setup
  node_policy c1 '.kind = "child" | .of = "a1" | .parent = "a1" | .n = 0'
  post a1 "$LEAD" PostToolUse Read | run_hook watch.sh post
  assert_code 0
  assert_stdout_empty
  post a1 "$LEAD" PostToolUseFailure Bash | run_hook watch.sh post
  post c1 Explore PostToolUse Bash '.tool_response.backgroundTaskId = "bash_7"' | run_hook watch.sh post
  post a1 "$LEAD" PostToolUse Monitor '.tool_response = {taskId: "mon_3", status: "started"}' | run_hook watch.sh post
  assert_code 0
  assert_eq 'end a1 Read false null|end a1 Bash true null|end c1 Bash false bash_7|end a1 Monitor false mon_3' \
    "$(lines call '"\(.phase) \(.agent_id) \(.tool) \(.failed) \(.shell)"')" "call ends"
  assert_eq 's1 toolu_2 Explore' "$(lines call 'select(.agent_id == "c1") | "\(.session_id) \(.tool_use_id) \(.agent_type)"')" fields
}

# R3: a bound agent's background shells and monitors go to its own
# shells/<agent_id>, one id per line, which hold.sh counts at its stop.
case_shells_file() {
  swarm_setup
  node_policy c1 '.kind = "child" | .of = "a1" | .parent = "a1" | .n = 0'
  sh_dir=$(hooks_dir)/shells
  post c1 Explore PostToolUse Bash '.tool_response.backgroundTaskId = "bash_7"' | run_hook watch.sh post
  post a1 "$LEAD" PostToolUse Monitor '.tool_response = {taskId: "mon_3", status: "started"}' | run_hook watch.sh post
  post a1 "$LEAD" PostToolUse Bash '.tool_response.backgroundTaskId = "bash_8"' | run_hook watch.sh post
  # A foreground call, and an id no file name can hold, add nothing.
  post a1 "$LEAD" PostToolUse Bash | run_hook watch.sh post
  post a1 "$LEAD" PostToolUse Bash '.tool_response.backgroundTaskId = "../x y"' | run_hook watch.sh post
  assert_code 0
  assert_eq 'bash_7' "$(cat "$sh_dir/c1")" shells/c1
  assert_eq 'mon_3|bash_8' "$(paste -sd '|' - <"$sh_dir/a1")" shells/a1
  # A run agent's are no node's.
  rm -rf "$(hooks_dir)"
  project >/dev/null
  policy
  bind a1 litter:executor
  post a1 litter:executor PostToolUse Bash '.tool_response.backgroundTaskId = "bash_9"' | run_hook watch.sh post
  assert_code 0
  assert_no_file "$(hooks_dir)/shells"
  assert_eq 'bash_9' "$(lines call .shell)" "the run agent's call end"
}

# R10: with date failing, a blob still gets a name the mod takes, and the mode line a number.
case_date_fails() {
  swarm_setup
  df_old=$PATH
  PATH=$(fake_tool date 'exit 1'):$PATH
  handback_in "$(jq -rn '[range(0; 500)] | map("line \(.)") | join("\n")')" | run_hook watch.sh post
  df_code=$(cat "$T_DIR/code")
  jq -cn '{session_id: "s1", transcript_path: "/t", cwd: "/p", permission_mode: "plan",
    hook_event_name: "UserPromptSubmit", prompt: "hi"}' | run_hook watch.sh prompt
  df_prompt=$(cat "$T_DIR/code")
  PATH=$df_old
  assert_eq 0 "$df_code" "watch.sh post's exit"
  assert_eq 0 "$df_prompt" "watch.sh prompt's exit"
  df_file=$(lines handback .file)
  printf '%s\n' "$df_file" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$' || fail "the blob name the mod rejects: $df_file"
  assert_file "$(hooks_dir)/spool/blobs/$df_file"
  assert_eq 'plan 0' "$(lines mode '"\(.mode) \(.ts)"')" "the mode line"
}

case_handback() {
  swarm_setup
  handback_in 'all three threads resolved; see the commits' | run_hook watch.sh post
  assert_code 0
  assert_stdout_empty
  assert_eq 'a1 litter:sw-s-lead toolu_2 all three threads resolved; see the commits' \
    "$(lines handback '"\(.agent_id) \(.agent_type) \(.tool_use_id) \(.message)"')" "handback line"
  assert_eq 'end SubagentHandback' "$(lines call '"\(.phase) \(.tool)"')" "the call's end"
  assert_eq '1 handback number' "$(jq -r '"\(.v) \(.via) \(.at | type)"' "$(hooks_dir)/done/a1")" done/a1
}

case_handback_refused() {
  swarm_setup
  handback_in 'early' false | run_hook watch.sh post
  post a1 "$LEAD" PostToolUseFailure SubagentHandback | run_hook watch.sh post
  assert_code 0
  assert_eq '' "$(lines handback .message)" "handback lines"
  assert_no_file "$(hooks_dir)/done/a1"
  # A run agent's hand-back is no node's.
  rm -rf "$(hooks_dir)"
  project >/dev/null
  policy
  post a1 litter:executor PostToolUse SubagentHandback '.tool_response = {success: true}' | run_hook watch.sh post
  assert_no_file "$(hooks_dir)/done/a1"
  assert_eq '' "$(lines handback .message)" "a run agent's"
}

case_handback_blob() {
  swarm_setup
  hb_msg=$(jq -rn '[range(0; 500)] | map("line \(.)") | join("\n")')
  handback_in "$hb_msg" | run_hook watch.sh post
  assert_code 0
  hb_file=$(lines handback .file)
  [ -n "$hb_file" ] && [ "$hb_file" != null ] || fail "no blob named: $(spool_lines)"
  assert_eq 'null' "$(lines handback .message)" "no message in the line"
  assert_eq "$hb_msg" "$(jq -r .message "$(hooks_dir)/spool/blobs/$hb_file")" "the blob's message"
  assert_eq 'a1 toolu_2' "$(lines handback '"\(.agent_id) \(.tool_use_id)"')" "the line keeps the ids"
  assert_file "$(hooks_dir)/done/a1"
}

# --- hold.sh --------------------------------------------------------------------

case_done_from_hold() {
  swarm_setup
  node_policy w1 '.kind = "worker" | .parent = "a1" | .type = "litter:sw-s-fixer"'
  node_policy c1 '.kind = "child" | .parent = "w1" | .of = "w1" | .n = 0'
  # Held, at the cap: no done/.
  LT_HOLD_CAP=0
  export LT_HOLD_CAP
  stop_input w1 litter:sw-s-fixer | run_hook hold.sh
  assert_no_file "$(hooks_dir)/done/w1"
  assert_eq 'held|timeout' "$(lines hold .phase)" "hold lines"
  # The child stops with nothing running: done/c1, then the worker's.
  stop_input c1 general-purpose | run_hook hold.sh
  assert_eq stop "$(jq -r .via "$(hooks_dir)/done/c1")" done/c1
  stop_input w1 litter:sw-s-fixer | run_hook hold.sh
  assert_eq stop "$(jq -r .via "$(hooks_dir)/done/w1")" done/w1
}

# --- a spool that fails -----------------------------------------------------------

case_spool_fails() {
  [ "$(id -u)" != 0 ] || return 0
  swarm_setup
  mkdir -p "$(hooks_dir)/spool"
  chmod 500 "$(hooks_dir)/spool"
  call "$LEAD" Read '{}' | run_hook guard.sh
  sf_pass=$(cat "$T_DIR/code")
  bash_call "$LEAD" 'git push' | run_hook guard.sh
  sf_deny=$(cat "$T_DIR/out")
  handback_in 'done' | run_hook watch.sh post
  sf_watch=$(cat "$T_DIR/code")
  sf_err=$(cat "$T_DIR/err")
  chmod 755 "$(hooks_dir)/spool"
  assert_eq 0 "$sf_pass" "the pass"
  assert_contains '"permissionDecision":"deny"' "$sf_deny" "the deny"
  assert_eq 1 "$sf_watch" "watch.sh's exit"
  assert_contains "couldn't spool a hand-back" "$sf_err" stderr
  assert_file "$(hooks_dir)/done/a1"
  assert_eq '' "$(spool_lines)" "no lines"
}

t "guard.sh spools a call start for a node's and a child's call it passes" case_call_start
t "a Bash start carries its command, cut to one line; a Read start none" case_call_start_detail
t "guard.sh spools a call start for a run agent's call it passes" case_call_start_run_agent
t "a denial spools a deny line and no start" case_deny_line
t "no call lines for the main thread, an unrelated agent or a fork" case_no_lines_for_others
t "watch.sh spools a call end, failed and shell from Bash and Monitor" case_call_end
t "a bound agent's background shells go to its own shells file, a run agent's nowhere" case_shells_file
t "with date failing, a blob name and the mode line are still valid" case_date_fails
t "a delivered hand-back spools its message, then done/" case_handback
t "a refused or failed hand-back, or a run agent's, spools none and marks nothing" case_handback_refused
t "a long hand-back goes to a blob" case_handback_blob
t "hold.sh writes done/ at a stop it lets go, none at one it holds" case_done_from_hold
t "a spool that fails changes no decision, and done/ is still written" case_spool_fails
done_testing
