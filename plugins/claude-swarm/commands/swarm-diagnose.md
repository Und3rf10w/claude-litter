---
description: Diagnose and troubleshoot swarm team health - check socket health, config validity, status consistency, and detect issues
argument-hint: <team_name>
---

# Swarm Diagnostics

Run comprehensive diagnostics on a swarm team to identify configuration issues, crashed agents, stale heartbeats, and socket problems.

## Arguments

- `$1` - Team name (required)

## Instructions

Execute the following script using bash explicitly:

```bash
bash << 'SCRIPT_EOF'
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null

if [[ -z "$1" ]]; then
    echo "Error: Team name required"
    echo "Usage: /swarm-diagnose <team_name>"
    exit 1
fi

TEAM_NAME="$1"
CONFIG_FILE="${TEAMS_DIR}/${TEAM_NAME}/config.json"

echo "=== Swarm Diagnostics for '${TEAM_NAME}' ==="
echo ""

# 1. Check if team exists
echo "## 1. Team Configuration"
if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "❌ ERROR: Team '${TEAM_NAME}' not found"
    echo "   Config file missing: ${CONFIG_FILE}"
    exit 1
else
    echo "✓ Team config found"

    # Validate JSON
    if ! jq empty "$CONFIG_FILE" 2>/dev/null; then
        echo "❌ ERROR: Invalid JSON in config file"
        exit 1
    else
        echo "✓ Config JSON is valid"
    fi

    # Show team status
    TEAM_STATUS=$(jq -r '.status // "unknown"' "$CONFIG_FILE")
    echo "  Status: ${TEAM_STATUS}"

    # Count members
    MEMBER_COUNT=$(jq '.members | length' "$CONFIG_FILE")
    echo "  Members: ${MEMBER_COUNT}"
fi

echo ""

# 2. Check socket health (for kitty)
echo "## 2. Multiplexer Socket Health"
if [[ "$SWARM_MULTIPLEXER" == "kitty" ]]; then
    SOCKET=$(find_kitty_socket)
    if [[ -n "$SOCKET" ]]; then
        echo "✓ Kitty socket found: ${SOCKET}"

        # Validate socket health
        if validate_kitty_socket "$SOCKET"; then
            echo "✓ Socket is healthy and responsive"
        else
            echo "❌ Socket found but not responding"
        fi
    else
        echo "❌ ERROR: No kitty socket found"
        echo "   Add to your kitty.conf:"
        echo "   listen_on unix:/tmp/kitty-\$USER"
        echo "   (Note: kitty appends -PID, so socket becomes /tmp/kitty-\$USER-12345)"
        echo "   Check with: ls -la /tmp/kitty-\$USER*"
    fi
elif [[ "$SWARM_MULTIPLEXER" == "tmux" ]]; then
    if command -v tmux &>/dev/null; then
        echo "✓ tmux is available"
        if tmux list-sessions &>/dev/null; then
            SESSION_COUNT=$(tmux list-sessions 2>/dev/null | wc -l)
            echo "  Active sessions: ${SESSION_COUNT}"
        else
            echo "  No active tmux sessions"
        fi
    else
        echo "❌ ERROR: tmux not found in PATH"
    fi
else
    echo "❌ No multiplexer detected"
fi

echo ""

# 3. Detect crashed agents
echo "## 3. Crashed Agent Detection"
CRASHED=$(detect_crashed_agents "$TEAM_NAME")
CRASHED_COUNT=$(echo "$CRASHED" | jq 'length')

if [[ "$CRASHED_COUNT" -eq 0 ]]; then
    echo "✓ No crashed agents detected"
else
    echo "⚠️  Found ${CRASHED_COUNT} crashed agent(s):"
    echo "$CRASHED" | jq -r '.[] | "   - \(.)"'
    echo ""
    echo "   These agents are marked active in config but have no live session."
    echo "   Run /swarm-reconcile to update their status."
fi

echo ""

# 4. Check heartbeats
echo "## 4. Heartbeat Status"
STALE=$(check_heartbeats "$TEAM_NAME" 300)
STALE_COUNT=$(echo "$STALE" | jq 'length')

if [[ "$STALE_COUNT" -eq 0 ]]; then
    echo "✓ All active agents have recent heartbeats"
else
    echo "⚠️  Found ${STALE_COUNT} stale agent(s) (>5 min since last activity):"
    echo "$STALE" | jq -r '.[] | "   - \(.name): \(.staleSec)s stale"'
fi

echo ""

# 5. Directory structure check
echo "## 5. Directory Structure"
TEAM_DIR="${TEAMS_DIR}/${TEAM_NAME}"
TEAM_TASKS_DIR="${TASKS_DIR}/${TEAM_NAME}"

if [[ -d "$TEAM_DIR" ]]; then
    echo "✓ Team directory exists: ${TEAM_DIR}"

    if [[ -d "${TEAM_DIR}/inboxes" ]]; then
        INBOX_COUNT=$(ls -1 "${TEAM_DIR}/inboxes"/*.json 2>/dev/null | wc -l)
        echo "✓ Inboxes directory exists (${INBOX_COUNT} inbox files)"
    else
        echo "❌ Missing inboxes directory"
    fi
else
    echo "❌ Team directory missing"
fi

if [[ -d "$TEAM_TASKS_DIR" ]]; then
    TASK_COUNT=$(ls -1 "${TEAM_TASKS_DIR}"/*.json 2>/dev/null | wc -l)
    echo "✓ Tasks directory exists (${TASK_COUNT} task files)"
else
    echo "⚠️  No tasks directory (will be created when first task is added)"
fi

echo ""

# 6. Member status consistency
echo "## 6. Status Consistency"
echo "Checking if config status matches live sessions..."
reconcile_team_status "$TEAM_NAME" "true"

echo ""
echo "=== Diagnostics Complete ==="
echo ""
echo "Recommendations:"
if [[ "$CRASHED_COUNT" -gt 0 ]]; then
    echo "- Run: /swarm-reconcile ${TEAM_NAME}"
fi
if [[ "$STALE_COUNT" -gt 0 ]]; then
    echo "- Consider checking stale agents - they may be idle or hung"
fi
echo "- Use /swarm-status ${TEAM_NAME} for a quick overview"
echo "- Use /swarm-resume ${TEAM_NAME} to respawn offline teammates"
SCRIPT_EOF
```

Present the diagnostic results clearly, highlighting any errors or warnings that need attention. If issues are found, provide specific remediation steps.
