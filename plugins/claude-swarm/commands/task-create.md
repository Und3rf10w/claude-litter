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

SUBJECT="$1"
DESCRIPTION="${2:-$1}"

if [[ -z "$SUBJECT" ]]; then
    echo "Error: Task subject required"
    echo "Usage: /task-create <subject> [description]"
    exit 1
fi

TASK_ID=$(create_task "$TEAM" "$SUBJECT" "$DESCRIPTION")

echo "Created task #${TASK_ID}"
SCRIPT_EOF
```

After creating, report:

1. Task ID assigned
2. Initial status is `pending`
3. Suggest assigning with `/task-update <id> --assign <teammate>`
4. Or setting dependencies with `/task-update <id> --blocked-by <other-id>`
5. Update status as work progresses: `pending` → `in_progress` → `in_review` → `completed`
