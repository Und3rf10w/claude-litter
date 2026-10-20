# Tier 3: guard.sh's write rules against the resolved target, never the
# spelling (plan section 9, "checked against the resolved target"; section 12,
# "resolved paths" and "the rules guard").

. "$(dirname "$0")/testlib.sh"

# Executor a1 in an active run, with a ledger folder to aim at.
setup() {
  project >/dev/null
  mkdir -p "$T_DIR/project/.claude/litter/20261002-test/ledger" "$T_DIR/project/src"
  policy "${1:-.}"
  bind a1 litter:executor
}

# Each of Write, Edit and NotebookEdit at <path> is denied with <text>.
deny_all_tools() {
  for dt_tool in Write Edit NotebookEdit; do
    write_call litter:executor "$1" "$dt_tool" | run_hook guard.sh
    assert_deny "$2"
  done
}

case_direct_ledger() {
  setup
  deny_all_tools "$T_DIR/project/.claude/litter/20261002-test/ledger/000009-verdict.json" 'is under .claude/litter'
}

case_alias_dir() {
  setup
  ln -s .claude/litter "$T_DIR/project/alias"
  deny_all_tools "$T_DIR/project/alias/20261002-test/ledger/000009-verdict.json" 'is under .claude/litter'
}

case_alias_new_folder() {
  setup
  ln -s .claude/litter "$T_DIR/project/alias"
  write_call litter:executor "$T_DIR/project/alias/newdir/deeper/x.json" | run_hook guard.sh
  assert_deny 'is under .claude/litter'
}

case_alias_final_link() {
  setup
  : >|"$T_DIR/project/.claude/litter/20261002-test/ledger/000001-run.start.json"
  ln -s .claude/litter/20261002-test/ledger/000001-run.start.json "$T_DIR/project/src/notes.json"
  write_call litter:executor "$T_DIR/project/src/notes.json" Edit | run_hook guard.sh
  assert_deny 'is under .claude/litter'
}

case_link_chain() {
  setup
  ln -s ../.claude/litter/20261002-test "$T_DIR/project/src/l1"
  ln -s l1 "$T_DIR/project/src/l2"
  ln -s l2/ledger/x.json "$T_DIR/project/src/l3"
  write_call litter:executor "$T_DIR/project/src/l3" | run_hook guard.sh
  assert_deny 'is under .claude/litter'
}

case_link_loop() {
  setup
  ln -s loop-b "$T_DIR/project/src/loop-a"
  ln -s loop-a "$T_DIR/project/src/loop-b"
  write_call litter:executor "$T_DIR/project/src/loop-a" | run_hook guard.sh
  assert_deny 'could not resolve'
}

# A worktree's link to litterDir: the run root is listed in policy.json.
case_link_to_litterdir_from_worktree() {
  setup
  w=$T_DIR/wt
  mkdir -p "$w"
  ln -s "$(real_project)/.claude/litter" "$w/state"
  policy ".run.roots.checkout = \"$(cd -P "$w" && pwd -P)\""
  write_call litter:executor "$w/state/20261002-test/ledger/x.json" | run_hook guard.sh
  assert_deny 'is under .claude/litter'
}

# A litterDir with no .claude/litter in its spelling (a bare repository's).
case_bare_litterdir() {
  setup
  mkdir -p "$T_DIR/store.git/litter"
  bare=$(cd -P "$T_DIR/store.git/litter" && pwd -P)
  policy ".litterDir = \"$bare\" | .run.roots.litterDir = \"$bare\" | .run.roots.checkout = \"$(cd -P "$T_DIR" && pwd -P)\""
  write_call litter:executor "$T_DIR/store.git/litter/x/ledger/1.json" | run_hook guard.sh
  assert_deny 'is under .claude/litter'
  ln -s "$bare" "$T_DIR/project/src/b"
  write_call litter:executor "$T_DIR/project/src/b/y.json" | run_hook guard.sh
  assert_deny 'is under .claude/litter'
}

case_case_folded() {
  setup
  write_call litter:executor "$T_DIR/project/.Claude/Litter/x.json" | run_hook guard.sh
  assert_deny 'is under .claude/litter'
}

case_stat_fails() {
  setup
  mkdir -p "$T_DIR/project/src/locked/inner"
  chmod 000 "$T_DIR/project/src/locked"
  write_call litter:executor "$T_DIR/project/src/locked/inner/x.py" | run_hook guard.sh
  chmod 755 "$T_DIR/project/src/locked"
  [ "$(id -u)" = 0 ] && return 0 # root enters any folder
  assert_deny 'could not resolve'
}

case_file_as_folder() {
  setup
  : >|"$T_DIR/project/src/a.py"
  write_call litter:executor "$T_DIR/project/src/a.py/x" | run_hook guard.sh
  assert_deny 'could not resolve'
}

case_dangling_link_on_the_way() {
  setup
  ln -s "$T_DIR/missing-target" "$T_DIR/project/src/gone"
  write_call litter:executor "$T_DIR/project/src/gone/x.py" | run_hook guard.sh
  assert_deny 'could not resolve'
}

case_dotdot_refused() {
  setup
  write_call litter:executor "$T_DIR/project/src/../.claude/litter/x" | run_hook guard.sh
  assert_deny 'no empty, . or .. parts'
  write_call litter:executor "$T_DIR/project/src/./a.py" | run_hook guard.sh
  assert_deny 'no empty, . or .. parts'
}

