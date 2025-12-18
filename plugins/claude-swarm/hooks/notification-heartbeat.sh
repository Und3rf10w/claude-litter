#!/bin/bash
# Throttled heartbeat - updates lastSeen timestamp for active team members
# Triggered on Notification events, but throttled to avoid excessive I/O
#
# Design: Most invocations exit in <1ms (just a stat check on throttle file)
# Only performs actual update every 60 seconds, which is plenty accurate
# for the 5-minute stale detection threshold in check_heartbeats()

# Priority: env vars (teammates) > user vars (team-lead)
if [[ -n "$CLAUDE_CODE_TEAM_NAME" ]]; then
    TEAM_NAME="$CLAUDE_CODE_TEAM_NAME"
elif [[ -n "$KITTY_PID" ]] && command -v kitten &>/dev/null; then
    # Lightweight user var query (no library sourcing for performance)
    TEAM_NAME=$(kitten @ ls 2>/dev/null | jq -r '.[].tabs[].windows[] | select(.is_focused == true) | .user_vars.swarm_team // ""' 2>/dev/null || echo "")
fi
[[ -z "$TEAM_NAME" ]] && exit 0

if [[ -n "$CLAUDE_CODE_AGENT_NAME" ]]; then
    AGENT_NAME="$CLAUDE_CODE_AGENT_NAME"
elif [[ -n "$KITTY_PID" ]] && command -v kitten &>/dev/null; then
    AGENT_NAME=$(kitten @ ls 2>/dev/null | jq -r '.[].tabs[].windows[] | select(.is_focused == true) | .user_vars.swarm_agent // ""' 2>/dev/null || echo "")
    [[ -z "$AGENT_NAME" ]] && AGENT_NAME="team-lead"
else
    AGENT_NAME="team-lead"
fi
THROTTLE_FILE="/tmp/swarm-heartbeat-${TEAM_NAME}-${AGENT_NAME}"

# Throttle: skip if last update was < 60 seconds ago
if [[ -f "$THROTTLE_FILE" ]]; then
    # macOS uses -f %m, Linux uses -c %Y for mtime in seconds
    LAST_UPDATE=$(stat -f %m "$THROTTLE_FILE" 2>/dev/null || stat -c %Y "$THROTTLE_FILE" 2>/dev/null || echo 0)
    NOW=$(date +%s)
    if (( NOW - LAST_UPDATE < 60 )); then
        exit 0  # Too recent, skip update
    fi
fi

# Update throttle marker (creates file or updates mtime)
touch "$THROTTLE_FILE"

# Lightweight config update (no library sourcing for performance)
CONFIG="${HOME}/.claude/teams/${TEAM_NAME}/config.json"
[[ ! -f "$CONFIG" ]] && exit 0

TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP=$(mktemp)

if [[ -z "$TMP" ]]; then
    exit 0  # Can't create temp file, skip silently
fi

# Update lastSeen for this agent
if jq --arg name "$AGENT_NAME" --arg ts "$TIMESTAMP" \
   '(.members[] | select(.name == $name)) |= (.lastSeen = $ts)' \
   "$CONFIG" > "$TMP" 2>/dev/null; then
    /bin/mv -f "$TMP" "$CONFIG" 2>/dev/null
else
    rm -f "$TMP" 2>/dev/null
fi

exit 0
