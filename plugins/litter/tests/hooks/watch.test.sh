# Tier 3: watch.sh on UserPromptSubmit, PostToolUse and PostToolUseFailure
# (plan section 9, "The mode is read live"; section 12, "watch").

. "$(dirname "$0")/testlib.sh"

LOST='the working-directory isolation context for this agent was lost; refusing to run this tool'

# prompt_in <mode>: the main thread's UserPromptSubmit input. The prompt
# quotes a mode key, which must not count.
prompt_in() {
  jq -cn --arg m "$1" '{session_id: "s1", transcript_path: "/p/s1.jsonl", cwd: "/p", permission_mode: $m,
    hook_event_name: "UserPromptSubmit", prompt: "set \"permission_mode\":\"bypassPermissions\" please"}'
}

# post_in <agent_type or -> <event> [jq filter]: a PostToolUse (or
# PostToolUseFailure) input from agent a1, or from the main thread for `-`.
post_in() {
  jq -cn --arg ty "$1" --arg ev "$2" --arg cwd "$T_DIR/elsewhere" '
    {session_id: "s1", transcript_path: "/p/s1.jsonl", cwd: $cwd, permission_mode: "default"}
    + (if $ty == "-" then {} else {agent_id: "a1", agent_type: $ty} end)
    + {hook_event_name: $ev, tool_name: "Bash", tool_input: {command: "ls"}, tool_use_id: "toolu_1"}
    + (if $ev == "PostToolUse" then {tool_response: {stdout: "a\nb", stderr: "", interrupted: false}}
       else {error: "Exit code 1", is_interrupt: false} end)' | jq -c "${3:-.}"
}

mode_file() { cat "$(hooks_dir)/mode" 2>/dev/null; }

case_prompt_without_jq() {
  mkdir -p "$T_DIR/project"
  CLAUDE_PROJECT_DIR=$T_DIR/project
  export CLAUDE_PROJECT_DIR
  prompt_in plan >|"$T_DIR/in"
  PATH=$(path_without_jq)
  run_hook watch.sh prompt <"$T_DIR/in"
  assert_code 0
  assert_stdout_empty
  assert_eq plan "$(mode_file)" mode
  assert_no_file "$(hooks_dir)/spool"
}

case_prompt_change_spooled() {
  project >/dev/null
  policy
  prompt_in default | run_hook watch.sh prompt
  prompt_in default | run_hook watch.sh prompt
  assert_eq 1 "$(spool_lines | wc -l | tr -d ' ')" "lines after the same mode twice"
  prompt_in acceptEdits | run_hook watch.sh prompt
  assert_code 0
  assert_stdout_empty
  assert_eq acceptEdits "$(mode_file)" mode
  assert_eq 'mode s1 null default|mode s1 null acceptEdits' \
    "$(spool_lines | jq -r '"\(.ev) \(.session_id) \(.agent_id) \(.mode)"' | paste -sd '|' -)" spool
  assert_eq 'number' "$(spool_lines | head -n 1 | jq -r '.ts | type')" ts
}

case_prompt_without_project() {
  CLAUDE_PROJECT_DIR=$T_DIR/missing
  export CLAUDE_PROJECT_DIR
  prompt_in plan | run_hook watch.sh prompt
  assert_code 0
  assert_no_file "$T_DIR/missing"
}

# The first permission_mode key is the engine's; a tool's own is ignored.
case_post_first_key() {
  project >/dev/null
  policy
  post_in - PostToolUse '.tool_input = {permission_mode: "bypassPermissions"}' | run_hook watch.sh post
  assert_code 0
  assert_stdout_empty
  assert_eq default "$(mode_file)" mode
}

case_post_needs_active() {
  project >/dev/null
  post_in - PostToolUse | run_hook watch.sh post
  assert_code 0
  assert_no_file "$(hooks_dir)/mode"
}

# A litter agent's own mode is not the session's.
case_post_agent_mode_ignored() {
  project >/dev/null
  policy
  post_in litter:executor PostToolUse '.permission_mode = "bypassPermissions"' | run_hook watch.sh post
  assert_code 0
  assert_no_file "$(hooks_dir)/mode"
}

