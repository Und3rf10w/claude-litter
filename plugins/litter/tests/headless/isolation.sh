#!/bin/sh
# Tier 4, isolation (plan section 12) and phase 1's manual checks, headless.
#
#   sh tests/headless/isolation.sh alone   # litter alone: every check passes
#   sh tests/headless/isolation.sh broad   # plus a matcher-less tool.call mod
#
# One session launches a litter run (run.start, then Workflow litter:fanout,
# the fixture), whose isolated prober runs the probe, and an isolated
# general-purpose Agent-tool agent that runs it too. The prober's live input is
# replayed through guard.sh as git commit and git push, and the main thread
# commits and pushes while the run is active. `alone` must pass every check.
# Before CC 2.1.288, `broad` must fail the isolation checks, and litter must
# halt the run naming the likely cause: a hooks-worker next() resumed outside
# the agent's working-directory store. 2.1.288 resumes it in the caller's
# context (anthropics/claude-code#91870), so from then on `broad` must pass
# every check `alone` does, with the broad hook seen hopping.

set -u
. "$(dirname "$0")/lib.sh"

mode=${1:-alone}
case $mode in alone | broad) ;; *) echo "usage: $0 alone|broad" >&2; exit 2 ;; esac

AGENT_PROMPT='You are a tier-4 test probe. Make each of these tool calls once, in this order, as separate calls. Do not retry a refused call and do not work around a refusal. 1. Bash: pwd 2. Read with file_path set to the relative path parent-local.txt, exactly that 3. Glob with pattern "*" and no path 4. Grep with pattern "PARENT-LOCAL", output_mode "files_with_matches" and no path 5. Write the file probe-write.txt with content "probe", file_path being the absolute path in the folder step 1 printed 6. Edit the README in the folder step 1 printed (absolute path), replacing hi with hi-edited. Then reply with one line per step: its number, then the result or the refusal, verbatim.'

