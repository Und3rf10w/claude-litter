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

Run the following bash command to create the team:

```bash
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh"
create_team "$1" "$2"
```

After running, report:
1. Team name and location
2. That the current session is now team-lead
3. Next steps: create tasks with `/task-create` and spawn teammates with `/swarm-spawn`
