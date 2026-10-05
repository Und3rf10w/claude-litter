#!/bin/sh
# Tier 4: phase 2b-2's repair (plan 15.11, phase 2b's "Done when"), in an
# interactive session drive.exp types into, since the repair starts on the
# lead's next turn:
#
#   sh tests/headless/repair.sh auto   # a fanout whose tasks merge but fail verify together continues as a swarm that repairs and lands it
#   sh tests/headless/repair.sh off    # the same fanout under repair: off stops with everything kept and starts nothing
#
# The repo has server/ and client/, each with a check that passes alone, and a
# verify (sh check.sh) that also needs every route the client calls to be one
# the server serves. Task server moves its items route from /v1/items to
# /v2/items; task client, in its own worktree at base, lists the server's
# items route it calls, which it reads as /v1/items. So the branches merge
# cleanly and the integration verify is red, and the fix (the client calls
# /v2/items) keeps both tasks' text: a seam to repair, not a contradiction
# between the tasks, which would be an intent question for you. The first
# prompt is the run.start and the launch the fanout skill would make after you
# confirm. Under auto, generation 1 ends halted, the bridge opens generation 2
# and launches the repair swarm with no ask, litter starts it after the
# notification turn, and a fixer, a critic and the orchestrator verify,
# judge and land the repaired tree. Once it has landed the session ends the
# swarm (if the lead hasn't already). If the lead's start is refused, litter
# fills /litter:swarm start in the prompt box and the steps press Enter once,
# as you would (WP-AS, startfill.sh); the checks say which way it started,
# and a swarm with no orchestrator 10 minutes on ends the waits.
#
# Needs expect. REPAIR_MODEL sets the session's model (--model).

set -u
. "$(dirname "$0")/lib.sh"

mode=${1:-auto}
case $mode in auto | off) ;; *) echo "usage: $0 auto|off" >&2; exit 2 ;; esac
command -v expect >/dev/null || { echo "$0: needs expect" >&2; exit 2; }

# A fresh path each run: $.store keeps ledger heads and drafts by their absolute paths.
h_scratch "repair-$mode-$(date +%Y%m%d-%H%M%S)"
cp "$LITTER_ROOT/workflows/fanout.js" "$H_DIR/litter/workflows/fanout.js" || exit 1
R=$H_REPO
LD=$R/.claude/litter
mkdir -p "$R/server" "$R/client"
printf 'The server. server/routes.txt lists the routes it serves, one per line.\n' >|"$R/server/README"
printf 'The client.\n' >|"$R/client/README"
printf '/v1/items\n' >|"$R/server/routes.txt"
printf '#!/bin/sh\n# Checks the server.\nset -e\n[ -s server/routes.txt ]\n' >|"$R/server/test.sh"
printf '#!/bin/sh\n# Checks the client.\nset -e\n[ -f client/README ]\n' >|"$R/client/test.sh"
printf '#!/bin/sh\n# The verify command: each part'"'"'s check, and every route the client calls is one the server serves.\nset -e\nsh server/test.sh\nsh client/test.sh\nif [ -f client/calls.txt ]; then\n  while read -r route; do\n    [ -z "$route" ] || grep -qxF "$route" server/routes.txt || { echo "the client calls $route, which the server does not serve"; exit 1; }\n  done <client/calls.txt\nfi\n' >|"$R/check.sh"
h_git -C "$R" add -A
h_git -C "$R" commit -q -m 'a server, a client and their checks' || exit 1
HEAD0=$(git -C "$R" rev-parse HEAD)

TS='Move the server'"'"'s items route from /v1/items to /v2/items: in server/routes.txt, replace the line /v1/items with /v2/items, so the server serves only /v2/items. Do not change anything else.'
TC='Add client/calls.txt listing, one per line, the server routes the client calls. The client calls only the server'"'"'s items route. Do not change anything else.'
TASKS=$(jq -cn --arg s "$TS" --arg c "$TC" '[
  {id: "server", title: "Server items route to v2", text: $s, files: ["server/"]},
  {id: "client", title: "Client route list", text: $c, files: ["client/"]}]')
