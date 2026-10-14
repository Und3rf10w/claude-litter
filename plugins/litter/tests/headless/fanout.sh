#!/bin/sh
# Tier 4: phase 2's fanout cases, headless (plan section 13), on the real
# workflows/fanout.js.
#
#   sh tests/headless/fanout.sh land   # 3 tasks, two writing: integrates, verifies and lands, every worktree at base
#   sh tests/headless/fanout.sh edit   # an edit to the checkout after the integration verify: the land refuses
#   sh tests/headless/fanout.sh red    # branches that merge cleanly but fail verify together: nothing lands, nothing is lost
#   sh tests/headless/fanout.sh stop   # TaskStop mid-run: the run ends stopped and the lock is released
#   sh tests/headless/fanout.sh chatty # land's run, with a verify that talks for 90 s: the record hook reads it all
#
# The repo is lib.sh's, whose HEAD is ahead of origin/main, plus two packages
# with a check each and a verify command (sh check.sh) that passes today.
# One session calls run.start and launches litter:fanout-run with its args, as
# the skill would after you confirm.
#
# chatty's check.sh prints 60,000 lines over about 90 s before the package
# checks. The mod reads the verify's output stream inside the record hook,
# which `$` calls are said to pause the hook's clock for (plan section 9,
# HookBudget). Every verify must be green with all its output logged, and no
# litter hook may be cut off.

set -u
. "$(dirname "$0")/lib.sh"

mode=${1:-land}
case $mode in land | edit | red | stop | chatty) ;; *) echo "usage: $0 land|edit|red|stop|chatty" >&2; exit 2 ;; esac

h_scratch "fanout-$mode"
cp "$LITTER_ROOT/workflows/fanout.js" "$H_DIR/litter/workflows/fanout.js" || exit 1
R=$H_REPO
mkdir -p "$R/a" "$R/b"
printf 'Package a.\n' >|"$R/a/README"
printf 'Package b.\n' >|"$R/b/README"
printf '#!/bin/sh\n# Checks package a.\nset -e\n[ -f a/README ]\n' >|"$R/a/test.sh"
printf '#!/bin/sh\n# Checks package b.\nset -e\n[ -f b/README ]\n' >|"$R/b/test.sh"
if [ "$mode" = red ]; then
  # Each package alone passes; together their versions must agree.
  printf '#!/bin/sh\n# The verify command: every package check, and a and b agree on the version.\nset -e\nsh a/test.sh\nsh b/test.sh\nif [ -f a/version.txt ] && [ -f b/expects.txt ]; then\n  [ "$(cat a/version.txt)" = "$(cat b/expects.txt)" ] || { echo "a ships version $(cat a/version.txt), b expects $(cat b/expects.txt)"; exit 1; }\nfi\n' >|"$R/check.sh"
elif [ "$mode" = chatty ]; then
  printf '#!/bin/sh\n# The verify command: 300 bursts of 200 lines, 0.3 s apart, then every package check.\nset -e\ni=0\nwhile [ "$i" -lt 300 ]; do\n  j=0\n  while [ "$j" -lt 200 ]; do echo "chatty line $i.$j: the verify keeps talking"; j=$((j + 1)); done\n  sleep 0.3\n  i=$((i + 1))\ndone\nsh a/test.sh\nsh b/test.sh\n' >|"$R/check.sh"
else
  printf '#!/bin/sh\n# The verify command: every package check.\nset -e\nsh a/test.sh\nsh b/test.sh\n' >|"$R/check.sh"
fi
h_git -C "$R" add -A
h_git -C "$R" commit -q -m 'two packages and their checks' || exit 1
HEAD0=$(git -C "$R" rev-parse HEAD)
ORIGIN=$(git -C "$R" rev-parse origin/main)

if [ "$mode" = red ]; then
  TA='Add a/version.txt holding the single line 2. Do not change anything else.'
  TB='Add b/expects.txt holding the single line 1. Do not change anything else.'
