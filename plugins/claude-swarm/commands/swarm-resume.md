---
description: Resume a suspended swarm team, respawning offline teammates with their task context
argument-hint: <team_name>
---

# Resume Swarm Team

Resume the suspended team `$1`, respawning any offline teammates.

## What Happens

1. Team status changes from "suspended" to "active"
2. You (team-lead) are marked as active
3. Each offline teammate is respawned with:
   - Their original model (haiku/sonnet/opus)
   - Context about their assigned tasks
   - Notice of unread messages
4. Teammates resume work from where they left off

## Instructions

Execute the following script using bash explicitly:

```bash
bash << 'SCRIPT_EOF'
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null

TEAM_NAME="$1"
resume_team "$TEAM_NAME"

# Set user vars on current window so team-lead can use commands
if [[ "$SWARM_MULTIPLEXER" == "kitty" ]]; then
    # Determine current agent (either env var or default to team-lead)
    CURRENT_AGENT="${CLAUDE_CODE_AGENT_NAME:-team-lead}"
    if [[ "$CURRENT_AGENT" == "team-lead" ]]; then
        set_current_window_vars "swarm_team=${TEAM_NAME}" "swarm_agent=team-lead"
    fi
fi
SCRIPT_EOF
```

## Notes

- Only suspended teams can be resumed
- Team data (tasks, messages, config) persists between sessions
- Teammates receive context injection to help them catch up
- If a teammate window already exists, it won't be duplicated

## See Also

- `/claude-swarm:swarm-status $1` - Check team status
- `/claude-swarm:swarm-cleanup $1` - Suspend team (soft cleanup)
- `/claude-swarm:swarm-cleanup $1 --force` - Delete team permanently
