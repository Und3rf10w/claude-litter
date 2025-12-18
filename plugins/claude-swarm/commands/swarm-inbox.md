---
description: Check your inbox for messages from teammates
argument-hint: [mark_read]
---

# Check Inbox

Check for messages from teammates.

## Arguments

- `$1` - Mark as read (optional: true/false, defaults to true)

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

if [[ -n "$CLAUDE_CODE_AGENT_NAME" ]]; then
    AGENT="$CLAUDE_CODE_AGENT_NAME"
else
    AGENT="$(get_current_window_var 'swarm_agent')"
    [[ -z "$AGENT" ]] && AGENT="team-lead"
fi

echo "=== Inbox for ${AGENT} in team ${TEAM} ==="
echo ""

# Read unread messages
UNREAD=$(read_unread_messages "$TEAM" "$AGENT")
UNREAD_COUNT=$(echo "$UNREAD" | jq 'length' 2>/dev/null || echo "0")

if [[ "$UNREAD_COUNT" -gt 0 ]]; then
    echo "Unread messages: ${UNREAD_COUNT}"
    echo ""
    format_messages_xml "$UNREAD"

    # Mark as read unless explicitly told not to
    MARK_READ="${1:-true}"
    if [[ "$MARK_READ" == "true" ]]; then
        mark_messages_read "$TEAM" "$AGENT"
        echo ""
        echo "(Messages marked as read)"
    fi
else
    echo "No unread messages."
fi
SCRIPT_EOF
```

Present messages in a clear format and note any action items mentioned.
