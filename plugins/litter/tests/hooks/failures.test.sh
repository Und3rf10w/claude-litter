# Tier 3: the fast path, and how every script fails (plan section 9, "Fail
# closed", "jq missing"; section 12, "fail-closed"): a litter agent's call is
# refused, anyone else's passes, and the events that can't refuse exit 1.

. "$(dirname "$0")/testlib.sh"

# with_path <dir> <script> [args...] < input: run_hook with <dir> first on
# PATH, or PATH set to <dir> alone for `only:<dir>`. PATH comes back after.
with_path() {
  wp_old=$PATH
  case $1 in
    only:*) PATH=${1#only:} ;;
    *) PATH=$1:$PATH ;;
  esac
  shift
  run_hook "$@"
  PATH=$wp_old
}

# Inputs, written before PATH loses jq: a litter executor's Bash, the main
# thread's Bash, EnterWorktree and Agent, another agent's Bash, and the
# StructuredOutput, SubagentStart and SubagentStop of a litter agent.
inputs() {
  bash_call litter:executor 'git push' >|"$T_DIR/in.litter"
  bash_call - 'ls' >|"$T_DIR/in.main"
  call - EnterWorktree '{"name":"x"}' >|"$T_DIR/in.enter"
  call - Agent '{"subagent_type":"litter:executor","prompt":"go","description":"d"}' >|"$T_DIR/in.agent"
  bash_call general-purpose 'ls' >|"$T_DIR/in.other"
  call litter:executor StructuredOutput '{"status":"done"}' >|"$T_DIR/in.so"
  jq -cn '{session_id: "s1", transcript_path: "/t", cwd: "/p", agent_id: "a1", agent_type: "litter:executor",
    hook_event_name: "SubagentStart"}' >|"$T_DIR/in.start"
  jq -cn '{session_id: "s1", transcript_path: "/t", cwd: "/p", agent_id: "a1", agent_type: "litter:executor",
    hook_event_name: "SubagentStop", stop_hook_active: false}' >|"$T_DIR/in.stop"
  jq -cn '{session_id: "s1", transcript_path: "/t", cwd: "/p", agent_id: "a1", agent_type: "litter:executor",
    hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: {command: "ls"}, tool_use_id: "t1",
    error: "the working-directory isolation context for this agent was lost"}' >|"$T_DIR/in.post"
  jq -cn '{session_id: "s1", transcript_path: "/t", cwd: "/p", permission_mode: "plan",
    hook_event_name: "UserPromptSubmit", prompt: "hi"}' >|"$T_DIR/in.prompt"
}

# A run in progress, with executor a1 bound.
active_run() {
  project >/dev/null
  policy
  bind a1 litter:executor
  inputs
}

# No run: each script is done after one stat, before reading its input or
# starting jq. The fake jq leaves a mark if anything starts it.
case_fast_path() {
  project >/dev/null
  inputs
  marker=$(fake_tool jq ": >|$T_DIR/jq-ran; exit 1")
  for fp in guard.sh:litter guard.sh:enter guard.sh:agent output.sh:so identity.sh:start identity.sh:stop watch.sh:post \
    hold.sh:stop guard.sh:other; do
    fp_script=${fp%%:*}
    fp_in=${fp#*:}
    fp_arg=
    case $fp_script in identity.sh) fp_arg=$fp_in ;; watch.sh) fp_arg=post ;; esac
    # shellcheck disable=SC2086
    with_path "$marker" "$fp_script" $fp_arg <"$T_DIR/in.$fp_in"
    assert_code 0
    assert_stdout_empty
    [ ! -s "$T_DIR/err" ] || fail "$fp: stderr: $(cat "$T_DIR/err")"
  done
  assert_no_file "$T_DIR/jq-ran"
  # The prompt hook reads, and records the mode, but never needs jq.
  with_path "$marker" watch.sh prompt <"$T_DIR/in.prompt"
  assert_code 0
  assert_no_file "$T_DIR/jq-ran"
  # No hooks folder at all is the same as no run.
  rm -rf "$T_DIR/project/.claude"
  with_path "$marker" guard.sh <"$T_DIR/in.litter"
  assert_pass
}

