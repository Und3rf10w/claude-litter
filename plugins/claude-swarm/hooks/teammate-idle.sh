#!/bin/bash
# TeammateIdle hook: Detect idle teammates and prompt them with available tasks
# Triggered when a teammate is about to go idle
#
# Stdin: {hook_event_name, teammate_name, team_name, session_id, transcript_path, cwd}
# Exit 0: teammate goes idle (stdout not shown)
# Exit 2: stderr shown to teammate, prevents idle (teammate continues working)

# Read hook input from stdin
HOOK_INPUT=$(cat)

TEAM_NAME=$(echo "$HOOK_INPUT" | jq -r '.team_name // ""' 2>/dev/null)
TEAMMATE_NAME=$(echo "$HOOK_INPUT" | jq -r '.teammate_name // ""' 2>/dev/null)

# If we can't determine team context, allow idle
[[ -z "$TEAM_NAME" ]] && exit 0
[[ -z "$TEAMMATE_NAME" ]] && exit 0

TEAMS_DIR="${HOME}/.claude/teams"
TASKS_DIR="${HOME}/.claude/tasks"

# Check if teammate has assigned incomplete tasks
tasks_dir="${TASKS_DIR}/${TEAM_NAME}"
if [[ ! -d "$tasks_dir" ]]; then
    exit 0
fi

incomplete_tasks=""
task_files=("$tasks_dir"/*.json)
if [[ -e "${task_files[0]}" ]]; then
    for task_file in "${task_files[@]}"; do
        if [[ -f "$task_file" ]]; then
            owner=$(jq -r '.owner // ""' "$task_file" 2>/dev/null)
            status=$(jq -r '.status // ""' "$task_file" 2>/dev/null)
            id=$(jq -r '.id // ""' "$task_file" 2>/dev/null)
            subject=$(jq -r '.subject // ""' "$task_file" 2>/dev/null)

            if [[ "$owner" == "$TEAMMATE_NAME" ]] && [[ "$status" == "in-progress" || "$status" == "in_progress" ]]; then
                incomplete_tasks+="- Task #${id} [${status}]: ${subject}\n"
            fi
        fi
    done
fi

# If teammate has incomplete tasks, prevent idle
if [[ -n "$incomplete_tasks" ]]; then
    echo -e "You have incomplete tasks assigned to you:\n${incomplete_tasks}\nPlease complete or update these tasks before going idle. Use /claude-swarm:task-update <id> --status completed to mark done, or --comment to add progress notes." >&2
    exit 2
fi

# Also check for unassigned tasks the teammate could pick up
unassigned_tasks=""
if [[ -e "${task_files[0]}" ]]; then
    for task_file in "${task_files[@]}"; do
        if [[ -f "$task_file" ]]; then
            owner=$(jq -r '.owner // ""' "$task_file" 2>/dev/null)
            status=$(jq -r '.status // ""' "$task_file" 2>/dev/null)
            id=$(jq -r '.id // ""' "$task_file" 2>/dev/null)
            subject=$(jq -r '.subject // ""' "$task_file" 2>/dev/null)

            if [[ -z "$owner" ]] && [[ "$status" == "pending" ]]; then
                unassigned_tasks+="- Task #${id}: ${subject}\n"
            fi
        fi
    done
fi

# If there are unassigned tasks, notify teammate but don't block idle
# (They may have legitimate reasons to stop)
if [[ -n "$unassigned_tasks" ]]; then
    echo -e "Note: There are unassigned tasks available:\n${unassigned_tasks}\nConsider claiming one with /claude-swarm:task-update <id> --assign ${TEAMMATE_NAME}" >&2
    # Exit 0 - allow idle but stderr goes to user as informational
fi

# Notify team-lead that teammate is going idle
INBOX_DIR="${TEAMS_DIR}/${TEAM_NAME}/inboxes"
INBOX_FILE="${INBOX_DIR}/team-lead.json"

if [[ -d "$INBOX_DIR" ]]; then
    TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    MSG_ID=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "msg-$(date +%s)")

    # Append message to team-lead inbox
    if [[ -f "$INBOX_FILE" ]]; then
        TMP=$(mktemp)
        if jq --arg from "$TEAMMATE_NAME" --arg ts "$TIMESTAMP" --arg id "$MSG_ID" \
           '. += [{"id": $id, "from": $from, "content": "\($from) is going idle.", "timestamp": $ts, "read": false}]' \
           "$INBOX_FILE" > "$TMP" 2>/dev/null; then
            /bin/mv -f "$TMP" "$INBOX_FILE" 2>/dev/null || rm -f "$TMP"
        else
            rm -f "$TMP"
        fi
    fi
fi

# Update member status to idle
CONFIG="${TEAMS_DIR}/${TEAM_NAME}/config.json"
if [[ -f "$CONFIG" ]]; then
    LOCK_DIR="${CONFIG}.lock"
    if mkdir "$LOCK_DIR" 2>/dev/null; then
        trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT
        TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        TMP=$(mktemp)
        if [[ -n "$TMP" ]] && jq --arg name "$TEAMMATE_NAME" --arg ts "$TIMESTAMP" \
           '(.members[] | select(.name == $name)) |= (.status = "idle" | .lastSeen = $ts)' \
           "$CONFIG" > "$TMP" 2>/dev/null; then
            /bin/mv -f "$TMP" "$CONFIG" 2>/dev/null || rm -f "$TMP"
        else
            rm -f "$TMP" 2>/dev/null
        fi
    fi
fi

exit 0
