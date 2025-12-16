---
description: List all tasks for a team with their status and assignments
---

# List Tasks

List all tasks for the current team.

## Instructions

Run the following bash command:

```bash
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh"

TEAM="${CLAUDE_CODE_TEAM_NAME:-default}"

list_tasks "$TEAM"
```

Present the task list clearly, organizing by:

1. Open unassigned tasks (available for claiming)
2. Open assigned tasks (in progress)
3. Blocked tasks (waiting on dependencies)
4. Resolved tasks (completed)