case_no_jq_guard() {
  active_run
  nojq=$(path_without_jq)
  with_path "only:$nojq" guard.sh <"$T_DIR/in.litter"
  assert_blocked 'jq not found'
  with_path "only:$nojq" guard.sh <"$T_DIR/in.main"
  assert_pass
  with_path "only:$nojq" guard.sh <"$T_DIR/in.other"
  assert_pass
  with_path "only:$nojq" guard.sh <"$T_DIR/in.enter"
  assert_blocked 'jq not found'
  with_path "only:$nojq" guard.sh <"$T_DIR/in.agent"
  assert_blocked 'jq not found'
}

case_no_jq_others() {
  active_run
  nojq=$(path_without_jq)
  with_path "only:$nojq" output.sh <"$T_DIR/in.so"
  assert_blocked 'jq not found'
  with_path "only:$nojq" output.sh <"$T_DIR/in.main"
  assert_pass
  with_path "only:$nojq" identity.sh start <"$T_DIR/in.start"
  assert_code 1
  assert_stderr_contains 'jq not found'
  with_path "only:$nojq" identity.sh stop <"$T_DIR/in.stop"
  assert_code 1
  with_path "only:$nojq" identity.sh start <"$T_DIR/in.other"
  assert_code 0
  with_path "only:$nojq" watch.sh post <"$T_DIR/in.post"
  assert_code 1
  assert_stdout_empty
}

case_policy_broken() {
  active_run
  rm "$(hooks_dir)/policy.json"
  run_hook guard.sh <"$T_DIR/in.litter"
  assert_deny 'policy.json is unreadable (missing)'
  run_hook guard.sh <"$T_DIR/in.main"
  assert_pass
  run_hook guard.sh <"$T_DIR/in.enter"
  assert_deny 'a litter run is active'
  printf '{"v":1,"run":{"run":"2026' >|"$(hooks_dir)/policy.json"
  run_hook guard.sh <"$T_DIR/in.litter"
  assert_deny 'policy.json is unreadable (it does not parse)'
  printf '{"v":2}\n' >|"$(hooks_dir)/policy.json"
  run_hook guard.sh <"$T_DIR/in.litter"
  assert_deny 'policy.json is unreadable (not version 1)'
  printf '[1]\n' >|"$(hooks_dir)/policy.json"
  run_hook guard.sh <"$T_DIR/in.litter"
  assert_deny 'policy.json is unreadable (not a JSON object)'
  [ "$(id -u)" = 0 ] && return 0 # root reads any file
  chmod 000 "$(hooks_dir)/policy.json"
  run_hook guard.sh <"$T_DIR/in.litter"
  assert_blocked 'litter guard failed: reading the hook input; refusing'
  run_hook guard.sh <"$T_DIR/in.main"
  assert_pass
  run_hook guard.sh <"$T_DIR/in.enter"
  assert_blocked 'litter guard failed'
  chmod 644 "$(hooks_dir)/policy.json"
}

case_bad_stdin() {
  active_run
  printf '%s' '{"session_id":"s1","agent_id":"a1","agent_type":"litter:executor","tool_name":"Bash","tool_input":{"comm' |
    run_hook guard.sh
  assert_blocked 'litter guard failed: reading the hook input; refusing'
  printf '%s' '{"session_id":"s1","agent_id":"a1","agent_type":"litter:relay","tool_name":"StructuredOutput","tool_input":{' |
    run_hook output.sh
  assert_blocked 'litter guard failed'
  printf '%s' '{"session_id":"s1","tool_name":"Bash","tool_input":{"comm' | run_hook guard.sh
  assert_pass
  printf '' | run_hook guard.sh
  assert_pass
  printf 'not json at all' | run_hook output.sh
  assert_pass
  printf '%s' '{"agent_type":"litter:executor","agent_id":"a1","hook_event_name":"SubagentStart"' | run_hook identity.sh start
  assert_code 1
}

