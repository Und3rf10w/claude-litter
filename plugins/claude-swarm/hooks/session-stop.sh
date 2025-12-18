#!/bin/bash
# Stop hook: Handle session end for team members
# - Marks member as offline
# - If team-lead: suspends team (unless SWARM_KEEP_ALIVE is set)
# - If teammate: notifies team-lead

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/swarm-utils.sh" 1>/dev/null

# Detect team and agent name (env vars for teammates, window vars for team-lead)
if [[ -n "$CLAUDE_CODE_TEAM_NAME" ]]; then
    TEAM_NAME="$CLAUDE_CODE_TEAM_NAME"
else
    TEAM_NAME="$(get_current_window_var 'swarm_team' 2>/dev/null || echo '')"
fi

if [[ -n "$CLAUDE_CODE_AGENT_NAME" ]]; then
    AGENT_NAME="$CLAUDE_CODE_AGENT_NAME"
else
    AGENT_NAME="$(get_current_window_var 'swarm_agent' 2>/dev/null || echo '')"
fi

AGENT_TYPE="${CLAUDE_CODE_AGENT_TYPE:-}"

# Only run if we're part of a team
if [[ -z "$TEAM_NAME" ]] || [[ -z "$AGENT_NAME" ]]; then
    exit 0
fi

# Mark this member as offline
update_member_status "$TEAM_NAME" "$AGENT_NAME" "offline"

# Handle team-lead exit
if [[ "$AGENT_NAME" == "team-lead" ]] || [[ "$AGENT_TYPE" == "team-lead" ]]; then
    if [[ "${SWARM_KEEP_ALIVE:-}" == "true" ]]; then
        # Keep teammates running, just notify them
        if ! broadcast_message "$TEAM_NAME" "Team-lead session ended. Team remains active." "$AGENT_NAME" "false"; then
            echo "$(date -u): Team-lead exit broadcast failed for $TEAM_NAME" >> "${TEAMS_DIR}/${TEAM_NAME}/events.log" 2>/dev/null
        fi
    else
        # Suspend the team (kill all teammates, keep data)
        suspend_team "$TEAM_NAME" "true"
    fi
else
    # Teammate exiting cleanly: notify team-lead
    # Note: Crashed agents (no hook run) are detected by reconcile_team_status in session-start
    send_message "$TEAM_NAME" "team-lead" "${AGENT_NAME} session ended cleanly. Check task status for any incomplete work."
fi

exit 0
