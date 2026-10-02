# Tier 3: worktree.sh, WorktreeCreate (plan section 9, "Run worktrees";
# section 12, "run worktrees"). In a scratch repository whose origin/main is
# behind HEAD: a litter name gets its run's worktree at base, every other
# name the worktree the engine would make, with its post-create step.

. "$(dirname "$0")/testlib.sh"

LNAME=wf_abc123-456-1
LBRANCH=litter/20261002-test-w1

# The litter worktree's path, resolved, as the mod's worktreeRoot has it.
lpath() { printf '%s\n' "$(real_project)/.claude/worktrees/${1:-$LNAME}"; }

# An engine-made worktree's path, under the resolved root.
epath() { printf '%s\n' "$(real_project)/.claude/worktrees/$1"; }

# git in the scratch repository.
g() { git -C "$T_DIR/project" "$@"; }

# The worktree.sh run for <name>: create <name> [cwd].
create() { wt_in "$1" "${2:-$T_DIR/project}" | run_hook worktree.sh; }

# The path printed: exit 0, and exactly one line, <path>.
assert_made() {
  assert_code 0
  assert_eq "$1" "$(cat "$T_DIR/out")" "the printed path"
  assert_eq 1 "$(wc -l <"$T_DIR/out" | tr -d ' ')" "lines on stdout"
  [ -d "$1" ] || fail "no worktree at $1"
}

# Refused: exit 1, nothing printed, <text> in the reason.
assert_refused() {
  assert_code 1
  assert_stdout_empty
  assert_stderr_contains "$1"
}

# The spooled worktree steps, one per line.
steps() { spool_lines | jq -r 'select(.ev == "worktree") | .step'; }

marker_step() { jq -r '.step' "$(hooks_dir)/wt/$LNAME"; }

# The marker a request left, with its step replaced, as an earlier one cut off would leave it.
set_marker() {
  sm_f=$(hooks_dir)/wt/$LNAME
  mkdir -p "$(hooks_dir)/wt"
  jq -n --arg step "$1" --arg path "$(lpath)" --arg base "$REPO_BASE" \
    '{v: 1, step: $step, run: "20261002-test", name: "wf_abc123-456-1", path: $path, branch: "litter/20261002-test-w1",
      base: $base, disposable: false}' >|"$sm_f" || fail "marker fixture"
}

# linked_at_origin <name>: origin/main gets a commit where <name> is a link
# to $T_DIR/outside, and HEAD one that drops it again, so only a worktree at
# the fresh base has the link. Neither touches the checkout's files.
linked_at_origin() {
  mkdir -p "$T_DIR/outside"
  la_blob=$(printf '%s' "$T_DIR/outside" | g hash-object -w --stdin) || fail "link blob"
  g update-index --add --cacheinfo "120000,$la_blob,$1" && g commit -qm "link $1" || fail "link commit"
  REPO_OLD=$(g rev-parse HEAD)
  g update-ref refs/remotes/origin/main "$REPO_OLD" || fail "origin/main"
  g rm -q --cached -- "$1" && g commit -qm "unlink $1" || fail "unlink commit"
  REPO_BASE=$(g rev-parse HEAD)
}

# The run's setup argv, as JSON.
with_setup() { fanout_policy ".run.setup = $1 | ${2:-.}"; }

# --- a litter name ----------------------------------------------------------

case_litter_at_base() {
  repo
  fanout_policy
  # A git that notes whether the intent was already spooled when the add ran.
  real_git=$(command -v git)
  mkdir -p "$T_DIR/spy"
  cat >|"$T_DIR/spy/git" <<EOF
#!/bin/sh
case " \$* " in
  *" worktree add "*) grep -q '"step":"intent"' '$(hooks_dir)/spool/s1.jsonl' 2>/dev/null && : >|'$T_DIR/intent-first' ;;
esac
exec '$real_git' "\$@"
EOF
  chmod +x "$T_DIR/spy/git"
  PATH=$T_DIR/spy:$PATH create "$LNAME"
  assert_made "$(lpath)"
  assert_file "$T_DIR/intent-first"
  assert_eq "$REPO_BASE" "$(git -C "$(lpath)" rev-parse HEAD)" "the worktree's HEAD"
  [ "$REPO_BASE" != "$REPO_OLD" ] || fail "origin/main isn't behind HEAD"
  assert_eq "$LBRANCH" "$(git -C "$(lpath)" symbolic-ref --short HEAD)" branch
  assert_eq "intent create" "$(steps | tr '\n' ' ' | sed 's/ $//')" "spooled steps"
  line=$(spool_lines | jq -c 'select(.step == "create")')
  assert_eq "20261002-test $LNAME $(lpath) $LBRANCH $REPO_BASE false" \
    "$(printf '%s' "$line" | jq -r '"\(.run) \(.name) \(.path) \(.branch) \(.base) \(.disposable)"')" "the create line"
  assert_eq '[]' "$(printf '%s' "$line" | jq -c '.ignored')" "ignored paths"
  assert_eq create "$(marker_step)" "wt/ marker"
}