else
  TA='Add a/hello.txt holding the single line "hello from a", and extend a/test.sh so it fails unless a/hello.txt holds exactly that line.'
  TB='Add b/hello.txt holding the single line "hello from b", and extend b/test.sh so it fails unless b/hello.txt holds exactly that line.'
fi
TASKS=$(jq -cn --arg a "$TA" --arg b "$TB" '[
  {id: "a", title: "Package a", text: $a, files: ["a/"]},
  {id: "b", title: "Package b", text: $b, files: ["b/"]},
  {id: "r", title: "Survey", text: "List the packages in this repository and what each test.sh checks.", writes: false}]')
START=$(jq -cn --argjson t "$TASKS" '{kind: "run.start", workflow: "fanout", authorized: ["tier-4 fanout probe"], tasks: $t, contract: ""}')

if [ "$mode" = stop ]; then
  STEPS="3. Run with Bash: sleep 60
4. Call TaskStop with the task ID the Workflow tool returned in step 2.
5. Run with Bash: sleep 45
6. Reply with each step's result, verbatim."
elif [ "$mode" = chatty ]; then
  # The turn sleeps, since claude -p kills background work about 10 minutes after the turn ends.
  STEPS='3. Run with Bash, with the tool'"'"'s timeout set to 600000: sleep 420
4. Wait for the workflow task notification. Then reply with each step result and the workflow result, verbatim.'
else
  STEPS='3. Wait for the workflow task notification. Then reply with each step result and the workflow result, verbatim.'
fi
PROMPT="You are running a scripted test. Do exactly these steps, in order, and nothing else.
1. Call mcp__litter__record with exactly this input: $START
2. Call the Workflow tool with name \"litter:fanout-run\" and args set to the args object step 1 returned, unchanged.
$STEPS
If a step is refused, note the refusal verbatim and stop."

