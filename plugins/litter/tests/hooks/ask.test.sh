# Tier 3: ask.sh, PermissionRequest (phase 5; COMMON decision 1). Whatever its
# input, or none, it prints nothing and exits 0, so the permission dialog is
# exactly the engine's; for a litter run agent, a swarm node or a node's
# child it spools one `ask` line whose detail is what guard.sh's call start
# carries for the same input; and hooks.json runs it on every
# PermissionRequest. WP-CA's stub cases (askstub.test.sh) are folded in here.

. "$(dirname "$0")/testlib.sh"

# perm_in <agent_type> <tool> <tool_input JSON> [jq filter]: a PermissionRequest
# input from agent a1 of that type, or from the main thread for `-`, the base
# fields first as the engine writes them.
perm_in() {
  jq -cn --arg ty "$1" --arg tool "$2" --argjson ti "$3" --arg cwd "$T_DIR/project" '
    {session_id: "s1", transcript_path: "/tmp/t.jsonl", cwd: $cwd, permission_mode: "default"}
    + (if $ty == "-" then {} else {agent_id: "a1", agent_type: $ty} end)
    + {hook_event_name: "PermissionRequest", tool_name: $tool, tool_input: $ti,
       permission_suggestions: [{type: "addRules", rules: [{toolName: $tool}], behavior: "allow", destination: "session"}]}' |
    jq -c "${4:-.}"
}

perm_bash() { perm_in "$1" Bash "$(jq -cn --arg c "$2" '{command: $c}')" "${3:-.}"; }

# silent: ask.sh's answer is no answer at all.
silent() {
  assert_code 0
  assert_stdout_empty
  [ ! -s "$T_DIR/err" ] || fail "stderr not empty: $(cat "$T_DIR/err")"
}

# The spool's ask lines, compact, one per line.
ask_lines() { spool_lines | jq -c 'select(.ev == "ask")'; }
no_ask() { [ -z "$(ask_lines)" ] || fail "an ask was spooled: $(ask_lines)"; }

# A fake jq that leaves a mark when it runs, first on PATH.
jq_marker() {
  fake_tool jq ": >>\"$T_DIR/jq-ran\"; exit 1"
}

case_run_agent() {
  project >/dev/null
  policy
  bind a1 litter:executor
  perm_bash litter:executor 'npm install left-pad' | run_hook ask.sh
  silent
  assert_eq 1 "$(ask_lines | wc -l | tr -d ' ')" 'ask lines'
  assert_eq '{"v":1,"ev":"ask","session_id":"s1","agent_id":"a1","agent_type":"litter:executor","tool":"Bash","detail":"npm install left-pad","mode":"default"}' \
    "$(ask_lines | jq -c 'del(.ts)')" 'the line'
  assert_eq number "$(ask_lines | jq -r '.ts | type')" 'ts'
}

