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

# A litter: type that isn't a litter role, such as the one fanout dropped
# (plan 15.11), in a fanout run: every tool is denied, its result and the
# record tool too, whatever its binding says.
case_unknown_litter_type() {
  project >/dev/null
  fanout_policy
  bind a1 litter:merger
  write_call litter:merger "$T_DIR/project/a.py" Edit | run_hook guard.sh
  assert_deny 'litter:merger is not a role of run 20261002-test; refusing'
  bash_call litter:merger 'git status' | run_hook guard.sh
  assert_deny 'is not a role of run 20261002-test'
  for uk_tool in Read StructuredOutput mcp__litter__record; do
    call litter:merger "$uk_tool" '{}' | run_hook guard.sh
    assert_deny 'is not a role of run 20261002-test'
  done
}

# A node's type with no node binding (node.test.sh has the rest): a run's
# binding in bind/ doesn't make it one, and no swarm lists the type, so it
# isn't waited for.
case_swarm_node_refused() {
  setup_executor
  bind a1 litter:sw-a-lead
  call litter:sw-a-lead Read '{"file_path":"/x"}' | run_hook guard.sh
  assert_deny 'litter:sw-a-lead is a swarm node that is not bound yet'
}

case_unbound() {
  project >/dev/null
  policy
  call litter:gate-critic Read '{"file_path":"/x"}' | run_hook guard.sh
  assert_deny 'no usable binding (bind/a1 is missing)'
}

