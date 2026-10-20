#!/bin/sh
# Tier 4: worktree.sh's live checks (plan section 9, "Run worktrees", the
# spike), headless.
#
#   sh tests/headless/worktrees.sh resume    # a fanout stopped mid-task and resumed: each writer gets its own worktree back
#   sh tests/headless/worktrees.sh default   # your own EnterWorktree with litter loaded: the same worktree the engine makes alone
#   sh tests/headless/worktrees.sh setup     # a setup that takes 200 s, inside the hook's 600 s: every worktree waits for it, and the run lands
#
# resume runs the real workflows/fanout.js with two writers that sleep before
# working, so both hold a worktree when the TaskStop lands. The resume's
# restarted writers ask for the same names, and worktree.sh hands back the
# recorded worktrees without making new ones.
#
# default makes one worktree with litter loaded and one in a session without
# it, from a repo that pins the engine's base to origin and has every
# post-create input: settings.local.json, symlinkDirectories, a
# .worktreeinclude and a relative core.hooksPath. The two must agree.
#
# setup runs the real workflows/fanout.js with one writer and the setup option
# set to a command that sleeps 200 s, then prints setup-done. worktree.sh runs
# it in each fresh worktree inside WorktreeCreate's 600 s limit, under the
# run's setupTimeoutSec (570 s by default). Each worktree's setup log must end
# in setup-done, no hook may time out, and the run must land.

set -u
. "$(dirname "$0")/lib.sh"

mode=${1:-resume}
case $mode in resume | default | setup) ;; *) echo "usage: $0 resume|default|setup" >&2; exit 2 ;; esac

h_scratch "worktrees-$mode"
R=$H_REPO
LD=$R/.claude/litter

if [ "$mode" = default ]; then
  printf '{ "worktree": { "baseRef": "fresh", "symlinkDirectories": ["node_modules"] } }\n' >|"$R/.claude/settings.json"
  printf 'node_modules/\n.env\n.claude/settings.local.json\n' >>"$R/.gitignore"
  printf '.env\n' >|"$R/.worktreeinclude"
  h_git -C "$R" add .claude/settings.json .gitignore .worktreeinclude
  h_git -C "$R" commit -q -m 'worktree settings' || exit 1
  mkdir -p "$R/node_modules/pkg" "$R/.githooks"
  printf 'module.exports = 1\n' >|"$R/node_modules/pkg/index.js"
  printf 'FIXTURE=1\n' >|"$R/.env"
  printf '{ "permissions": { "allow": ["Bash(true)"] } }\n' >|"$R/.claude/settings.local.json"
  git -C "$R" config core.hooksPath .githooks
  ORIGIN=$(git -C "$R" rev-parse origin/main)
  ask() { printf 'Call EnterWorktree with name "%s". Then reply with the path it reports, and nothing else.' "$1"; }

  h_claude "$(ask probe-litter)" --allowedTools EnterWorktree
  # The same request in a session without litter: the engine's own worktree.
  (
    cd "$R" || exit 1
    claude -p --plugin-dir "$H_DIR/toollog" --allowedTools EnterWorktree --debug-file "$H_DIR/debug-engine.txt" \
      --output-format json --max-turns 10 "$(ask probe-engine)" </dev/null >|"$H_DIR/out-engine.json" 2>|"$H_DIR/stderr-engine.txt"
  )
  printf '%s: claude without litter exited %s\n' "$H_CASE" "$?"

  WL=$R/.claude/worktrees/probe-litter
  WE=$R/.claude/worktrees/probe-engine
  # What a worktree got: base, branch (its name generalized), each post-create step's result, its status.
  facts() {
    printf 'head %s\n' "$(git -C "$1" rev-parse HEAD 2>/dev/null)"
    printf 'branch %s\n' "$(git -C "$1" symbolic-ref -q --short HEAD 2>/dev/null | sed "s/$2/<name>/")"
    printf 'settings.local.json %s\n' "$(cat "$1/.claude/settings.local.json" 2>/dev/null || echo absent)"
    printf 'node_modules %s\n' "$( [ -L "$1/node_modules" ] && readlink "$1/node_modules" || echo 'not a link')"
    printf '.env %s\n' "$(cat "$1/.env" 2>/dev/null || echo absent)"
    printf 'core.hooksPath %s\n' "$(git -C "$1" config --get core.hooksPath 2>/dev/null || echo unset)"
    printf 'status %s\n' "$(git -C "$1" status --porcelain 2>/dev/null | tr '\n' ' ')"
  }
  c_made() {
    for w in "$WL" "$WE"; do
      git -C "$R" worktree list --porcelain | grep -qx "worktree $w" || { echo "no worktree at $w"; return 1; }
    done
  }
  c_fresh() {
    for w in "$WL" "$WE"; do
      [ "$(git -C "$w" rev-parse HEAD 2>/dev/null)" = "$ORIGIN" ] || { echo "$w isn't at origin/main ($ORIGIN)"; return 1; }
    done
  }
  c_same() {
    facts "$WL" probe-litter >|"$H_DIR/facts-litter.txt"
    facts "$WE" probe-engine >|"$H_DIR/facts-engine.txt"
    d=$(/usr/bin/diff "$H_DIR/facts-engine.txt" "$H_DIR/facts-litter.txt") || { echo "the engine's (<) and litter's (>) differ: $d"; return 1; }
  }
  c_steps_ran() {
    grep -q '^node_modules /' "$H_DIR/facts-litter.txt" || { echo "symlinkDirectories didn't link node_modules"; return 1; }
    grep -q '^\.env FIXTURE=1' "$H_DIR/facts-litter.txt" || { echo ".worktreeinclude didn't copy .env"; return 1; }
  }
  c_no_run() { [ ! -e "$LD/hooks/active" ] && [ -z "$(ls "$LD" 2>/dev/null | grep -E '^[0-9]{8}-')" ] || { echo "a litter run was made"; return 1; }; }

  h_expect "both sessions made their worktree" c_made
  h_expect "both are at origin/main, the base the repo pins (worktree.baseRef fresh)" c_fresh
  h_expect "litter's matches the engine's: branch, settings.local.json, links, includes, hooksPath, status" c_same
  h_expect "the post-create steps ran (node_modules linked, .env copied)" c_steps_ran
  h_expect "nothing of litter's run machinery was touched" c_no_run
  h_done
  exit
