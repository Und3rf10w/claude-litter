#!/bin/bash
# SessionStart hook: Auto-deliver unread messages and task reminders
# Triggered when a Claude Code session starts

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/swarm-utils.sh"

# Only run if we're part of a team
TEAM_NAME="${CLAUDE_CODE_TEAM_NAME:-}"
AGENT_NAME="${CLAUDE_CODE_AGENT_NAME:-}"

if [[ -z "$TEAM_NAME" ]]; then
    exit 0
fi

# Build output message
output=""

# Check for unread messages
inbox_file="${TEAMS_DIR}/${TEAM_NAME}/inboxes/${AGENT_NAME:-team-lead}.json"

if [[ -f "$inbox_file" ]]; then
    unread=$(jq '[.[] | select(.read == false)]' "$inbox_file" 2>/dev/null)
    unread_count=$(echo "$unread" | jq 'length' 2>/dev/null || echo "0")

    if [[ "$unread_count" -gt 0 ]]; then
        output+="## Unread Messages (${unread_count})\n\n"
        output+=$(format_messages_xml "$unread")
        output+="\n\n"

        # Mark as read
        mark_messages_read "$TEAM_NAME" "${AGENT_NAME:-team-lead}"
    fi
fi

# Check for assigned tasks (for non-team-lead)
if [[ -n "$AGENT_NAME" ]] && [[ "$AGENT_NAME" != "team-lead" ]]; then
    tasks_dir="${TASKS_DIR}/${TEAM_NAME}"

    if [[ -d "$tasks_dir" ]]; then
        assigned_tasks=""
        for task_file in "$tasks_dir"/*.json 2>/dev/null; do
            if [[ -f "$task_file" ]]; then
                owner=$(jq -r '.owner // ""' "$task_file")
                status=$(jq -r '.status' "$task_file")

                if [[ "$owner" == "$AGENT_NAME" ]] && [[ "$status" == "open" ]]; then
                    id=$(jq -r '.id' "$task_file")
                    subject=$(jq -r '.subject' "$task_file")
                    assigned_tasks+="- Task #${id}: ${subject}\n"
                fi
            fi
        done

        if [[ -n "$assigned_tasks" ]]; then
            output+="## Your Assigned Tasks\n\n"
            output+="${assigned_tasks}\n"
            output+="Use \`/task-list\` to see full details.\n\n"
        fi
    fi
fi

# Output if there's anything to show
if [[ -n "$output" ]]; then
    echo -e "<system-reminder>\n# Team Updates for ${AGENT_NAME:-team-lead}\n\n${output}</system-reminder>"
fi

exit 0