case_litter_design_disposable() {
  repo
  fanout_policy '.run.workflow = "design"'
  create "$LNAME"
  assert_made "$(lpath)"
  assert_eq true "$(spool_lines | jq -r 'select(.step == "create") | .disposable')" disposable
}

case_refuse_stopping() {
  repo
  fanout_policy '.run.stopping = true'
  create "$LNAME"
  assert_refused 'run 20261002-test is stopping'
  assert_no_file "$(lpath)"
  assert_eq '' "$(spool_lines)" spool
}

case_refuse_no_worktree_root() {
  repo
  fanout_policy 'del(.run.worktreeRoot)'
  create "$LNAME"
  assert_refused 'no worktreeRoot'
  fanout_policy '.run.worktreeRoot = "relative/wt"'
  create "$LNAME"
  assert_refused 'no worktreeRoot'
  fanout_policy 'del(.run.setupTimeoutSec)'
  create "$LNAME"
  assert_refused 'no setupTimeoutSec'
  assert_no_file "$(lpath)"
  [ -z "$(g branch --list "$LBRANCH")" ] || fail "a branch was made"
}

case_refuse_unknown_run() {
  repo
  fanout_policy '.run.run = "not a run"'
  create "$LNAME"
  assert_refused 'names no usable run'
  # A marker for another run's worktree under this name.
  fanout_policy
  set_marker intent
  jq '.run = "20261001-other"' "$(hooks_dir)/wt/$LNAME" >|"$T_DIR/m" && mv "$T_DIR/m" "$(hooks_dir)/wt/$LNAME"
  create "$LNAME"
  assert_refused "records another worktree (run \"20261001-other\""
  assert_no_file "$(lpath)"
}

case_refuse_no_jq() {
  repo
  fanout_policy
  wt_in "$LNAME" >|"$T_DIR/in"
  nojq=$(path_without_jq)
  PATH=$nojq run_hook worktree.sh <"$T_DIR/in"
  assert_refused 'jq not found'
  assert_no_file "$(lpath)"
}

case_refuse_bad_policy() {
  repo
  fanout_policy
  printf '{"v":1,"run":' >|"$(hooks_dir)/policy.json"
  create "$LNAME"
  assert_refused 'policy.json is unreadable (it does not parse)'
  rm "$(hooks_dir)/policy.json"
  create "$LNAME"
  assert_refused 'policy.json is unreadable (missing)'
  fanout_policy
  if [ "$(id -u)" != 0 ]; then
    chmod 000 "$(hooks_dir)/policy.json"
    create "$LNAME"
    assert_refused 'policy.json is unreadable'
    chmod 644 "$(hooks_dir)/policy.json"
  fi
  assert_no_file "$(lpath)"
  # A name that isn't litter's is still made.
  printf '{"v":1,"run":' >|"$(hooks_dir)/policy.json"
  create feature
  assert_made "$(epath feature)"
}

case_refuse_no_hooks_folder() {
  repo
  fanout_policy
  wt_in "$LNAME" >|"$T_DIR/in"
  wt_in feature >|"$T_DIR/in.other"
  unset CLAUDE_PROJECT_DIR
  run_hook worktree.sh <"$T_DIR/in"
  assert_refused "can't find litter's hooks folder"
  run_hook worktree.sh <"$T_DIR/in.other"
  assert_made "$(epath feature)"
  assert_stderr_contains "worktree.json isn't read"
}

# later_policy [jq filter]: the policy.json the mod writes next, kept aside
# for a background mv, which replaces it whole as the mod's atomic write does.
later_policy() {
  fanout_policy "${1:-.}"
  mv "$(hooks_dir)/policy.json" "$T_DIR/later.json" || fail "later policy"
}

case_launching_appears() {
  repo
  later_policy
  fanout_policy '.run.runIds = [] | .run.launching = true'
  # The launch returns its run id a moment after the first agent asks.
  (sleep 2 && mv "$T_DIR/later.json" "$(hooks_dir)/policy.json") &
  create "$LNAME"
  wait
  assert_made "$(lpath)"
  assert_eq "$LBRANCH" "$(git -C "$(lpath)" symbolic-ref --short HEAD)" branch
}

