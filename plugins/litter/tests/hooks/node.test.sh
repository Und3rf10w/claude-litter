# Tier 3: guard.sh for swarm nodes and their children (plan 15.4, "The guard
# for nodes"): the swarm's state, the node's, its type, its tools, writes and
# Bash, the race with a binding still landing, the main thread while a swarm
# is live, and the failures. The spool lines are spool.test.sh's.

. "$(dirname "$0")/testlib.sh"

LEAD=litter:sw-s-lead

# A node's call, from agent a1 of the lead's type.
lead() { call "$LEAD" "$@"; }
lead_bash() { bash_call "$LEAD" "$1"; }

# Each command, from the lead, denied with <text>: deny_each <text> <command…>.
deny_each() {
  de_why=$1
  shift
  for de_c in "$@"; do
    lead_bash "$de_c" | run_hook guard.sh
    ( assert_deny "$de_why" ) || fail "'$de_c' was not denied for '$de_why'"
  done
}

# Each command, from the lead, passed: pass_each <command…>.
pass_each() {
  for pe_c in "$@"; do
    lead_bash "$pe_c" | run_hook guard.sh
    ( assert_pass ) || fail "'$pe_c' did not pass"
  done
}

# The scratch repository (`repo`), with swarm s live and the lead bound to
# main with authority.commit true, then a node filter after that.
committer() {
  repo
  swarm_setup ".authority = {commit: true} | .branch = \"refs/heads/main\" | ${1:-.}"
}

# A sleep that counts the guard's 100 ms ticks, one line each in
# $T_DIR/ticks, without waiting, and runs the real sleep for anything else
# (the read's own watchdog). With <n>, the tick that brings the count to <n>
# moves $T_DIR/landing to <dest>: a binding landing mid-wait.
# tick_sleep [n dest]: prints the folder to put first on PATH.
tick_sleep() {
  ts_real=$(command -v sleep)
  fake_tool sleep "case \$1 in
  0.1)
    echo 0.1 >>'$T_DIR/ticks'
    if [ -n '${1:-}' ] && [ \$((\$(wc -l <'$T_DIR/ticks'))) -ge '${1:-0}' ] && [ -f '$T_DIR/landing' ]; then
      mv '$T_DIR/landing' '${2:-/nonexistent}'
    fi
    exit 0
    ;;
  *) exec '$ts_real' \"\$@\" ;;
esac"
}

# A sleep that takes no fraction, as some old ones: each refused 0.1 and each
# 1 is a line in $T_DIR/ticks, and nothing waits.
whole_sleep() {
  ws_real=$(command -v sleep)
  fake_tool sleep "case \$1 in
  0.1) echo refused >>'$T_DIR/ticks'; exit 1 ;;
  1) echo 1 >>'$T_DIR/ticks'; exit 0 ;;
  *) exec '$ws_real' \"\$@\" ;;
esac"
}

ticks() { paste -sd ' ' - <"$T_DIR/ticks" 2>/dev/null; }

# A pending spawn's marker, as the mod's reservation writes it.
pending_marker() {
  mkdir -p "$(hooks_dir)/pending"
  printf '{"v":1,"swarm":"s","node":"fixer","parent":"a1","at":%s}\n' "$(date +%s)" >|"$(hooks_dir)/pending/toolu_spawn"
}

# --- the tools ---------------------------------------------------------------

case_node_plain() {
  swarm_setup
  lead Read '{"file_path":"/x"}' | run_hook guard.sh
  assert_pass
  lead mcp__litter__record '{"kind":"finding"}' | run_hook guard.sh
  assert_pass
  lead SubagentHandback '{"message":"done"}' | run_hook guard.sh
  assert_pass
}

case_node_worktree_tools() {
  swarm_setup
  lead EnterWorktree '{"name":"x"}' | run_hook guard.sh
  assert_deny 'litter guard: your directory is fixed by the swarm; ask your parent'
  lead ExitWorktree '{"action":"keep"}' | run_hook guard.sh
  assert_deny 'your directory is fixed by the swarm'
}

case_node_tools_deny() {
  swarm_setup '.toolsDeny = ["Edit", "WebFetch"]'
  write_call "$LEAD" "$(real_project)/a.txt" Edit | run_hook guard.sh
  assert_deny 'Edit is denied to node lead by its spec (tools.deny)'
  lead WebFetch '{"url":"https://example.com"}' | run_hook guard.sh
  assert_deny 'WebFetch is denied to node lead'
  write_call "$LEAD" "$(real_project)/a.txt" | run_hook guard.sh
  assert_pass
}

case_node_agent_name() {
  swarm_setup '.spawns = ["litter:sw-s-fixer"]'
  lead Agent '{"description":"d","prompt":"p","subagent_type":"litter:sw-s-fixer","name":"f"}' | run_hook guard.sh
  assert_deny 'a swarm node spawns no named agent: where agent teams are on, a named agent starts as a teammate, which runs in the directory of the session and ignores the cwd and background litter gives it. Spawn it again without name'
  lead Agent '{"description":"d","prompt":"p","subagent_type":"general-purpose","name":"g"}' | run_hook guard.sh
  assert_deny 'a swarm node spawns no named agent: where agent teams are on, a named agent starts as a teammate'
}

case_node_agent_spawns() {
  swarm_setup '.spawns = ["litter:sw-s-fixer", "litter:sw-s-reviewer"]'
  lead Agent '{"description":"d","prompt":"p","subagent_type":"litter:sw-s-fixer"}' | run_hook guard.sh
  assert_pass
  lead Agent '{"description":"d","prompt":"p","subagent_type":"litter:sw-s-lead"}' | run_hook guard.sh
  assert_deny 'node lead may spawn only litter:sw-s-fixer, litter:sw-s-reviewer, and litter:sw-s-lead is not one of them'
  node_policy a1 '.spawns = []'
  lead Agent '{"description":"d","prompt":"p","subagent_type":"litter:sw-s-fixer"}' | run_hook guard.sh
  assert_deny 'node lead spawns no swarm workers'
}

