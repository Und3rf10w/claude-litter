---
description: Broadcast a message to all teammates in the team
argument-hint: <message> [--exclude <agent-name>]
---

# Broadcast Message to Team

Broadcast a message to all teammates in the current team.

## Arguments

- `$1` - Message to broadcast (required)
- `--exclude` - Agent name to exclude from broadcast (optional, defaults to sender)

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

MESSAGE=""
EXCLUDE="$FROM_AGENT"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --exclude)
            EXCLUDE="$2"
            shift 2
            ;;
        *)
            if [[ -z "$MESSAGE" ]]; then
                MESSAGE="$1"
            else
                # Append to message if more args without flags
                MESSAGE="$MESSAGE $1"
            fi
            shift
            ;;
    esac
done

if [[ -z "$MESSAGE" ]]; then
    echo "Error: Message is required"
    echo "Usage: /swarm-broadcast <message> [--exclude <agent-name>]"
    exit 1
fi

# Temporarily set CLAUDE_CODE_AGENT_NAME so broadcast_message uses correct sender
export CLAUDE_CODE_AGENT_NAME="$FROM_AGENT"

# Call broadcast_message with fail-fast mode
if broadcast_message "$TEAM" "$MESSAGE" "$EXCLUDE" "true"; then
    echo ""
    echo "Broadcast sent successfully to all teammates (excluding: ${EXCLUDE})"
else
    echo ""
    echo "Broadcast completed with errors (see above)"
    exit 1
fi
SCRIPT_EOF
```

Report:

1. Number of teammates who received the message
2. Confirmation that broadcast was sent
3. Note that recipients will see the message when they run `/swarm-inbox` or on their next session start

## Examples

**Broadcast to all teammates:**

```
/swarm-broadcast "Team meeting in 5 minutes"
```

**Broadcast excluding a specific teammate:**

```
/swarm-broadcast "API v2 is deployed" --exclude backend-dev
```

**Broadcast with multi-word message:**

```
/swarm-broadcast "Please review PR #42 before proceeding with your tasks"
```