# jq that fails, or dies, refuses a litter agent and keeps the main thread's rules.
case_jq_fails() {
  active_run
  for body in 'exit 1' 'kill -9 $$'; do
    broken=$(fake_tool jq "$body")
    with_path "$broken" guard.sh <"$T_DIR/in.litter"
    assert_blocked 'litter guard failed: reading the hook input; refusing'
    with_path "$broken" guard.sh <"$T_DIR/in.main"
    assert_pass
    with_path "$broken" guard.sh <"$T_DIR/in.enter"
    assert_blocked 'litter guard failed: reading the hook input; refusing'
    with_path "$broken" output.sh <"$T_DIR/in.so"
    assert_blocked 'litter guard failed'
    with_path "$broken" identity.sh stop <"$T_DIR/in.stop"
    assert_code 1
    rm -rf "$broken"
  done
}

# A run agent's checks never run git, so a broken one changes nothing (a
# swarm node's do: node.test.sh).
case_git_fails() {
  active_run
  broken=$(fake_tool git ": >|$T_DIR/git-ran; exit 1")
  bash_call litter:executor 'git status' >|"$T_DIR/in.status"
  write_call litter:executor "$T_DIR/project/src/a.py" >|"$T_DIR/in.write"
  write_call litter:executor "$T_DIR/project/.claude/litter/x.json" >|"$T_DIR/in.ledger"
  with_path "$broken" guard.sh <"$T_DIR/in.status"
  assert_pass
  with_path "$broken" guard.sh <"$T_DIR/in.write"
  assert_pass
  with_path "$broken" guard.sh <"$T_DIR/in.litter"
  assert_deny 'git push is denied'
  with_path "$broken" guard.sh <"$T_DIR/in.ledger"
  assert_deny 'is under .claude/litter'
  assert_no_file "$T_DIR/git-ran"
}

case_project_dir_bad() {
  active_run
  unset CLAUDE_PROJECT_DIR
  run_hook guard.sh <"$T_DIR/in.litter"
  assert_blocked 'CLAUDE_PROJECT_DIR is not an absolute path'
  run_hook guard.sh <"$T_DIR/in.main"
  assert_pass
  run_hook output.sh <"$T_DIR/in.so"
  assert_blocked 'CLAUDE_PROJECT_DIR is not an absolute path'
  run_hook identity.sh start <"$T_DIR/in.start"
  assert_code 1
  assert_stderr_contains 'CLAUDE_PROJECT_DIR is not an absolute path'
  run_hook identity.sh start <"$T_DIR/in.other"
  assert_code 0
  run_hook watch.sh post <"$T_DIR/in.post"
  assert_code 0
  CLAUDE_PROJECT_DIR=project
  export CLAUDE_PROJECT_DIR
  run_hook guard.sh <"$T_DIR/in.litter"
  assert_blocked 'CLAUDE_PROJECT_DIR is not an absolute path'
  run_hook guard.sh <"$T_DIR/in.main"
  assert_pass
}

# A session started in a linked worktree finds hooks/ through the pointer,
# whichever of the two forms it holds.
case_pointer_followed() {
  active_run
  mkdir -p "$T_DIR/linked/.claude/litter/hooks"
  CLAUDE_PROJECT_DIR=$T_DIR/linked
  export CLAUDE_PROJECT_DIR
  for ptr in "$T_DIR/project/.claude/litter" "$T_DIR/project/.claude/litter/hooks" "$T_DIR/project/.claude/litter/hooks/"; do
    printf '%s\n' "$ptr" >|"$T_DIR/linked/.claude/litter/hooks/pointer"
    run_hook guard.sh <"$T_DIR/in.litter"
    assert_deny 'git push is denied'
    run_hook guard.sh <"$T_DIR/in.main"
    assert_pass
  done
  assert_eq 3 "$(spool_lines | jq -r 'select(.ev == "deny") | .agent_id' | wc -l | tr -d ' ')" "denies spooled in the run's hooks/"
  # The run's `active` counts, not the linked worktree's.
  rm "$(hooks_dir)/active"
  marker=$(fake_tool jq ": >|$T_DIR/jq-ran; exit 1")
  with_path "$marker" guard.sh <"$T_DIR/in.litter"
  assert_pass
  assert_no_file "$T_DIR/jq-ran"
}

