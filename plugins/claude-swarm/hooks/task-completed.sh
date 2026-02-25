#!/bin/bash
# TaskCompleted hook: Validate task completion and notify dependencies
# Triggered when a task is being marked as 'completed' via TaskUpdate
#
# Stdin: {hook_event_name, task_id, task_subject, task_description, teammate_name, team_name, session_id, transcript_path, cwd}
# Exit 0: task completion proceeds (stdout not shown)
# Exit 2: stderr shown to model, prevents task completion

# Read hook input from stdin
HOOK_INPUT=$(cat)

TEAM_NAME=$(echo "$HOOK_INPUT" | jq -r '.team_name // ""' 2>/dev/null)
TASK_ID=$(echo "$HOOK_INPUT" | jq -r '.task_id // ""' 2>/dev/null)
TASK_SUBJECT=$(echo "$HOOK_INPUT" | jq -r '.task_subject // ""' 2>/dev/null)
TEAMMATE_NAME=$(echo "$HOOK_INPUT" | jq -r '.teammate_name // ""' 2>/dev/null)

# If we can't determine context, allow completion
[[ -z "$TEAM_NAME" ]] && exit 0
[[ -z "$TASK_ID" ]] && exit 0

TEAMS_DIR="${HOME}/.claude/teams"
TASKS_DIR="${HOME}/.claude/tasks"
INBOX_DIR="${TEAMS_DIR}/${TEAM_NAME}/inboxes"

# Notify team-lead about task completion
if [[ -d "$INBOX_DIR" ]]; then
    TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    MSG_ID=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "msg-$(date +%s)")
    INBOX_FILE="${INBOX_DIR}/team-lead.json"

    msg_content="Task #${TASK_ID} completed: ${TASK_SUBJECT}"
    if [[ -n "$TEAMMATE_NAME" ]]; then
        msg_content="${TEAMMATE_NAME} completed task #${TASK_ID}: ${TASK_SUBJECT}"
    fi

    if [[ -f "$INBOX_FILE" ]]; then
        TMP=$(mktemp)
        if jq --arg from "${TEAMMATE_NAME:-system}" --arg ts "$TIMESTAMP" --arg id "$MSG_ID" --arg content "$msg_content" \
           '. += [{"id": $id, "from": $from, "content": $content, "timestamp": $ts, "read": false}]' \
           "$INBOX_FILE" > "$TMP" 2>/dev/null; then
            /bin/mv -f "$TMP" "$INBOX_FILE" 2>/dev/null || rm -f "$TMP"
        else
            rm -f "$TMP"
        fi
    fi
fi

# Check for tasks that were blocked by this completed task
# and notify their owners
tasks_dir="${TASKS_DIR}/${TEAM_NAME}"
if [[ -d "$tasks_dir" ]]; then
    task_files=("$tasks_dir"/*.json)
    if [[ -e "${task_files[0]}" ]]; then
        for task_file in "${task_files[@]}"; do
            if [[ -f "$task_file" ]]; then
                # Check if this task has a blockedBy reference to the completed task
                blocked_by=$(jq -r ".blockedBy // [] | .[] | select(. == \"$TASK_ID\")" "$task_file" 2>/dev/null)
                if [[ -n "$blocked_by" ]]; then
                    blocked_id=$(jq -r '.id // ""' "$task_file" 2>/dev/null)
                    blocked_owner=$(jq -r '.owner // ""' "$task_file" 2>/dev/null)
                    blocked_subject=$(jq -r '.subject // ""' "$task_file" 2>/dev/null)

                    # Notify the blocked task's owner if they have an inbox
                    if [[ -n "$blocked_owner" ]] && [[ -f "${INBOX_DIR}/${blocked_owner}.json" ]]; then
                        TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
                        MSG_ID=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "msg-$(date +%s)")
                        TMP=$(mktemp)
                        if jq --arg from "system" --arg ts "$TIMESTAMP" --arg id "$MSG_ID" \
                           --arg content "Task #${TASK_ID} (${TASK_SUBJECT}) is now completed. Your task #${blocked_id} (${blocked_subject}) may be unblocked." \
                           '. += [{"id": $id, "from": $from, "content": $content, "timestamp": $ts, "read": false}]' \
                           "${INBOX_DIR}/${blocked_owner}.json" > "$TMP" 2>/dev/null; then
                            /bin/mv -f "$TMP" "${INBOX_DIR}/${blocked_owner}.json" 2>/dev/null || rm -f "$TMP"
                        else
                            rm -f "$TMP"
                        fi
                    fi
                fi
            fi
        done
    fi
fi

# Allow task completion
exit 0