# The detail is what guard.sh's callline writes for the same Bash input:
# the first 80 characters, controls as spaces.
case_detail_matches_call() {
  project >/dev/null
  policy
  bind a1 litter:executor
  cmd=$(printf 'echo one\ttwo && echo %s' 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz')
  bash_call litter:executor "$cmd" | run_hook guard.sh
  assert_pass
  started=$(spool_lines | jq -r 'select(.ev == "call" and .phase == "start") | .detail')
  [ -n "$started" ] || fail "guard.sh spooled no call start: $(spool_lines)"
  perm_bash litter:executor "$cmd" | run_hook ask.sh
  silent
  assert_eq "$started" "$(ask_lines | jq -r .detail)" 'detail'
  assert_eq 80 "$(ask_lines | jq -r '.detail | length')" 'detail length'
  assert_not_contains "$(printf '\t')" "$(ask_lines | jq -r .detail)" 'detail'
}

case_monitor_detail() {
  project >/dev/null
  policy
  bind a1 litter:executor
  perm_in litter:executor Monitor '{"command": "tail -f build.log", "description": "build"}' | run_hook ask.sh
  silent
  assert_eq 'Monitor|tail -f build.log' "$(ask_lines | jq -r '"\(.tool)|\(.detail)"')" 'Monitor detail'
}

# A file tool's detail is its path, cut to 120 characters, controls as spaces;
# a tool with neither a command nor a path has none.
case_file_and_other_details() {
  project >/dev/null
  policy
  bind a1 litter:executor
  # 76 characters, a newline, then 72 more.
  long=$(awk 'BEGIN { s = "/repo/"; for (i = 0; i < 70; i++) s = s "d"; s = s "\nx/"; for (i = 0; i < 70; i++) s = s "f"; print s }')
  perm_in litter:executor Write "$(jq -cn --arg p "$long" '{file_path: $p, content: "x"}')" | run_hook ask.sh
  silent
  perm_in litter:executor NotebookEdit '{"notebook_path": "/repo/n.ipynb", "new_source": "x"}' | run_hook ask.sh
  silent
  perm_in litter:executor WebFetch '{"url": "https://example.com", "prompt": "read it"}' | run_hook ask.sh
  silent
  assert_eq 3 "$(ask_lines | wc -l | tr -d ' ')" 'ask lines'
  want=$(jq -rn --arg p "$long" '$p | .[0:120] | gsub("\n"; " ")')
  assert_eq "$want" "$(ask_lines | jq -r 'select(.tool == "Write") | .detail')" 'Write detail'
  assert_eq 120 "$(ask_lines | jq -r 'select(.tool == "Write") | .detail | length')" 'Write detail length'
  assert_eq /repo/n.ipynb "$(ask_lines | jq -r 'select(.tool == "NotebookEdit") | .detail')" 'NotebookEdit detail'
  assert_eq '' "$(ask_lines | jq -r 'select(.tool == "WebFetch") | .detail')" 'WebFetch detail'
}

# An input with no permission_mode, and no agent_type on the line it gives: null.
case_mode_null() {
  project >/dev/null
  policy
  bind a1 litter:executor
  perm_bash litter:executor 'make' 'del(.permission_mode)' | run_hook ask.sh
  silent
  assert_eq null "$(ask_lines | jq -c .mode)" 'mode'
}

case_node_and_child() {
  swarm_setup
  perm_bash litter:sw-s-lead 'git push' | run_hook ask.sh
  silent
  assert_eq 'litter:sw-s-lead' "$(ask_lines | jq -r .agent_type)" "the node's ask"
  # A child keeps its own type: the binding the mod wrote for its id is what counts.
  node_policy a2 '.kind = "child" | .of = "a1" | .parent = "a1" | .n = 0'
  perm_bash general-purpose 'rm -rf build' '.agent_id = "a2"' | run_hook ask.sh
  silent
  assert_eq 'a1 a2' "$(ask_lines | jq -r .agent_id | tr '\n' ' ' | sed 's/ $//')" 'asks'
  assert_eq 'general-purpose' "$(ask_lines | jq -r 'select(.agent_id == "a2") | .agent_type')" "the child's type"
}

case_other_callers() {
  project >/dev/null
  policy
  perm_in - Bash '{"command": "rm -rf build"}' | run_hook ask.sh
  silent
  perm_in general-purpose Write '{"file_path": "/tmp/x", "content": "y"}' | run_hook ask.sh
  silent
  # An outside agent whose command names a litter type is still an outside agent.
  perm_bash general-purpose 'echo "\"agent_type\":\"litter:executor\""' | run_hook ask.sh
  silent
  no_ask
}

# A litter agent whose agent_id can't be a file name, or with no session id: nothing spooled.
case_unusable_ids() {
  project >/dev/null
  policy
  perm_bash litter:executor 'make' '.agent_id = "a/../b"' | run_hook ask.sh
  silent
  perm_bash litter:executor 'make' '.session_id = "../s"' | run_hook ask.sh
  silent
  perm_bash litter:executor 'make' '.tool_name = ""' | run_hook ask.sh
  silent
  no_ask
}

# Nothing active and no binding: the fast path, which reads nothing and runs
# no jq. The main thread with a run active doesn't run jq either.
case_fast_path() {
  project >/dev/null
  fake=$(jq_marker)
  perm_bash litter:executor 'make' >|"$T_DIR/in"
  PATH=$fake:$PATH run_hook ask.sh <"$T_DIR/in"
  silent
  assert_no_file "$T_DIR/jq-ran"
  policy
  perm_in - Bash '{"command": "make"}' >|"$T_DIR/in"
  PATH=$fake:$PATH run_hook ask.sh <"$T_DIR/in"
  silent
  assert_no_file "$T_DIR/jq-ran"
  perm_bash general-purpose 'make' >|"$T_DIR/in"
  PATH=$fake:$PATH run_hook ask.sh <"$T_DIR/in"
  silent
  assert_no_file "$T_DIR/jq-ran"
  no_ask
}

case_no_project() {
  # No litter directory at all: nothing to spool into.
  CLAUDE_PROJECT_DIR=$T_DIR/nowhere
  export CLAUDE_PROJECT_DIR
  perm_bash litter:executor 'make' | run_hook ask.sh
  silent
  CLAUDE_PROJECT_DIR=relative/path
  perm_bash litter:executor 'make' | run_hook ask.sh
  silent
  [ ! -e "$T_DIR/nowhere" ] || fail "made $T_DIR/nowhere"
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
  no_ask
}

case_bad_input() {
  project >/dev/null
  policy
  bind a1 litter:executor
  printf 'not json {' | run_hook ask.sh
  silent
  printf '[1, 2, 3]\n' | run_hook ask.sh
  silent
  printf '{"agent_id": 7, "tool_name": null, "tool_input": "x"}\n' | run_hook ask.sh
  silent
  # A litter agent's input cut short.
  perm_bash litter:executor 'make' | cut -c 1-120 | run_hook ask.sh
  silent
  no_ask
}

case_large_input() {
  project >/dev/null
  policy
  bind a1 litter:executor
  big=$(awk 'BEGIN { for (i = 0; i < 4000; i++) printf "echo %d && ", i; print "true" }')
  perm_bash litter:executor "$big" | run_hook ask.sh
  silent
  assert_eq "$(printf '%s' "$big" | cut -c 1-80)" "$(ask_lines | jq -r .detail)" 'detail'
}

case_no_jq() {
  project >/dev/null
  policy
  bind a1 litter:executor
  perm_bash litter:executor 'npm test' >|"$T_DIR/in"
  PATH=$(path_without_jq)
  run_hook ask.sh <"$T_DIR/in"
  silent
  [ ! -e "$(hooks_dir)/spool/s1.jsonl" ] || fail "spooled without jq: $(cat "$(hooks_dir)/spool/s1.jsonl")"
}

case_no_lib() {
  project >/dev/null
  policy
  bind a1 litter:executor
  mkdir -p "$T_DIR/lone"
  cp "$LITTER_ROOT/hooks/ask.sh" "$T_DIR/lone/ask.sh" || fail "copy"
  # shellcheck disable=SC2086
  perm_bash litter:executor 'make' | ${SHELL_UNDER_TEST:-sh} "$T_DIR/lone/ask.sh" >|"$T_DIR/out" 2>|"$T_DIR/err"
  printf '%s\n' "$?" >|"$T_DIR/code"
  silent
  no_ask
}

case_unwritable_spool() {
  project >/dev/null
  policy
  bind a1 litter:executor
  # A file where the spool folder goes: no folder can be made there, whoever runs it.
  : >|"$(hooks_dir)/spool"
  perm_bash litter:executor 'make' | run_hook ask.sh
  silent
  [ ! -s "$(hooks_dir)/spool" ] || fail "wrote into the spool file"
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

t "a run agent's ask: one ask line, nothing printed, exit 0" case_run_agent
t "a Bash ask's detail is the call start's detail for the same input" case_detail_matches_call
t "a Monitor ask's detail is its command" case_monitor_detail
t "a file tool's detail is its path, cut and cleaned; another tool's is empty" case_file_and_other_details
t "an input with no permission_mode: mode null" case_mode_null
t "a node's ask and its child's are spooled" case_node_and_child
t "the main thread's and another agent's ask: nothing spooled or printed" case_other_callers
t "an unusable agent id, session id or tool: nothing spooled" case_unusable_ids
t "the fast path: no jq for nothing active, the main thread or an outside agent" case_fast_path
t "no litter directory: nothing printed, exit 0" case_no_project
t "no input: nothing printed, exit 0" case_no_input
t "input that isn't a litter agent's PermissionRequest: nothing printed, exit 0" case_bad_input
t "a long command: its first 80 characters, nothing printed" case_large_input
t "no jq on PATH: nothing printed or spooled, exit 0" case_no_jq
t "lib.sh missing: nothing printed, exit 0" case_no_lib
t "a spool that can't be written: nothing printed, exit 0" case_unwritable_spool
t "hooks.json runs ask.sh on every PermissionRequest, exec form, 5 s" case_wired
done_testing