START=$(jq -cn --argjson t "$TASKS" --arg m "$mode" '{kind: "run.start", workflow: "fanout", authorized: ["tier-4 repair probe"], tasks: $t, contract: "", repair: $m}')
FIRST="You are running a scripted test. Do exactly these steps, in order.
1. Call mcp__litter__record with exactly this input: $START
2. Call the Workflow tool with name \"litter:fanout-run\" and args set to the args object step 1 returned, unchanged.
3. Wait for the workflow task notification, then reply with each step result and the workflow result, verbatim.
After that, if litter starts a repair swarm, follow the litter swarm skill for it, and don't push anything."

runs() { ls "$LD" 2>/dev/null | grep -E '^[0-9]{8}-' | head -n 1; }
# The steps' waits, as sh commands drive.exp runs (scratch paths hold no spaces or quotes).
ended1="ls $LD/2*/ledger/*-run.end.json >/dev/null 2>&1"
landed="ls $LD/2*/ledger/*-land.json >/dev/null 2>&1"
swarm_ended="ls $LD/swarms/repair-*/launches/*/ledger/*-swarm.end.json >/dev/null 2>&1"
ends2="[ \$(ls $LD/2*/ledger/*-run.end.json 2>/dev/null | wc -l) -ge 2 ]"
end_cmd="[ -d $LD/swarms ] && ! $swarm_ended && for d in $LD/swarms/repair-*; do echo \"/litter:swarm end \${d##*/}\"; done"
# Nothing more can come: the bridge declined, or generation 2 ended.
over="ls $LD/2*/ledger/*-repair.declined.json >/dev/null 2>&1 || $ends2"
# No orchestrator within 10 minutes of litter's fill of the start line, or of run.repair when there's none (WP-AS).
stalled="sh $H_HERE/startfill.sh stalled $LD"

if [ "$mode" = auto ]; then
  cat >|"$H_DIR/steps.txt" <<EOF
# The first prompt starts the fanout. Generation 1 ends halted at the red integration verify.
wait 1800 $ended1
# The bridge opens generation 2, and litter submits the swarm's start after the notification turn. If the
# lead's turn doesn't start it (its start refused), litter fills /litter:swarm start in the prompt box
# (WP-AS): Enter, once, as the user, until an orchestrator is spawned, it lands, the run is over or it stalled.
keysh 1800 5 ! { $landed || $over || $stalled; } && sh $H_HERE/startfill.sh enter $LD $H_DIR/enter-mark
# The repair swarm runs on the lead's next turns until it lands.
wait 2700 $landed || $over || $stalled
# The lead ends a landed repair on the orchestrator's report; if it hasn't, the session says to.
wait 600 $swarm_ended || $stalled
sendsh $end_cmd
wait 900 $ends2
sleep 20
exit
EOF
else
  cat >|"$H_DIR/steps.txt" <<EOF
wait 1800 $ended1
# Long enough for a bridge that wrongly started anything to have made its swarm.
sleep 90
exit
EOF
fi

[ "${H_DRY:-}" = 1 ] && { echo "$H_CASE: dry run, files in $H_DIR"; exit 0; }

SETTINGS=$(jq -cn '{pluginConfigs: {litter: {options: {verify: ["sh", "check.sh"], summaryModel: "haiku"}}}}')
echo "$H_CASE: driving the session in $R"
(
  cd "$R" || exit 1
  # Auto mode, as swarm.sh: the classifier answers the lead's and the nodes' asks, and the repair's start needs no ask.
  # A fanout and then a repair run longer than drive.exp's default 40 minutes.
  # shellcheck disable=SC2086
  H_DRIVE_MAX=${H_DRIVE_MAX:-7200} LITTER_TIER4_GUARD=$H_DIR/litter/hooks/guard.sh expect "$H_HERE/drive.exp" "$H_DIR/steps.txt" "$H_DIR/tty.txt" \
    claude ${REPAIR_MODEL:+--model "$REPAIR_MODEL"} --permission-mode auto --settings "$SETTINGS" \
    --allowedTools ToolSearch Agent Workflow Read Glob Grep Write Edit mcp__litter__record mcp__litter__swarm_read \
    mcp__litter__swarm_propose mcp__litter__swarm_send 'Bash(git:*)' 'Bash(sh:*)' 'Bash(cat:*)' 'Bash(ls:*)' \
    --plugin-dir "$H_DIR/litter" --plugin-dir "$H_DIR/toollog" --debug-file "$H_DIR/debug.txt" "$FIRST" >|"$H_DIR/drive.txt" 2>&1
)
printf '%s: drive exited %s\n' "$H_CASE" "$?"