PROMPT="You are running a scripted test. Do exactly these steps, in order, and nothing else.
1. Call mcp__litter__record with exactly this input: {\"kind\": \"run.start\", \"workflow\": \"fanout\", \"authorized\": [\"tier-4 isolation probe\"], \"tasks\": [{\"id\": \"probe\", \"title\": \"Isolation probe\", \"text\": \"Run the isolation probe\", \"writes\": false}]}
2. Call the Workflow tool with name \"litter:fanout\" and args set to the args object step 1 returned, unchanged.
3. Call the Agent tool once with subagent_type \"general-purpose\", isolation \"worktree\", run_in_background false, and this prompt: \"$AGENT_PROMPT\"
4. Run with Bash: git commit --allow-empty -m main-probe
5. Run with Bash: git push origin HEAD:refs/heads/main-push
6. Run with Bash: pwd
7. Wait for the workflow's task notification. Then reply with each step's result, the agent's report and the workflow's result, verbatim.
If a step is refused, note the refusal verbatim and go on to the next step."

h_scratch "isolation-$mode"
extra=
[ "$mode" = broad ] && extra=$H_DIR/broad
# run.start needs a verify command; the fixture never runs it.
# shellcheck disable=SC2086
h_claude "$PROMPT" ${extra:+--plugin-dir "$extra"} \
  --settings '{"pluginConfigs": {"litter": {"options": {"verify": ["true"]}}}}' \
  --allowedTools mcp__litter__record Workflow Agent Read Glob Grep Write Edit \
  'Bash(pwd)' 'Bash(git commit:*)' 'Bash(git push:*)'

[ -s "$H_DIR/tool-log.jsonl" ] || { echo "no tool log: the session made no tool calls"; exit 1; }

# The run litter launched, from its ledger.
LD=$H_REPO/.claude/litter
RUN=$(ls "$LD" 2>/dev/null | grep -E '^[0-9]{8}-' | head -n 1)
run_end() { cat "$LD/$RUN"/ledger/*-run.end.json 2>/dev/null | jq -r '.body.status' | tail -n 1; }

# --- checks on one isolated agent -------------------------------------------

# Its calls' results; a call is matched on its tool and, for Bash, its command.
results() { h_log "$1" | jq -r --arg tool "$2" --arg cmd "${3:-}" '
  select((.ev == "PostToolUse" or .ev == "PostToolUseFailure") and .tool == $tool
    and ($cmd == "" or ((.input.command // "") | startswith($cmd)))) | .result'; }

c_not_lost() {
  l=$(h_log "$1" | jq -r 'select(.result != null) | .result' | grep -i 'isolation context' | head -n 1)
  [ -z "$l" ] || { echo "a result says: $l"; return 1; }
}
c_cwd() {
  wt=$(h_worktree "$1")
  [ -n "$wt" ] || { echo "no SubagentStart for $1"; return 1; }
  case $wt in "$H_REPO"/.claude/worktrees/*) ;; *) echo "SubagentStart cwd $wt isn't a worktree of $H_REPO"; return 1 ;; esac
  bad=$(h_log "$1" | jq -r --arg wt "$wt" 'select(.ev == "PreToolUse" and .cwd != $wt) | "\(.tool) ran in \(.cwd)"' | head -n 3)
  [ -z "$bad" ] || { echo "$bad (worktree $wt)"; return 1; }
}
c_pwd() {
  wt=$(h_worktree "$1")
  r=$(results "$1" Bash pwd)
  [ -n "$r" ] || { echo "no pwd result"; return 1; }
  case $r in *"$wt"*) ;; *) echo "pwd said $r, not $wt"; return 1 ;; esac
}
# Only the parent has parent-local.txt (lib.sh). A Read is judged on the
# content, since its refusal may name the path it was asked for.
c_parent_free() {
  asked=$(h_log "$1" | jq -r --arg tool "$2" 'select(.ev == "PreToolUse" and .tool == $tool) | .input.file_path // .input.pattern // ""' | head -n 1)
  case $2:$asked in Read:*parent-local.txt | Grep:PARENT-LOCAL | Glob:*) ;;
    *:) echo "no $2 call"; return 1 ;;
    *) echo "$2 was asked for '$asked', not the parent's marker, so it tested nothing"; return 1 ;;
  esac
  r=$(results "$1" "$2")
  [ -n "$r" ] || { echo "no $2 result"; return 1; }
  case $2:$r in *PARENT-LOCAL* | Glob:*parent-local.txt* | Grep:*parent-local.txt*) echo "$2 answered from the parent checkout: $r"; return 1 ;; esac
}
c_write() {
  wt=$(h_worktree "$1")
  [ -f "$wt/probe-write.txt" ] || { echo "no $wt/probe-write.txt"; return 1; }
  [ ! -e "$H_REPO/probe-write.txt" ] || { echo "probe-write.txt landed in the parent checkout"; return 1; }
}
c_edit() {
  wt=$(h_worktree "$1")
  grep -q hi-edited "$wt/README" 2>/dev/null || { echo "$wt/README wasn't edited"; return 1; }
  ! grep -q hi-edited "$H_REPO/README" || { echo "the parent checkout's README was edited"; return 1; }
}

isolated() {
  h_expect "$2: no result says the isolation context was lost" c_not_lost "$1"
  h_expect "$2: every call ran in its worktree" c_cwd "$1"
  h_expect "$2: pwd is its worktree" c_pwd "$1"
  h_expect "$2: a relative Read answers from the worktree" c_parent_free "$1" Read
  h_expect "$2: a Glob with no path answers from the worktree" c_parent_free "$1" Glob
  h_expect "$2: a Grep with no path answers from the worktree" c_parent_free "$1" Grep
  h_expect "$2: a Write lands in the worktree" c_write "$1"
}

# --- the litter agent's git denials and the main thread's git -----------------

# The prober won't commit or push (its role forbids it), so the toollog
# fixture replays its live `pwd` input through guard.sh as each command.
c_denied() {
  r=$(jq -c --arg c "$1" 'select(.command | startswith($c))' "$H_DIR/guard-replay.jsonl" 2>/dev/null | head -n 1)
  [ -n "$r" ] || { echo "no replay of $1 (the prober ran no pwd while the run was active?)"; return 1; }
  printf '%s\n' "$r" | jq -e --arg why "$1 is denied to litter agents" '
    (.code == 0 and (.stdout | fromjson? | .hookSpecificOutput.permissionDecision == "deny"
       and (.hookSpecificOutput.permissionDecisionReason | contains($why))))
    or (.code == 2 and (.stderr | contains($why)))' >/dev/null || { echo "the guard answered $r"; return 1; }
  [ -z "$(results litter:prober Bash "$1")" ] || { echo "$1 ran: $(results litter:prober Bash "$1")"; return 1; }
}
c_no_ref() {
  if h_git -C "$H_REPO" log --all --format=%s | grep -q probe-commit; then echo "a probe-commit exists"; return 1; fi
  if git -C "$H_DIR/origin.git" rev-parse -q --verify refs/heads/probe-push >/dev/null; then echo "origin has probe-push"; return 1; fi
}
c_main_git() {
  h_git -C "$H_REPO" log --all --format=%s | grep -q main-probe || { echo "no main-probe commit"; return 1; }
  git -C "$H_DIR/origin.git" rev-parse -q --verify refs/heads/main-push >/dev/null || { echo "origin has no main-push"; return 1; }
}
c_main_cwd() {
  bad=$(h_log main | jq -r --arg r "$H_REPO" 'select(.ev == "PreToolUse" and .cwd != $r) | "\(.tool) ran in \(.cwd)"' | head -n 3)
  [ -z "$bad" ] || { echo "$bad"; return 1; }
}

# --- the debug log ----------------------------------------------------------

c_no_exec_block() {
  l=$(grep 'blocked shell exec after cwd-override loss' "$H_DIR/debug.txt" | head -n 1)
  [ -z "$l" ] || { echo "$l"; return 1; }
}
# litter's tool.call hops, against its allowlisted calls: one more means a hop
# on a tool the allowlist leaves out.
c_hops() {
  hops=$(grep -c 'hooks module .*litter@inline.* tool\.call settled' "$H_DIR/debug.txt")
  # The record tool is answered in litter's hook, so no PreToolUse logs it: count from the transcripts.
  calls=$(h_tool_uses | grep -c -E '^(Workflow|TaskStop|mcp__litter__[a-z_]+)$')
  [ "$hops" -le "$calls" ] || { echo "$hops litter tool.call hops for $calls allowlisted calls"; return 1; }
}

c_run_status() {
  [ -n "$RUN" ] || { echo "no run in $LD"; return 1; }
  s=$(run_end)
  [ "$s" = "$1" ] || { echo "run $RUN ended '${s:-not at all}', expected $1"; return 1; }
}
c_halt_message() {
  grep -q "likely another plugin's tool.call hook" "$H_DIR/debug.txt" ||
    { echo "no isolation-lost message naming the cause in the debug log"; return 1; }
}
c_broad_hopped() {
  grep -q 'hooks module broad@inline tool\.call settled .*(worker hop' "$H_DIR/debug.txt" ||
    { echo "the broad hook never hopped to the worker, so nothing was tested"; return 1; }
}

# Whether this CC resumes a worker hop in the caller's context: 2.1.288 on.
hop_fixed() {
  claude --version 2>/dev/null | awk '{ split($1, v, ".")
    exit !(v[1] > 2 || (v[1] == 2 && (v[2] > 1 || (v[2] == 1 && v[3] >= 288)))) }'
}

if [ "$mode" = alone ] || hop_fixed; then
  [ "$mode" = broad ] && h_expect "the broad hook hopped to the worker" c_broad_hopped
  isolated litter:prober "litter agent"
  isolated general-purpose "Agent-tool agent"
  h_expect "Agent-tool agent: an Edit lands in the worktree" c_edit general-purpose
  h_expect "litter agent: git commit is denied" c_denied 'git commit'
  h_expect "litter agent: git push is denied" c_denied 'git push'
  h_expect "litter agent: no commit or pushed ref came of it" c_no_ref
  h_expect "main thread: git commit and git push go through during the run" c_main_git
  h_expect "main thread: its working directory never moved" c_main_cwd
  h_expect "debug log: no shell exec blocked for a lost cwd" c_no_exec_block
  h_expect "debug log: litter hopped only allowlisted tools" c_hops
  h_expect "the run ended done" c_run_status done
else
  # Each must fail: the hop is what breaks them. Every check's answer is
  # shown, so a run also shows which ones caught it.
  for t in litter:prober general-purpose; do
    broke=
    for c in c_not_lost c_pwd c_cwd 'c_parent_free Read' 'c_parent_free Glob' 'c_parent_free Grep'; do
      # A word list on purpose: the check and its argument.
      # shellcheck disable=SC2086
      why=$(set -- $c && "$1" "$t" ${2:+"$2"}) || { broke=1; echo "     $t: $c: $why"; }
    done
    if [ -n "$broke" ]; then
      h_check ok "$t: the broad hook broke its isolation"
    else
      h_check fail "$t: the broad hook broke its isolation" "every isolation check passed, so the fixture didn't hop"
    fi
  done
  h_expect "litter agent: no commit or pushed ref came of it" c_no_ref
  h_expect "litter halted the run, naming the likely cause" c_halt_message
  h_expect "the run ended halted" c_run_status halted
fi

h_done