case_pointer_bad() {
  active_run
  mkdir -p "$T_DIR/linked/.claude/litter/hooks"
  CLAUDE_PROJECT_DIR=$T_DIR/linked
  export CLAUDE_PROJECT_DIR
  ptr=$T_DIR/linked/.claude/litter/hooks/pointer
  printf 'project/.claude/litter\n' >|"$ptr"
  run_hook guard.sh <"$T_DIR/in.litter"
  assert_blocked "doesn't hold an absolute path"
  run_hook guard.sh <"$T_DIR/in.main"
  assert_pass
  : >|"$ptr"
  run_hook guard.sh <"$T_DIR/in.litter"
  assert_blocked "doesn't hold an absolute path"
  printf '%s\n' "$T_DIR/gone/.claude/litter" >|"$ptr"
  run_hook guard.sh <"$T_DIR/in.litter"
  assert_blocked "which isn't a folder"
  run_hook guard.sh <"$T_DIR/in.enter"
  assert_pass
  run_hook identity.sh start <"$T_DIR/in.start"
  assert_code 1
}

# A copy of the scripts without lib.sh beside them.
case_no_lib() {
  active_run
  mkdir -p "$T_DIR/copy"
  cp "$LITTER_ROOT/hooks/guard.sh" "$LITTER_ROOT/hooks/output.sh" "$LITTER_ROOT/hooks/identity.sh" \
    "$LITTER_ROOT/hooks/watch.sh" "$LITTER_ROOT/hooks/hold.sh" "$T_DIR/copy/"
  # hold.sh never blocks a stop on its own failure: exit 0, with the note.
  for nl in guard.sh:litter:2 output.sh:so:2 identity.sh:start:1 watch.sh:post:1 hold.sh:stop:0; do
    nl_script=${nl%%:*}
    nl_rest=${nl#*:}
    nl_in=${nl_rest%%:*}
    nl_arg=
    case $nl_script in identity.sh) nl_arg=start ;; watch.sh) nl_arg=post ;; esac
    # shellcheck disable=SC2086
    ${SHELL_UNDER_TEST:-sh} "$T_DIR/copy/$nl_script" $nl_arg <"$T_DIR/in.$nl_in" >|"$T_DIR/out" 2>|"$T_DIR/err"
    printf '%s\n' "$?" >|"$T_DIR/code"
    assert_code "${nl_rest#*:}"
    assert_stderr_contains 'loading lib.sh'
  done
  rm "$(hooks_dir)/active"
  for nl in guard.sh output.sh identity.sh watch.sh hold.sh; do
    ${SHELL_UNDER_TEST:-sh} "$T_DIR/copy/$nl" start <"$T_DIR/in.litter" >|"$T_DIR/out" 2>|"$T_DIR/err"
    printf '%s\n' "$?" >|"$T_DIR/code"
    assert_code 0
  done
}

# Swarm s live, with node a1 and its child c1 bound, and their inputs.
active_swarm() {
  swarm_setup
  node_policy c1 '.kind = "child" | .of = "a1" | .parent = "a1" | .n = 0'
  inputs
  bash_call litter:sw-s-lead 'ls' >|"$T_DIR/in.node"
  as_agent c1 bash_call general-purpose 'ls' >|"$T_DIR/in.child"
  as_agent o1 bash_call general-purpose 'ls' >|"$T_DIR/in.other"
  stop_input a1 litter:sw-s-lead >|"$T_DIR/in.nodestop"
}

# Without jq, a node and a child are refused (the child known by its
# binding alone), the main thread and other agents keep their rules, and
# hold.sh lets the stop go.
case_no_jq_swarm() {
  active_swarm
  nojq=$(path_without_jq)
  for nj in node child; do
    with_path "only:$nojq" guard.sh <"$T_DIR/in.$nj"
    assert_blocked 'jq not found'
  done
  with_path "only:$nojq" guard.sh <"$T_DIR/in.main"
  assert_pass
  with_path "only:$nojq" guard.sh <"$T_DIR/in.other"
  assert_pass
  with_path "only:$nojq" guard.sh <"$T_DIR/in.enter"
  assert_blocked 'jq not found'
  with_path "only:$nojq" hold.sh <"$T_DIR/in.nodestop"
  assert_code 0
  assert_stdout_empty
  assert_stderr_contains 'jq not found; no hold'
}