fi

if [ "$mode" = setup ]; then
  cp "$LITTER_ROOT/workflows/fanout.js" "$H_DIR/litter/workflows/fanout.js" || exit 1
  mkdir -p "$R/a"
  printf 'Package a.\n' >|"$R/a/README"
  printf '#!/bin/sh\nset -e\n[ -f a/README ]\n' >|"$R/check.sh"
  h_git -C "$R" add -A
  h_git -C "$R" commit -q -m 'a package and a check' || exit 1
  TASKS=$(jq -cn '[{id: "a", title: "Package a", text: "Add a/hello.txt holding the single line \"hello from a\". Change nothing else.", files: ["a/"]}]')
  START=$(jq -cn --argjson t "$TASKS" '{kind: "run.start", workflow: "fanout", authorized: ["tier-4 setup probe"], tasks: $t, contract: ""}')
  PROMPT="You are running a scripted test. Do exactly these steps, in order, and nothing else.
1. Call mcp__litter__record with exactly this input: $START
2. Call the Workflow tool with name \"litter:fanout-run\" and args set to the args object step 1 returned, unchanged.
$(h_wait_steps)
If a step is refused, note the refusal verbatim and stop."
  # The turn waits for the run's end (lib.sh's h_wait_steps): two 200 s setups and the run can take
  # longer than the 10 minutes claude -p gives background work once the turn ends.
  h_claude "$PROMPT" \
    --settings '{"pluginConfigs": {"litter": {"options": {"verify": ["sh", "check.sh"], "setup": ["sh", "-c", "sleep 200; echo setup-done"]}}}}' \
    --allowedTools mcp__litter__record Workflow Read Glob Grep Write Edit 'Bash(git:*)' 'Bash(sh:*)' 'Bash(cat:*)' 'Bash(ls:*)'

  RUN=$(ls "$LD" 2>/dev/null | grep -E '^[0-9]{8}-' | head -n 1)
  RD=$LD/$RUN
  records() { for f in "$RD"/ledger/*.json; do jq -c . "$f"; done 2>/dev/null; }
  c_done() {
    s=$(records | jq -r 'select(.kind == "run.end") | .body.status' | tail -n 1)
    [ "$s" = done ] || { echo "the run ended '${s:-not at all}'"; return 1; }
  }
  c_setup_logs() {
    names=$(records | jq -r 'select(.kind == "worktree.create") | .body.name' | sort -u)
    [ -n "$names" ] || { echo "no worktree.create record"; return 1; }
    for n in $names; do
      l=$(ls "$RD/verify/setup-$n"/*.log 2>/dev/null | tail -n 1)
      [ -n "$l" ] && [ "$(tail -n 1 "$l")" = setup-done ] || { echo "worktree $n: its setup log '${l:-none}' doesn't end in setup-done"; return 1; }
    done
    [ -z "$(records | jq -r 'select(.kind == "worktree.setup_failed") | .body.name')" ] || { echo "a setup failed: $(records | jq -c 'select(.kind == "worktree.setup_failed")')"; return 1; }
  }
  # Each worktree.create came at least 200 s after its intent, and the writer's WorktreeCreate
  # (worktree.sh; the mod makes the integration worktree itself) exited 0.
  c_hook_waited() {
    grep 'WorktreeCreate' "$H_DIR/debug.txt" | grep -q 'timed out' && { echo "a WorktreeCreate hook timed out"; return 1; }
    grep -qE 'WorktreeCreate \[.*worktree\.sh\] completed with status 0' "$H_DIR/debug.txt" || { echo "no WorktreeCreate exited 0"; return 1; }
    short=$(records | jq -rs '[.[] | select(.kind == "worktree.intent" or .kind == "worktree.create")] | group_by(.body.name)[]
      | (map(select(.kind == "worktree.intent")) | .[0].at) as $i | (map(select(.kind == "worktree.create")) | .[0].at) as $c
      | select($i == null or $c == null or $c - $i < 200000) | .[0].body.name')
    [ -z "$short" ] || { echo "worktrees made in under 200 s, or never: $short"; return 1; }
  }
  c_landed() {
    c=$(records | jq -r 'select(.kind == "land") | .body.commit' | tail -n 1)
    [ -n "$c" ] && [ "$(git -C "$R" show "$c:a/hello.txt" 2>/dev/null)" = 'hello from a' ] || { echo "no land with a/hello.txt"; return 1; }
  }
  h_expect 'the run ended done' c_done
  h_expect "each worktree's setup ran to its end, and none failed" c_setup_logs
  h_expect 'WorktreeCreate waited out the 200 s setup, and never timed out' c_hook_waited
  h_expect 'the run landed a/hello.txt' c_landed
  h_done
  exit
fi

# resume, on the real workflow rather than lib.sh's fixture
cp "$LITTER_ROOT/workflows/fanout.js" "$H_DIR/litter/workflows/fanout.js" || exit 1
mkdir -p "$R/a" "$R/b"
printf 'Package a.\n' >|"$R/a/README"
printf 'Package b.\n' >|"$R/b/README"
printf '#!/bin/sh\nset -e\n[ -f a/README ]\n[ -f b/README ]\n' >|"$R/check.sh"
h_git -C "$R" add -A
h_git -C "$R" commit -q -m 'two packages and a check' || exit 1

slow() { printf 'Before anything else, run `sleep 90` with Bash. Then add %s/hello.txt holding the single line "hello from %s". Change nothing else.' "$1" "$1"; }
TASKS=$(jq -cn --arg a "$(slow a)" --arg b "$(slow b)" '[
  {id: "a", title: "Package a", text: $a, files: ["a/"]},
  {id: "b", title: "Package b", text: $b, files: ["b/"]}]')
START=$(jq -cn --argjson t "$TASKS" '{kind: "run.start", workflow: "fanout", authorized: ["tier-4 worktree probe"], tasks: $t, contract: ""}')
PROMPT="You are running a scripted test. Do exactly these steps, in order, and nothing else.
1. Call mcp__litter__record with exactly this input: $START
2. Call the Workflow tool with name \"litter:fanout-run\" and args set to the args object step 1 returned, unchanged.
3. Run with Bash: sleep 60
4. Call TaskStop with the task ID the Workflow tool returned in step 2.
5. Run with Bash: sleep 20
6. Call the Workflow tool again with name \"litter:fanout-run\", resumeFromRunId set to the Run ID step 2 returned (it starts with wf_), and args set to the same args object as in step 2.
7. Wait for the workflow task notification. Then reply with each step's result and the workflow result, verbatim.
If a step is refused, note the refusal verbatim and stop."

h_claude "$PROMPT" \
  --settings '{"pluginConfigs": {"litter": {"options": {"verify": ["sh", "check.sh"]}}}}' \
  --allowedTools mcp__litter__record Workflow TaskStop Read Glob Grep Write Edit \
  'Bash(git:*)' 'Bash(sh:*)' 'Bash(cat:*)' 'Bash(ls:*)' 'Bash(sleep:*)'

RUN=$(ls "$LD" 2>/dev/null | grep -E '^[0-9]{8}-' | head -n 1)
RD=$LD/$RUN
# Ledger records in order, each on one line.
records() { for f in "$RD"/ledger/*.json; do jq -c . "$f"; done 2>/dev/null; }
seq_of() { records | jq -r --arg k "$1" 'select(.kind == $k) | .seq' | head -n 1; }

c_run() { [ -n "$RUN" ] && [ -f "$RD/run.json" ] || { echo "no run in $LD"; return 1; }; }
c_stopped_resumed() {
  k=$(records | jq -r '.kind + (if .kind == "run.end" then ":" + .body.status else "" end)' | grep -E '^run\.(stopping|end|resume)' | tr '\n' ' ')
  case $k in 'run.stopping run.end:stopped run.resume run.end:done ') ;; *) echo "the run's ends: $k"; return 1 ;; esac
}
c_held_at_stop() {
  s=$(seq_of run.stopping)
  n=$(records | jq -r --argjson s "${s:-0}" 'select(.kind == "task.bind" and .seq < $s) | .body.task' | sort -u | wc -l | tr -d ' ')
  [ "$n" = 2 ] || { echo "$n writer(s) were bound when the stop came, not both: the stop missed the window"; return 1; }
}
c_same_worktrees() {
  names=$(records | jq -r 'select(.kind == "worktree.create" and (.body.name | endswith("-integration") | not)) | .body.name' | sort)
  [ "$(printf '%s\n' "$names" | wc -l | tr -d ' ')" = 2 ] && [ -z "$(printf '%s\n' "$names" | uniq -d)" ] ||
    { echo "writer worktrees made: [$(echo $names)], expected two, each made once"; return 1; }
  r=$(seq_of run.resume)
  for t in a b; do
    before=$(records | jq -r --argjson r "$r" --arg t "$t" 'select(.kind == "task.bind" and .seq < $r and .body.task == $t) | .body.worktree.path' | tail -n 1)
    after=$(records | jq -r --argjson r "$r" --arg t "$t" 'select(.kind == "task.bind" and .seq > $r and .body.task == $t) | .body.worktree.path' | tail -n 1)
    [ -n "$after" ] && [ "$after" = "$before" ] || { echo "task $t bound in '$before' before the stop and '$after' after the resume"; return 1; }
  done
}
c_landed() {
  c=$(records | jq -r 'select(.kind == "land") | .body.commit' | tail -n 1)
  [ -n "$c" ] || { echo "no land record"; return 1; }
  for t in a b; do
    [ "$(git -C "$R" show "$c:$t/hello.txt" 2>/dev/null)" = "hello from $t" ] || { echo "the landed $t/hello.txt is wrong"; return 1; }
  done
}
c_lock_free() {
  git -C "$R" rev-parse -q --verify refs/litter-active >/dev/null && { echo "refs/litter-active is still held"; return 1; }
  return 0
}

h_expect "run.start and the launch made a run" c_run
h_expect "it stopped, settled, was resumed, and ended done" c_stopped_resumed
h_expect "both writers held a bound worktree when the stop came" c_held_at_stop
h_expect "the resumed writers got their own worktrees back, and none was made twice" c_same_worktrees
h_expect "the resumed run landed both tasks" c_landed
h_expect "the lock is released" c_lock_free
h_done