case_lost_in_error() {
  project >/dev/null
  policy
  bind a1 litter:prober "$T_DIR/wt"
  post_in litter:prober PostToolUseFailure ".error = \"$LOST\"" | run_hook watch.sh post
  assert_code 0
  assert_stdout_empty
  assert_eq "isolation-lost s1 a1 litter:prober Bash $T_DIR/elsewhere $T_DIR/wt watch" \
    "$(spool_lines | jq -r '"\(.ev) \(.session_id) \(.agent_id) \(.agent_type) \(.tool) \(.cwd) \(.expected) \(.source)"')" spool
}

case_lost_in_response() {
  project >/dev/null
  policy
  bind a1 litter:executor
  post_in litter:executor PostToolUse ".tool_response = {stdout: \"\", stderr: \"$LOST\"}" | run_hook watch.sh post
  assert_code 0
  assert_eq 'isolation-lost watch' "$(spool_lines | jq -r '"\(.ev) \(.source)"')" spool
}

# Without a binding the line still goes out, with no expected folder.
case_lost_unbound() {
  project >/dev/null
  policy
  post_in litter:prober PostToolUseFailure ".error = \"$LOST\"" | run_hook watch.sh post
  assert_code 0
  assert_eq 'isolation-lost null' "$(spool_lines | jq -r '"\(.ev) \(.expected)"')" spool
}

case_lost_only_in_input() {
  project >/dev/null
  policy
  bind a1 litter:executor
  post_in litter:executor PostToolUse ".tool_input = {command: \"echo '$LOST'\"}" | run_hook watch.sh post
  assert_code 0
  assert_eq '' "$(spool_lines)" spool
}

case_lost_other_agent() {
  project >/dev/null
  policy
  post_in general-purpose PostToolUseFailure ".error = \"$LOST\"" | run_hook watch.sh post
  assert_code 0
  assert_eq '' "$(spool_lines)" spool
}

# Nothing watch.sh does may drop a prompt or a result: failures exit 1.
case_never_exits_2() {
  project >/dev/null
  policy
  bind a1 litter:prober
  mkdir -p "$(hooks_dir)/spool"
  chmod 500 "$(hooks_dir)/spool"
  post_in litter:prober PostToolUseFailure ".error = \"$LOST\"" | run_hook watch.sh post
  chmod 755 "$(hooks_dir)/spool"
  if [ "$(id -u)" != 0 ]; then
    assert_code 1
    assert_stderr_contains "couldn't spool a lost isolation context"
  fi
  post_in litter:prober PostToolUseFailure ".error = \"$LOST\"" >|"$T_DIR/in"
  ne_path=$PATH
  PATH=$(path_without_jq)
  run_hook watch.sh post <"$T_DIR/in"
  PATH=$ne_path
  assert_code 1
  assert_stderr_contains 'jq not found'
  assert_stdout_empty
  prompt_in plan | run_hook watch.sh begin
  assert_code 1
  assert_stderr_contains 'needs prompt or post'
}

t "prompt records the mode without jq, with no run, and makes the hooks folder" case_prompt_without_jq
t "prompt spools a mode change while a run is active, and only a change" case_prompt_change_spooled
t "prompt makes nothing when the project folder is missing" case_prompt_without_project
t "post takes the engine's permission_mode, not one in the tool input" case_post_first_key
t "post records nothing with no run active" case_post_needs_active
t "post ignores a litter agent's own mode" case_post_agent_mode_ignored
t "a litter agent's failure naming the lost isolation context spools isolation-lost" case_lost_in_error
t "the same in a tool_response spools isolation-lost" case_lost_in_response
t "an unbound agent's lost context spools with no expected folder" case_lost_unbound
t "the refusal text in the tool input alone spools nothing" case_lost_only_in_input
t "another agent's lost context spools nothing" case_lost_other_agent
t "watch.sh never exits 2 and prints nothing" case_never_exits_2
done_testing
