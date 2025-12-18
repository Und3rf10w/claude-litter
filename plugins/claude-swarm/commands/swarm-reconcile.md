---
description: Fix status mismatches between config and reality
argument-hint: [team_name] [--auto-fix]
---

# Swarm Reconcile

Reconcile team configuration with actual running sessions, fixing mismatches.

## Arguments

- `$1` - Team name (optional, defaults to $CLAUDE_CODE_TEAM_NAME)
- `$2` - `--auto-fix` to automatically fix all issues (optional)

## Instructions

Execute the following script using bash explicitly:

```bash
bash << 'SCRIPT_EOF'
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null

TEAM=""
AUTO_FIX=false

# Parse arguments
for arg in "$@"; do
    case "$arg" in
        --auto-fix)
            AUTO_FIX=true
            ;;
        *)
            if [[ -z "$TEAM" ]]; then
                TEAM="$arg"
            fi
            ;;
    esac
done

# Priority: arg > env vars (teammates) > user vars (team-lead) > error
if [[ -z "$TEAM" ]]; then
    if [[ -n "$CLAUDE_CODE_TEAM_NAME" ]]; then
        TEAM="$CLAUDE_CODE_TEAM_NAME"
    else
        TEAM="$(get_current_window_var 'swarm_team')"
    fi
fi

if [[ -z "$TEAM" ]]; then
    echo "Error: Team name required"
    echo "Usage: /swarm-reconcile [team_name] [--auto-fix]"
    exit 1
fi

CONFIG_FILE="${TEAMS_DIR}/${TEAM}/config.json"

if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "Error: Team '${TEAM}' not found"
    exit 1
fi

echo "Reconciling team '${TEAM}'..."
echo "Multiplexer: ${SWARM_MULTIPLEXER}"
echo "Mode: $([ "$AUTO_FIX" == "true" ] && echo "auto-fix" || echo "report-only")"
echo ""

# Arrays to track issues
declare -a DEAD_BUT_ACTIVE=()
declare -a ALIVE_BUT_OFFLINE=()
declare -a ZOMBIE_SESSIONS=()

# Build list of sessions from config (use tab separator for safer parsing)
declare -A CONFIG_MEMBERS
while IFS=$'\t' read -r NAME STATUS; do
    [[ -z "$NAME" ]] && continue
    CONFIG_MEMBERS["$NAME"]="$STATUS"
done < <(jq -r '.members[] | "\(.name)\t\(.status)"' "$CONFIG_FILE")

# Check each config member against reality
echo "=== Config vs Reality ==="
for NAME in "${!CONFIG_MEMBERS[@]}"; do
    CONFIG_STATUS="${CONFIG_MEMBERS[$NAME]}"
    SESSION_ALIVE=false

    # Check if session is running
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

    # Detect mismatches
    if [[ "$SESSION_ALIVE" == "true" && "$CONFIG_STATUS" == "offline" ]]; then
        ALIVE_BUT_OFFLINE+=("$NAME")
        echo "⚠ ${NAME}: alive but config says offline"
    elif [[ "$SESSION_ALIVE" == "false" && "$CONFIG_STATUS" == "active" ]]; then
        DEAD_BUT_ACTIVE+=("$NAME")
        echo "⚠ ${NAME}: dead but config says active"
    else
        echo "✓ ${NAME}: status matches (${CONFIG_STATUS})"
    fi
done

# Check for zombie sessions (running but not in config)
echo ""
echo "=== Zombie Sessions ==="
case "$SWARM_MULTIPLEXER" in
    kitty)
        while IFS= read -r AGENT_NAME; do
            [[ -z "$AGENT_NAME" ]] && continue
            if [[ -z "${CONFIG_MEMBERS[$AGENT_NAME]}" ]]; then
                ZOMBIE_SESSIONS+=("$AGENT_NAME")
                echo "⚠ ${AGENT_NAME}: session exists but not in config"
            fi
        done < <(kitten_cmd ls 2>/dev/null | jq -r --arg team "$TEAM" '.[].tabs[].windows[] | select(.user_vars.swarm_team == $team) | .user_vars.swarm_agent' 2>/dev/null)
        ;;
    tmux)
        while IFS= read -r SESSION_NAME; do
            [[ -z "$SESSION_NAME" ]] && continue
            # Extract agent name from session name
            AGENT_NAME="${SESSION_NAME#swarm-${TEAM}-}"
            if [[ -z "${CONFIG_MEMBERS[$AGENT_NAME]}" ]]; then
                ZOMBIE_SESSIONS+=("$AGENT_NAME")
                echo "⚠ ${AGENT_NAME}: session exists but not in config"
            fi
        done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep "^swarm-${TEAM}-" || true)
        ;;
esac

if [[ ${#ZOMBIE_SESSIONS[@]} -eq 0 ]]; then
    echo "(no zombie sessions)"
fi

# Summary
echo ""
echo "=== Summary ==="
echo "Dead but marked active: ${#DEAD_BUT_ACTIVE[@]}"
echo "Alive but marked offline: ${#ALIVE_BUT_OFFLINE[@]}"
echo "Zombie sessions: ${#ZOMBIE_SESSIONS[@]}"

# Auto-fix or suggest fixes
if [[ ${#DEAD_BUT_ACTIVE[@]} -gt 0 || ${#ALIVE_BUT_OFFLINE[@]} -gt 0 ]]; then
    echo ""
    if [[ "$AUTO_FIX" == "true" ]]; then
        echo "=== Auto-Fixing ==="
        for NAME in "${DEAD_BUT_ACTIVE[@]}"; do
            update_member_status "$TEAM" "$NAME" "offline"
            echo "✓ Marked ${NAME} as offline"
        done
        for NAME in "${ALIVE_BUT_OFFLINE[@]}"; do
            update_member_status "$TEAM" "$NAME" "active"
            echo "✓ Marked ${NAME} as active"
        done
    else
        echo "=== Suggested Fixes ==="
        for NAME in "${DEAD_BUT_ACTIVE[@]}"; do
            echo "  - ${NAME}: Run '/claude-swarm:swarm-spawn ${NAME}' to respawn"
            echo "           OR update_member_status '$TEAM' '$NAME' 'offline'"
        done
        for NAME in "${ALIVE_BUT_OFFLINE[@]}"; do
            echo "  - ${NAME}: update_member_status '$TEAM' '$NAME' 'active'"
        done
        echo ""
        echo "Run with --auto-fix to automatically update statuses"
    fi
fi

if [[ ${#ZOMBIE_SESSIONS[@]} -gt 0 ]]; then
    echo ""
    echo "=== Zombie Session Cleanup ==="
    for NAME in "${ZOMBIE_SESSIONS[@]}"; do
        echo "  - ${NAME}: kill_swarm_session '$TEAM' '$NAME'"
    done
fi
SCRIPT_EOF
```

After running, report:

1. Number of mismatches found
2. Actions taken (if --auto-fix) or suggested fixes
3. Whether the team is now in a consistent state