case_bound_to_other_type() {
  setup_executor
  call litter:verifier Read '{"file_path":"/x"}' | run_hook guard.sh
  assert_deny 'belongs to litter:executor, not to litter:verifier'
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

# --- a fanout writer (section 7, fanout.js step 2) ---------------------------

# A fanout run, and its writer a1 bound to its worktree W (bind/a1) and, with
# [owned JSON], to task t1 (agents/a1.json).
setup_writer() {
  project >/dev/null
  W=$(real_project)/.claude/worktrees/wf_abc123-456-1
  mkdir -p "$W/src/lib" "$W/docs"
  policy ".run.workflow = \"fanout\" | .roles.executor = {write: \"own-worktree\", bash: \"rw\", isolated: true}
    | .run.roots.worktrees = [\"$W\"]"
  bind a1 litter:executor "$W"
  if [ -n "${1:-}" ]; then
    mkdir -p "$(hooks_dir)/agents"
    jq -n --argjson owned "$1" --arg w "$W" '{v: 1, run: "20261002-test", task: {id: "t1", owned: $owned},
      worktree: {name: "wf_abc123-456-1", path: $w, branch: "litter/20261002-test-w1"}}' >|"$(hooks_dir)/agents/a1.json" ||
      fail "agents fixture"
  fi
}

# in_w <call…>: the writer's call, made from its worktree.
in_w() { "$@" | jq -c --arg c "$W" '.cwd = $c'; }

# A bound writer's Bash call: wbash <command>.
wbash() { in_w bash_call litter:executor "$1" | run_hook guard.sh; }

case_writer_unbound() {
  setup_writer
  wbash 'ls'
  assert_deny 'bind first: call mcp__litter__record with kind task.bind and the bind value from your <task>'
  in_w call litter:executor Read "{\"file_path\":\"$W/src/a.py\"}" | run_hook guard.sh
  assert_deny 'bind first'
  in_w write_call litter:executor "$W/src/a.py" | run_hook guard.sh
  assert_deny 'bind first'
  in_w call litter:executor Glob '{"pattern":"**/*.py"}' | run_hook guard.sh
  assert_deny 'bind first'
  in_w call litter:executor StructuredOutput '{"status":"blocked"}' | run_hook guard.sh
  assert_pass
  # A task for another run doesn't bind it.
  mkdir -p "$(hooks_dir)/agents"
  printf '%s\n' '{"v":1,"run":"20261001-other","task":{"id":"t1","owned":["src/a.py"]}}' >|"$(hooks_dir)/agents/a1.json"
  wbash 'ls'
  assert_deny 'bind first'
  printf '{"v":1,"task":' >|"$(hooks_dir)/agents/a1.json"
  wbash 'ls'
  assert_deny 'agents/a1.json is unreadable (it does not parse)'
}

case_writer_owned_writes() {
  setup_writer '["src/a.py", "docs/"]'
  in_w write_call litter:executor "$W/src/a.py" | run_hook guard.sh
  assert_pass
  in_w write_call litter:executor "$W/docs/new/guide.md" Edit | run_hook guard.sh
  assert_pass
  in_w write_call litter:executor "src/a.py" | run_hook guard.sh
  assert_pass
  in_w write_call litter:executor "$W/src/b.py" | run_hook guard.sh
  assert_deny 'task t1 owns only src/a.py, docs/, and'
  in_w write_call litter:executor "$W/src/a.py.bak" NotebookEdit | run_hook guard.sh
  assert_deny 'owns only'
  in_w write_call litter:executor "$W/docsx/a.md" | run_hook guard.sh
  assert_deny 'owns only'
  # Checked on the resolved path: an owned name that is a link elsewhere in the worktree.
  ln -s "$W/src/lib" "$W/docs/lib"
  in_w write_call litter:executor "$W/docs/lib/x.py" | run_hook guard.sh
  assert_deny 'resolves to src/lib/x.py'
  in_w write_call litter:executor "$(real_project)/src/a.py" | run_hook guard.sh
  assert_deny 'writes only inside'
}

case_writer_commits() {
  setup_writer '["src/a.py"]'
  wbash 'git add src/a.py && git commit -m "add a"'
  assert_pass
  wbash "cd $W && git commit -am 'add a'"
  assert_pass
  wbash "git -C $W add -A && git -C $W/ commit -m x"
  assert_pass
  wbash 'git -C . status && git restore --staged src/a.py && git rm --cached src/b.py'
  assert_pass
}

case_writer_commit_skips_denied() {
  setup_writer '["src/a.py"]'
  wbash 'git commit --no-verify -m x'
  assert_deny 'skip your repository hooks'
  wbash 'git commit --no-verif -m x'
  assert_deny 'skip your repository hooks'
  wbash 'git commit -n -m x'
  assert_deny 'skip your repository hooks'
  wbash 'git commit -anm x'
  assert_deny 'skip your repository hooks'
  wbash 'git commit --amend --no-edit'
  assert_deny 'rewrites a commit'
  wbash 'git commit --am'
  assert_deny 'rewrites a commit'
  wbash 'git -c core.hooksPath=/dev/null commit -m x'
  assert_deny 'git -c and --config-env overrides are denied'
  wbash 'HUSKY=0 git commit -m x'
  assert_deny 'drop HUSKY'
  wbash 'SKIP=ruff git commit -m x'
  assert_deny 'drop SKIP'
  wbash 'env HUSKY=0 git commit -m x'
  assert_deny 'drop HUSKY'
  wbash 'GIT_DIR=/tmp/x.git git add a'
  assert_deny 'drop GIT_DIR'
}

case_writer_commit_elsewhere_denied() {
  setup_writer '["src/a.py"]'
  wbash "git -C $(real_project) commit -m x"
  assert_deny "runs only in your own worktree $W"
  wbash "cd $(real_project) && git commit -m x"
  assert_deny "run them there, without cd"
  wbash "git --git-dir=$(real_project)/.git add a"
  assert_deny 'without -C to another folder, --git-dir or --work-tree'
  wbash "git --work-tree $W add a"
  assert_deny '--work-tree'
}

case_writer_other_git_denied() {
  setup_writer '["src/a.py"]'
  wbash 'git push origin HEAD'
  assert_deny 'git push is denied'
  wbash 'git rebase main'
  assert_deny 'git rebase is denied'
  wbash 'git reset --hard HEAD~1'
  assert_deny 'git reset --hard discards work'
  wbash 'git merge main'
  assert_deny 'git merge is denied'
  wbash 'git add --force deps/x'
  assert_deny 'force flags are denied'
  wbash 'git clean -fd'
  assert_deny 'git clean deletes files'
  wbash 'git checkout -- src/a.py'
  assert_deny 'git checkout moves the checkout'
  wbash 'git branch -D main'
  assert_deny 'git branch may only list here'
  wbash 'git config core.hooksPath /dev/null'
  assert_deny 'git config touching hooks is denied'
  wbash 'git stash'
  assert_deny 'refs/stash'
  wbash 'git reset -q HEAD -- src/a.py && git reset --soft HEAD'
  assert_pass
}

# An execute run's executor still stages nothing.
case_executor_no_index_writes() {
  setup_executor
  bash_call litter:executor 'git add a.py' | run_hook guard.sh
  assert_deny 'git add'
  bash_call litter:executor 'git commit -m x' | run_hook guard.sh
  assert_deny 'git commit is denied'
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
t "a litter type that isn't a litter role is denied every tool, its result too" case_unknown_litter_type
t "a swarm node's type with no node binding is refused, a run's binding notwithstanding" case_swarm_node_refused
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
t "an unbound fanout writer is denied every tool but StructuredOutput" case_writer_unbound
t "a bound fanout writer writes only its owned paths, resolved" case_writer_owned_writes
t "a bound fanout writer stages and commits in its own worktree" case_writer_commits
t "a fanout commit that skips the hooks, amends or overrides git is denied" case_writer_commit_skips_denied
t "a fanout commit from another folder is denied" case_writer_commit_elsewhere_denied
t "a fanout writer keeps every denial but commit and staging, and gets no stash" case_writer_other_git_denied
t "an execute executor stages and commits nothing" case_executor_no_index_writes
t "a prober writes only in its own worktree" case_prober_scope
t "a prober bound to the checkout itself is denied" case_prober_bound_to_checkout
done_testing
