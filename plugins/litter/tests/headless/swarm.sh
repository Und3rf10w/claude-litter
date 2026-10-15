#!/bin/sh
# Tier 4: phase 2b-1's live swarm (plan section 13, phase 2b's "Done when"),
# in an interactive session that drive.exp types into, since a swarm starts
# from the builder's [Launch] and its ask:
#
#   sh tests/headless/swarm.sh trio   # three orchestrators, each in its own worktree with a checker under it
#
# The swarm is saved first through J's store (fixtures/swarm-save.ts). Then the
# session opens it with /litter swarms, presses [Launch] from the keyboard
# (ctrl+x tab focuses the pane, where [Launch] holds the focus), confirms the
# ask, and sends the start line Launch put in the prompt box. Each part adds
# and commits its own file and has a checker confirm it. Two parts also try
# what the guard must refuse: part-b a push, part-c a write into part-a's
# worktree. Once all three have stopped, the session ends the swarm.
#
# Needs expect and bun. SWARM_MODEL sets the session's model (--model), and
# SWARM_SUMMARY_MODEL the summaryModel option (default haiku).

set -u
. "$(dirname "$0")/lib.sh"

mode=${1:-trio}
case $mode in trio) ;; *) echo "usage: $0 trio" >&2; exit 2 ;; esac
command -v expect >/dev/null || { echo "$0: needs expect" >&2; exit 2; }
command -v bun >/dev/null || { echo "$0: needs bun" >&2; exit 2; }

# A fresh path each run: $.store keeps a ledger's head and a swarm's draft by
# their absolute paths, so a repo made again at the same path would read as
# tampered, and open the last run's draft.
h_scratch "swarm-$mode-$(date +%Y%m%d-%H%M%S)"
R=$H_REPO
LD=$R/.claude/litter
SW=$LD/swarms/trio
WT=$(cd -P "$R" && pwd -P)/.claude/worktrees
mkdir -p "$R/a" "$R/b" "$R/c"
for x in a b c; do printf 'Part %s.\n' "$x" >|"$R/$x/README"; done
h_git -C "$R" add -A
h_git -C "$R" commit -q -m 'three parts' || exit 1
HEAD0=$(git -C "$R" rev-parse HEAD)

# The spec: three orchestrators with a `new` worktree each, committing on their
# own branch and writing only in their own part's folder, and a read-only
# checker each may spawn once. Every authority field a parent sets, its worker
# sets no higher (15.3). Without `paths` a node may write anywhere the session
# may (the plan's table in 15.3), so part-c's write is refused by its paths.
AUTH_O='{"commit": true, "push": "none", "forcePush": false, "rewriteHistory": false, "worktreeOps": false}'
AUTH_W='{"commit": false, "push": "none", "forcePush": false, "rewriteHistory": false, "worktreeOps": false}'
orch() {
  jq -cn --arg id "part-$1" --arg br "trio/$1" --arg dir "$1/" --argjson a "$AUTH_O" '{
    id: $id, kind: "orchestrator", brief: "briefs/\($id).md", task: "Follow your brief, step by step.",
    worktree: {new: {from: "HEAD", branch: $br}}, paths: [$dir], spawns: {checker: 1}, authority: $a, report: ["done", "blocked"]}'
}
jq -n --argjson a "$(orch a)" --argjson b "$(orch b)" --argjson c "$(orch c)" --argjson w "$AUTH_W" '{
  name: "trio",
  goal: "Each part adds and commits its own hello file in its own worktree, and a checker confirms it.",
  nodes: [$a, $b, $c, {
    id: "checker", kind: "worker", brief: "briefs/checker.md", worktree: "inherit",
    tools: {deny: ["Edit", "Write", "NotebookEdit"]}, authority: $w, report: ["done"]}]}' >|"$H_DIR/spec.json"
