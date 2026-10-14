#!/bin/sh
# Tier 4: a session started below the checkout's top, live:
#
#   sh tests/headless/subdir.sh
#
# The repo is lib.sh's, plus src/deep/notes.txt and a verify command. The
# session starts in src/deep, so CLAUDE_PROJECT_DIR is that folder (2.1.299),
# while the mod keeps litter's folder at the checkout's top. Before lib.sh's
# lt_locate looked up for the top, the command hooks kept their state in
# src/deep/.claude/litter/hooks/, so run.start found no mode and refused.
# The session starts a fanout run with one read-only task, whose researcher
# runs `pwd` and `cat notes.txt`. The researcher won't push (its role forbids
# it), so the toollog fixture replays its live `pwd` through guard.sh as git
# commit and git push, in the session's own environment. The checks want the
# run made in the top's litter folder, both replays denied (the guard found
# the run's hooks/ at the top), and no litter folder under src/.
#
# Needs a signed-in claude and jq. SUBDIR_MODEL sets the session's model (--model).

set -u
. "$(dirname "$0")/lib.sh"

h_scratch "subdir-$(date +%Y%m%d-%H%M%S)"
cp "$LITTER_ROOT/workflows/fanout.js" "$H_DIR/litter/workflows/fanout.js" || exit 1
R=$H_REPO
LD=$R/.claude/litter
mkdir -p "$R/src/deep"
printf 'Notes for the survey.\n' >|"$R/src/deep/notes.txt"
printf '#!/bin/sh\n# The verify command.\n[ -f src/deep/notes.txt ]\n' >|"$R/check.sh"
h_git -C "$R" add -A
h_git -C "$R" commit -q -m 'notes, and a check' || exit 1

TEXT='Run exactly these two Bash commands, one call each, in this order, from the folder you start in: first pwd, then cat notes.txt. Report each command with its output, verbatim.'
TASKS=$(jq -cn --arg t "$TEXT" '[{id: "r", title: "Survey", text: $t, writes: false}]')
START=$(jq -cn --argjson t "$TASKS" '{kind: "run.start", workflow: "fanout", authorized: ["tier-4 subfolder probe"], tasks: $t, contract: ""}')
PROMPT="You are running a scripted test. Do exactly these steps, in order, and nothing else.
1. Call mcp__litter__record with exactly this input: $START
2. Call the Workflow tool with name \"litter:fanout-run\" and args set to the args object step 1 returned, unchanged.
3. Wait for the workflow task notification. Then reply with each step result and the workflow result, verbatim.
If a step is refused, note the refusal verbatim and stop."

# shellcheck disable=SC2046
H_SUBDIR=src/deep h_claude "$PROMPT" ${SUBDIR_MODEL:+--model "$SUBDIR_MODEL"} \
  --settings '{"pluginConfigs": {"litter": {"options": {"verify": ["sh", "check.sh"]}}}}' \
  --allowedTools mcp__litter__record Workflow Read Glob Grep 'Bash(cat:*)' 'Bash(ls:*)'

RESULT='if type == "array" then (map(select(.type == "result")) | .[-1]) else . end'
h_expect 'the session ran' jq -e "$RESULT | .is_error == false" "$H_DIR/out.json"
h_expect 'the run was made in the top'"'"'s litter folder' sh -c "ls -d '$LD'/2*/run.json >/dev/null 2>&1"
# denied <command>: the guard's answer to the replay of the researcher's pwd as <command>.
denied() {
  r=$(jq -c --arg c "$1" 'select(.command | startswith($c))' "$H_DIR/guard-replay.jsonl" 2>/dev/null | head -n 1)
  [ -n "$r" ] || { echo "no replay of $1 (the researcher ran no pwd while the run was active?)"; return 1; }
  printf '%s\n' "$r" | jq -e --arg why "$1 is denied to litter agents" '
    (.code == 0 and (.stdout | fromjson? | .hookSpecificOutput.permissionDecision == "deny"
       and (.hookSpecificOutput.permissionDecisionReason | contains($why))))
    or (.code == 2 and (.stderr | contains($why)))' >/dev/null || { echo "the guard answered $r"; return 1; }
}
h_expect 'the researcher ran from src/deep' sh -c \
  "jq -s -e '[.[] | select(.ev == \"PreToolUse\" and .tool == \"Bash\" and .input.command == \"pwd\" and ((.agent_type // \"\") | test(\"researcher\")) and (.cwd | endswith(\"/src/deep\")))] | length >= 1' '$H_DIR/tool-log.jsonl' >/dev/null"
h_expect 'git commit, replayed from there, is denied' denied 'git commit'
h_expect 'git push, replayed from there, is denied' denied 'git push'
h_expect 'no litter folder under src/' sh -c "[ ! -e '$R/src/.claude' ] && [ ! -e '$R/src/deep/.claude' ]"
h_done