case_tilde_refused() {
  setup
  write_call litter:executor '~/notes.md' | run_hook guard.sh
  assert_deny 'give an absolute path'
}

case_relative_against_binding() {
  setup
  mkdir -p "$T_DIR/elsewhere"
  # Relative paths go against the bound folder, never the call's cwd.
  write_call litter:executor 'src/a.py' | jq -c --arg c "$T_DIR/elsewhere" '.cwd = $c' | run_hook guard.sh
  assert_pass
  write_call litter:executor '.claude/litter/x.json' | jq -c --arg c "$T_DIR/elsewhere" '.cwd = $c' | run_hook guard.sh
  assert_deny 'is under .claude/litter'
}

case_new_folder_inside() {
  setup
  write_call litter:executor "$T_DIR/project/pkg/new/deeper/mod.py" | run_hook guard.sh
  assert_pass
}

case_link_out_of_checkout() {
  setup
  mkdir -p "$T_DIR/outside"
  ln -s "$T_DIR/outside" "$T_DIR/project/src/out"
  write_call litter:executor "$T_DIR/project/src/out/a.py" | run_hook guard.sh
  assert_deny 'writes only inside'
}

case_rule_folders() {
  setup
  for rf in .litter/rules/x.md .litter.local/rules/x.md .claude/rules/litter/x.md .claude/rules/litter-local/x.md; do
    write_call litter:executor "$T_DIR/project/$rf" | run_hook guard.sh
    assert_deny 'rules change only through /litter:rules'
  done
}

case_rule_folder_link() {
  setup
  mkdir -p "$T_DIR/project/.litter/rules"
  ln -s ../.litter/rules "$T_DIR/project/src/r"
  write_call litter:executor "$T_DIR/project/src/r/x.md" | run_hook guard.sh
  assert_deny 'rules change only through /litter:rules'
}

case_rule_dirs_from_policy() {
  setup
  mkdir -p "$T_DIR/project/team-rules"
  policy ".run.roots.ruleDirs = [\"$(real_project)/team-rules\"]"
  write_call litter:executor "$T_DIR/project/team-rules/x.md" | run_hook guard.sh
  assert_deny 'rules change only through /litter:rules'
}

case_user_rule_folders() {
  setup
  mkdir -p "$T_DIR/config/litter/rules" "$T_DIR/config/rules/litter"
  policy ".run.roots.checkout = \"$(cd -P "$T_DIR" && pwd -P)\""
  CLAUDE_CONFIG_DIR=$T_DIR/config
  export CLAUDE_CONFIG_DIR
  write_call litter:executor "$T_DIR/config/litter/rules/x.md" | run_hook guard.sh
  assert_deny 'rules change only through /litter:rules'
  write_call litter:executor "$T_DIR/config/rules/litter/x.md" | run_hook guard.sh
  assert_deny 'rules change only through /litter:rules'
  ln -s "$T_DIR/config/rules" "$T_DIR/project/src/cfg"
  write_call litter:executor "$T_DIR/project/src/cfg/litter/x.md" | run_hook guard.sh
  assert_deny 'rules change only through /litter:rules'
}

# The rules store's files under the config dir (WP-AD) before any exist:
# your rules ledger, where a forged rule.accept would go, a user rule, and
# its .history, each denied with every write tool.
case_user_rules_store() {
  setup
  mkdir -p "$T_DIR/config"
  policy ".run.roots.checkout = \"$(cd -P "$T_DIR" && pwd -P)\""
  CLAUDE_CONFIG_DIR=$T_DIR/config
  export CLAUDE_CONFIG_DIR
  deny_all_tools "$T_DIR/config/litter/rules-ledger/ledger/000001-rule.accept.json" 'rules change only through /litter:rules'
  deny_all_tools "$T_DIR/config/litter/rules/U-answer-tersely.md" 'rules change only through /litter:rules'
  deny_all_tools "$T_DIR/config/litter/rules/.history/U-answer-tersely@1.md" 'rules change only through /litter:rules'
}

t "Write, Edit and NotebookEdit into the ledger are denied" case_direct_ledger
t "the same through a symlink alias -> .claude/litter are denied" case_alias_dir
t "a new file in a new folder below the alias is denied" case_alias_new_folder
t "a link whose target is a ledger file is denied" case_alias_final_link
t "a chain of links into the ledger is denied" case_link_chain
t "a link loop is denied" case_link_loop
t "a worktree's link to litterDir is denied" case_link_to_litterdir_from_worktree
t "a litterDir without .claude/litter in its name is denied, through a link too" case_bare_litterdir
t ".Claude/Litter/x is denied" case_case_folded
t "a path whose folder can't be entered is denied" case_stat_fails
t "a path through a file is denied" case_file_as_folder
t "a path through a dangling link is denied" case_dangling_link_on_the_way
t "a path with . or .. parts is denied" case_dotdot_refused
t "a path starting with ~ is denied" case_tilde_refused
t "a relative path is taken against the binding, not the cwd" case_relative_against_binding
t "a new file in a new folder inside the checkout is allowed" case_new_folder_inside
t "a link out of the checkout is denied" case_link_out_of_checkout
t "the project and local rule folders and their exports are denied" case_rule_folders
t "a rule folder through a link is denied" case_rule_folder_link
t "the rule folders policy.json lists are denied" case_rule_dirs_from_policy
t "the user rule folders under the config dir are denied" case_user_rule_folders
t "the user rules ledger, a user rule and its .history are denied before they exist" case_user_rules_store
done_testing
