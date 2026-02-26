#!/bin/bash
# SubagentStart hook: Inject team context into spawned subagents
# Triggered when a Task tool subagent is launched
#
# Stdin: {hook_event_name, agent_id, agent_type, session_id, transcript_path, cwd}
# Output: JSON with hookSpecificOutput.additionalContext to inject into subagent
# Exit 0: stdout (JSON) injected as first message context to subagent
# Exit 2: blocking is ignored for SubagentStart

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Read hook input from stdin
HOOK_INPUT=$(cat)

# Determine team context
if [[ -n "$CLAUDE_CODE_TEAM_NAME" ]]; then
    TEAM_NAME="$CLAUDE_CODE_TEAM_NAME"
else
    # Try to source library for window var detection
    if [[ -f "${SCRIPT_DIR}/../lib/swarm-utils.sh" ]]; then
        source "${SCRIPT_DIR}/../lib/swarm-utils.sh" 1>/dev/null
        TEAM_NAME="$(get_current_window_var 'swarm_team' 2>/dev/null || echo '')"
    fi
fi

# If not in a team, exit silently (no output = no injection)
if [[ -z "$TEAM_NAME" ]]; then
    exit 0
fi

AGENT_TYPE=$(echo "$HOOK_INPUT" | jq -r '.agent_type // ""' 2>/dev/null)
AGENT_ID=$(echo "$HOOK_INPUT" | jq -r '.agent_id // ""' 2>/dev/null)

# Build the context string to inject into the subagent
CONTEXT="# Team Context Available

You are in team '${TEAM_NAME}'. Team coordination resources:

1. Team config: ~/.claude/teams/${TEAM_NAME}/config.json
2. Tasks: ~/.claude/tasks/${TEAM_NAME}/
3. You can use swarm commands if team coordination is needed

If this subagent should be a full teammate (persistent, with inbox), use \`/swarm-spawn\` instead of the Task tool."

# Output JSON with additionalContext for SubagentStart hook
# CC parses this and injects it as the first message to the subagent
jq -n --arg context "$CONTEXT" '{
  "hookSpecificOutput": {
    "hookEventName": "SubagentStart",
    "additionalContext": $context
  }
}'

exit 0
