#!/bin/bash
# Notification hook: Update heartbeat (lastSeen) for active team members
# Triggered on any notification event to maintain liveness tracking

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/swarm-utils.sh"

# Only run if we're part of a team
TEAM_NAME="${CLAUDE_CODE_TEAM_NAME:-}"
AGENT_NAME="${CLAUDE_CODE_AGENT_NAME:-}"

if [[ -z "$TEAM_NAME" ]]; then
    exit 0
fi

# Update lastSeen timestamp silently (this happens frequently)
# The update_member_status function already updates lastSeen
update_member_status "$TEAM_NAME" "${AGENT_NAME:-team-lead}" "active" 2>/dev/null

exit 0