case_node_agent_role() {
  swarm_setup
  lead Agent '{"description":"d","prompt":"p","subagent_type":"litter:executor"}' | run_hook guard.sh
  assert_deny 'litter roles run inside litter workflows, not under a swarm node'
}

case_node_spawn_other() {
  swarm_setup
  lead Agent '{"description":"d","prompt":"p","subagent_type":"general-purpose"}' | run_hook guard.sh
  assert_pass
  node_policy a1 '.spawnOther = false | .spawns = ["litter:sw-s-fixer"]'
  lead Agent '{"description":"d","prompt":"p","subagent_type":"general-purpose"}' | run_hook guard.sh
  assert_deny 'node lead may spawn no agent types but its swarm workers (spawnOther is false)'
  lead Agent '{"description":"d","prompt":"p","subagent_type":"litter:sw-s-fixer"}' | run_hook guard.sh
  assert_pass
}

case_node_powershell() {
  swarm_setup
  lead PowerShell '{"command":"git push"}' | run_hook guard.sh
  assert_deny 'PowerShell is not checked for swarm nodes; use Bash'
}

# --- writes ------------------------------------------------------------------

# paths resolved under dir, and a relative file_path taken against dir: the
# node works in sub/, while the call's cwd is the project.
case_node_write_paths() {
  project >/dev/null
  mkdir -p "$T_DIR/project/sub/src"
  wp_co=$(real_project)
  swarm_setup ".dir = \"$wp_co/sub\" | .paths = [\"$wp_co/sub/src/\", \"$wp_co/sub/README.md\"]"
  write_call "$LEAD" "$wp_co/sub/src/a.py" | run_hook guard.sh
  assert_pass
  write_call "$LEAD" "src/b.py" Edit | run_hook guard.sh
  assert_pass
  write_call "$LEAD" "README.md" | run_hook guard.sh
  assert_pass
  write_call "$LEAD" "$wp_co/sub/src/n.ipynb" NotebookEdit | run_hook guard.sh
  assert_pass
  write_call "$LEAD" "$wp_co/sub/other.txt" | run_hook guard.sh
  assert_deny "node lead writes only in $wp_co/sub/src/, $wp_co/sub/README.md, and $wp_co/sub/other.txt resolves to $wp_co/sub/other.txt"
  # Against the call's cwd this would be the project's src/, outside paths.
  write_call "$LEAD" "other.txt" | run_hook guard.sh
  assert_deny "resolves to $wp_co/sub/other.txt"
  write_call "$LEAD" "$wp_co/src/a.py" | run_hook guard.sh
  assert_deny 'writes only in'
  node_policy a1 ".dir = \"$wp_co/sub\" | .paths = []"
  write_call "$LEAD" "src/a.py" | run_hook guard.sh
  assert_deny 'node lead writes no files (its spec gives it no paths)'
}

case_node_write_protect() {
  swarm_setup
  wr_co=$(real_project)
  mkdir -p "$T_DIR/copy" "$wr_co/.claude/litter"
  wr_copy=$(cd -P "$T_DIR/copy" && pwd -P)
  node_policy a1 ".protect += [\"$wr_copy\"]"
  write_call "$LEAD" "$wr_co/.claude/litter/x.json" | run_hook guard.sh
  assert_deny 'is under .claude/litter'
  write_call "$LEAD" "$wr_co/.litter/r.md" | run_hook guard.sh
  assert_deny 'is in a litter rule folder'
  write_call "$LEAD" "$wr_co/.claude/rules/litter-local/r.md" Edit | run_hook guard.sh
  assert_deny 'is in a litter rule folder'
  write_call "$LEAD" "$wr_copy/x" | run_hook guard.sh
  assert_deny 'inside a folder litter protects'
  ln -s "$wr_co/.claude/litter" "$wr_co/lnk"
  write_call "$LEAD" "$wr_co/lnk/x.json" | run_hook guard.sh
  assert_deny "it resolves to $wr_co/.claude/litter/x.json"
  # paths unset: anywhere else is the node's.
  write_call "$LEAD" "$wr_co/a.txt" | run_hook guard.sh
  assert_pass
}

case_node_write_unresolvable() {
  swarm_setup
  wu_co=$(real_project)
  lead Write '{"content":"x"}' | run_hook guard.sh
  assert_deny 'Write needs file_path'
  write_call "$LEAD" '~/x' | run_hook guard.sh
  assert_deny 'give an absolute path'
  write_call "$LEAD" "$wu_co/a/../b" | run_hook guard.sh
  assert_deny 'no empty, . or .. parts'
  printf 'x\n' >|"$wu_co/f.txt"
  write_call "$LEAD" "$wu_co/f.txt/x" | run_hook guard.sh
  assert_deny 'could not resolve'
}

# --- Bash --------------------------------------------------------------------

case_node_push() {
  swarm_setup
  for np_au in '{}' '{"commit": true}' '{"commit": false}'; do
    node_policy a1 ".authority = $np_au | .branch = \"refs/heads/main\""
    deny_each 'git push is denied to swarm nodes: report ready-to-push; the lead pushes' \
      'git push origin HEAD' 'git -C . push' 'ls && git push --force' 'git send-pack origin main'
  done
}

case_node_commit_unset() {
  swarm_setup
  PATH=$(fake_tool git "echo \"\$*\" >>'$T_DIR/git.log'; exit 128"):$PATH
  pass_each 'git commit -m x' 'git add a.txt' 'git reset --hard' 'git switch other' 'git worktree add ../x'
  assert_no_file "$T_DIR/git.log"
}

case_node_commit_false() {
  swarm_setup '.authority = {commit: false}'
  deny_each 'and node lead may not commit (authority.commit is false)' \
    'git commit -m x' 'git add a.txt' 'git merge other' 'git cherry-pick abc' 'git stash' 'git rm a.txt'
  lead_bash 'git commit -m x' | run_hook guard.sh
  assert_deny 'git commit makes a commit'
  lead_bash 'git add a.txt' | run_hook guard.sh
  assert_deny 'git add writes the index'
  pass_each 'git status' 'git diff' 'git log --oneline' 'git show HEAD'
}