case_launching_never() {
  repo
  fanout_policy '.run.runIds = [] | .run.launching = true'
  t0=$(date +%s)
  create "$LNAME"
  t1=$(date +%s)
  assert_made "$(epath "$LNAME")"
  assert_eq "worktree-$LNAME" "$(git -C "$(epath "$LNAME")" symbolic-ref --short HEAD)" "the engine's branch"
  [ $((t1 - t0)) -ge 14 ] || fail "decided after $((t1 - t0)) s, before the 15 s wait"
}

case_launching_other_run() {
  repo
  later_policy '.run.runIds = ["wf_fff999-000"] | .run.launching = false'
  fanout_policy '.run.runIds = [] | .run.launching = true'
  (sleep 1 && mv "$T_DIR/later.json" "$(hooks_dir)/policy.json") &
  t0=$(date +%s)
  create "$LNAME"
  t1=$(date +%s)
  wait
  assert_made "$(epath "$LNAME")"
  assert_eq "$REPO_OLD" "$(git -C "$(epath "$LNAME")" rev-parse HEAD)" "the engine's base"
  # The whole wait would be 15 s before the engine's add even began.
  [ $((t1 - t0)) -lt 15 ] || fail "waited $((t1 - t0)) s after the launch had ended"
}

# --- setup and linkDirs -------------------------------------------------------

case_setup_ok() {
  repo
  with_setup '["sh", "-c", "mkdir -p deps && printf \"%s\\n\" \"$0\" >deps/arg && echo set up", "one word"]'
  create "$LNAME"
  assert_made "$(lpath)"
  assert_eq 'one word' "$(cat "$(lpath)/deps/arg")" "the argv's last word"
  log=$(real_project)/.claude/litter/20261002-test/verify/setup-$LNAME/0001.log
  assert_eq 'set up' "$(cat "$log")" "the setup log"
  assert_eq '["deps/"]' "$(spool_lines | jq -c 'select(.step == "create") | .ignored')" "ignored after the setup"
}

case_setup_fails() {
  repo
  with_setup '["sh", "-c", "echo broken; exit 3"]'
  create "$LNAME"
  assert_refused 'exited 3'
  log=$(real_project)/.claude/litter/20261002-test/verify/setup-$LNAME/0001.log
  assert_stderr_contains "$log"
  assert_eq broken "$(cat "$log")" "the setup log"
  line=$(spool_lines | jq -c 'select(.step == "setup_failed")')
  assert_eq "3 false $log" "$(printf '%s' "$line" | jq -r '"\(.exit_code) \(.timed_out) \(.log)"')" "the setup_failed line"
  assert_eq setup_failed "$(marker_step)" "wt/ marker"
  # Never made some other way.
  [ -z "$(g branch --list "worktree-$LNAME")" ] || fail "the engine's branch was made"
  assert_no_file "$(epath "$LNAME.x")"
}

case_setup_times_out() {
  repo
  with_setup '["sleep", "60"]' '.run.setupTimeoutSec = 1'
  t0=$(date +%s)
  create "$LNAME"
  t1=$(date +%s)
  assert_refused 'timed out after 1 s'
  [ $((t1 - t0)) -lt 40 ] || fail "the setup ran $((t1 - t0)) s"
  assert_eq 'null true' "$(spool_lines | jq -r 'select(.step == "setup_failed") | "\(.exit_code) \(.timed_out)"')" "the setup_failed line"
}

case_setup_missing_command() {
  repo
  with_setup '["litter-no-such-command"]'
  create "$LNAME"
  assert_refused 'exited 127'
}

case_links_made() {
  repo
  mkdir -p "$T_DIR/project/node_modules/pkg"
  printf 'node_modules\n' >>"$T_DIR/project/.gitignore"
  g commit -qam 'ignore node_modules as a link' || fail commit
  REPO_BASE=$(g rev-parse HEAD)
  fanout_policy '.run.linkDirs = ["node_modules/"]'
  create "$LNAME"
  assert_made "$(lpath)"
  [ -L "$(lpath)/node_modules" ] || fail "no link"
  assert_eq "$(real_project)/node_modules" "$(readlink "$(lpath)/node_modules")" "the link's target"
  assert_contains 'node_modules' "$(spool_lines | jq -c 'select(.step == "create") | .ignored')" "ignored"
}

