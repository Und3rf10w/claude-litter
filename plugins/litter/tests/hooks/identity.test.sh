# Tier 3: identity.sh on SubagentStart and SubagentStop (plan section 9,
# "Guard"; section 12, "identity").

. "$(dirname "$0")/testlib.sh"

# start_in <agent_type> [jq filter]: a SubagentStart input for agent a1.
start_in() {
  jq -cn --arg ty "$1" --arg cwd "$T_DIR/project/.claude/worktrees/wf_abc123-456-1" '
    {session_id: "s1", transcript_path: "/p/s1.jsonl", cwd: $cwd, agent_id: "a1", agent_type: $ty,
     hook_event_name: "SubagentStart"}' | jq -c "${2:-.}"
}

# stop_in <agent_type> [jq filter]: a SubagentStop input for agent a1.
stop_in() {
  jq -cn --arg ty "$1" '
    {session_id: "s1", transcript_path: "/p/s1.jsonl", cwd: "/p", permission_mode: "auto", agent_id: "a1",
     agent_type: $ty, hook_event_name: "SubagentStop", stop_hook_active: true,
     agent_transcript_path: "/p/s1/subagents/a1.jsonl", last_assistant_message: "done",
     background_tasks: [{id: "t1", type: "workflow", status: "running"}, {id: "t2", type: "shell", status: "running"}],
     session_crons: []}' | jq -c "${2:-.}"
}

setup() {
  project >/dev/null
  policy
}

case_start_binds() {
  setup
  start_in litter:prober | run_hook identity.sh start
  assert_code 0
  assert_stdout_empty
  b=$(hooks_dir)/bind/a1
  assert_file "$b"
  assert_eq "1 a1 litter:prober $T_DIR/project/.claude/worktrees/wf_abc123-456-1 s1 /p/s1.jsonl" \
    "$(jq -r '"\(.v) \(.agent_id) \(.agent_type) \(.cwd) \(.session_id) \(.transcript_path)"' "$b")" bind
  line=$(spool_lines)
  assert_eq "1 start s1 a1 litter:prober $T_DIR/project/.claude/worktrees/wf_abc123-456-1 /p/s1.jsonl" \
    "$(printf '%s' "$line" | jq -r '"\(.v) \(.ev) \(.session_id) \(.agent_id) \(.agent_type) \(.cwd) \(.transcript_path)"')" start
  assert_eq number "$(printf '%s' "$line" | jq -r '.ts | type')" ts
}

# The bind file is replaced through a temp file and mv: a hard link to the
# old file keeps the old bytes, and no temp file is left over.
case_start_atomic() {
  setup
  mkdir -p "$(hooks_dir)/bind"
  printf 'old\n' >|"$(hooks_dir)/bind/a1"
  ln "$(hooks_dir)/bind/a1" "$T_DIR/old-link"
  start_in litter:executor | run_hook identity.sh start
  assert_code 0
  assert_eq old "$(cat "$T_DIR/old-link")" "the old file"
  assert_eq litter:executor "$(jq -r .agent_type "$(hooks_dir)/bind/a1")" "the new file"
  assert_eq 'a1' "$(ls "$(hooks_dir)/bind")" "bind/"
}

case_start_other_agent() {
  setup
  start_in general-purpose | run_hook identity.sh start
  assert_code 0
  assert_no_file "$(hooks_dir)/bind/a1"
  assert_eq '' "$(spool_lines)" spool
}

case_start_bad_id() {
  setup
  start_in litter:executor '.agent_id = "../../x"' | run_hook identity.sh start
  assert_code 1
  assert_stderr_contains 'no usable agent_id'
  assert_no_file "$(hooks_dir)/bind/a1"
}