# Phase 3 (decision 10): a plan-template swarm's executor, a worker with
# commit false and no paths, in the active execute run's own checkout while
# its repair generation is open, so policy.json has both the run and the
# swarm. Its writes pass; it may not commit, since the mod lands the tree.
case_node_run_checkout_executor() {
  repo
  rc_co=$(real_project)
  policy ".run.runIds = [] | .swarm = {swarms: {s: {launch: \"20261003-120000\", state: \"live\", commonDir: \"$rc_co/.git\",
    owner: {ref: \"refs/litter-swarm/s\", oid: \"0123456789abcdef0123456789abcdef01234567\", generation: 1, session: \"s1\", checkedAt: $(date +%s)},
    nodeTypes: [\"litter:sw-s-runner\", \"litter:sw-s-executor\", \"litter:sw-s-critic\"]}}}"
  node_policy a1 '.node = "executor" | .kind = "worker" | .type = "litter:sw-s-executor" | .parent = "a0"
    | .authority = {commit: false, push: "none", rewriteHistory: false, worktreeOps: false, verify: true}'
  write_call litter:sw-s-executor "$rc_co/src/x.py" Edit | run_hook guard.sh
  assert_pass
  write_call litter:sw-s-executor "g2.txt" | run_hook guard.sh
  assert_pass
  bash_call litter:sw-s-executor 'git commit -am G2' | run_hook guard.sh
  assert_deny 'node executor may not commit (authority.commit is false)'
  bash_call litter:sw-s-executor 'git add g2.txt' | run_hook guard.sh
  assert_deny 'git add writes the index'
  bash_call litter:sw-s-executor 'git diff HEAD' | run_hook guard.sh
  assert_pass
}

case_node_commit_true() {
  committer
  ct_co=$(real_project)
  pass_each 'git commit -am x' 'git add a.txt && git commit -m y' "git -C $ct_co commit -m x" \
    'git -C . commit -m x' "cd $ct_co && git commit -m x" 'git add src/x.py' 'git status'
  deny_each 'runs only in your directory' "git -C $T_DIR/elsewhere commit -m x" 'git --git-dir=/x/.git commit -m x' \
    'git --work-tree=/x add a.txt'
  deny_each 'drop GIT_DIR' 'GIT_DIR=/x/.git git commit -m x'
  deny_each 'drop GIT_INDEX_FILE' 'GIT_INDEX_FILE=/x/index git add a.txt'
  deny_each 'without cd elsewhere' 'cd /tmp && git commit -m x' 'cd && git add a.txt'
}

case_node_bound_branch() {
  committer
  deny_each 'would move you off your bound branch refs/heads/main: your branch is fixed by the swarm; ask your parent' \
    'git switch other' 'git switch -c other' 'git checkout -b x' 'git checkout -B x' 'git checkout --detach' \
    'git checkout other' 'git branch -f main HEAD~1' 'git branch -m x' 'git branch -M x y' 'git branch --force main HEAD' \
    'git symbolic-ref HEAD refs/heads/x' 'git symbolic-ref --delete HEAD' 'git update-ref refs/heads/main HEAD~1' \
    'git reset HEAD~1' 'git reset --soft main~1'
  pass_each 'git checkout -- a.txt' 'git checkout .' 'git reset -- a.txt' 'git reset HEAD a.txt' 'git reset' \
    'git symbolic-ref HEAD' 'git branch' 'git branch -a' 'git restore a.txt' 'git restore --staged a.txt'
}

# HEAD moved out of band, as by a command the parse missed: the commit itself
# is checked against the bound branch.
case_node_head_moved() {
  committer
  hm_co=$(real_project)
  git -C "$hm_co" symbolic-ref HEAD refs/heads/other || fail "moving HEAD"
  lead_bash 'git commit -am x' | run_hook guard.sh
  assert_deny "HEAD in $hm_co is refs/heads/other, not your bound branch refs/heads/main"
  pass_each 'git status' 'git add a.txt'
  git -C "$hm_co" checkout -q --detach main || fail "detaching HEAD"
  lead_bash 'git merge other' | run_hook guard.sh
  assert_deny "HEAD in $hm_co is detached, not your bound branch refs/heads/main"
  git -C "$hm_co" checkout -q main || fail "back to main"
  pass_each 'git commit -am x'
}

case_node_no_branch() {
  committer '.branch = null'
  lead_bash 'git commit -m x' | run_hook guard.sh
  assert_deny 'node lead has no bound branch, so it cannot commit; report blocked to your parent'
  pass_each 'git add a.txt'
}

case_node_rewrite() {
  swarm_setup '.authority = {rewriteHistory: false}'
  deny_each 'rewrites history, and node lead may not (authority.rewriteHistory is false); make a new commit instead' \
    'git rebase main' 'git rebase -i HEAD~2' 'git reset --hard' 'git commit --amend' 'git filter-branch --all' 'git filter-repo --force'
  pass_each 'git commit -m x' 'git reset --soft HEAD' 'git revert HEAD'
}

case_node_worktree_ops() {
  swarm_setup '.authority = {worktreeOps: false}'
  deny_each 'works on another worktree, and node lead may not (authority.worktreeOps is false)' \
    'git worktree add ../x' 'git worktree remove x' 'git worktree prune' "git -C $T_DIR/elsewhere status" 'git -C ../x log'
  pass_each 'git worktree list' 'git -C . status' 'git -C sub status' "git -C $(real_project) status"
}

case_node_bash_deny() {
  swarm_setup '.bashDeny = ["make release", "rm -rf", "curl"]'
  deny_each 'is denied to node lead by its spec (bash.deny)' \
    'make release' '/usr/bin/make release now' 'ls && rm -rf build' 'curl https://example.com' 'sh -c "make release"'
  lead_bash 'rm -rf build' | run_hook guard.sh
  assert_deny 'litter guard: rm -rf is denied to node lead'
  pass_each 'make test' 'rm -r build' 'makefoo release' 'echo make release'
}

case_node_deploys() {
  swarm_setup
  deny_each 'publishes or deploys, which litter agents never do' 'npm publish' 'ls; npm publish --dry-run'
}

case_node_bash_protect() {
  swarm_setup
  bp_co=$(real_project)
  deny_each 'Bash may not write under .claude/litter or a litter rule folder' \
    "echo x > $bp_co/.claude/litter/f" "cp a.txt $bp_co/.litter/r.md" "rm -f $bp_co/.claude/rules/litter/r.md"
  pass_each "cat $bp_co/.claude/litter/f" "ls $bp_co/.litter"
}

# R5: litter's hooks and ledgers, however the command spells them, whether or
# not the guard sees a write: a fence against the obvious spellings.
case_node_bash_litter_paths() {
  swarm_setup
  lp_co=$(real_project)
  deny_each 'Bash may not name the litter hooks folder or a litter ledger' \
    'cd .claude; rm litter/hooks/active' \
    'cd .claude && rm -f ./litter//hooks/policy.json' \
    "rm -rf $lp_co/.claude/lit\"\"ter/hooks" \
    "rm -rf $lp_co/.CLAUDE/Litter/HOOKS" \
    'cd .claude/litter; python3 -c "import os; os.remove(\"hooks/active\")"' \
    'cd .claude/litter && mv hooks/agents /tmp/x' \
    'cat > hooks/policy.json' \
    "printf x >> $lp_co/.claude/litter/swarms/s/launches/20261003-120000/ledger/000009-swarm.end.json" \
    'cd .claude/foo; rm -r ../litter/hooks' \
    'cd .claude; rm -r lit?er/hooks' \
    'cd .claude; rm -r */hooks/done' \
    'ls hooks/pending hooks/done hooks/spool'
  # Litter's own source, a React hooks folder, the litter folder itself and its notes are fine.
  pass_each 'cat plugins/litter/hooks/guard.sh' 'sh plugins/litter/tests/hooks/run.sh' 'ls src/hooks/useAgent.ts src/hooks/*' \
    "ls $lp_co/.claude/litter" "cat $lp_co/.claude/litter/WIKI.md" 'git log -- src/hooks' 'grep -r active hooks.ts'
}

# R6: a command too long to check is denied, and one at the limit is checked
# well inside the hook's 30 s timeout, in the worst shape the parse has.
case_node_bash_too_long() {
  swarm_setup
  tl_words=$(awk 'BEGIN { for (i = 0; i < 4001; i++) printf "a " }')
  deny_each 'this command is too long for the guard to check; split it' "echo $tl_words" "env $tl_words; git push"
  tl_bytes=$(awk 'BEGIN { s = "x"; for (i = 0; i < 15; i++) s = s s; printf "%s", s }')
  deny_each 'this command is too long for the guard to check; split it' "echo $tl_bytes"
  lead Monitor "$(jq -cn --arg c "tail $tl_words" '{command: $c, description: "d"}')" | run_hook guard.sh
  assert_deny 'too long for the guard to check'
  # At the limit, one simple command after a wrapper: every later word may start a command.
  tl_at=$(awk 'BEGIN { for (i = 0; i < 3990; i++) printf "a " }')
  tl_t0=$(date +%s)
  lead_bash "env $tl_at git push --force" | run_hook guard.sh
  tl_t1=$(date +%s)
  assert_deny 'git push is denied to swarm nodes'
  [ $((tl_t1 - tl_t0)) -le 10 ] || fail "a command at the limit took $((tl_t1 - tl_t0)) s"
  # The most words that may start one (32), each with the rest of the command after it.
  tl_many=$(awk 'BEGIN { for (i = 0; i < 32; i++) printf "git -C x "; for (i = 0; i < 1950; i++) printf "-C x " }')
  tl_t0=$(date +%s)
  lead_bash "sudo $tl_many push" | run_hook guard.sh
  tl_t1=$(date +%s)
  assert_deny 'git push is denied to swarm nodes'
  [ $((tl_t1 - tl_t0)) -le 10 ] || fail "a command of 32 starts at the limit took $((tl_t1 - tl_t0)) s"
  # More than that, after a wrapper: too many to check.
  tl_starts=$(awk 'BEGIN { for (i = 0; i < 33; i++) printf "git -C x " }')
  lead_bash "sudo $tl_starts status" | run_hook guard.sh
  assert_deny 'too many words that may start a command'
  pass_each 'sudo -u root env A=1 nice -n 5 make test' 'find . -name x -exec grep -l y {} +'
}

case_node_monitor() {
  swarm_setup
  lead Monitor '{"command":"git push","description":"d"}' | run_hook guard.sh
  assert_deny 'git push is denied to swarm nodes'
  lead Monitor '{"command":"tail -f log","description":"d"}' | run_hook guard.sh
  assert_pass
}

# --- the swarm's state and the node's ----------------------------------------

case_swarm_missing() {
  swarm_setup '.' '.swarm.swarms = {t: .swarm.swarms.s}'
  lead Read '{"file_path":"/x"}' | run_hook guard.sh
  assert_deny 'swarm s is not live, so this node has nothing to do; make no more tool calls and end your turn'
  swarm_policy '.swarm = null'
  lead SubagentHandback '{"message":"m"}' | run_hook guard.sh
  assert_deny 'swarm s is not live'
}

case_swarm_handed_over() {
  swarm_setup '.' '.swarm.swarms.s.owner.generation = 2'
  for ho_tool in Read SubagentHandback SendMessage mcp__litter__record; do
    lead "$ho_tool" '{}' | run_hook guard.sh
    assert_deny 'swarm s was handed to another session; make no more tool calls and end your turn'
  done
  node_policy a1 '.generation = 2'
  lead Read '{}' | run_hook guard.sh
  assert_pass
}

# R4: every launch starts at generation 1, so a policy left from an earlier
# launch of the same swarm is told apart by its launch.
case_swarm_other_launch() {
  swarm_setup '.launch = "20261002-090000"'
  for ol_tool in Read SubagentHandback SendMessage mcp__litter__record; do
    lead "$ol_tool" '{}' | run_hook guard.sh
    assert_deny 'belongs to launch 20261002-090000 of swarm s, not to its live launch 20261003-120000; make no more tool calls and end your turn'
  done
  node_policy a1 '.launch = null'
  lead Read '{}' | run_hook guard.sh
  assert_deny 'belongs to launch'
  node_policy a1
  lead Read '{}' | run_hook guard.sh
  assert_pass
}

case_swarm_stale_agrees() {
  repo
  swarm_ref
  swarm_setup '.' '.swarm.swarms.s.owner.checkedAt -= 60'
  lead Read '{"file_path":"/x"}' | run_hook guard.sh
  assert_pass
}

case_swarm_stale_disagrees() {
  repo
  swarm_ref
  swarm_setup '.' '.swarm.swarms.s.owner.checkedAt -= 11 | .swarm.swarms.s.owner.oid = "1111111111111111111111111111111111111111"'
  lead SubagentHandback '{"message":"m"}' | run_hook guard.sh
  assert_deny 'swarm s was handed to another session (its ownership ref no longer names this owner)'
}

case_swarm_stale_ref_missing() {
  repo
  swarm_setup '.' '.swarm.swarms.s.owner.checkedAt -= 60'
  lead Read '{}' | run_hook guard.sh
  assert_deny 'its ownership ref no longer names this owner'
}

case_swarm_stale_git_fails() {
  repo
  swarm_ref
  swarm_setup '.' '.swarm.swarms.s.owner.checkedAt -= 60'
  PATH=$(fake_tool git 'exit 128'):$PATH
  lead Read '{}' | run_hook guard.sh
  assert_deny 'the ownership ref of swarm s could not be read (git failed), so this call cannot be checked; refusing'
}

# A check under 10 s old runs no git; a clock that can't be read makes it stale.
case_swarm_fresh_no_git() {
  swarm_setup
  fn_path=$PATH
  PATH=$(fake_tool git "echo \"\$*\" >>'$T_DIR/git.log'; exit 128"):$fn_path
  lead Read '{}' | run_hook guard.sh
  assert_pass
  assert_no_file "$T_DIR/git.log"
  PATH=$(fake_tool date 'exit 1'):$PATH
  lead Read '{}' | run_hook guard.sh
  assert_deny 'could not be read (git failed)'
  assert_eq "--git-dir=$(real_project)/.git rev-parse -q --verify refs/litter-swarm/s" "$(cat "$T_DIR/git.log")" "the check"
}

case_swarm_bad_entry() {
  swarm_setup '.' '.swarm.swarms.s.owner.checkedAt -= 60 | .swarm.swarms.s.owner.ref = "refs/heads/main"'
  PATH=$(fake_tool git "echo \"\$*\" >>'$T_DIR/git.log'; exit 0"):$PATH
  lead Read '{}' | run_hook guard.sh
  assert_deny 'the ownership check of swarm s cannot run: its entry in policy.json names no usable ref, oid or common dir'
  swarm_policy '.swarm.swarms.s.owner.checkedAt -= 60 | .swarm.swarms.s.commonDir = "rel/.git"'
  lead Read '{}' | run_hook guard.sh
  assert_deny 'cannot run'
  swarm_policy '.swarm.swarms.s.owner.checkedAt -= 60 | .swarm.swarms.s.owner.oid = "--all"'
  lead Read '{}' | run_hook guard.sh
  assert_deny 'cannot run'
  assert_no_file "$T_DIR/git.log"
}

case_swarm_stopping() {
  swarm_setup '.' '.swarm.swarms.s.state = "stopping"'
  for sp_tool in Read Bash Write mcp__litter__record Agent; do
    lead "$sp_tool" '{"command":"ls"}' | run_hook guard.sh
    assert_deny 'swarm s is ending; report and end your turn'
  done
  lead SendMessage '{"to":"main","message":"m"}' | run_hook guard.sh
  assert_pass
  lead SubagentHandback '{"message":"m"}' | run_hook guard.sh
  assert_pass
}

case_node_stopped() {
  swarm_setup '.stopped = "browser"'
  lead SubagentHandback '{"message":"m"}' | run_hook guard.sh
  assert_pass
  for st_tool in SendMessage Read mcp__litter__record; do
    lead "$st_tool" '{}' | run_hook guard.sh
    assert_deny 'you were stopped from the swarm browser: deliver your report and end your turn'
  done
}

case_node_bind() {
  swarm_setup '.bind = true'
  lead mcp__litter__record '{"kind":"swarm.bind","token":"t"}' | run_hook guard.sh
  assert_pass
  lead Read '{}' | run_hook guard.sh
  assert_deny 'bind first: record kind swarm.bind with the token from your <instance> block'
}

case_node_unadmitted() {
  swarm_setup '.admitted = false'
  for un_tool in Read SubagentHandback mcp__litter__record SendMessage; do
    lead "$un_tool" '{}' | run_hook guard.sh
    assert_deny 'not admitted; end your turn'
  done
}

case_node_lost_type() {
  swarm_setup
  for lt_ty in general-purpose litter:sw-s-fixer; do
    call "$lt_ty" Read '{}' | run_hook guard.sh
    assert_deny 'this node lost its type; end your turn'
  done
  lead Read '{}' '.agent_type = ""' | run_hook guard.sh
  assert_deny 'this node lost its type'
}

# A child keeps its own type and gets its node's scope.
case_child() {
  swarm_setup
  node_policy c1 '.kind = "child" | .of = "a1" | .parent = "a1" | .n = 0 | .spawns = ["litter:sw-s-fixer"]'
  as_agent c1 call general-purpose Read '{"file_path":"/x"}' | run_hook guard.sh
  assert_pass
  as_agent c1 bash_call Explore 'git push' | run_hook guard.sh
  assert_deny 'git push is denied to swarm nodes'
  as_agent c1 call general-purpose EnterWorktree '{"name":"x"}' | run_hook guard.sh
  assert_deny 'your directory is fixed by the swarm'
  as_agent c1 call general-purpose Agent '{"description":"d","prompt":"p","subagent_type":"litter:sw-s-fixer"}' | run_hook guard.sh
  assert_pass
  write_call general-purpose "$(real_project)/.claude/litter/x" | jq -c '.agent_id = "c1"' | run_hook guard.sh
  assert_deny 'is under .claude/litter'
}

# --- the race ------------------------------------------------------------------

# The binding lands at the fifth tick, stopped, so the decision shows it was
# decided as a node.
case_race_lands() {
  swarm_setup '.stopped = "browser"'
  mv "$(hooks_dir)/agents/a1.json" "$T_DIR/landing"
  lead Read '{}' >|"$T_DIR/in"
  PATH=$(tick_sleep 5 "$(hooks_dir)/agents/a1.json"):$PATH
  run_hook guard.sh <"$T_DIR/in"
  assert_deny 'you were stopped from the swarm browser'
  assert_eq '0.1 0.1 0.1 0.1 0.1' "$(ticks)" ticks
}

# The same with the real sleep: the binding lands after 1 s.
case_race_lands_late() {
  swarm_setup '.stopped = "browser"'
  mv "$(hooks_dir)/agents/a1.json" "$T_DIR/landing"
  (sleep 1 && mv "$T_DIR/landing" "$(hooks_dir)/agents/a1.json") &
  rl_mv=$!
  lead Read '{}' | run_hook guard.sh
  wait "$rl_mv"
  assert_deny 'you were stopped from the swarm browser'
}

case_race_never() {
  swarm_setup
  rm -f "$(hooks_dir)/agents/a1.json"
  lead Read '{}' >|"$T_DIR/in"
  rn_path=$PATH
  PATH=$(tick_sleep):$rn_path
  run_hook guard.sh <"$T_DIR/in"
  assert_deny 'litter:sw-s-lead is a swarm node that is not bound yet: if your <instance> block names a token, record kind swarm.bind with it; otherwise try again'
  assert_eq 20 "$(wc -l <"$T_DIR/ticks" | tr -d ' ')" "ticks of 100 ms"
  # The record tool passes unbound: the bind token goes through it.
  rm -f "$T_DIR/ticks"
  lead mcp__litter__record '{"kind":"swarm.bind"}' >|"$T_DIR/in"
  run_hook guard.sh <"$T_DIR/in"
  assert_pass
  # A sleep that takes no fraction: two whole seconds instead.
  rm -f "$T_DIR/ticks"
  lead Read '{}' >|"$T_DIR/in"
  PATH=$(whole_sleep):$rn_path
  run_hook guard.sh <"$T_DIR/in"
  assert_deny 'is a swarm node that is not bound yet'
  assert_eq 'refused 1 1' "$(ticks)" ticks
}

# A type no live swarm lists isn't waited for.
case_race_type_not_live() {
  swarm_setup
  as_agent x9 call litter:sw-t-lead Read '{}' >|"$T_DIR/in"
  PATH=$(tick_sleep):$PATH
  run_hook guard.sh <"$T_DIR/in"
  assert_deny 'litter:sw-t-lead is a swarm node that is not bound yet'
  assert_no_file "$T_DIR/ticks"
}

# The agent-summary fork passes at once, a spawn pending or not.
case_race_fork() {
  swarm_setup
  pending_marker
  as_agent f1 call litter:sw-s-lead Bash '{"command":"git push"}' '.agent_type = ""' >|"$T_DIR/in.empty"
  as_agent f1 call litter:sw-s-lead Bash '{"command":"git push"}' 'del(.agent_type)' >|"$T_DIR/in.none"
  PATH=$(tick_sleep):$PATH
  for rf_in in empty none; do
    run_hook guard.sh <"$T_DIR/in.$rf_in"
    assert_pass
  done
  assert_no_file "$T_DIR/ticks"
}

case_race_unrelated() {
  swarm_setup
  as_agent o1 bash_call general-purpose 'git push' >|"$T_DIR/in"
  ru_path=$PATH
  PATH=$(tick_sleep):$ru_path
  run_hook guard.sh <"$T_DIR/in"
  assert_pass
  assert_no_file "$T_DIR/ticks"
  pending_marker
  run_hook guard.sh <"$T_DIR/in"
  assert_pass
  assert_eq 20 "$(wc -l <"$T_DIR/ticks" | tr -d ' ')" "ticks with a spawn pending"
  # A child's binding landing during that wait: decided as the child.
  rm -f "$T_DIR/ticks"
  node_policy o1 '.kind = "child" | .of = "a1" | .parent = "a1" | .n = 0'
  mv "$(hooks_dir)/agents/o1.json" "$T_DIR/landing"
  PATH=$(tick_sleep 3 "$(hooks_dir)/agents/o1.json"):$ru_path
  run_hook guard.sh <"$T_DIR/in"
  assert_deny 'git push is denied to swarm nodes'
  assert_eq '0.1 0.1 0.1' "$(ticks)" ticks
}

# --- the main thread -------------------------------------------------------------

main_moves_denied() {
  call - EnterWorktree '{"name":"x"}' "$1" | run_hook guard.sh
  assert_deny 'litter guard: a litter swarm is live: a session in a worktree confines the Bash, Write and Edit of every agent to that worktree, which would cut off every node pinned elsewhere in the repository (plan 15.4)'
  call - EnterWorktree "$(jq -cn --arg p "$(real_project)" '{path: $p}')" "$1" | run_hook guard.sh
  assert_deny 'a litter swarm is live'
  call - ExitWorktree '{"action":"keep"}' "$1" | run_hook guard.sh
  assert_deny 'a litter swarm is live'
  lead EnterWorktree '{"name":"x"}' "$1" | run_hook guard.sh
  assert_deny 'your directory is fixed by the swarm'
  call - Read '{"file_path":"/x"}' "$1" | run_hook guard.sh
  assert_pass
}

# Before, during and after a /clear rebind: the session id changes, the
# per-agent files don't.
case_main_rebind() {
  swarm_setup
  mr_sum=$(cksum <"$(hooks_dir)/agents/a1.json")
  main_moves_denied '.'
  main_moves_denied '.session_id = "s2"'
  swarm_policy '.session = "s2" | .swarm.swarms.s.owner.session = "s2"'
  main_moves_denied '.session_id = "s2"'
  assert_eq "$mr_sum" "$(cksum <"$(hooks_dir)/agents/a1.json")" "the node policy"
}

case_main_with_run() {
  project >/dev/null
  policy '.run.runIds = [] | .swarm = {swarms: {s: {launch: "20261003-120000", state: "live", commonDir: "/x/.git", owner: {ref: "refs/litter-swarm/s", oid: "0123456789abcdef0123456789abcdef01234567", generation: 1, session: "s1", checkedAt: 0}, nodeTypes: []}}}'
  call - EnterWorktree "$(jq -cn --arg p "$(real_project)" '{path: $p}')" | run_hook guard.sh
  assert_deny 'a litter swarm is live'
  # The swarm gone, the run before its launch: its own rule again.
  policy '.run.runIds = []'
  call - EnterWorktree "$(jq -cn --arg p "$(real_project)" '{path: $p}')" | run_hook guard.sh
  assert_pass
}

case_main_after_swarm() {
  swarm_setup
  swarm_policy '.swarm = null'
  rm -f "$(hooks_dir)/active"
  call - EnterWorktree '{"name":"x"}' | run_hook guard.sh
  assert_pass
  call - ExitWorktree '{"action":"keep"}' | run_hook guard.sh
  assert_pass
}

# --- failures --------------------------------------------------------------------

case_fail_binding_unreadable() {
  swarm_setup
  node_policy c1 '.kind = "child" | .parent = "a1"'
  printf '{"v":1,"node":' >|"$(hooks_dir)/agents/a1.json"
  printf '{"v":1,"node":' >|"$(hooks_dir)/agents/c1.json"
  lead Read '{}' | run_hook guard.sh
  assert_deny 'agents/a1.json is unreadable (it does not parse), so the swarm rules for this agent cannot be read'
  as_agent c1 call general-purpose Read '{}' | run_hook guard.sh
  assert_deny 'agents/c1.json is unreadable'
  call - Read '{}' | run_hook guard.sh
  assert_pass
}

# R8: a binding that exists but is empty, or can't be read, is malformed, not missing.
case_fail_binding_empty() {
  swarm_setup
  node_policy c1 '.kind = "child" | .parent = "a1"'
  : >|"$(hooks_dir)/agents/c1.json"
  as_agent c1 call general-purpose Read '{}' | run_hook guard.sh
  assert_deny 'agents/c1.json is unreadable (empty), so the swarm rules for this agent cannot be read'
  : >|"$(hooks_dir)/agents/a1.json"
  lead Read '{}' | run_hook guard.sh
  assert_deny 'agents/a1.json is unreadable (empty)'
  [ "$(id -u)" != 0 ] || return 0
  node_policy c1 '.kind = "child" | .parent = "a1"'
  chmod 000 "$(hooks_dir)/agents/c1.json"
  as_agent c1 call general-purpose Read '{}' | run_hook guard.sh
  fb_code=$(cat "$T_DIR/code")
  chmod 644 "$(hooks_dir)/agents/c1.json"
  [ "$fb_code" != 0 ] || assert_deny 'agents/c1.json'
  [ "$fb_code" = 0 ] || assert_blocked
  call - Read '{}' | run_hook guard.sh
  assert_pass
}

# R5: `active` removed (from a node's Bash, say) while bindings remain: bound
# agents are still checked, and everyone else passes as with nothing active.
case_fail_no_active() {
  swarm_setup
  node_policy c1 '.kind = "child" | .parent = "a1"'
  rm -f "$(hooks_dir)/active"
  lead_bash 'git push' | run_hook guard.sh
  assert_deny 'git push is denied to swarm nodes'
  as_agent c1 bash_call general-purpose 'git push' | run_hook guard.sh
  assert_deny 'git push is denied to swarm nodes'
  call - ExitWorktree '{"action":"keep"}' >|"$T_DIR/in.main"
  as_agent o1 bash_call general-purpose 'git push' >|"$T_DIR/in.other"
  na_path=$PATH
  PATH=$(fake_tool jq ": >|$T_DIR/jq-ran; exit 1"):$na_path
  for na_in in main other; do
    run_hook guard.sh <"$T_DIR/in.$na_in"
    ( assert_pass ) || fail "the $na_in call was refused"
  done
  PATH=$na_path
  assert_no_file "$T_DIR/jq-ran"
  # With no binding left either, nothing runs past the stat.
  lead_bash 'git push' >|"$T_DIR/in.node"
  rm -f "$(hooks_dir)"/agents/*.json
  PATH=$(fake_tool jq ": >|$T_DIR/jq-ran; exit 1"):$na_path
  run_hook guard.sh <"$T_DIR/in.node"
  PATH=$na_path
  assert_pass
  assert_no_file "$T_DIR/jq-ran"
}

case_fail_no_jq() {
  swarm_setup
  node_policy c1 '.kind = "child" | .parent = "a1"'
  lead Read '{}' >|"$T_DIR/in.node"
  as_agent c1 call general-purpose Read '{}' >|"$T_DIR/in.child"
  as_agent o1 call general-purpose Read '{}' >|"$T_DIR/in.other"
  call - Read '{}' >|"$T_DIR/in.main"
  call - EnterWorktree '{"name":"x"}' >|"$T_DIR/in.enter"
  PATH=$(path_without_jq)
  for nj_who in node child; do
    run_hook guard.sh <"$T_DIR/in.$nj_who"
    assert_blocked 'jq not found'
  done
  run_hook guard.sh <"$T_DIR/in.other"
  assert_pass
  run_hook guard.sh <"$T_DIR/in.main"
  assert_pass
  run_hook guard.sh <"$T_DIR/in.enter"
  assert_blocked 'jq not found'
}

case_fail_policy_broken() {
  swarm_setup
  node_policy c1 '.kind = "child" | .parent = "a1"'
  for pb_text in '{"v":1,"swarm":' '{"v":2}' '[]'; do
    printf '%s' "$pb_text" >|"$(hooks_dir)/policy.json"
    lead Read '{}' | run_hook guard.sh
    assert_deny 'policy.json is unreadable'
    as_agent c1 call general-purpose Read '{}' | run_hook guard.sh
    assert_deny 'policy.json is unreadable'
    call - Read '{}' | run_hook guard.sh
    assert_pass
  done
  lead Read '{}' | run_hook guard.sh
  assert_deny 'policy.json is unreadable (not a JSON object)'
}

# git failing for the head check denies the commit: no HEAD is no branch.
case_fail_git_head() {
  committer
  PATH=$(fake_tool git 'exit 128'):$PATH
  lead_bash 'git commit -m x' | run_hook guard.sh
  assert_deny 'is detached, not your bound branch refs/heads/main'
  pass_each 'git status'
}

t "a node's plain calls pass, the record tool and the hand-back too" case_node_plain
t "a node's EnterWorktree and ExitWorktree are denied" case_node_worktree_tools
t "tools.deny denies by name" case_node_tools_deny
t "a node spawns no named agent" case_node_agent_name
t "a node spawns only the swarm types its spec lists" case_node_agent_spawns
t "a node spawns no litter role" case_node_agent_role
t "spawnOther false leaves only the listed swarm types" case_node_spawn_other
t "PowerShell is denied to a node" case_node_powershell
t "writes stay in paths, resolved under dir, relative ones against dir" case_node_write_paths
t "writes into .claude/litter, a rule folder or a protected copy are denied, through a link too" case_node_write_protect
t "a write path that can't be resolved is denied" case_node_write_unresolvable
t "git push is denied whatever the authority" case_node_push
t "with commit unset there's no commit rule, and no git runs" case_node_commit_unset
t "commit false denies commits and index writes" case_node_commit_false
t "a plan-template executor in the active run's checkout writes, and may not commit" case_node_run_checkout_executor
t "commit true allows commits in dir only, without -C, git dirs, GIT_* or cd elsewhere" case_node_commit_true
t "commit true denies every way off the bound branch, and allows restores" case_node_bound_branch
t "a commit is denied while HEAD names another branch or none" case_node_head_moved
t "commit true with no bound branch denies the commit" case_node_no_branch
t "rewriteHistory false denies rebase, reset --hard, amend and filters" case_node_rewrite
t "worktreeOps false denies git worktree and -C outside dir" case_node_worktree_ops
t "bash.deny entries are command prefixes, by program name" case_node_bash_deny
t "publish and deploy commands are denied to nodes" case_node_deploys
t "Bash writing under .claude/litter or a rule folder is denied" case_node_bash_protect
t "Bash naming litter's hooks or a ledger is denied, however it's spelled" case_node_bash_litter_paths
t "a command too long to check is denied, and one at the limit is checked in time" case_node_bash_too_long
t "Monitor's command is checked as Bash" case_node_monitor
t "a swarm with no entry denies everything" case_swarm_missing
t "a node of an older generation denies everything" case_swarm_handed_over
t "a node policy of another launch denies everything" case_swarm_other_launch
t "a stale check whose ref agrees passes" case_swarm_stale_agrees
t "a stale check whose ref disagrees denies" case_swarm_stale_disagrees
t "a stale check with the ref gone denies" case_swarm_stale_ref_missing
t "a stale check with git failing denies" case_swarm_stale_git_fails
t "a fresh check runs no git, and a clock that fails makes it stale" case_swarm_fresh_no_git
t "an entry with no usable ref, oid or common dir denies, and runs no git" case_swarm_bad_entry
t "a stopping swarm leaves SendMessage and SubagentHandback" case_swarm_stopping
t "a stopped node has SubagentHandback only" case_node_stopped
t "a node binding has the record tool only" case_node_bind
t "an unadmitted node has nothing" case_node_unadmitted
t "a node that lost its type has nothing" case_node_lost_type
t "a child keeps its type and gets its node's rules" case_child
t "a binding that lands mid-wait is decided as a node" case_race_lands
t "a binding that lands after 1 s is decided as a node" case_race_lands_late
t "a binding that never lands is denied after 2 s, and the record tool passes" case_race_never
t "a node type no live swarm lists is not waited for" case_race_type_not_live
t "an agent with no agent_type passes at once" case_race_fork
t "an unrelated agent waits only while a spawn is pending" case_race_unrelated
t "the main thread's worktree moves are denied before, during and after a /clear rebind" case_main_rebind
t "a live swarm overrides the run's EnterWorktree before the launch" case_main_with_run
t "after the swarm, the main thread's worktree moves pass" case_main_after_swarm
t "an unreadable node binding denies the node and the child, not the main thread" case_fail_binding_unreadable
t "an empty or unreadable binding is malformed, not missing" case_fail_binding_empty
t "with active gone while bindings remain, bound agents are still checked" case_fail_no_active
t "without jq, nodes and children are refused, others pass" case_fail_no_jq
t "a broken policy.json denies nodes and children, not the main thread" case_fail_policy_broken
t "git failing at the head check denies the commit" case_fail_git_head
done_testing
