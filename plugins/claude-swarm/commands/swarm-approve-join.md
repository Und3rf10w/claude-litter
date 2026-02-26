---
description: Approve a join request (team-lead only)
argument-hint: <request-id> [agent-name] [color]
---

# Approve Join Request

Approve a pending join request and add the agent to the team.

## Arguments

- `$1` - Request ID (required)
- `$2` - Agent name to assign (optional, defaults to requester's suggested name)
- `$3` - Agent color (optional, default: blue)

## Instructions

Execute the following script using bash explicitly:

```bash
bash << 'SCRIPT_EOF'
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null

REQUEST_ID="$1"
ASSIGNED_NAME="$2"
AGENT_COLOR="${3:-blue}"

if [[ -z "$REQUEST_ID" ]]; then
    echo "Error: Request ID is required" >&2
    echo "Usage: /swarm-approve-join <request-id> [agent-name] [color]" >&2
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

# Verify caller is team-lead
CURRENT_AGENT="${CLAUDE_CODE_AGENT_NAME:-$(get_current_window_var 'swarm_agent')}"
if [[ "$CURRENT_AGENT" != "team-lead" ]] && [[ "${CLAUDE_CODE_IS_TEAM_LEAD:-}" != "true" ]]; then
    echo "Error: Only team-lead can approve join requests"
    exit 1
fi

# Find and validate request
REQUEST_FILE="${TEAMS_DIR}/${TEAM}/join-requests/${REQUEST_ID}.json"
if [[ ! -f "$REQUEST_FILE" ]]; then
    echo "Error: Join request '${REQUEST_ID}' not found"
    echo "Use /swarm-status to see pending join requests"
    exit 1
fi

# Check request status
STATUS=$(jq -r '.status' "$REQUEST_FILE")
if [[ "$STATUS" != "pending" ]]; then
    echo "Error: Request already processed (status: ${STATUS})"
    exit 1
fi

# Extract request details
REQUESTER_ID=$(jq -r '.requesterId' "$REQUEST_FILE")
REQUESTER_NAME=$(jq -r '.requesterName' "$REQUEST_FILE")
AGENT_TYPE=$(jq -r '.agentType' "$REQUEST_FILE")

# Use assigned name or requester's name
AGENT_NAME="${ASSIGNED_NAME:-$REQUESTER_NAME}"

# Validate agent name
if ! validate_name "$AGENT_NAME" "agent"; then
    exit 1
fi

# Add member to team
if ! add_member "$TEAM" "$REQUESTER_ID" "$AGENT_NAME" "$AGENT_TYPE" "$AGENT_COLOR"; then
    echo "Error: Failed to add member to team"
    exit 1
fi

# Update request status
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP_FILE=$(mktemp)
jq --arg status "approved" \
   --arg ts "$TIMESTAMP" \
   --arg name "$AGENT_NAME" \
   '.status = $status | .approvedAt = $ts | .assignedName = $name' \
   "$REQUEST_FILE" > "$TMP_FILE" && mv "$TMP_FILE" "$REQUEST_FILE"

echo "Join request approved!"
echo "  Agent: ${AGENT_NAME}"
echo "  Type: ${AGENT_TYPE}"
echo "  Color: ${AGENT_COLOR}"
echo ""
echo "The new member's inbox has been created at:"
echo "  ${TEAMS_DIR}/${TEAM}/inboxes/${AGENT_NAME}.json"
SCRIPT_EOF
```

Report:

1. Approval confirmation with agent details
2. New member's inbox location
3. Suggest notifying the new member of their acceptance
