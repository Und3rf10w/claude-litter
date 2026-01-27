---
description: Request graceful shutdown of a specific teammate
argument-hint: <agent-name> [reason]
---

# Request Teammate Shutdown

Send a shutdown request to a specific teammate, allowing them to finish current work.

## Arguments

- `$1` - Agent name to shut down (required)
- `$2` - Reason for shutdown (optional)

## Instructions

Execute the following script using bash explicitly:

```bash
bash << 'SCRIPT_EOF'
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null

AGENT_NAME="$1"
REASON="${2:-Team cleanup requested}"

if [[ -z "$AGENT_NAME" ]]; then
    echo "Error: Agent name required"
    echo "Usage: /swarm-request-shutdown <agent-name> [reason]"
    exit 1
fi

# Priority: env vars (teammates) > user vars (team-lead) > error
if [[ -n "$CLAUDE_CODE_TEAM_NAME" ]]; then
    TEAM="$CLAUDE_CODE_TEAM_NAME"
else
    TEAM="$(get_current_window_var 'swarm_team')"
    if [[ -z "$TEAM" ]]; then
        echo "Error: Cannot determine team. Run from a swarm window or set CLAUDE_CODE_TEAM_NAME" >&2
        exit 1
    fi
fi

# Check if agent exists in team
config_file="${TEAMS_DIR}/${TEAM}/config.json"
if [[ ! -f "$config_file" ]]; then
    echo "Error: Team '${TEAM}' not found"
    exit 1
fi

agent_exists=$(jq -r --arg name "$AGENT_NAME" '.members[] | select(.name == $name) | .name' "$config_file")
if [[ -z "$agent_exists" ]]; then
    echo "Error: Agent '${AGENT_NAME}' not found in team '${TEAM}'"
    exit 1
fi

# Create shutdown request
REQUEST_ID=$(generate_uuid)
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Send shutdown request message
MESSAGE="SHUTDOWN REQUEST: You are requested to shutdown gracefully. Request ID: ${REQUEST_ID}. Reason: ${REASON}. Please finish any critical work and acknowledge with: Shutdown acknowledged for request ${REQUEST_ID}"

# Use typed message if available, fallback to regular message
if send_typed_message "$TEAM" "$AGENT_NAME" "$MSG_TYPE_SHUTDOWN_REQUEST" "$MESSAGE" "{\"requestId\": \"${REQUEST_ID}\", \"reason\": \"${REASON}\"}" "red" 2>/dev/null; then
    echo "Shutdown request sent to '${AGENT_NAME}'"
elif send_message "$TEAM" "$AGENT_NAME" "$MESSAGE" "red"; then
    echo "Shutdown request sent to '${AGENT_NAME}'"
else
    echo "Error: Failed to send shutdown request"
    exit 1
fi

echo "  Request ID: ${REQUEST_ID}"
echo "  Reason: ${REASON}"
echo ""
echo "The agent will receive this in their inbox."
echo "They should acknowledge before shutting down."
SCRIPT_EOF
```

Report:

1. Shutdown request confirmation
2. Request ID for tracking
3. Remind that agent should acknowledge