case_links_not_ignored_as_link() {
  repo
  mkdir -p "$T_DIR/project/node_modules/pkg"
  printf 'node_modules/\n' >>"$T_DIR/project/.gitignore"
  g commit -qam 'ignore node_modules as a folder' || fail commit
  REPO_BASE=$(g rev-parse HEAD)
  fanout_policy '.run.linkDirs = ["node_modules"]'
  create "$LNAME"
  assert_refused "isn't ignored as a link"
  assert_no_file "$(lpath)/node_modules"
  assert_eq setup_failed "$(marker_step)" "wt/ marker"
}

case_links_refused() {
  repo
  fanout_policy '.run.linkDirs = ["../outside"]'
  create "$LNAME"
  assert_refused 'not a relative folder'
  fanout_policy '.run.linkDirs = ["missing"]'
  printf 'missing\n' >>"$T_DIR/project/.gitignore"
  create "$LNAME"
  assert_refused "missing isn't a folder in the checkout"
}

case_links_left_alone() {
  repo
  mkdir -p "$T_DIR/project/node_modules"
  printf 'node_modules\n' >>"$T_DIR/project/.gitignore"
  g commit -qam 'ignore node_modules' || fail commit
  REPO_BASE=$(g rev-parse HEAD)
  fanout_policy '.run.linkDirs = ["node_modules"]'
  create "$LNAME"
  assert_made "$(lpath)"
  before=$(ls -id "$(lpath)/node_modules" | awk '{print $1}')
  # A request cut off after the link, before the create, finishes without touching it.
  set_marker intent
  create "$LNAME"
  assert_made "$(lpath)"
  assert_eq "$before" "$(ls -id "$(lpath)/node_modules" | awk '{print $1}')" "the link's inode"
  # A link that points elsewhere is replaced.
  rm "$(lpath)/node_modules"
  ln -s /nonexistent "$(lpath)/node_modules"
  set_marker intent
  create "$LNAME"
  assert_made "$(lpath)"
  assert_eq "$(real_project)/node_modules" "$(readlink "$(lpath)/node_modules")" "the replaced link"
}

# --- an unfinished request, cut off after its intent --------------------------

case_unfinished_branch_only() {
  repo
  fanout_policy
  set_marker intent
  g branch "$LBRANCH" "$REPO_BASE" || fail branch
  create "$LNAME"
  assert_made "$(lpath)"
  assert_eq "$REPO_BASE" "$(git -C "$(lpath)" rev-parse HEAD)" HEAD
  assert_eq create "$(steps)" "spooled steps"
  assert_eq create "$(marker_step)" "wt/ marker"
}

case_unfinished_setup_killed() {
  repo
  with_setup '["sh", "-c", "mkdir -p deps && echo run >>deps/runs"]'
  set_marker intent
  g worktree add -q -b "$LBRANCH" "$(lpath)" "$REPO_BASE" || fail add
  mkdir -p "$(lpath)/deps"
  printf 'cut off\n' >|"$(lpath)/deps/runs"
  create "$LNAME"
  assert_made "$(lpath)"
  # Kept, not made again: what the cut-off setup left is still there.
  assert_eq 'cut off run' "$(tr '\n' ' ' <"$(lpath)/deps/runs" | sed 's/ $//')" "the setup's file"
  assert_eq create "$(steps)" "spooled steps"
}

case_unfinished_checkout_cut() {
  repo
  fanout_policy
  set_marker intent
  g worktree add -q -b "$LBRANCH" "$(lpath)" "$REPO_BASE" || fail add
  rm "$(lpath)/a.txt"
  create "$LNAME"
  assert_made "$(lpath)"
  assert_file "$(lpath)/a.txt"
  assert_eq '' "$(git -C "$(lpath)" status --porcelain)" "status"
}

case_unfinished_setup_retried() {
  repo
  with_setup '["sh", "-c", "test -f /nonexistent/litter-ready || exit 4"]'
  create "$LNAME"
  assert_refused 'exited 4'
  with_setup '["sh", "-c", "mkdir -p deps && echo ok >deps/ok"]'
  create "$LNAME"
  assert_made "$(lpath)"
  assert_file "$(lpath)/deps/ok"
  assert_eq "intent setup_failed create" "$(steps | tr '\n' ' ' | sed 's/ $//')" "spooled steps"
}

