---
description: Create a new swarm team with directories, config, and initialize the current session as team-lead
argument-hint: <team_name> [description]
---

# Create Swarm Team

Create a new team called `$1`.

## Arguments

- `$1` - Team name (required)
- `$2` - Team description (optional)

## Instructions

Run the following bash commands to create the team:

```bash
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null

TEAM_NAME="$1"
DESCRIPTION="$2"

create_team "$TEAM_NAME" "$DESCRIPTION"

# Set user vars on current window so team-lead can check inbox
if [[ "$SWARM_MULTIPLEXER" == "kitty" ]]; then
    set_current_window_vars "swarm_team=${TEAM_NAME}" "swarm_agent=team-lead"
fi
```

After running, report:

1. Team name and location
2. That the current session is now team-lead
3. Next steps: create tasks with `/task-create` and spawn teammates with `/swarm-spawn`
