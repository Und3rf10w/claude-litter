---
description: "Deep multi-agent planning session (alias for /swarm-loop --mode deepplan)"
argument-hint: "<planning prompt> --completion-promise 'TEXT'"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/setup-swarm-loop.sh:*)", "Edit(.claude/swarm-loop/**)", "Write(.claude/swarm-loop/**)", "Read(.claude/swarm-loop/**)", "Edit(.claude/swarm-loop.local.md)", "Write(.claude/swarm-loop.local.md)", "Read(.claude/swarm-loop.local.md)", "Read", "Grep", "Glob", "Bash", "Agent", "EnterPlanMode", "ExitPlanMode", "TeamCreate", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "SendMessage", "AskUserQuestion"]
---

# Deepplan Command

Execute the setup script with deepplan mode:

```!
mkdir -p .claude
# Write raw arguments to a PID-unique file to avoid shell expansion of special chars
# in multiline prompts and to prevent races between concurrent swarm invocations.
_prompt_file=".claude/swarm-loop.local.prompt.$$.md"
printf '%s' "$ARGUMENTS" > "$_prompt_file"
"${CLAUDE_PLUGIN_ROOT}/scripts/setup-swarm-loop.sh" --mode deepplan --prompt-file "$_prompt_file"
```

You are now the DEEPPLAN ORCHESTRATOR. Follow the instructions output by the setup script exactly.

Deepplan mode uses a persistent team with diverse-perspective teammates:
- Phase 1: 3 scout teammates (architect, pathfinder, adversary) explore in parallel
- Phase 2: Orchestrator synthesizes findings into structured plan
- Phase 3: 2 critique teammates (pragmatist, strategist) review the draft from opposing angles; orchestrator revises based on their feedback
- Phase 4: Deliver revised plan via ExitPlanMode for user approval

Do not skip the exploration and critique phases. Do not implement — plan only.