# A jq that fails refuses a node and a child, and passes the main thread.
case_jq_fails_swarm() {
  active_swarm
  broken=$(fake_tool jq 'exit 1')
  for jf in node child; do
    with_path "$broken" guard.sh <"$T_DIR/in.$jf"
    assert_blocked 'litter guard failed: reading the hook input; refusing'
  done
  with_path "$broken" guard.sh <"$T_DIR/in.main"
  assert_pass
  with_path "$broken" guard.sh <"$T_DIR/in.other"
  assert_pass
  with_path "$broken" hold.sh <"$T_DIR/in.nodestop"
  assert_code 0
  assert_stdout_empty
}

# The engine closes stdin; a writer that doesn't is cut after LT_READ_SECS,
# and since the caller can't be told, the call is refused.
case_read_times_out() {
  active_run
  mkfifo "$T_DIR/fifo"
  for rt in litter main; do
    { cat "$T_DIR/in.$rt"; sleep 6; } >"$T_DIR/fifo" &
    rt_w=$!
    rt_t0=$(date +%s)
    run_hook guard.sh <"$T_DIR/fifo"
    rt_t1=$(date +%s)
    kill "$rt_w" 2>/dev/null
    wait "$rt_w" 2>/dev/null
    assert_blocked 'did not arrive within 3 s'
    [ $((rt_t1 - rt_t0)) -le 5 ] || fail "the read took $((rt_t1 - rt_t0)) s"
  done
}

# An input over LT_MAX_IN is cut, and a cut input doesn't parse.
case_input_too_big() {
  active_run
  for big in litter main; do
    case $big in
      litter) printf '%s' '{"session_id":"s1","agent_id":"a1","agent_type":"litter:executor","tool_name":"Bash","tool_input":{"command":"' ;;
      main) printf '%s' '{"session_id":"s1","tool_name":"Bash","tool_input":{"command":"' ;;
    esac >|"$T_DIR/in.big"
    head -c 9000000 /dev/zero | tr '\000' a >>"$T_DIR/in.big"
    printf '"}}' >>"$T_DIR/in.big"
    run_hook guard.sh <"$T_DIR/in.big"
    case $big in
      litter) assert_blocked 'litter guard failed: reading the hook input; refusing' ;;
      main) assert_pass ;;
    esac
  done
}

t "with no run active, every script exits 0 at once and never starts jq" case_fast_path
t "without jq, the guard refuses litter agents and keeps the main thread's rules" case_no_jq_guard
t "without jq, output.sh refuses, and identity.sh and watch.sh exit 1" case_no_jq_others
t "a missing, half-written, wrong-version or unreadable policy.json denies" case_policy_broken
t "malformed input refuses a litter agent and passes anyone else" case_bad_stdin
t "a jq that fails or dies refuses a litter agent, passes the main thread's Bash" case_jq_fails
t "a broken git changes no decision, and the hooks never run it" case_git_fails
t "an unset or relative CLAUDE_PROJECT_DIR refuses litter agents only" case_project_dir_bad
t "the pointer from a linked worktree is followed, in both forms" case_pointer_followed
t "a bad pointer refuses litter agents only" case_pointer_bad
t "without lib.sh, a run refuses (guard, output) or reports (identity, watch)" case_no_lib
t "a read that doesn't end in 3 s refuses the call" case_read_times_out
t "an input over 8 MiB is cut, and refuses a litter agent" case_input_too_big
t "without jq, swarm nodes and children are refused, and hold.sh lets the stop go" case_no_jq_swarm
t "a jq that fails refuses swarm nodes and children, and passes the main thread" case_jq_fails_swarm
done_testing