mkdir -p "$H_DIR/briefs"
part_brief() {
  cat <<EOF
You own part $1 of this repository, in the directory your instance block names. Work only there.

1. Create $1/hello.txt holding the single line: hello from $1
2. Commit it on your branch with the message: part $1: hello
3. Spawn one checker worker with the Agent tool (its subagent_type is in your instance block), asking it to read $1/hello.txt in your directory and say whether it holds exactly that line.
4. Wait for the checker's report.
$2
Then reply with the commit's sha, the checker's answer$3, and nothing else.
EOF
}
part_brief a '' '' >|"$H_DIR/briefs/part-a.md"
part_brief b '5. Run with Bash exactly: git push origin HEAD. It is expected to be refused.' ', the push result verbatim' >|"$H_DIR/briefs/part-b.md"
part_brief c "5. Use the Write tool to create $WT/sw-trio-part-a/from-c.txt holding: from c. That is part a's directory, so it is expected to be refused." ', the Write result verbatim' >|"$H_DIR/briefs/part-c.md"
cat >|"$H_DIR/briefs/checker.md" <<'EOF'
You check one file for the node that started you, in its directory. Read the file your task names and reply with its exact content and whether it matches what the task expects. Change nothing.
EOF
(cd "$LITTER_ROOT/tests/unit" && bun ../headless/fixtures/swarm-save.ts "$R" "$H_DIR/spec.json" "$H_DIR/briefs") || exit 1

