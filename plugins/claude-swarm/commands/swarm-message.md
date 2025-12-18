---
description: Send a message to a teammate's inbox
argument-hint: <to> <message>
---

# Send Message to Teammate

Send a message to a teammate.

## Arguments

- `$1` - Recipient name (required, e.g., team-lead, backend-dev)
- `$2` - Message to send (required)

## Instructions

Execute the following script using bash explicitly:

```bash
bash << 'SCRIPT_EOF'
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null

# Priority: env vars (teammates) > user vars (team-lead) > error
if [[ -n "$CLAUDE_CODE_TEAM_NAME" ]]; then
    TEAM="$CLAUDE_CODE_TEAM_NAME"
else
    TEAM="$(get_current_window_var 'swarm_team')"
    if [[ -z "$TEAM" ]]; then
        echo "Error: Cannot determine team. Run this command from a swarm window or set CLAUDE_CODE_TEAM_NAME" >&2
        exit 1
    fi
fi

# Detect agent name for sender identity
if [[ -n "$CLAUDE_CODE_AGENT_NAME" ]]; then
    FROM_AGENT="$CLAUDE_CODE_AGENT_NAME"
else
    FROM_AGENT="$(get_current_window_var 'swarm_agent')"
    [[ -z "$FROM_AGENT" ]] && FROM_AGENT="team-lead"
fi

TO="$1"
MESSAGE="$2"

if [[ -z "$TO" ]] || [[ -z "$MESSAGE" ]]; then
    echo "Error: Both recipient and message are required"
    echo "Usage: /swarm-message <to> <message>"
    exit 1
fi

# Temporarily set CLAUDE_CODE_AGENT_NAME so send_message uses correct sender
export CLAUDE_CODE_AGENT_NAME="$FROM_AGENT"
send_message "$TEAM" "$TO" "$MESSAGE"
SCRIPT_EOF
```

Report:

1. Message sent confirmation
2. Note that the recipient will see the message when they run `/swarm-inbox` or on their next session start
