---
description: Update a task's status, assignment, or add comments
argument-hint: <task_id> [options...]
---

# Update Task

Update a task's properties.

## Arguments

- `$1` - Task ID (required)
- Remaining arguments are options in `--key value` format

## Options

- `--status <pending|in-progress|blocked|in-review|completed>` - Change task status
- `--assign <name>` - Assign to teammate
- `--comment <text>` - Add a comment
- `--blocked-by <id>` - Add blocking dependency

## Instructions

Parse the arguments and build the update command:

```bash
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh"

TEAM="${CLAUDE_CODE_TEAM_NAME:-default}"
TASK_ID="$1"

if [[ -z "$TASK_ID" ]]; then
    echo "Error: Task ID required"
    echo "Usage: /task-update <task_id> [--status pending|in-progress|blocked|in-review|completed] [--assign name] [--comment text] [--blocked-by id]"
    exit 1
fi

shift  # Remove task_id from arguments

# Pass remaining arguments directly to update_task
update_task "$TEAM" "$TASK_ID" "$@"

# Show updated task
echo ""
echo "Updated task:"
get_task "$TEAM" "$TASK_ID" | jq '.'
```

Report what was changed and the current task state.

## Examples

**Assign to teammate:**

```
/task-update 1 --assign backend-dev
```

**Mark as completed:**

```
/task-update 1 --status completed --comment "Done. See PR #42"
```

**Start working on a task:**

```
/task-update 1 --status in-progress --comment "Starting implementation"
```

**Request review:**

```
/task-update 1 --status in-review --comment "Ready for code review"
```

**Add progress update:**

```
/task-update 1 --comment "50% complete, working on tests"
```

**Add dependency:**

```
/task-update 2 --blocked-by 1
```