ledger() { cat "$SW"/launches/*/ledger/*-"$1".json 2>/dev/null; }
# The steps' waits, as sh commands drive.exp runs (scratch paths hold no spaces or quotes).
started="ls $SW/launches/*/ledger/*-swarm.start.json >/dev/null 2>&1"
bound3="[ \$(cat $SW/launches/*/ledger/*-swarm.node.json 2>/dev/null | jq -s '[.[] | select(.body.kind == \"orchestrator\")] | length') -ge 3 ]"
# All three orchestrators stopped: hold.sh's done/ for each bound one.
stopped3="ids=\$(cat $SW/launches/*/ledger/*-swarm.node.json 2>/dev/null | jq -r 'select(.body.kind == \"orchestrator\") | .body.agentId'); [ \$(printf '%s\n' \$ids | grep -c .) -ge 3 ] && for i in \$ids; do [ -f $LD/hooks/done/\$i ] || exit 1; done"
ended="ls $SW/launches/*/ledger/*-swarm.end.json >/dev/null 2>&1"

cat >|"$H_DIR/steps.txt" <<EOF
# The first prompt records the session's mode (watch.sh), which Launch's health check reads.
until [ -f $LD/hooks/mode ]
sleep 5
send /litter swarms trio
sleep 8
# /litter opens the pane with the keyboard, and [Launch] takes the focus. ctrl+x tab toggles the
# keyboard, so it's pressed only while the pane doesn't hold it. The strip draws the tabs' digits
# (5: Swarms) only while it does. Then Enter presses [Launch]. Launch runs its checks before its
# ask shows, which takes over 6 s on a loaded machine, so the second Enter, which takes the ask's
# first option (Launch), waits until that option is drawn.
keysh 30 3 sh $H_HERE/ui.sh shows $H_DIR '[0-9]: *Swarms' 2>/dev/null && exit 1; echo ctrl-x tab
sleep 2
key enter
wait 120 sh $H_HERE/ui.sh shows $H_DIR '❯ 1\. Launch' 2>/dev/null
sleep 1
key enter
wait 120 $started
sleep 5
# The start line is in the prompt box; Esc takes the keyboard from the pane back to it
# (ctrl+x tab only goes into the panes, 2.1.288).
key esc
sleep 2
key enter
wait 300 $bound3
wait 1500 $stopped3
sleep 20
send /litter:swarm end trio
wait 600 $ended
sleep 10
exit
EOF

# H_DRY=1 stops here: the repo, the saved swarm and the steps, with no session.
[ "${H_DRY:-}" = 1 ] && { echo "$H_CASE: dry run, files in $H_DIR"; exit 0; }

FIRST='Reply with the single word ready, and nothing else.'
SETTINGS=$(jq -cn --arg m "${SWARM_SUMMARY_MODEL:-haiku}" '{pluginConfigs: {litter: {options: {summaryModel: $m}}}}')
echo "$H_CASE: driving the session in $R"
(
  cd "$R" || exit 1
  # Auto mode: Launch's ask is an AskUserQuestion call, which asks even when a rule allows it; dontAsk
  # refuses every ask, and auto shows it (2.1.288). In default mode the lead's own checking Bash raised
  # permission dialogs that took the typed end command's Enter; auto's classifier answers those.
  # shellcheck disable=SC2086
  expect "$H_HERE/drive.exp" "$H_DIR/steps.txt" "$H_DIR/tty.txt" claude ${SWARM_MODEL:+--model "$SWARM_MODEL"} \
    --permission-mode auto --settings "$SETTINGS" \
    --allowedTools ToolSearch Agent Read Glob Grep Write Edit mcp__litter__record mcp__litter__swarm_read \
    mcp__litter__swarm_propose mcp__litter__swarm_send 'Bash(git:*)' 'Bash(cat:*)' 'Bash(ls:*)' \
    --plugin-dir "$H_DIR/litter" --plugin-dir "$H_DIR/toollog" --debug-file "$H_DIR/debug.txt" "$FIRST" >|"$H_DIR/drive.txt" 2>&1
)
printf '%s: drive exited %s\n' "$H_CASE" "$?"

events() { ledger swarm.event | jq -c '.body'; }
node_of() { ledger swarm.node | jq -r --arg n "$1" 'select(.body.node == $n) | .body.agentId' | head -n 1; }

c_started() { [ -n "$(ledger swarm.start)" ] || { echo "no swarm.start in $SW/launches"; return 1; }; }
c_orchestrators() {
  for x in a b c; do
    cwd=$(ledger swarm.node | jq -r --arg n "part-$x" 'select(.body.node == $n) | .body.cwd' | head -n 1)
    [ "$cwd" = "$WT/sw-trio-part-$x" ] || { echo "part-$x ran in '${cwd:-nowhere}', not $WT/sw-trio-part-$x"; return 1; }
  done
}
c_workers() {
  for x in a b c; do
    o=$(node_of "part-$x")
    n=$(ledger swarm.node | jq -s --arg o "$o" '[.[] | select(.body.node == "checker" and .body.parentAgentId == $o)] | length')
    [ "$n" -ge 1 ] || { echo "part-$x ($o) started no checker"; return 1; }
  done
}
c_commits() {
  for x in a b c; do
    got=$(git -C "$R" show "trio/$x:$x/hello.txt" 2>/dev/null)
    [ "$got" = "hello from $x" ] || { echo "trio/$x's $x/hello.txt is '${got:-missing}'"; return 1; }
    mb=$(git -C "$R" merge-base "trio/$x" "$HEAD0")
    [ "$mb" = "$HEAD0" ] || { echo "trio/$x doesn't fork from the launch's HEAD"; return 1; }
  done
  [ "$(git -C "$R" rev-parse HEAD)" = "$HEAD0" ] || { echo "the main checkout's HEAD moved"; return 1; }
}
c_push_denied() {
  b=$(node_of part-b)
  events | jq -e --arg b "$b" 'select(.kind == "denied" and .agentId == $b and .tool == "Bash")' >/dev/null ||
    { echo "no denied Bash event for part-b ($b)"; return 1; }
  git --git-dir="$H_DIR/origin.git" rev-parse -q --verify refs/heads/trio/b >/dev/null && { echo "trio/b reached origin"; return 1; }
  return 0
}
c_cross_write_denied() {
  c=$(node_of part-c)
  events | jq -e --arg c "$c" 'select(.kind == "denied" and .agentId == $c and .tool == "Write")' >/dev/null ||
    { echo "no denied Write event for part-c ($c)"; return 1; }
  [ ! -e "$WT/sw-trio-part-a/from-c.txt" ] || { echo "part-c wrote into part-a's worktree"; return 1; }
}
c_summary() {
  n=$(ledger swarm.summary | jq -s 'length')
  [ "$n" -ge 1 ] || { echo "no swarm.summary record (summaryModel ${SWARM_SUMMARY_MODEL:-haiku})"; return 1; }
}
c_ended() {
  e=$(ledger swarm.end | jq -c '.body | {status, settled}')
  [ "$e" = '{"status":"ended","settled":true}' ] || { echo "swarm.end is '${e:-missing}'"; return 1; }
  git -C "$R" rev-parse -q --verify refs/litter-swarm/trio >/dev/null && { echo "refs/litter-swarm/trio is still held"; return 1; }
  jq -e '.swarm == null' "$LD/hooks/policy.json" >/dev/null 2>&1 || { echo "policy.json still names a swarm"; return 1; }
}

h_expect "Launch recorded swarm.start" c_started
h_expect "each orchestrator ran in its own new worktree" c_orchestrators
h_expect "each orchestrator started a checker under it" c_workers
h_expect "each part committed its file on its own branch, from the launch's HEAD; the checkout didn't move" c_commits
h_expect "part-b's push was denied and nothing reached origin" c_push_denied
h_expect "part-c's write into part-a's worktree was denied" c_cross_write_denied
h_expect "the summary followed the swarm" c_summary
h_expect "the end settled, released the ref and cleared the policy" c_ended
h_done
