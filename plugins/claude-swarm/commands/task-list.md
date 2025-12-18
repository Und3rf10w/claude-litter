---
description: List all tasks for a team with their status and assignments
---

# List Tasks

List all tasks for the current team.

## Instructions

Execute the following script using bash explicitly:

```bash
bash << 'SCRIPT_EOF'
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null

# Priority: env vars (teammates) > user vars (team-lead) > error
if [[ -n "$CLAUDE_CODE_TEAM_NAME" ]]; then
    TEAM="$CLAUDE_CODE_TEAM_NAME"
else
    TEAM="$(get_current_window_var 'swarm_team')"
    if [[ -z "$TEAM" ]]; then
        echo "Error: Cannot determine team. Run this command from a swarm window or set CLAUDE_CODE_TEAM_NAME" >&2
        exit 1
    fi
fi

list_tasks "$TEAM"
SCRIPT_EOF
```

Present the task list clearly, organizing by:

1. Open unassigned tasks (available for claiming)
2. Open assigned tasks (in progress)
3. Blocked tasks (waiting on dependencies)
4. Resolved tasks (completed)
