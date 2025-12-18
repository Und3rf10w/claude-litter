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

Run the following bash command to send the message:

```bash
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh"

# Priority: env vars (teammates) > user vars (team-lead) > defaults
if [[ -n "$CLAUDE_CODE_TEAM_NAME" ]]; then
    TEAM="$CLAUDE_CODE_TEAM_NAME"
else
    TEAM="$(get_current_window_var 'swarm_team')"
    [[ -z "$TEAM" ]] && TEAM="default"
fi

TO="$1"
MESSAGE="$2"

if [[ -z "$TO" ]] || [[ -z "$MESSAGE" ]]; then
    echo "Error: Both recipient and message are required"
    echo "Usage: /swarm-message <to> <message>"
    exit 1
fi

send_message "$TEAM" "$TO" "$MESSAGE"
```

Report:

1. Message sent confirmation
2. Note that the recipient will see the message when they run `/swarm-inbox` or on their next session start
