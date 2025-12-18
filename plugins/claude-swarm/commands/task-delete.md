---
description: Delete a task using delete_task() from swarm-utils.sh
argument-hint: <task_id>
---

# Delete Task

Delete a task from the team task list.

## Arguments

- `$1` - Task ID (required)

## Instructions

Run the following bash command:

```bash
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh"

# Priority: env vars (teammates) > user vars (team-lead) > defaults
if [[ -n "$CLAUDE_CODE_TEAM_NAME" ]]; then
    TEAM="$CLAUDE_CODE_TEAM_NAME"
else
    TEAM="$(get_current_window_var 'swarm_team')"
    [[ -z "$TEAM" ]] && TEAM="default"
fi

TASK_ID="$1"

if [[ -z "$TASK_ID" ]]; then
    echo "Error: Task ID required"
    echo "Usage: /task-delete <task_id>"
    exit 1
fi

delete_task "$TEAM" "$TASK_ID"
```

After deleting, report:

1. Confirmation that the task was deleted
2. Suggest using `/task-list` to view remaining tasks
3. Remind that deleted tasks cannot be recovered