case_unfinished_commits_past_base() {
  repo
  fanout_policy
  set_marker intent
  g worktree add -q -b "$LBRANCH" "$(lpath)" "$REPO_BASE" || fail add
  printf 'work\n' >|"$(lpath)/w.txt"
  git -C "$(lpath)" add w.txt && git -C "$(lpath)" commit -qm work || fail commit
  create "$LNAME"
  assert_refused 'has commits past base'
  # The branch alone, with no worktree, is refused the same way.
  g worktree remove --force "$(lpath)" || fail remove
  create "$LNAME"
  assert_refused 'has commits past base'
  assert_eq work "$(g log -1 --format=%s "$LBRANCH")" "the branch"
}

case_unfinished_branch_elsewhere() {
  repo
  fanout_policy
  set_marker intent
  g worktree add -q -b "$LBRANCH" "$T_DIR/elsewhere" "$REPO_BASE" || fail add
  create "$LNAME"
  assert_refused "is checked out at"
}

# --- a replay ---------------------------------------------------------------

case_replay_keeps_work() {
  repo
  fanout_policy
  create "$LNAME"
  assert_made "$(lpath)"
  printf 'done\n' >|"$(lpath)/w.txt"
  git -C "$(lpath)" add w.txt && git -C "$(lpath)" commit -qm 'the writer commit' || fail commit
  printf 'half\n' >>"$(lpath)/a.txt"
  create "$LNAME"
  assert_made "$(lpath)"
  assert_eq 'the writer commit' "$(git -C "$(lpath)" log -1 --format=%s)" "the commit"
  assert_eq ' M a.txt' "$(git -C "$(lpath)" status --porcelain)" "the uncommitted change"
  assert_eq "intent create" "$(steps | tr '\n' ' ' | sed 's/ $//')" "nothing more spooled"
}

case_replay_gone_readded() {
  repo
  with_setup '["sh", "-c", "mkdir -p deps && echo ok >deps/ok"]'
  create "$LNAME"
  assert_made "$(lpath)"
  printf 'done\n' >|"$(lpath)/w.txt"
  git -C "$(lpath)" add w.txt && git -C "$(lpath)" commit -qm 'the writer commit' || fail commit
  # Its folder is gone, its registration left behind.
  rm -rf "$(lpath)"
  create "$LNAME"
  assert_made "$(lpath)"
  assert_file "$(lpath)/w.txt"
  assert_file "$(lpath)/deps/ok"
  # Removed outright, registration and all.
  g worktree remove --force "$(lpath)" || fail remove
  create "$LNAME"
  assert_made "$(lpath)"
  assert_eq 'the writer commit' "$(git -C "$(lpath)" log -1 --format=%s)" "the re-added branch"
}

case_replay_not_that_worktree() {
  repo
  fanout_policy
  create "$LNAME"
  assert_made "$(lpath)"
  g worktree remove --force "$(lpath)" || fail remove
  mkdir -p "$(lpath)"
  printf 'stray\n' >|"$(lpath)/x"
  create "$LNAME"
  assert_refused "exists but isn't the recorded worktree"
  assert_eq stray "$(cat "$(lpath)/x")" "the stray folder"
}

case_replay_mid_merge() {
  repo
  fanout_policy
  create "$LNAME"
  assert_made "$(lpath)"
  gd=$(git -C "$(lpath)" rev-parse --absolute-git-dir)
  printf '%s\n' "$REPO_BASE" >|"$gd/MERGE_HEAD"
  create "$LNAME"
  assert_refused 'is in progress'
}

# --- any other name: the engine's way ----------------------------------------

case_engine_default() {
  repo
  create feature
  assert_made "$(epath feature)"
  assert_eq worktree-feature "$(git -C "$(epath feature)" symbolic-ref --short HEAD)" branch
  assert_eq "$REPO_OLD" "$(git -C "$(epath feature)" rev-parse HEAD)" "origin/main as the base"
  assert_stderr_contains 'no worktree.json'
  # With a run active, the same.
  fanout_policy
  create other/name
  assert_made "$(epath other+name)"
  assert_eq worktree-other+name "$(git -C "$(epath other+name)" symbolic-ref --short HEAD)" branch
  assert_eq '' "$(spool_lines)" "nothing spooled"
}

case_engine_unlisted_wf_name() {
  repo
  fanout_policy
  create wf_fff999-000-2
  assert_made "$(epath wf_fff999-000-2)"
  assert_eq "$REPO_OLD" "$(git -C "$(epath wf_fff999-000-2)" rev-parse HEAD)" "the engine's base"
}

case_engine_base_head() {
  repo
  printf '{"v":1,"baseRef":"head","symlinkDirectories":[]}\n' >|"$(hooks_dir)/worktree.json"
  create feature
  assert_made "$(epath feature)"
  assert_eq "$REPO_BASE" "$(git -C "$(epath feature)" rev-parse HEAD)" "HEAD as the base"
}

