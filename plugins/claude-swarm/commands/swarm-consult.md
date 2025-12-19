---
description: Send a message to team-lead and trigger their inbox check
argument-hint: <message>
---

# Consult Team-Lead

Send a message to the team-lead and automatically trigger their inbox to notify them immediately.

## Arguments

- `$1` - Message/question to send to team-lead (required)

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

MESSAGE="$1"

if [[ -z "$MESSAGE" ]]; then
    echo "Error: Message is required"
    echo "Usage: /swarm-consult <message>"
    exit 1
fi

# Prevent team-lead from consulting themselves
if [[ "$FROM_AGENT" == "team-lead" ]]; then
    echo "Error: team-lead cannot consult themselves"
    exit 1
fi

# Temporarily set CLAUDE_CODE_AGENT_NAME so send_message uses correct sender
export CLAUDE_CODE_AGENT_NAME="$FROM_AGENT"

# Send message to team-lead's inbox
if send_message "$TEAM" "team-lead" "$MESSAGE"; then
    echo ""
    echo "Message sent to team-lead's inbox"

    # Try to trigger team-lead's inbox check via send-text
    # Use check_active=false to avoid failing if team-lead is inactive
    # Note: send_text_to_teammate may fail silently if team-lead is offline
    send_text_to_teammate "$TEAM" "team-lead" "/claude-swarm:swarm-inbox" "false" 2>/dev/null
    if [[ $? -eq 0 ]]; then
        echo "Team-lead notified (inbox check triggered)"
    else
        echo "Team-lead will see message on next inbox check"
    fi
else
    echo "Error: Failed to send message" >&2
    exit 1
fi
SCRIPT_EOF
```

Report:

1. Confirmation that message was sent to team-lead's inbox
2. Whether team-lead was actively notified (if online) or will see it later
3. Explain that team-lead will see the message and can respond via `/swarm-message`

## Examples

**Ask team-lead a question:**
```
/swarm-consult "Should I proceed with refactoring the API module?"
```

**Request clarification:**
```
/swarm-consult "Need clarification on task #5 - which endpoint should I modify?"
```

**Report a blocker:**
```
/swarm-consult "Blocked on database schema - can you help?"
```

## Notes

- This command sends a message to team-lead's inbox AND attempts to trigger their `/swarm-inbox` command
- If team-lead is active, they'll be immediately notified
- If team-lead is offline, the message will be waiting in their inbox
- Team-lead cannot use this command (prevents self-consultation)
