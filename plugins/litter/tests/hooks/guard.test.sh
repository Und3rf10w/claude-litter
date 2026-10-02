# Tier 3: guard.sh, PreToolUse on every tool (plan section 9, "Guard";
# section 12). The agent's own context, the main thread's three rules, and
# the tool rules other than Bash (bash.test.sh) and resolved paths (paths.test.sh).

. "$(dirname "$0")/testlib.sh"

# A run is active, and executor a1 is bound to the checkout.
setup_executor() {
  project >/dev/null
  policy "${1:-.}"
  bind a1 litter:executor
}

# --- the main thread and other agents -------------------------------------

case_main_push() {
  setup_executor
  bash_call - 'git commit -m x && git push' | run_hook guard.sh
  assert_pass
}

case_other_agent() {
  setup_executor
  bash_call litter:executor 'git push' | jq -c '.agent_type = "general-purpose"' | run_hook guard.sh
  assert_pass
}

case_main_enter_worktree() {
  setup_executor
  call - EnterWorktree '{"name":"feature"}' | run_hook guard.sh
  assert_deny 'stays in its working directory'
}

case_main_exit_worktree() {
  setup_executor
  call - ExitWorktree '{"action":"keep"}' | run_hook guard.sh
  assert_deny 'stays in its working directory'
}

case_main_enter_checkout_before_launch() {
  setup_executor '.run.runIds = []'
  call - EnterWorktree "$(jq -cn --arg p "$(real_project)" '{path: $p}')" | run_hook guard.sh
  assert_pass
}

case_main_enter_checkout_after_launch() {
  setup_executor
  call - EnterWorktree "$(jq -cn --arg p "$(real_project)" '{path: $p}')" | run_hook guard.sh
  assert_deny 'only EnterWorktree({ path })'
}

case_main_enter_while_launching() {
  setup_executor '.run.runIds = [] | .run.launching = true'
  call - EnterWorktree "$(jq -cn --arg p "$(real_project)" '{path: $p}')" | run_hook guard.sh
  assert_deny
}

case_main_enter_bad_policy() {
  setup_executor '.run.runIds = []'
  printf '{"v":1,"run":' >|"$(hooks_dir)/policy.json"
  call - EnterWorktree "$(jq -cn --arg p "$(real_project)" '{path: $p}')" | run_hook guard.sh
  assert_deny
}

case_subagent_enter_worktree() {
  setup_executor
  call general-purpose EnterWorktree '{"name":"x"}' | run_hook guard.sh
  assert_pass
}

case_main_spawns_role() {
  setup_executor
  call - Agent '{"description":"d","prompt":"p","subagent_type":"litter:executor"}' | run_hook guard.sh
  assert_deny 'litter roles run inside litter workflows'
}

case_subagent_spawns_role() {
  setup_executor
  call general-purpose Agent '{"description":"d","prompt":"p","subagent_type":"litter:gate-critic"}' | run_hook guard.sh
  assert_deny 'litter roles run inside litter workflows'
}

case_named_node() {
  setup_executor
  call - Agent '{"description":"d","prompt":"p","subagent_type":"litter:sw-a-lead","name":"lead"}' | run_hook guard.sh
  assert_deny 'takes no name'
}

case_unnamed_node() {
  setup_executor
  call - Agent '{"description":"d","prompt":"p","subagent_type":"litter:sw-a-lead"}' | run_hook guard.sh
  assert_pass
}

case_main_other_agent() {
  setup_executor
  call - Agent '{"description":"d","prompt":"p","subagent_type":"general-purpose"}' | run_hook guard.sh
  assert_pass
}

# --- a litter agent's own context ------------------------------------------

case_plain_read() {
  setup_executor
  call litter:executor Read "$(jq -cn --arg p "$T_DIR/project/x" '{file_path: $p}')" | run_hook guard.sh
  assert_pass
}

case_mode_accept_edits() {
  setup_executor
  call litter:executor Read '{"file_path":"/x"}' '.permission_mode = "acceptEdits"' | run_hook guard.sh
  assert_deny 'switched to acceptEdits during a litter run; switch back with shift+tab'
}

case_mode_bypass() {
  setup_executor
  call litter:executor Read '{"file_path":"/x"}' '.permission_mode = "bypassPermissions"' | run_hook guard.sh
  assert_deny 'switched to bypassPermissions'
}

case_mode_default_dontask() {
  setup_executor
  call litter:executor Read '{"file_path":"/x"}' '.permission_mode = "default"' | run_hook guard.sh
  assert_pass
  call litter:executor Read '{"file_path":"/x"}' '.permission_mode = "dontAsk"' | run_hook guard.sh
  assert_pass
}

case_mode_from_file() {
  setup_executor
  printf 'bypassPermissions\n' >|"$(hooks_dir)/mode"
  call litter:executor Read '{"file_path":"/x"}' 'del(.permission_mode)' | run_hook guard.sh
  assert_deny 'switched to bypassPermissions'
  # The agent's own mode wins over the main thread's.
  call litter:executor Read '{"file_path":"/x"}' | run_hook guard.sh
  assert_pass
}