case_engine_no_origin() {
  repo
  g update-ref -d refs/remotes/origin/HEAD
  g update-ref -d refs/remotes/origin/main
  create feature
  assert_made "$(epath feature)"
  assert_eq "$REPO_BASE" "$(git -C "$(epath feature)" rev-parse HEAD)" "HEAD without origin"
  # origin/master when origin has no HEAD and no main.
  g update-ref refs/remotes/origin/master "$REPO_OLD"
  create feature2
  assert_eq "$REPO_OLD" "$(git -C "$(epath feature2)" rev-parse HEAD)" "origin/master as the base"
}

case_engine_from_subfolder_and_worktree() {
  repo
  create feature "$T_DIR/project/src"
  assert_made "$(epath feature)"
  # From inside a linked worktree, the primary checkout is the root.
  create second "$(epath feature)"
  assert_made "$(epath second)"
}

case_engine_resumed() {
  repo
  create feature
  assert_made "$(epath feature)"
  printf 'mine\n' >|"$(epath feature)/m.txt"
  create feature
  assert_made "$(epath feature)"
  assert_eq mine "$(cat "$(epath feature)/m.txt")" "the resumed worktree's file"
}

case_engine_refusals() {
  repo
  create '../escape'
  assert_refused "isn't one the engine makes"
  create 'a/.git'
  assert_refused "isn't one the engine makes"
  mkdir -p "$T_DIR/outside"
  ln -s "$T_DIR/outside" "$T_DIR/project/.claude/worktrees"
  create feature
  assert_refused 'is a symlink'
  rm "$T_DIR/project/.claude/worktrees"
  mkdir -p "$T_DIR/plain"
  create feature "$T_DIR/plain"
  assert_refused "isn't in a git repository"
}

case_engine_settings_local() {
  repo
  printf '{"permissions":{}}\n' >|"$T_DIR/project/.claude/settings.local.json"
  # You own the repository, so your local settings resolve to it: no copy.
  create one
  assert_made "$(epath one)"
  assert_no_file "$(epath one)/.claude/settings.local.json"
  # With the root as your home, they don't, and the file is copied.
  HOME=$T_DIR/project create two
  assert_made "$(epath two)"
  assert_eq '{"permissions":{}}' "$(cat "$(epath two)/.claude/settings.local.json")" "the copy"
  # A symlinked source isn't copied.
  mv "$T_DIR/project/.claude/settings.local.json" "$T_DIR/s.json"
  ln -s "$T_DIR/s.json" "$T_DIR/project/.claude/settings.local.json"
  HOME=$T_DIR/project create three
  assert_made "$(epath three)"
  assert_no_file "$(epath three)/.claude/settings.local.json"
  assert_stderr_contains 'is a symlink, so it isn'
}

case_engine_settings_escape() {
  repo
  printf '{}\n' >|"$T_DIR/project/.claude/settings.local.json"
  mkdir -p "$T_DIR/outside"
  # origin/main has a .claude that is a link out of the repository; HEAD and the checkout don't.
  linked_at_origin .claude
  HOME=$T_DIR/project create four
  assert_made "$(epath four)"
  assert_no_file "$T_DIR/outside/settings.local.json"
  assert_stderr_contains 'escapes the worktree'
}

case_engine_hooks_path() {
  repo
  g config core.hooksPath .husky
  create feature
  assert_made "$(epath feature)"
  assert_eq "$(real_project)/.husky" "$(g config --get core.hooksPath)" "core.hooksPath"
  # An absolute one is left as it is.
  g config core.hooksPath /opt/hooks
  create second
  assert_eq /opt/hooks "$(g config --get core.hooksPath)" "core.hooksPath"
  # And a litter worktree gets the step too.
  g config core.hooksPath ./.husky/
  fanout_policy
  create "$LNAME"
  assert_made "$(lpath)"
  assert_eq "$(real_project)/.husky" "$(g config --get core.hooksPath)" "core.hooksPath after a litter worktree"
}

