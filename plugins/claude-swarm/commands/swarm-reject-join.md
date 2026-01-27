---
description: Reject a join request (team-lead only)
argument-hint: <request-id> [reason]
---

# Reject Join Request

Reject a pending join request.

## Arguments

- `$1` - Request ID (required)
- `$2` - Reason for rejection (optional)

## Instructions

Execute the following script using bash explicitly:

```bash
bash << 'SCRIPT_EOF'
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null

REQUEST_ID="$1"
REASON="${2:-No reason provided}"

if [[ -z "$REQUEST_ID" ]]; then
    echo "Error: Request ID is required"
    echo "Usage: /swarm-reject-join <request-id> [reason]"
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
    echo "Error: Only team-lead can reject join requests"
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

# Extract request details for logging
REQUESTER_NAME=$(jq -r '.requesterName' "$REQUEST_FILE")

# Update request status
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP_FILE=$(mktemp)
jq --arg status "rejected" \
   --arg ts "$TIMESTAMP" \
   --arg reason "$REASON" \
   '.status = $status | .rejectedAt = $ts | .rejectionReason = $reason' \
   "$REQUEST_FILE" > "$TMP_FILE" && mv "$TMP_FILE" "$REQUEST_FILE"

echo "Join request rejected"
echo "  Requester: ${REQUESTER_NAME}"
echo "  Reason: ${REASON}"
SCRIPT_EOF
```

Report:

1. Rejection confirmation
2. Reason provided (if any)