case_stopping() {
  setup_executor '.run.stopping = true'
  call litter:executor StructuredOutput '{"status":"done"}' | run_hook guard.sh
  assert_deny 'is stopping; make no more tool calls'
}

case_isolation_lost_flag() {
  setup_executor '.run.isolationLost = true'
  call litter:executor mcp__litter__record '{"kind":"finding"}' | run_hook guard.sh
  assert_deny 'is halting'
}

case_no_run() {
  setup_executor '.run = null'
  call litter:executor Read '{"file_path":"/x"}' | run_hook guard.sh
  assert_deny 'no litter run is active'
}

case_not_a_role() {
  setup_executor 'del(.roles.executor)'
  call litter:executor Read '{"file_path":"/x"}' | run_hook guard.sh
  assert_deny 'is not a role of run 20261002-test'
}

case_swarm_node_refused() {
  setup_executor
  bind a1 litter:sw-a-lead
  call litter:sw-a-lead Read '{"file_path":"/x"}' | run_hook guard.sh
  assert_deny 'swarm node'
}

case_unbound() {
  project >/dev/null
  policy
  call litter:gate-critic Read '{"file_path":"/x"}' | run_hook guard.sh
  assert_deny 'no usable binding (bind/a1 is missing)'
}

case_bound_to_other_type() {
  setup_executor
  call litter:integrator Read '{"file_path":"/x"}' | run_hook guard.sh
  assert_deny 'belongs to litter:executor, not to litter:integrator'
}

case_bind_unparsable() {
  setup_executor
  printf '{"v":1,' >|"$(hooks_dir)/bind/a1"
  call litter:executor Read '{"file_path":"/x"}' | run_hook guard.sh
  assert_deny 'bind/a1 is it does not parse'
}

case_bad_agent_id() {
  setup_executor
  call litter:executor Read '{"file_path":"/x"}' '.agent_id = "../a1"' | run_hook guard.sh
  assert_deny 'no usable agent_id'
}

# An isolated role (the prober) whose call's cwd isn't its bound worktree.
case_cwd_lost() {
  project >/dev/null
  mkdir -p "$T_DIR/project/.claude/worktrees/w1"
  policy
  bind a1 litter:prober "$T_DIR/project/.claude/worktrees/w1"
  bash_call litter:prober 'pwd' | run_hook guard.sh
  assert_deny 'isolation context was lost'
  assert_contains '"ev":"isolation-lost"' "$(spool_lines)" spool
  assert_contains '"source":"guard"' "$(spool_lines)" spool
  assert_contains "\"expected\":\"$T_DIR/project/.claude/worktrees/w1\"" "$(spool_lines)" spool
  assert_contains '"ev":"deny"' "$(spool_lines)" spool
}

case_cwd_kept() {
  project >/dev/null
  mkdir -p "$T_DIR/project/.claude/worktrees/w1"
  policy
  bind a1 litter:prober "$T_DIR/project/.claude/worktrees/w1"
  bash_call litter:prober 'pwd' | jq -c --arg c "$T_DIR/project/.claude/worktrees/w1" '.cwd = $c' | run_hook guard.sh
  assert_pass
}

case_cwd_not_isolated() {
  setup_executor
  bash_call litter:executor 'pwd' | jq -c '.cwd = "/elsewhere"' | run_hook guard.sh
  assert_pass
}

# --- tool rules ------------------------------------------------------------

case_agent_denied() {
  setup_executor
  call litter:executor Agent '{"description":"d","prompt":"p","subagent_type":"general-purpose"}' | run_hook guard.sh
  assert_deny 'do not start agents'
}

case_enter_worktree_denied() {
  setup_executor
  call litter:executor EnterWorktree '{"path":"/x"}' | run_hook guard.sh
  assert_deny 'EnterWorktree is not available'
  call litter:executor ExitWorktree '{"action":"keep"}' | run_hook guard.sh
  assert_deny 'ExitWorktree is not available'
}

case_monitor_denied() {
  setup_executor
  call litter:executor Monitor '{"command":"git push"}' | run_hook guard.sh
  assert_deny 'use Bash'
}

case_other_tools_pass() {
  setup_executor
  call litter:executor StructuredOutput '{"status":"done"}' | run_hook guard.sh
  assert_pass
  call litter:executor mcp__litter__record '{"kind":"verify"}' | run_hook guard.sh
  assert_pass
  call litter:executor Grep '{"pattern":"x"}' | run_hook guard.sh
  assert_pass
}

case_readonly_write_denied() {
  project >/dev/null
  policy
  bind a1 litter:gate-critic
  write_call litter:gate-critic "$T_DIR/project/src/a.py" | run_hook guard.sh
  assert_deny 'litter:gate-critic does not write files'
  write_call litter:gate-critic "$T_DIR/project/src/a.py" Edit | run_hook guard.sh
  assert_deny 'does not write files'
}

case_executor_writes_checkout() {
  setup_executor
  write_call litter:executor "$T_DIR/project/src/new/a.py" | run_hook guard.sh
  assert_pass
  write_call litter:executor "src/rel.py" | run_hook guard.sh
  assert_pass
}

