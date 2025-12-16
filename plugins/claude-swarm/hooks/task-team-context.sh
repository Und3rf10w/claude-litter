#!/bin/bash
# PreToolUse:Task hook: Inject team context into spawned subagents
# When in a team, ensures spawned agents know about the team

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Only inject if we're part of a team
TEAM_NAME="${CLAUDE_CODE_TEAM_NAME:-}"

if [[ -z "$TEAM_NAME" ]]; then
    exit 0
fi

# Read tool input from stdin
TOOL_INPUT=$(cat)

# Check if this is spawning a new agent (Task tool)
# We want to suggest that spawned agents should be aware of the team

echo "<system-reminder>
# Team Context Available

You are in team '${TEAM_NAME}'. When spawning subagents via the Task tool, consider:

1. The subagent can use swarm commands if it needs team coordination
2. Team config is at: ~/.claude/teams/${TEAM_NAME}/config.json
3. Tasks are at: ~/.claude/tasks/${TEAM_NAME}/

If the subagent should be a full teammate (persistent, with inbox), use \`/swarm-spawn\` instead of the Task tool.
</system-reminder>"

exit 0
