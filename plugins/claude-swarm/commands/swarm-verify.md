---
description: Verify all spawned teammates are alive and update their status
argument-hint: [team_name]
---

# Swarm Verify

Verify that all teammates in the config actually have active sessions running.

## Arguments

- `$1` - Team name (optional, defaults to $CLAUDE_CODE_TEAM_NAME)

## Instructions

Run the following bash command to verify all teammates:

```bash
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh"

# Priority: arg > env vars (teammates) > user vars (team-lead) > error
if [[ -n "$1" ]]; then
    TEAM="$1"
elif [[ -n "$CLAUDE_CODE_TEAM_NAME" ]]; then
    TEAM="$CLAUDE_CODE_TEAM_NAME"
else
    TEAM="$(get_current_window_var 'swarm_team')"
fi

if [[ -z "$TEAM" ]]; then
    echo "Error: Team name required"
    echo "Usage: /swarm-verify [team_name]"
    exit 1
fi

CONFIG_FILE="${TEAMS_DIR}/${TEAM}/config.json"

if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "Error: Team '${TEAM}' not found"
    exit 1
fi

echo "Verifying teammates for team '${TEAM}'..."
echo "Multiplexer: ${SWARM_MULTIPLEXER}"
echo ""

# Get all members from config
MEMBERS=$(jq -r '.members[] | "\(.name)|\(.status)"' "$CONFIG_FILE")

ALIVE_COUNT=0
DEAD_COUNT=0
TOTAL_COUNT=0

while IFS='|' read -r NAME CONFIG_STATUS; do
    [[ -z "$NAME" ]] && continue
    TOTAL_COUNT=$((TOTAL_COUNT + 1))

    # Check if session is actually running
    SESSION_ALIVE=false

    case "$SWARM_MULTIPLEXER" in
        kitty)
            SWARM_VAR="swarm_${TEAM}_${NAME}"
            if kitten_cmd ls 2>/dev/null | jq -e --arg var "$SWARM_VAR" '.[].tabs[].windows[] | select(.user_vars[$var] != null)' &>/dev/null; then
                SESSION_ALIVE=true
            fi
            ;;
        tmux)
            SAFE_TEAM="${TEAM//[^a-zA-Z0-9_-]/_}"
            SAFE_NAME="${NAME//[^a-zA-Z0-9_-]/_}"
            SESSION_NAME="swarm-${SAFE_TEAM}-${SAFE_NAME}"
            if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
                SESSION_ALIVE=true
            fi
            ;;
    esac

    # Report status
    if [[ "$SESSION_ALIVE" == "true" ]]; then
        echo "✓ ${NAME}: alive (config: ${CONFIG_STATUS})"
        ALIVE_COUNT=$((ALIVE_COUNT + 1))

        # Update config if marked offline
        if [[ "$CONFIG_STATUS" == "offline" ]]; then
            update_member_status "$TEAM" "$NAME" "active"
            echo "  └─ Updated status to active"
        fi
    else
        echo "✗ ${NAME}: dead (config: ${CONFIG_STATUS})"
        DEAD_COUNT=$((DEAD_COUNT + 1))

        # Update config if marked active
        if [[ "$CONFIG_STATUS" == "active" ]]; then
            update_member_status "$TEAM" "$NAME" "offline"
            echo "  └─ Updated status to offline"
        fi
    fi
done <<< "$MEMBERS"

echo ""
echo "Summary: ${ALIVE_COUNT}/${TOTAL_COUNT} alive, ${DEAD_COUNT}/${TOTAL_COUNT} dead"

if [[ $DEAD_COUNT -gt 0 ]]; then
    echo ""
    echo "Suggestions:"
    echo "  - Use /claude-swarm:swarm-resume ${TEAM} to respawn offline teammates"
    echo "  - Use /claude-swarm:swarm-spawn <name> to manually respawn a specific teammate"
    echo "  - Check multiplexer logs if spawns are failing"
fi
```

After running, report:

1. How many teammates are alive vs dead
2. Any status mismatches that were corrected
3. Suggestions for recovery if teammates are dead