RUN=$(runs)
RD=$LD/$RUN
ledger() { cat "$RD"/ledger/*-"$1".json 2>/dev/null; }
swarm_dir() { ls -d "$LD"/swarms/repair-* 2>/dev/null | head -n 1; }
sledger() { cat "$(swarm_dir)"/launches/*/ledger/*-"$1".json 2>/dev/null; }
tip() { git -C "$R" rev-parse -q --verify "refs/heads/litter/$RUN"; }
integration_branch() { ledger worktree.create | jq -r 'select(.body.name | endswith("-integration")) | .body.branch' | head -n 1; }

c_run() { [ -n "$RUN" ] && [ -f "$RD/run.json" ] || { echo "no run in $LD"; return 1; }; }
c_setting() {
  m=$(jq -r '.repair.mode // empty' "$RD/run.json")
  [ "$m" = "$mode" ] || { echo "run.json's repair mode is '${m:-unset}', not $mode"; return 1; }
}
c_red_halt() {
  s=$(ledger run.end | jq -r '.body.status' | head -n 1)
  [ "$s" = halted ] || { echo "generation 1 ended '${s:-not at all}', not halted"; return 1; }
  v=$(ledger verify | jq -r 'select(.body.gate == "integration") | .body.exit_code' | head -n 1)
  [ -n "$v" ] && [ "$v" != 0 ] || { echo "no red integration verify (exit '${v:-none}')"; return 1; }
}
c_repair_opened() {
  g=$(ledger run.repair | jq -r '.body.generation' | head -n 1)
  [ "$g" = 2 ] || { echo "no run.repair opening generation 2 (got '${g:-none}')"; return 1; }
  c=$(sledger swarm.start | jq -r '.body.confirmedBy.run // empty')
  [ -n "$c" ] || { echo "the repair swarm's swarm.start isn't confirmed by the run"; return 1; }
  sledger swarm.node | jq -e 'select(.body.kind == "orchestrator")' >/dev/null || { echo "the repair orchestrator never spawned"; return 1; }
}
# The mod's $.ui.ask is an AskUserQuestion call too, so the tool log holds both kinds of ask.
c_no_ask() {
  n=$(jq -s '[.[] | select(.ev == "PreToolUse" and .tool == "AskUserQuestion")] | length' "$H_DIR/tool-log.jsonl" 2>/dev/null)
  [ "${n:-0}" = 0 ] || { echo "$n AskUserQuestion call(s) after the launch"; return 1; }
}
c_fixed_on_branch() {
  br=$(integration_branch)
  [ -n "$br" ] || { echo "no integration branch recorded"; return 1; }
  done_tip=$(ledger integrate.done | jq -r '.body.tip' | head -n 1)
  [ "$(git -C "$R" rev-parse "refs/heads/$br" 2>/dev/null)" != "$done_tip" ] || { echo "nothing was committed on $br past the integration tip"; return 1; }
}
c_gates() {
  ledger verify | jq -e 'select(.body.gate == "repair" and .body.exit_code == 0)' >/dev/null || { echo "no green repair verify"; return 1; }
  ledger verdict | jq -e 'select(.body.approved == true)' >/dev/null || { echo "no approving verdict"; return 1; }
  r=$(ledger verdict | jq -s '[.[] | select(.body.round != null)] | length')
  [ "$r" -le 3 ] || { echo "$r rounds, past the budget of 3"; return 1; }
  a=$(sledger swarm.node | jq -s '[.[] | select(.body.kind != "orchestrator")] | length')
  [ "$a" -le 6 ] || { echo "$a agents spawned, past the budget of 6"; return 1; }
}
c_landed() {
  c=$(ledger land | jq -r '.body.commit' | tail -n 1)
  [ -n "$c" ] || { echo "no land record"; return 1; }
  [ "$(tip)" = "$c" ] || { echo "litter/$RUN is at $(tip), not the land's $c"; return 1; }
  sr=$(git -C "$R" show "$c:server/routes.txt" 2>/dev/null)
  cr=$(git -C "$R" show "$c:client/calls.txt" 2>/dev/null)
  [ "$sr" = /v2/items ] && [ "$cr" = /v2/items ] || { echo "the landed routes don't meet at /v2/items: server '$sr', client '$cr'"; return 1; }
  (cd "$R" && sh check.sh >/dev/null 2>&1) || { echo "check.sh fails in the checkout after the land"; return 1; }
}
c_repair_done() {
  s=$(ledger run.end | jq -r '.body.status' | sed -n 2p)
  [ "$s" = done ] || { echo "generation 2 ended '${s:-not at all}', not done"; return 1; }
  git -C "$R" worktree list --porcelain | grep -q -- '-integration$' && { echo "the integration worktree is still there"; return 1; }
  return 0
}
c_nothing_started() {
  [ -z "$(ledger run.repair)" ] || { echo "a run.repair was recorded"; return 1; }
  [ -z "$(swarm_dir)" ] || { echo "a repair swarm was made: $(swarm_dir)"; return 1; }
  [ -z "$(git -C "$R" for-each-ref refs/litter-swarm/)" ] || { echo "a swarm ref exists"; return 1; }
}
c_kept() {
  for br in $(ledger worktree.create | jq -r '.body.branch'); do
    git -C "$R" rev-parse -q --verify "refs/heads/$br" >/dev/null || { echo "branch $br is gone"; return 1; }
  done
  git -C "$R" worktree list --porcelain | grep -q -- '-integration$' || { echo "the integration worktree is gone"; return 1; }
  grep -q '^## Repair' "$RD/summary.md" 2>/dev/null || { echo "summary.md has no Repair section"; return 1; }
}
c_lock_free() {
  git -C "$R" rev-parse -q --verify refs/litter-active >/dev/null && { echo "refs/litter-active is still held"; return 1; }
  jq -e '.run == null' "$LD/hooks/policy.json" >/dev/null 2>&1 || [ ! -f "$LD/hooks/policy.json" ] || { echo "policy.json still has the run"; return 1; }
}
c_not_landed() {
  [ -z "$(ledger land)" ] || { echo "the ledger has a land"; return 1; }
  [ "$(git -C "$R" rev-parse "$(tip)^{tree}")" = "$(git -C "$R" rev-parse "$HEAD0^{tree}")" ] || { echo "litter/$RUN moved off the launch's tree"; return 1; }
}

h_expect "run.start and the launch made a run, with the repair setting" c_run
h_expect "run.json holds repair: $mode" c_setting
h_expect "generation 1 halted at a red integration verify" c_red_halt
if [ "$mode" = auto ]; then
  # Which way it started, read from the launch ledger (WP-AS): an info line, not a check.
  echo "$H_CASE: $(sh "$H_HERE/startfill.sh" how "$LD")"
  h_expect "run.repair opened generation 2, and the repair swarm, confirmed by the run, spawned its orchestrator" c_repair_opened
  h_expect "no ask after the fanout's launch" c_no_ask
  h_expect "a fix was committed on the integration branch" c_fixed_on_branch
  h_expect "a green repair verify and an approving verdict, within 3 rounds and 6 agents" c_gates
  h_expect "the land moved litter/<run> to a tree where the client calls the server's /v2/items, and check.sh passes in the checkout" c_landed
  h_expect "generation 2 ended done, and the integration worktree is gone" c_repair_done
else
  h_expect "nothing started: no run.repair, no repair swarm, no swarm ref" c_nothing_started
  h_expect "the branches, the integration worktree and a Repair section are kept" c_kept
  h_expect "nothing landed" c_not_landed
fi
h_expect "the lock is released" c_lock_free
h_done