LD=$R/.claude/litter
# The out-of-band edit, once the mod has recorded the integration verify: at most 30 minutes.
if [ "$mode" = edit ]; then
  (
    i=0
    while [ "$i" -lt 900 ]; do
      if cat "$LD"/*/ledger/*-verify.json 2>/dev/null | jq -e 'select(.body.gate == "integration")' >/dev/null 2>&1; then
        printf 'edited out of band\n' >>"$R/README"
        : >|"$H_DIR/edited"
        exit 0
      fi
      sleep 2
      i=$((i + 1))
    done
  ) &
  watcher=$!
fi

h_claude "$PROMPT" \
  --settings '{"pluginConfigs": {"litter": {"options": {"verify": ["sh", "check.sh"]}}}}' \
  --allowedTools mcp__litter__record Workflow TaskStop Read Glob Grep Write Edit \
  'Bash(git:*)' 'Bash(sh:*)' 'Bash(cat:*)' 'Bash(ls:*)' 'Bash(sleep:*)'
[ "$mode" = edit ] && kill "$watcher" 2>/dev/null

RUN=$(ls "$LD" 2>/dev/null | grep -E '^[0-9]{8}-' | head -n 1)
RD=$LD/$RUN
ledger() { cat "$RD"/ledger/*-"$1".json 2>/dev/null; }
base() { jq -r .base "$RD/run.json"; }
tip() { git -C "$R" rev-parse -q --verify "refs/heads/litter/$RUN"; }
run_end() { ledger run.end | jq -r '.body.status' | tail -n 1; }

c_run() { [ -n "$RUN" ] && [ -f "$RD/run.json" ] || { echo "no run in $LD"; return 1; }; }
c_base() {
  b=$(base)
  [ "$(git -C "$R" rev-parse "$b^{tree}")" = "$(git -C "$R" rev-parse "$HEAD0^{tree}")" ] || { echo "base $b isn't HEAD's tree at launch"; return 1; }
  [ "$(git -C "$R" rev-parse "$b^{tree}")" != "$(git -C "$R" rev-parse "$ORIGIN^{tree}")" ] || { echo "base is origin/main's tree"; return 1; }
}
c_worktrees_at_base() {
  b=$(base)
  n=$(ledger worktree.create | jq -s 'length')
  [ "$n" -ge 2 ] || { echo "$n worktree.create records, expected one per writer"; return 1; }
  bad=$(ledger worktree.create | jq -r --arg b "$b" 'select(.body.base != $b) | "\(.body.name) at \(.body.base)"')
  [ -z "$bad" ] || { echo "not at base $b: $bad"; return 1; }
  # Each merge's second parent is the task branch's tip, which a landed run's cleanup deletes.
  m=$(ledger integrate.merge | jq -s 'length')
  [ "$m" -ge 2 ] || { echo "$m integrate.merge records, expected one per writer"; return 1; }
  for c in $(ledger integrate.merge | jq -r '.body.commit'); do
    mb=$(git -C "$R" merge-base "$c^2" "$b" 2>/dev/null)
    [ "$mb" = "$b" ] || { echo "the branch merged by $c forks from ${mb:-nothing}, not base"; return 1; }
  done
}
# The path worktree.sh printed is where the engine started the writer: its SubagentStart cwd, from bind/.
c_cwd_is_path() {
  want=$(ledger worktree.create | jq -r 'select(.body.name | endswith("-integration") | not) | .body.path' | sort)
  got=$(cat "$LD"/hooks/bind/* 2>/dev/null | jq -r 'select(.agent_type == "litter:executor") | .cwd' | sort -u)
  [ -n "$want" ] && [ "$got" = "$want" ] || { echo "the writers started in [$got], the recorded worktrees are [$want]"; return 1; }
}
c_integration_green() {
  g=$(ledger verify | jq -r 'select(.body.gate == "integration") | .body.exit_code' | tail -n 1)
  [ "$g" = 0 ] || { echo "the integration verify exit code is '${g:-none}'"; return 1; }
}
c_landed() {
  c=$(ledger land | jq -r '.body.commit' | tail -n 1)
  [ -n "$c" ] || { echo "no land record"; return 1; }
  [ "$(tip)" = "$c" ] || { echo "litter/$RUN is at $(tip), not the land's $c"; return 1; }
  i=$(ledger land.intent | jq -r '.body.commit' | tail -n 1)
  [ "$i" = "$c" ] || { echo "the intent's commit is '$i', the land's $c"; return 1; }
  [ "$(git -C "$R" show "$c:a/hello.txt")" = 'hello from a' ] || { echo "the landed a/hello.txt is wrong"; return 1; }
  [ "$(git -C "$R" show "$c:b/hello.txt")" = 'hello from b' ] || { echo "the landed b/hello.txt is wrong"; return 1; }
  [ "$(cat "$R/a/hello.txt" 2>/dev/null)" = 'hello from a' ] || { echo "the checkout has no a/hello.txt"; return 1; }
  [ -z "$(git -C "$R" status --porcelain --untracked-files=no)" ] || { echo "the checkout isn't clean after the land: $(git -C "$R" status --porcelain | head -n 3)"; return 1; }
}
c_status() {
  s=$(run_end)
  [ "$s" = "$1" ] || { echo "the run ended '${s:-not at all}', expected $1"; return 1; }
}
c_not_landed() {
  [ -z "$(ledger land)" ] || { echo "the ledger has a land"; return 1; }
  [ "$(tip)" = "$(base)" ] || { echo "litter/$RUN moved to $(tip) from base"; return 1; }
}
c_edit_kept() {
  [ -f "$H_DIR/edited" ] || { echo "the out-of-band edit never happened"; return 1; }
  tail -n 1 "$R/README" | grep -q 'edited out of band' || { echo "the edit is gone from README"; return 1; }
}
c_kept() {
  for br in $(ledger worktree.create | jq -r '.body.branch'); do
    git -C "$R" rev-parse -q --verify "refs/heads/$br" >/dev/null || { echo "task branch $br is gone"; return 1; }
  done
  wt=$(git -C "$R" worktree list --porcelain | sed -n 's/^worktree //p' | grep -- "-integration$" | head -n 1)
  [ -n "$wt" ] || { echo "the integration worktree is gone"; return 1; }
  [ -f "$wt/a/version.txt" ] && [ -f "$wt/b/expects.txt" ] || { echo "the integration worktree doesn't hold both tasks' files"; return 1; }
  v=$(ledger verify | jq -r 'select(.body.gate == "integration") | .body.exit_code' | tail -n 1)
  [ -n "$v" ] && [ "$v" != 0 ] || { echo "no red integration verify recorded (exit '${v:-none}')"; return 1; }
  ledger verify | jq -r 'select(.body.gate == "integration") | .body.output_tail' | grep -q 'a ships version 2, b expects 1' ||
    { echo "the red verify's output tail doesn't hold check.sh's message"; return 1; }
  grep -q '^## What blocked the land' "$RD/summary.md" 2>/dev/null || { echo "summary.md doesn't say what blocked the land"; return 1; }
}
c_lock_free() {
  git -C "$R" rev-parse -q --verify refs/litter-active >/dev/null && { echo "refs/litter-active is still held"; return 1; }
  jq -e '.run == null' "$LD/hooks/policy.json" >/dev/null 2>&1 || [ ! -f "$LD/hooks/policy.json" ] || { echo "policy.json still has the run"; return 1; }
}

# chatty: every verify green with all its 2.7 MB logged, and no litter hook cut off by its budget.
c_chatty_verifies() {
  n=$(ledger verify | jq -s 'length')
  [ "$n" -ge 1 ] || { echo "no verify record"; return 1; }
  bad=$(ledger verify | jq -r 'select(.body.green != true or (.body.log_bytes // 0) < 2000000) | "\(.body.verify_id): green \(.body.green), \(.body.log_bytes) bytes logged"')
  [ -z "$bad" ] || { echo "$bad"; return 1; }
}
c_hooks_kept() {
  cut=$(grep -E 'hooks module litter@inline' "$H_DIR/debug.txt" | grep -iE 'timeout|budget|linger|outran' | head -n 3)
  [ -z "$cut" ] || { echo "$cut"; return 1; }
  ms=$(grep -E 'hooks module litter@inline [a-z.]+ settled in' "$H_DIR/debug.txt" | sed -n 's/.*settled in \([0-9]*\).*/\1/p' | sort -n | tail -n 1)
  [ "${ms:-0}" -ge 90000 ] || { echo "litter's longest hook settled in ${ms:-no} ms, so none waited out the 90 s verify"; return 1; }
  echo "the longest litter hook settled in $ms ms"
}

