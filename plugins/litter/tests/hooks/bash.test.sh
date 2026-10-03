# Tier 3: guard.sh's Bash rules (plan section 9, "Bash"; section 12): git
# for every role, publish and deploy, installs, the read-only roles' loss of
# redirections and write-ish commands, and Bash writes into litter's folders.

. "$(dirname "$0")/testlib.sh"

# setup <role> [policy filter]: an active run with agent a1 bound as <role>.
setup() {
  project >/dev/null
  policy "${2:-.}"
  bind a1 "litter:$1"
}

# denied <role> <text> <command>...: each command is denied, naming <text>.
denied() {
  dn_role=$1
  dn_text=$2
  shift 2
  for dn_cmd in "$@"; do
    bash_call "litter:$dn_role" "$dn_cmd" | run_hook guard.sh
    assert_deny "$dn_text" || return 1
  done
}

# passes <role> <command>...: each command passes.
passes() {
  ps_role=$1
  shift
  for ps_cmd in "$@"; do
    bash_call "litter:$ps_role" "$ps_cmd" | run_hook guard.sh
    [ "$(cat "$T_DIR/code")" = 0 ] && [ ! -s "$T_DIR/out" ] || fail "denied: $ps_cmd: $(cat "$T_DIR/out" "$T_DIR/err")"
  done
}

case_commits_and_history() {
  setup executor
  denied executor 'belong to the mod' \
    'git push origin HEAD' 'git commit -m wip' 'git commit --amend --no-edit' 'git rebase main' \
    'git merge feature' 'git cherry-pick abc' 'git revert HEAD' 'git update-ref refs/heads/x HEAD' \
    'git pull' 'git am < p' 'git symbolic-ref HEAD refs/heads/x' 'git commit-tree abc -p HEAD'
}

case_index_writes() {
  setup executor
  denied executor 'writes the real index' \
    'git add -A' 'git rm a.py' 'git mv a b' 'git reset --hard' 'git reset HEAD~1' 'git stash' \
    'git stash list' 'git update-index --assume-unchanged a' 'git read-tree HEAD'
  denied executor 'restore --staged' 'git restore --staged a.py' 'git restore -S a.py'
  denied executor 'apply --cached' 'git apply --cached p.diff' 'git apply --index p.diff'
}

case_checkout_moves() {
  setup executor
  denied executor 'moves the checkout' 'git checkout -- a.py' 'git checkout main' 'git switch -c x' 'git bisect start'
}

case_overrides_and_force() {
  setup executor
  denied executor 'overrides are denied' 'git -c core.hooksPath=/dev/null commit -m x' 'git -c color.ui=never log' \
    'git --config-env=core.pager=X log'
  denied executor 'force flags' 'git worktree remove --force x' 'git fetch --force' 'git fetch -f origin'
  denied executor 'git clean deletes files' 'git clean -fd' 'git clean -f'
  denied executor 'may only list here' 'git branch -D topic' 'git branch -f main HEAD' 'git branch -m a b' \
    'git worktree add ../x' 'git worktree remove x' 'git tag v1' 'git tag -d v1'
  denied executor 'creates a branch' 'git branch topic'
  denied executor 'touching hooks' 'git config core.hooksPath .husky' 'git config --unset core.hooksPath'
  denied executor 'may only read here' 'git config user.name me' 'git config --add a.b c'
  denied executor 'drop objects' 'git gc --prune=now' 'git prune'
}

# The same call wrapped, chained or nested still names git.
case_wrapped() {
  setup executor
  denied executor 'git push is denied' \
    "sh -c 'git push'" 'bash -lc "git status; git push"' 'sudo -u me git push' 'env GIT_DIR=.git git push' \
    'FOO=1 git push' '/usr/bin/git push' 'cd src && git push' 'echo $(git push)' 'echo `git push`' \
    'if true; then git push; fi' 'timeout 10 git push' 'nohup git push &' 'git -C /tmp/x push' \
    'git --git-dir=.git --work-tree . push'
  denied executor 'git add writes' 'xargs git add < files' 'find . -name "*.py" -exec git add {} \;'
}

case_git_reads_pass() {
  setup executor
  passes executor 'git status' 'git status --porcelain' 'git diff HEAD' 'git log --oneline -5' \
    'git show HEAD:src/a.py' 'git branch --show-current' 'git branch -a' 'git branch --contains HEAD' \
    'git tag' 'git tag -l' 'git worktree list' 'git config --get user.name' 'git config -l' \
    'git rev-parse HEAD' 'git clean -n' 'git blame a.py' 'git grep -n foo' 'git restore a.py' \
    'grep -rn "git push" docs' 'echo done' 'git remote -v' 'git submodule status'
}

case_publish_deploy() {
  setup executor
  denied executor 'publishes or deploys' 'npm publish' 'cargo publish --dry-run' 'twine upload dist/*' \
    'kubectl apply -f k8s/' 'terraform apply -auto-approve' 'helm upgrade x y' 'docker push img' \
    'gh pr create --fill' 'gh release create v1' 'vercel --prod' 'npm --registry x publish'
  passes executor 'npm test' 'cargo test' 'kubectl get pods' 'terraform plan'
}

