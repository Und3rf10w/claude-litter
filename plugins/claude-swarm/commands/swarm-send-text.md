---
description: Send text directly to a teammate's terminal (types commands for them)
argument-hint: <target> <text>
---

# Send Text to Teammate Terminal

Send text directly to a teammate's terminal, as if they typed it themselves. This is useful for triggering commands or providing input.

## Arguments

- `$1` - Target (required: teammate name or "all")
- `$2` - Text to send (required)

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

TARGET="$1"
TEXT="$2"

if [[ -z "$TARGET" ]] || [[ -z "$TEXT" ]]; then
    echo "Error: Both target and text are required"
    echo "Usage: /swarm-send-text <target|all> <text>"
    exit 1
fi

# Function to send text to a specific teammate
send_text_to_teammate() {
    local agent_name="$1"
    local text="$2"

    # Skip if sending to self
    if [[ "$agent_name" == "$FROM_AGENT" ]]; then
        echo "Skipping self (${agent_name})"
        return 0
    fi

    # Check if teammate is active
    local live_agents=$(get_live_agents "$TEAM")
    if ! echo "$live_agents" | grep -q "^${agent_name}$"; then
        echo "Agent '${agent_name}' is not active, skipping"
        return 0
    fi

    case "$SWARM_MULTIPLEXER" in
        kitty)
            local swarm_var="swarm_${TEAM}_${agent_name}"
            if kitten_cmd send-text --match "var:${swarm_var}" "$text"; then
                echo "Text sent to '${agent_name}' (kitty)"
            else
                echo "Failed to send text to '${agent_name}' (kitty)" >&2
                return 1
            fi
            ;;
        tmux)
            local safe_team="${TEAM//[^a-zA-Z0-9_-]/_}"
            local safe_agent="${agent_name//[^a-zA-Z0-9_-]/_}"
            local session="swarm-${safe_team}-${safe_agent}"
            if tmux send-keys -t "$session" "$text" 2>/dev/null; then
                echo "Text sent to '${agent_name}' (tmux)"
            else
                echo "Failed to send text to '${agent_name}' (tmux)" >&2
                return 1
            fi
            ;;
        *)
            echo "Error: Unknown multiplexer '${SWARM_MULTIPLEXER}'" >&2
            return 1
            ;;
    esac
}

# Send to all or specific target
if [[ "$TARGET" == "all" ]]; then
    echo "Sending text to all active teammates in team '${TEAM}'..."
    echo ""

    local config_file="${TEAMS_DIR}/${TEAM}/config.json"
    if [[ ! -f "$config_file" ]]; then
        echo "Error: Team '${TEAM}' not found" >&2
        exit 1
    fi

    local success_count=0
    local fail_count=0

    # Iterate through all team members
    while IFS= read -r member; do
        [[ -n "$member" ]] || continue
        if send_text_to_teammate "$member" "$TEXT"; then
            ((success_count++))
        else
            ((fail_count++))
        fi
    done < <(jq -r '.members[].name' "$config_file")

    echo ""
    echo "Broadcast complete: ${success_count} sent, ${fail_count} failed"

    if [[ $fail_count -gt 0 ]]; then
        exit 1
    fi
else
    # Send to specific teammate
    send_text_to_teammate "$TARGET" "$TEXT"
fi
SCRIPT_EOF
```

Report:

1. Confirmation that text was sent to the target(s)
2. Note which multiplexer was used (kitty or tmux)
3. For "all" targets, report success/failure counts

## Examples

**Send a command to a specific teammate:**

```
/swarm-send-text backend-dev "/swarm-inbox"
```

**Send text with enter key to all teammates:**

```
/swarm-send-text all "/swarm-inbox\r"
```

Note: Use `\r` for carriage return (Enter key) in the text.

**Trigger a command for a teammate:**

```
/swarm-send-text frontend-dev "echo 'Starting work'\r"
```

## Use Cases

- Trigger `/swarm-inbox` check for teammates who have new messages
- Send coordination commands to active teammates
- Provide input to teammates waiting for user input
- Broadcast a command to all active teammates

## Important Notes

- Text is sent directly to the terminal - use carefully
- Does not send to inactive teammates (they won't receive it)
- Skips sending to self automatically
- Use `\r` at the end to simulate pressing Enter