case_engine_symlink_dirs() {
  repo
  mkdir -p "$T_DIR/project/node_modules" "$T_DIR/project/cache/x" "$T_DIR/outside"
  ln -s "$T_DIR/outside" "$T_DIR/project/esc"
  g add esc && g commit -qm 'a committed link' || fail commit
  REPO_OLD=$(g rev-parse HEAD)
  g update-ref refs/remotes/origin/main "$REPO_OLD"
  printf '%s\n' '{"v":1,"baseRef":"fresh","symlinkDirectories":["node_modules","cache/x","/abs","../up","missing","esc/inner"]}' \
    >|"$(hooks_dir)/worktree.json"
  mkdir -p "$T_DIR/outside/inner"
  create feature
  assert_made "$(epath feature)"
  assert_eq "$(real_project)/node_modules" "$(readlink "$(epath feature)/node_modules")" "node_modules"
  [ ! -e "$(epath feature)/cache/x" ] || fail "cache/x linked into a folder the worktree lacks"
  assert_stderr_contains '/abs is absolute'
  assert_stderr_contains '../up has a .. part'
  assert_stderr_contains "missing isn't in"
  assert_stderr_contains 'escapes the worktree'
  assert_no_file "$T_DIR/outside/inner/inner"
}

case_engine_worktreeinclude() {
  repo
  printf '.env\nnotes.txt\n.venv/\n.secret\ncfg/\n' >>"$T_DIR/project/.gitignore"
  printf '# copied into new worktrees\n.env\n.venv/lib/\n.secret\ncfg/local.json\n' >|"$T_DIR/project/.worktreeinclude"
  g add .gitignore .worktreeinclude && g commit -qm include || fail commit
  REPO_OLD=$(g rev-parse HEAD)
  g update-ref refs/remotes/origin/main "$REPO_OLD"
  printf 'SECRET=1\n' >|"$T_DIR/project/.env"
  printf 'n\n' >|"$T_DIR/project/notes.txt"
  mkdir -p "$T_DIR/project/.venv/lib" "$T_DIR/project/.venv/bin"
  printf 's\n' >|"$T_DIR/project/.venv/lib/site.py"
  printf 'b\n' >|"$T_DIR/project/.venv/bin/python"
  printf 'x\n' >|"$T_DIR/s"
  ln -s "$T_DIR/s" "$T_DIR/project/.secret"
  create feature
  assert_made "$(epath feature)"
  assert_eq 'SECRET=1' "$(cat "$(epath feature)/.env")" ".env"
  assert_file "$(epath feature)/.venv/lib/site.py"
  assert_no_file "$(epath feature)/.venv/bin/python"
  assert_no_file "$(epath feature)/notes.txt"
  assert_no_file "$(epath feature)/.secret"
  assert_stderr_contains '.secret is a symlink'
}

case_engine_worktreeinclude_escape() {
  repo
  printf 'cfg/\n' >>"$T_DIR/project/.gitignore"
  printf 'cfg/local.json\n' >|"$T_DIR/project/.worktreeinclude"
  g add .gitignore .worktreeinclude && g commit -qm include || fail commit
  # origin/main has cfg as a link out of the repository; the checkout has a folder there.
  linked_at_origin cfg
  mkdir -p "$T_DIR/project/cfg"
  printf 'local\n' >|"$T_DIR/project/cfg/local.json"
  create feature
  assert_made "$(epath feature)"
  assert_no_file "$T_DIR/outside/local.json"
  assert_stderr_contains 'escapes the worktree'
}

# Without worktree.json, or without jq, the steps that don't need them still run.
case_engine_without_settings_or_jq() {
  repo
  g config core.hooksPath .husky
  printf '.env\n' >>"$T_DIR/project/.gitignore"
  printf '.env\n' >|"$T_DIR/project/.worktreeinclude"
  g add .gitignore .worktreeinclude && g commit -qm include || fail commit
  printf 'E=1\n' >|"$T_DIR/project/.env"
  printf '{"v":1,"baseRef":"head","symlinkDirectories":[]}\n' >|"$(hooks_dir)/worktree.json"
  wt_in feature >|"$T_DIR/in"
  nojq=$(path_without_jq)
  PATH=$nojq run_hook worktree.sh <"$T_DIR/in"
  assert_made "$(epath feature)"
  assert_stderr_contains 'jq not found'
  assert_eq "$REPO_OLD" "$(git -C "$(epath feature)" rev-parse HEAD)" "the fresh base without jq"
  assert_file "$(epath feature)/.env"
  assert_eq "$(real_project)/.husky" "$(g config --get core.hooksPath)" "core.hooksPath"
  # Without worktree.json, the same.
  rm "$(hooks_dir)/worktree.json"
  g config core.hooksPath .husky
  create second
  assert_made "$(epath second)"
  assert_stderr_contains 'no worktree.json'
  assert_file "$(epath second)/.env"
  assert_eq "$(real_project)/.husky" "$(g config --get core.hooksPath)" "core.hooksPath"
  # A litter run without jq still refuses only its own names.
  fanout_policy
  wt_in third >|"$T_DIR/in"
  PATH=$nojq run_hook worktree.sh <"$T_DIR/in"
  assert_made "$(epath third)"
}

