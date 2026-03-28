---
description: "Start an orchestrated multi-agent swarm loop"
argument-hint: "GOAL --completion-promise 'TEXT' [--mode NAME] [--soft-budget N] [--verify 'CMD'] [--safe-mode true|false]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/setup-swarm-loop.sh:*)", "Edit(.claude/swarm-loop.local.*)", "Write(.claude/swarm-loop.local.*)", "Read(.claude/swarm-loop.local.*)", "Edit(.claude/deepplan.local.*)", "Write(.claude/deepplan.local.*)", "Read(.claude/deepplan.local.*)", "Read", "Grep", "Glob", "Bash", "TeamCreate", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "SendMessage", "Agent", "EnterPlanMode", "ExitPlanMode", "AskUserQuestion"]
---

# Swarm Loop Command

Execute the setup script to initialize the swarm loop:

```!
mkdir -p .claude
# Write raw arguments to file to avoid shell expansion of special chars in multiline prompts.
# The setup script's --prompt-file flag reads the goal from this file and parses flags from it.
printf '%s' "$ARGUMENTS" > .claude/swarm-loop.local.prompt.md
"${CLAUDE_PLUGIN_ROOT}/scripts/setup-swarm-loop.sh" --prompt-file .claude/swarm-loop.local.prompt.md
```

You are now the SWARM LOOP ORCHESTRATOR. Follow the instructions output by the setup script exactly.

Use `--mode deepplan` for multi-agent planning or `--mode async` for background-agent orchestration. See `/swarm-help` for details.

Key things to remember:
- Read .claude/swarm-loop.local.state.json and .claude/swarm-loop.local.log.md at the start of each iteration
- The team is persistent — call TeamCreate ONCE at loop start (team_name is in .claude/swarm-loop.local.state.json), do NOT recreate it between iterations
- Use native TaskCreate/TaskUpdate/TaskList for ALL task tracking — there is no tasks[] array in the state file
- Check `teammates_isolation` in state: if "worktree", use `isolation: "worktree"` on every Agent call; if "shared" (default), partition file ownership carefully
- Check `teammates_max_count` in state: do not spawn more than this many teammates at once
- Use TaskCreate with blockedBy dependencies to model the work graph; spawn teammates via Agent tool into the persistent team
- Each iteration follows the 7-step cycle: ASSESS → PLAN → EXECUTE → MONITOR → VERIFY → PERSIST → SIGNAL
- In MONITOR: persist each teammate's result to .claude/swarm-loop.local.state.json (progress_history) and the log IMMEDIATELY on receipt — do not defer to PERSIST (microcompact risk)
- In SIGNAL: if compact_on_iteration is enabled, run /compact BEFORE writing the sentinel
- Write .claude/swarm-loop.local.next-iteration (empty content) to signal the stop hook to start the next iteration
- Do NOT call TeamDelete — only /cancel-swarm calls TeamDelete; normal loop completion shuts down teammates but leaves the team intact
- Configure loop settings (compact mode, classifier, notifications, etc.) via /swarm-settings

CRITICAL: If a completion promise is set, you may ONLY output it when the statement is completely and unequivocally TRUE. Do not output false promises to escape the loop.

NOTE: Safe mode (default: true) enables auto-approval for file edits and injects safety context into teammates. Use `--safe-mode false` for supervised sessions where you want manual approval for all operations.
