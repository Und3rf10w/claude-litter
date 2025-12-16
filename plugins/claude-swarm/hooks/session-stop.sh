#!/bin/bash
# Stop hook: Notify team-lead when a teammate session ends
# Triggered when a Claude Code session is about to end

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/swarm-utils.sh"

# Only run if we're part of a team and NOT the team-lead
TEAM_NAME="${CLAUDE_CODE_TEAM_NAME:-}"
AGENT_NAME="${CLAUDE_CODE_AGENT_NAME:-}"
AGENT_TYPE="${CLAUDE_CODE_AGENT_TYPE:-}"

if [[ -z "$TEAM_NAME" ]] || [[ -z "$AGENT_NAME" ]]; then
    exit 0
fi

# Don't notify if we ARE the team-lead
if [[ "$AGENT_NAME" == "team-lead" ]] || [[ "$AGENT_TYPE" == "team-lead" ]]; then
    exit 0
fi

# Send notification to team-lead
send_message "$TEAM_NAME" "team-lead" "Session ending for ${AGENT_NAME}. Check task status for any incomplete work."

exit 0
