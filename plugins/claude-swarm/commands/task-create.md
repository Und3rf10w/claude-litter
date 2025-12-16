---
description: Create a new task in the team task list
argument-hint: <subject> [description]
---

# Create Task

Create a new task for the team.

## Arguments

- `$1` - Task subject/title (required)
- `$2` - Task description (optional, defaults to subject)

## Instructions

Run the following bash command:

```bash
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh"

TEAM="${CLAUDE_CODE_TEAM_NAME:-default}"
SUBJECT="$1"
DESCRIPTION="${2:-$1}"

if [[ -z "$SUBJECT" ]]; then
    echo "Error: Task subject required"
    echo "Usage: /task-create <subject> [description]"
    exit 1
fi

TASK_ID=$(create_task "$TEAM" "$SUBJECT" "$DESCRIPTION")

echo "Created task #${TASK_ID}"
```

After creating, report:
1. Task ID assigned
2. Suggest assigning with `/task-update <id> --assign <teammate>`
3. Or setting dependencies with `/task-update <id> --blocked-by <other-id>`
