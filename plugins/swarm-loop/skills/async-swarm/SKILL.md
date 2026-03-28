---
description: "Async background-agent swarm loop (alias for /swarm-loop --mode async)"
argument-hint: "GOAL --completion-promise 'TEXT'"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/setup-swarm-loop.sh:*)", "Edit(.claude/swarm-loop/**)", "Write(.claude/swarm-loop/**)", "Read(.claude/swarm-loop/**)", "Edit(.claude/swarm-loop.local.md)", "Write(.claude/swarm-loop.local.md)", "Read(.claude/swarm-loop.local.md)", "Read", "Grep", "Glob", "Bash", "Agent", "TaskCreate", "TaskUpdate", "TaskList"]
---

# Async Swarm Command

Execute the setup script with async mode:

```!
mkdir -p .claude
# Write raw arguments to file to avoid shell expansion of special chars in multiline prompts.
printf '%s' "$ARGUMENTS" > .claude/swarm-loop.local.prompt.md
"${CLAUDE_PLUGIN_ROOT}/scripts/setup-swarm-loop.sh" --mode async --prompt-file .claude/swarm-loop.local.prompt.md
```

You are now the ASYNC SWARM ORCHESTRATOR. Follow the instructions output by the setup script exactly.

Async mode uses background agents instead of Teams:
- Agents spawn with run_in_background: true
- No TeamCreate, TeamDelete, or SendMessage
- You get notified when each agent completes
- Each agent is fully independent — no inter-agent coordination

Do NOT call TeamCreate or SendMessage in async mode.