case_stop_spools() {
  setup
  stop_in litter:gate-critic | run_hook identity.sh stop
  assert_code 0
  assert_stdout_empty
  assert_eq '1 stop s1 a1 litter:gate-critic /p/s1.jsonl true 2' \
    "$(spool_lines | jq -r '"\(.v) \(.ev) \(.session_id) \(.agent_id) \(.agent_type) \(.transcript_path) \(.stop_hook_active) \(.background_tasks)"')" stop
}

case_stop_without_tasks() {
  setup
  stop_in litter:relay 'del(.background_tasks) | .stop_hook_active = false' | run_hook identity.sh stop
  assert_eq 'false 0' "$(spool_lines | jq -r '"\(.stop_hook_active) \(.background_tasks)"')" stop
}

case_stop_other_agent() {
  setup
  stop_in workflow-subagent | run_hook identity.sh stop
  assert_code 0
  assert_eq '' "$(spool_lines)" spool
}

# Neither event is ever refused: a stop that can't spool exits 1, never 2.
case_stop_never_blocks() {
  setup
  mkdir -p "$(hooks_dir)/spool"
  chmod 500 "$(hooks_dir)/spool"
  stop_in litter:executor | run_hook identity.sh stop
  chmod 755 "$(hooks_dir)/spool"
  [ "$(id -u)" = 0 ] && return 0
  assert_code 1
  assert_stderr_contains "couldn't spool the stop"
}

case_bad_argument() {
  setup
  start_in litter:executor | run_hook identity.sh begin
  assert_code 1
  assert_stderr_contains 'needs start or stop'
}

# Lines appended at once by many scripts each come out whole.
case_concurrent_appends() {
  setup
  long=$(jq -rn '[range(0; 300)] | map("p") | join("/")')
  i=0
  while [ "$i" -lt 24 ]; do
    stop_in litter:executor ".agent_id = \"a$i\" | .transcript_path = \"/$long/$i\"" >|"$T_DIR/in$i"
    i=$((i + 1))
  done
  i=0
  while [ "$i" -lt 24 ]; do
    # shellcheck disable=SC2086
    CLAUDE_PLUGIN_ROOT=$LITTER_ROOT ${SHELL_UNDER_TEST:-sh} "$LITTER_ROOT/hooks/identity.sh" stop <"$T_DIR/in$i" &
    i=$((i + 1))
  done
  wait
  assert_eq 24 "$(spool_lines | jq -c . | wc -l | tr -d ' ')" "lines that parse"
  assert_eq 24 "$(spool_lines | wc -l | tr -d ' ')" "lines"
  assert_eq 24 "$(spool_lines | jq -r .agent_id | sort -u | wc -l | tr -d ' ')" "distinct agents"
}

case_big_start_blob() {
  setup
  long=$(jq -rn '[range(0; 2500)] | map("d") | join("/")')
  start_in litter:executor ".transcript_path = \"/$long.jsonl\"" | run_hook identity.sh start
  assert_code 0
  line=$(spool_lines)
  assert_eq 'start a1 litter:executor' "$(printf '%s' "$line" | jq -r '"\(.ev) \(.agent_id) \(.agent_type)"')" "short line"
  assert_eq "/$long.jsonl" "$(jq -r .transcript_path "$(hooks_dir)/spool/blobs/$(printf '%s' "$line" | jq -r .file)")" blob
}

t "start writes bind/<agent_id> and spools the start" case_start_binds
t "start replaces the binding through a temp file and mv" case_start_atomic
t "start leaves other agents alone" case_start_other_agent
t "start with an unusable agent_id writes nothing and says so" case_start_bad_id
t "stop spools stop_hook_active and the count of background_tasks" case_stop_spools
t "stop with no background_tasks counts 0" case_stop_without_tasks
t "stop leaves other agents alone" case_stop_other_agent
t "a stop that can't spool exits 1, never 2" case_stop_never_blocks
t "an unknown argument exits 1" case_bad_argument
t "lines from 24 scripts appending at once each come out whole" case_concurrent_appends
t "a start over 4 KiB goes to spool/blobs" case_big_start_blob
done_testing
