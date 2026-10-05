# Tier 3: ask.sh, PermissionRequest (phase 5; COMMON decision 1). Whatever its
# input, or none, it prints nothing and exits 0, so the permission dialog is
# exactly the engine's; and hooks.json runs it on every PermissionRequest.
# WP-CA wrote these against the stub; CF's ask.sh keeps them passing.

. "$(dirname "$0")/testlib.sh"

# perm_in <agent_type> <tool> <tool_input JSON>: a PermissionRequest input from
# agent a1 of that type, or from the main thread for `-`.
perm_in() {
  jq -cn --arg ty "$1" --arg tool "$2" --argjson ti "$3" --arg cwd "$T_DIR/project" '
    {session_id: "s1", transcript_path: "/tmp/t.jsonl", cwd: $cwd, permission_mode: "default"}
    + (if $ty == "-" then {} else {agent_id: "a1", agent_type: $ty} end)
    + {hook_event_name: "PermissionRequest", tool_name: $tool, tool_input: $ti,
       permission_suggestions: [{type: "addRules", rules: [{toolName: $tool}], behavior: "allow", destination: "session"}]}'
}

# silent: ask.sh's answer is no answer at all.
silent() {
  assert_code 0
  assert_stdout_empty
  [ ! -s "$T_DIR/err" ] || fail "stderr not empty: $(cat "$T_DIR/err")"
}

case_litter_agent() {
  project >/dev/null
  policy
  bind a1 litter:executor
  perm_in litter:executor Bash '{"command": "npm install left-pad"}' | run_hook ask.sh
  silent
}

case_other_callers() {
  project >/dev/null
  policy
  perm_in - Bash '{"command": "rm -rf build"}' | run_hook ask.sh
  silent
  perm_in general-purpose Write '{"file_path": "/tmp/x", "content": "y"}' | run_hook ask.sh
  silent
}

case_no_project() {
  # No litter directory at all: nothing to spool into.
  CLAUDE_PROJECT_DIR=$T_DIR/nowhere
  export CLAUDE_PROJECT_DIR
  perm_in litter:executor Bash '{"command": "make"}' | run_hook ask.sh
  silent
}

case_no_input() {
  project >/dev/null
  policy
  run_hook ask.sh </dev/null
  silent
  printf '' | run_hook ask.sh
  silent
  # Its stdin closed.
  run_hook ask.sh <&-
  silent
}

case_bad_input() {
  project >/dev/null
  policy
  printf 'not json {' | run_hook ask.sh
  silent
  printf '[1, 2, 3]\n' | run_hook ask.sh
  silent
  printf '{"agent_id": 7, "tool_name": null, "tool_input": "x"}\n' | run_hook ask.sh
  silent
}

case_large_input() {
  project >/dev/null
  policy
  bind a1 litter:executor
  big=$(awk 'BEGIN { for (i = 0; i < 4000; i++) printf "echo %d && ", i; print "true" }')
  perm_in litter:executor Bash "$(jq -cn --arg c "$big" '{command: $c}')" | run_hook ask.sh
  silent
}

case_no_jq() {
  project >/dev/null
  policy
  bind a1 litter:executor
  perm_in litter:executor Bash '{"command": "npm test"}' >|"$T_DIR/in"
  PATH=$(path_without_jq)
  run_hook ask.sh <"$T_DIR/in"
  silent
}

# The hook entry (WP-CA): one command hook on PermissionRequest, with no
# matcher (an ask of any tool), exec form, and a 5 s limit.
case_wired() {
  hj=$LITTER_ROOT/hooks/hooks.json
  assert_eq '1' "$(jq -r '.hooks.PermissionRequest | length' "$hj")" 'PermissionRequest entries'
  assert_eq 'null' "$(jq -r '.hooks.PermissionRequest[0].matcher' "$hj")" 'matcher'
  assert_eq '1' "$(jq -r '.hooks.PermissionRequest[0].hooks | length' "$hj")" 'hooks in the entry'
  assert_eq 'command sh ${CLAUDE_PLUGIN_ROOT}/hooks/ask.sh 5' \
    "$(jq -r '.hooks.PermissionRequest[0].hooks[0] | "\(.type) \(.command) \(.args | join(" ")) \(.timeout)"' "$hj")" 'the hook'
}

t "a litter agent's ask: nothing printed, exit 0" case_litter_agent
t "the main thread's and another agent's ask: nothing printed, exit 0" case_other_callers
t "no litter directory: nothing printed, exit 0" case_no_project
t "no input: nothing printed, exit 0" case_no_input
t "input that isn't a PermissionRequest: nothing printed, exit 0" case_bad_input
t "a long command: nothing printed, exit 0" case_large_input
t "no jq on PATH: nothing printed, exit 0" case_no_jq
t "hooks.json runs ask.sh on every PermissionRequest, exec form, 5 s" case_wired
done_testing
