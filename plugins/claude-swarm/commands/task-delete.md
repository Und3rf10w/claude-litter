---
description: Delete a task from the team task list
argument-hint: <task_id>
---

# Delete Task

Delete a task from the team task list.

## Arguments

- `$1` - Task ID (required)

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

TASK_ID="$1"

if [[ -z "$TASK_ID" ]]; then
    echo "Error: Task ID required"
    echo "Usage: /task-delete <task_id>"
    exit 1
fi

delete_task "$TEAM" "$TASK_ID"
SCRIPT_EOF
```

After deleting, report:

1. Confirmation that the task was deleted
2. Suggest using `/task-list` to view remaining tasks
3. Remind that deleted tasks cannot be recovered