case_installs() {
  setup gate-critic
  denied gate-critic 'installs packages' 'npm install left-pad' 'pip install x' 'uv add x' 'cargo install x'
  setup prober
  denied prober 'litter:prober may not install anything' 'npm install' 'pip3 install x'
  setup executor
  passes executor 'npm install' 'uv sync'
}

case_readonly_redirects() {
  setup gate-critic
  denied gate-critic 'litter:gate-critic is read-only' 'echo x > out.txt' 'cat a >> b' 'ls 1>x' 'echo x >| f' \
    'cmd &> log' 'exec 3>f'
  passes gate-critic 'cat a 2>&1 | head' 'ls >/dev/null 2>&1' 'cmd &>/dev/null' 'grep -n "->" src/a.js' \
    "awk '\$1 > 5' data" 'uv run pytest -q tests/test_a.py' 'git diff --stat' 'cmd 2>/dev/null'
}

case_readonly_writers() {
  setup verifier
  denied verifier 'writes files' 'rm -f x' 'sed -i s/a/b/ f' 'sed -ni p f' 'tee f' 'touch x' 'mkdir d' \
    'cp a b' 'mv a b' 'ln -s a b' 'perl -pi -e s/a/b/ f' 'curl -o x https://e' 'curl -sSLo x https://e' \
    'tar xzf a.tgz' 'find . -name x -delete' 'xargs rm < list' 'chmod +x a'
  denied verifier 'writes files or refs' 'git fetch' 'git restore a.py' 'git init x'
  passes verifier 'perl -Mstrict -e 1' 'tar -tf a.tar' 'sed -n 1,5p f' 'curl -s https://e' 'git apply --check p.diff' \
    'unzip -l a.zip' 'find . -name "*.py"'
}

case_litter_folders() {
  setup executor
  denied executor 'may not write under .claude/litter' \
    'echo x > .claude/litter/hooks/policy.json' 'cp a.json .claude/litter/20261002-test/ledger/' \
    'cd .claude/litter && rm -rf 20261002-test' 'printf x >> .litter/rules/a.md' \
    "rm $(real_project)/.claude/litter/hooks/active" 'tee .claude/rules/litter/x.md < a' \
    'mv .litter.local/rules/a.md /tmp'
  passes executor 'cat .claude/litter/20261002-test/verify/v1/0001.log | tail -5' \
    "tail -n 50 $(real_project)/.claude/litter/x/0001.log" 'echo x > src/a.py'
}

case_inflight() {
  setup executor '.run.inflight = "critique"'
  denied executor 'a critique is in flight, so Bash is read-only' 'echo x > a.py' 'rm a.py'
  passes executor 'git status'
}

case_no_command() {
  setup executor
  call litter:executor Bash '{"description":"x"}' | run_hook guard.sh
  assert_deny 'Bash needs a command'
}

# R6: past the hook's 30 s timeout the call would run unchecked; a run agent
# gets the same size limits and the same linear parse as a node.
case_too_long() {
  setup executor
  tl_words=$(awk 'BEGIN { for (i = 0; i < 4001; i++) printf "a " }')
  denied executor 'this command is too long for the guard to check; split it' "echo $tl_words" "env $tl_words; git push"
  tl_at=$(awk 'BEGIN { for (i = 0; i < 1300; i++) printf "npm git rm " }')
  tl_t0=$(date +%s)
  bash_call litter:executor "env $tl_at" | run_hook guard.sh
  tl_t1=$(date +%s)
  assert_deny 'too many words that may start a command'
  [ $((tl_t1 - tl_t0)) -le 10 ] || fail "a command at the limit took $((tl_t1 - tl_t0)) s"
  passes executor "echo $(awk 'BEGIN { for (i = 0; i < 3990; i++) printf "a " }')"
}

t "commits, pushes and history rewrites are denied" case_commits_and_history
t "git commands that write the real index are denied" case_index_writes
t "checkout, switch and bisect are denied" case_checkout_moves
t "-c, force flags, clean -f, branch, tag, worktree and config writes are denied" case_overrides_and_force
t "git wrapped, chained or nested is still denied" case_wrapped
t "git reads and plain commands pass" case_git_reads_pass
t "publish and deploy commands are denied" case_publish_deploy
t "installs are denied to read-only roles and the prober, not the executor" case_installs
t "a read-only role loses redirections, but not /dev/null or quoted text" case_readonly_redirects
t "a read-only role loses write-ish commands" case_readonly_writers
t "Bash writes into .claude/litter and the rule folders are denied, reads pass" case_litter_folders
t "while a critique is in flight, the executor's Bash is read-only" case_inflight
t "a Bash call without a command is denied" case_no_command
t "a command too long to check is denied, and one at the limit is checked in time" case_too_long
done_testing