case_executor_writes_outside() {
  setup_executor
  mkdir -p "$T_DIR/elsewhere"
  write_call litter:executor "$T_DIR/elsewhere/a.py" | run_hook guard.sh
  assert_deny 'writes only inside'
}

case_inflight_denies_writes() {
  setup_executor '.run.inflight = "land"'
  write_call litter:executor "$T_DIR/project/a.py" | run_hook guard.sh
  assert_deny 'a land is in flight for this checkout'
}

case_integrator_scope() {
  project >/dev/null
  mkdir -p "$T_DIR/integration" "$T_DIR/project/src"
  policy ".run.roots.integration = \"$(cd -P "$T_DIR/integration" && pwd -P)\""
  bind a1 litter:integrator
  write_call litter:integrator "$T_DIR/integration/a.py" Edit | run_hook guard.sh
  assert_pass
  write_call litter:integrator "$T_DIR/project/src/a.py" Edit | run_hook guard.sh
  assert_deny 'litter:integrator writes only inside'
}

case_integrator_no_worktree() {
  project >/dev/null
  policy
  bind a1 litter:integrator
  write_call litter:integrator "$T_DIR/project/a.py" | run_hook guard.sh
  assert_deny 'has none recorded'
}

case_prober_scope() {
  project >/dev/null
  w=$T_DIR/project/.claude/worktrees/w1
  mkdir -p "$w"
  policy
  bind a1 litter:prober "$w"
  write_call litter:prober "$w/scratch/t.py" | jq -c --arg c "$w" '.cwd = $c' | run_hook guard.sh
  assert_pass
  write_call litter:prober "$T_DIR/project/a.py" | jq -c --arg c "$w" '.cwd = $c' | run_hook guard.sh
  assert_deny 'writes only inside'
}

case_prober_bound_to_checkout() {
  project >/dev/null
  policy
  bind a1 litter:prober "$T_DIR/project"
  write_call litter:prober "$T_DIR/project/a.py" | run_hook guard.sh
  assert_deny 'is not one'
}

t "the main thread's git commit and push pass" case_main_push
t "another plugin's agent passes" case_other_agent
t "the main thread's EnterWorktree is denied while a run is active" case_main_enter_worktree
t "the main thread's ExitWorktree is denied while a run is active" case_main_exit_worktree
t "EnterWorktree into the run checkout before the launch passes" case_main_enter_checkout_before_launch
t "EnterWorktree into the run checkout after the launch is denied" case_main_enter_checkout_after_launch
t "EnterWorktree while the launch is in progress is denied" case_main_enter_while_launching
t "EnterWorktree with a half-written policy is denied" case_main_enter_bad_policy
t "a non-litter subagent's EnterWorktree passes" case_subagent_enter_worktree
t "the main thread can't spawn a litter role" case_main_spawns_role
t "a non-litter subagent can't spawn a litter role" case_subagent_spawns_role
t "a swarm node spawned with a name is denied" case_named_node
t "a swarm node spawned without a name passes on" case_unnamed_node
t "the main thread's other spawns pass" case_main_other_agent
t "a bound litter agent's Read passes" case_plain_read
t "a litter agent in acceptEdits is denied" case_mode_accept_edits
t "a litter agent in bypassPermissions is denied" case_mode_bypass
t "a litter agent in default or dontAsk passes" case_mode_default_dontask
t "with no mode in the input, the recorded mode counts" case_mode_from_file
t "a stopping run's agents are denied every tool" case_stopping
t "after a lost isolation context, every call is denied" case_isolation_lost_flag
t "with no run active, a litter role is denied" case_no_run
t "a role the policy doesn't list is denied" case_not_a_role
t "a swarm node is refused in this build" case_swarm_node_refused
t "an unbound litter agent is denied every tool" case_unbound
t "an agent bound as another role is denied" case_bound_to_other_type
t "an unparsable binding denies" case_bind_unparsable
t "an agent_id that isn't a file name denies" case_bad_agent_id
t "an isolated agent whose cwd isn't its worktree is denied, and the loss spooled" case_cwd_lost
t "an isolated agent in its own worktree passes" case_cwd_kept
t "a non-isolated agent's cwd isn't checked" case_cwd_not_isolated
t "a litter agent's Agent call is denied" case_agent_denied
t "a litter agent's EnterWorktree and ExitWorktree are denied" case_enter_worktree_denied
t "a litter agent's Monitor is denied" case_monitor_denied
t "a litter agent's other tools pass" case_other_tools_pass
t "a read-only role's Write and Edit are denied" case_readonly_write_denied
t "an executor writes inside the checkout, new folders and relative paths too" case_executor_writes_checkout
t "an executor's write outside the checkout is denied" case_executor_writes_outside
t "writes wait while a land is in flight" case_inflight_denies_writes
t "an integrator writes only in the integration worktree" case_integrator_scope
t "an integrator with no integration worktree is denied" case_integrator_no_worktree
t "a prober writes only in its own worktree" case_prober_scope
t "a prober bound to the checkout itself is denied" case_prober_bound_to_checkout
done_testing