h_expect "run.start and the launch made a run" c_run
h_expect "the run's base is HEAD's tree at launch, ahead of origin/main" c_base
case $mode in
land)
  h_expect "every writer's worktree was made at base, and its branch forks there" c_worktrees_at_base
  h_expect "each writer started in the worktree worktree.sh printed for it" c_cwd_is_path
  h_expect "the integration verify is green" c_integration_green
  h_expect "the land moved litter/<run> to the intent's commit, with both tasks' files, and the checkout with it" c_landed
  h_expect "the run ended done" c_status done
  h_expect "the lock is released" c_lock_free
  ;;
edit)
  h_expect "every writer's worktree was made at base" c_worktrees_at_base
  h_expect "the land refused and nothing moved" c_not_landed
  h_expect "the out-of-band edit is still in the checkout" c_edit_kept
  h_expect "the lock is released" c_lock_free
  ;;
red)
  h_expect "every writer's worktree was made at base" c_worktrees_at_base
  h_expect "nothing landed" c_not_landed
  h_expect "the branches, the integration worktree, the red verify and its evidence are kept" c_kept
  h_expect "the lock is released" c_lock_free
  ;;
chatty)
  h_expect "every verify is green, with all its output logged" c_chatty_verifies
  h_expect "no litter hook was cut off, and the record hook waited the verify out" c_hooks_kept
  h_expect "the land moved litter/<run> to the intent's commit, with both tasks' files, and the checkout with it" c_landed
  h_expect "the run ended done" c_status done
  h_expect "the lock is released" c_lock_free
  ;;
stop)
  h_expect "the run ended stopped" c_status stopped
  h_expect "the lock is released by the end of the session" c_lock_free
  ;;
esac
h_done
