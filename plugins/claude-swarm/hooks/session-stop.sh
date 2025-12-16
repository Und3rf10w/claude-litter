#!/bin/bash
# Stop hook: Handle session end for team members
# - Marks member as offline
# - If team-lead: suspends team (unless SWARM_KEEP_ALIVE is set)
# - If teammate: notifies team-lead

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/swarm-utils.sh"

# Only run if we're part of a team
TEAM_NAME="${CLAUDE_CODE_TEAM_NAME:-}"
AGENT_NAME="${CLAUDE_CODE_AGENT_NAME:-}"
AGENT_TYPE="${CLAUDE_CODE_AGENT_TYPE:-}"

if [[ -z "$TEAM_NAME" ]] || [[ -z "$AGENT_NAME" ]]; then
    exit 0
fi

# Mark this member as offline
update_member_status "$TEAM_NAME" "$AGENT_NAME" "offline"

# Handle team-lead exit
if [[ "$AGENT_NAME" == "team-lead" ]] || [[ "$AGENT_TYPE" == "team-lead" ]]; then
    if [[ "${SWARM_KEEP_ALIVE:-}" == "true" ]]; then
        # Keep teammates running, just notify them
        broadcast_message "$TEAM_NAME" "Team-lead session ended. Team remains active. Continue with assigned tasks." "$AGENT_NAME"
    else
        # Suspend the team (kill all teammates, keep data)
        suspend_team "$TEAM_NAME" "true"
    fi
else
    # Teammate exiting: notify team-lead
    send_message "$TEAM_NAME" "team-lead" "Session ending for ${AGENT_NAME}. Check task status for any incomplete work."
fi

exit 0
