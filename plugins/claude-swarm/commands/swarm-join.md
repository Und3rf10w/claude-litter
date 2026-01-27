---
description: Request to join an existing team
argument-hint: <team-name> [agent-type]
---

# Request to Join Team

Send a join request to a team's team-lead.

## Arguments

- `$1` - Team name to join (required)
- `$2` - Agent type (optional, default: worker)

## Instructions

Execute the following script using bash explicitly:

```bash
bash << 'SCRIPT_EOF'
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null

TEAM_NAME="$1"
AGENT_TYPE="${2:-worker}"

if [[ -z "$TEAM_NAME" ]]; then
    echo "Error: Team name is required"
    echo "Usage: /swarm-join <team-name> [agent-type]"
    exit 1
fi

# Validate team exists
config_file="${TEAMS_DIR}/${TEAM_NAME}/config.json"
if [[ ! -f "$config_file" ]]; then
    echo "Error: Team '${TEAM_NAME}' not found"
    echo "Use /swarm-discover to list available teams"
    exit 1
fi

# Check team status
status=$(jq -r '.status' "$config_file")
if [[ "$status" == "suspended" ]]; then
    echo "Error: Team '${TEAM_NAME}' is suspended and not accepting new members"
    exit 1
fi

# Generate request ID and agent ID for this join request
REQUEST_ID=$(generate_uuid)
REQUESTER_ID="${CLAUDE_CODE_AGENT_ID:-$(generate_uuid)}"
REQUESTER_NAME="${CLAUDE_CODE_AGENT_NAME:-external-agent}"

# Create join requests directory if it doesn't exist
JOIN_REQUESTS_DIR="${TEAMS_DIR}/${TEAM_NAME}/join-requests"
mkdir -p "$JOIN_REQUESTS_DIR"

# Create join request file
REQUEST_FILE="${JOIN_REQUESTS_DIR}/${REQUEST_ID}.json"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

jq -n \
    --arg requestId "$REQUEST_ID" \
    --arg requesterId "$REQUESTER_ID" \
    --arg requesterName "$REQUESTER_NAME" \
    --arg agentType "$AGENT_TYPE" \
    --arg timestamp "$TIMESTAMP" \
    '{
        requestId: $requestId,
        requesterId: $requesterId,
        requesterName: $requesterName,
        agentType: $agentType,
        status: "pending",
        createdAt: $timestamp
    }' > "$REQUEST_FILE"

# Send message to team-lead about join request
MESSAGE="JOIN REQUEST: Agent '${REQUESTER_NAME}' (ID: ${REQUESTER_ID}) is requesting to join as '${AGENT_TYPE}'. Request ID: ${REQUEST_ID}. Use /swarm-approve-join ${REQUEST_ID} or /swarm-reject-join ${REQUEST_ID}."

send_message "$TEAM_NAME" "team-lead" "$MESSAGE" "yellow"

echo "Join request sent to team '${TEAM_NAME}'"
echo "  Request ID: ${REQUEST_ID}"
echo "  Agent Type: ${AGENT_TYPE}"
echo ""
echo "The team-lead will review your request."
echo "You will be notified when approved or rejected."
SCRIPT_EOF
```

Report:

1. Join request status
2. Request ID for tracking
3. Next steps (wait for team-lead approval)
