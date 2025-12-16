---
description: Check your inbox for messages from teammates
argument-hint: [mark_read]
---

# Check Inbox

Check for messages from teammates.

## Arguments

- `$1` - Mark as read (optional: true/false, defaults to true)

## Instructions

Run the following bash commands:

```bash
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh"

TEAM="${CLAUDE_CODE_TEAM_NAME:-default}"
AGENT="${CLAUDE_CODE_AGENT_NAME:-team-lead}"

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
```

Present messages in a clear format and note any action items mentioned.