case_no_lib() {
  repo
  mkdir -p "$T_DIR/copy"
  cp "$LITTER_ROOT/hooks/worktree.sh" "$T_DIR/copy/"
  create feature >/dev/null
  wt_in other | ${SHELL_UNDER_TEST:-sh} "$T_DIR/copy/worktree.sh" >|"$T_DIR/out" 2>|"$T_DIR/err"
  printf '%s\n' "$?" >|"$T_DIR/code"
  assert_refused "can't load lib.sh"
}

case_bad_input() {
  repo
  printf '{"session_id":"s1","name":' | run_hook worktree.sh
  assert_refused 'does not parse'
  printf '' | run_hook worktree.sh
  assert_refused 'is empty'
}

t "a litter name gets its worktree at base, the intent spooled before git ran" case_litter_at_base
t "a design run's worktree is disposable" case_litter_design_disposable
t "a litter name while the run is stopping is refused" case_refuse_stopping
t "a litter name without worktreeRoot or setupTimeoutSec is refused" case_refuse_no_worktree_root
t "a litter name for no usable run, or another run's marker, is refused" case_refuse_unknown_run
t "a litter name without jq is refused" case_refuse_no_jq
t "a litter name with an unreadable policy.json is refused, other names made" case_refuse_bad_policy
t "a wf_ name without the hooks folder is refused, other names made" case_refuse_no_hooks_folder
t "a run id that appears during the launch wait makes the name litter's" case_launching_appears
t "a run id that never appears is made the engine's way after 15 s" case_launching_never
t "a launch that ends with another run id is made the engine's way at once" case_launching_other_run
t "the setup runs its argv word for word, logged, and its ignored paths recorded" case_setup_ok
t "a failed setup refuses, with its log, and nothing else is made" case_setup_fails
t "a setup past setupTimeoutSec is killed and refused" case_setup_times_out
t "a setup command that isn't there refuses" case_setup_missing_command
t "linkDirs are linked from the checkout" case_links_made
t "a linkDirs entry not ignored as a link refuses" case_links_not_ignored_as_link
t "a .. linkDirs entry, or one missing from the checkout, refuses" case_links_refused
t "a link already pointing at the checkout is left alone, another replaced" case_links_left_alone
t "unfinished, with only the branch made: added without -b" case_unfinished_branch_only
t "unfinished, with the setup killed: kept, set up again, created" case_unfinished_setup_killed
t "unfinished, with the checkout cut off part way: added again" case_unfinished_checkout_cut
t "unfinished, after a failed setup: retried" case_unfinished_setup_retried
t "unfinished, with commits past base: refused" case_unfinished_commits_past_base
t "unfinished, with the branch checked out elsewhere: refused" case_unfinished_branch_elsewhere
t "a replay returns the worktree with its commit and uncommitted change" case_replay_keeps_work
t "a replay re-adds a gone worktree from its branch, and sets it up" case_replay_gone_readded
t "a replay whose path isn't that worktree is refused" case_replay_not_that_worktree
t "a replay mid-merge is refused" case_replay_mid_merge
t "another name gets the engine's path, branch and origin/main base, run or no run" case_engine_default
t "a wf_ name of another workflow gets the engine's worktree" case_engine_unlisted_wf_name
t "baseRef head bases another name on HEAD" case_engine_base_head
t "without origin/main the base is HEAD, or origin/master" case_engine_no_origin
t "from a subfolder or a linked worktree the root is the primary checkout" case_engine_from_subfolder_and_worktree
t "an existing worktree at the path is resumed" case_engine_resumed
t "bad names, a symlinked .claude/worktrees and no repository refuse" case_engine_refusals
t "settings.local.json: kept at your root, copied otherwise, never through a symlink" case_engine_settings_local
t "settings.local.json isn't copied through a committed link" case_engine_settings_escape
t "a relative core.hooksPath becomes absolute, for litter's worktrees too" case_engine_hooks_path
t "symlinkDirectories are linked, with each skip" case_engine_symlink_dirs
t "the .worktreeinclude copy, with a symlinked source skipped" case_engine_worktreeinclude
t "the .worktreeinclude copy isn't made through a committed link" case_engine_worktreeinclude_escape
t "without worktree.json or jq, the other post-create steps still run" case_engine_without_settings_or_jq
t "without lib.sh beside it, every creation is refused" case_no_lib
t "malformed or empty input is refused" case_bad_input
done_testing
