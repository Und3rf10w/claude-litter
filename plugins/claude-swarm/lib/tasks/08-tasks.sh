#!/bin/bash
# Module: 08-tasks.sh
# Description: Task management CRUD operations
# Dependencies: Various (see implementation plan)
# Exports: create_task, get_task, update_task, list_tasks, assign_task

[[ -n "${SWARM_08_TASKS_LOADED}" ]] && return 0
SWARM_08_TASKS_LOADED=1

if [[ -z "$TEAMS_DIR" ]]; then
    echo "Error: 00-globals.sh must be sourced first" >&2
    return 1
fi

create_task() {
    local team_name="${1:-${CLAUDE_CODE_TEAM_NAME:-default}}"
    local subject="$2"
    local description="$3"
    local tasks_dir="${TASKS_DIR}/${team_name}"

    if ! command mkdir -p "$tasks_dir"; then
        echo -e "${RED}Failed to create tasks directory${NC}" >&2
        return 1
    fi

    # Acquire lock to prevent race condition in ID generation
    local lock_file="${tasks_dir}/.tasks.lock"
    if ! acquire_file_lock "$lock_file"; then
        echo -e "${RED}Failed to acquire lock for task creation${NC}" >&2
        return 1
    fi

    # Find next task ID
    # Use find instead of glob to avoid zsh "no matches found" error
    local max_id=0
    while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        local id=$(basename "$f" .json)
        if [[ "$id" =~ ^[0-9]+$ ]] && [[ $id -gt $max_id ]]; then
            max_id=$id
        fi
    done < <(find "$tasks_dir" -maxdepth 1 -name "*.json" -type f 2>/dev/null)
    local new_id=$((max_id + 1))

    local task_file="${tasks_dir}/${new_id}.json"
    local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    # Use jq to properly escape values and prevent JSON injection
    if ! jq -n \
        --arg id "$new_id" \
        --arg subject "$subject" \
        --arg description "$description" \
        --arg timestamp "$timestamp" \
        '{
            id: $id,
            subject: $subject,
            description: $description,
            status: "pending",
            owner: null,
            references: [],
            blocks: [],
            blockedBy: [],
            comments: [],
            createdAt: $timestamp
        }' > "$task_file"; then
        release_file_lock
        echo -e "${RED}Failed to create task file${NC}" >&2
        return 1
    fi

    # Release lock after task file is written
    release_file_lock

    echo -e "${GREEN}Created task #${new_id}: ${subject}${NC}"

    # Trigger webhook notification
    webhook_task_created "$team_name" "$new_id" "$subject" 2>/dev/null || true

    echo "$new_id"
}

get_task() {
    local team_name="${1:-${CLAUDE_CODE_TEAM_NAME:-default}}"
    local task_id="$2"

    # Validate task ID (must be numeric to prevent path traversal)
    if [[ ! "$task_id" =~ ^[0-9]+$ ]]; then
        echo -e "${RED}Error: Invalid task ID '${task_id}' (must be numeric)${NC}" >&2
        return 1
    fi

    local task_file="${TASKS_DIR}/${team_name}/${task_id}.json"

    if [[ -f "$task_file" ]]; then
        command cat "$task_file"
    else
        echo "null"
    fi
}

# Helper function to detect direct dependency cycles
# Returns 0 if cycle detected, 1 if no cycle
check_direct_cycle() {
    local team_name="$1"
    local task_id="$2"
    local target_id="$3"
    local target_file="${TASKS_DIR}/${team_name}/${target_id}.json"

    if [[ -f "$target_file" ]]; then
        if jq -e --arg id "$task_id" '.blockedBy | index($id) != null' "$target_file" &>/dev/null; then
            return 0  # Cycle detected
        fi
    fi
    return 1  # No cycle
}

update_task() {
    local team_name="${1:-${CLAUDE_CODE_TEAM_NAME:-default}}"
    local task_id="$2"

    # Validate task ID (must be numeric to prevent path traversal)
    if [[ ! "$task_id" =~ ^[0-9]+$ ]]; then
        echo -e "${RED}Error: Invalid task ID '${task_id}' (must be numeric)${NC}" >&2
        return 1
    fi

    local task_file="${TASKS_DIR}/${team_name}/${task_id}.json"
    shift 2

    if [[ ! -f "$task_file" ]]; then
        echo -e "${RED}Task #${task_id} not found${NC}"
        return 1
    fi

    # Track if task is being marked completed for webhook
    local task_completed=false
    local task_owner=""
    local new_status=""

    # Acquire lock for concurrent access protection
    if ! acquire_file_lock "$task_file"; then
        echo -e "${RED}Failed to acquire lock for task #${task_id}${NC}" >&2
        return 1
    fi

    local tmp_file=$(mktemp)
    if [[ -z "$tmp_file" ]]; then
        release_file_lock
        echo -e "${RED}Failed to create temp file${NC}" >&2
        return 1
    fi

    # Add trap to ensure cleanup on interrupt/error
    trap "rm -f '$tmp_file' '${tmp_file}.new'" INT TERM

    command cp "$task_file" "$tmp_file"

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --status)
                new_status="$2"
                if [[ "$new_status" == "completed" ]]; then
                    task_completed=true
                    # Get current owner before status change
                    task_owner=$(jq -r '.owner // "unknown"' "$tmp_file")
                fi
                if ! jq --arg val "$2" '.status = $val' "$tmp_file" > "${tmp_file}.new"; then
                    trap - INT TERM
                    command rm -f "$tmp_file" "${tmp_file}.new"
                    release_file_lock
                    echo -e "${RED}Failed to update task status${NC}" >&2
                    return 1
                fi
                command mv "${tmp_file}.new" "$tmp_file"
                shift 2
                ;;
            --owner|--assign)
                if ! jq --arg val "$2" '.owner = $val' "$tmp_file" > "${tmp_file}.new"; then
                    trap - INT TERM
                    command rm -f "$tmp_file" "${tmp_file}.new"
                    release_file_lock
                    echo -e "${RED}Failed to update task owner${NC}" >&2
                    return 1
                fi
                command mv "${tmp_file}.new" "$tmp_file"
                shift 2
                ;;
            --comment)
                local author="${CLAUDE_CODE_AGENT_NAME:-${CLAUDE_CODE_AGENT_ID:-unknown}}"
                local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
                if ! jq --arg author "$author" --arg content "$2" --arg ts "$timestamp" \
                   '.comments += [{"author": $author, "text": $content, "timestamp": $ts}]' \
                   "$tmp_file" > "${tmp_file}.new"; then
                    trap - INT TERM
                    command rm -f "$tmp_file" "${tmp_file}.new"
                    release_file_lock
                    echo -e "${RED}Failed to add task comment${NC}" >&2
                    return 1
                fi
                command mv "${tmp_file}.new" "$tmp_file"
                shift 2
                ;;
            --blocked-by)
                local target_id="$2"

                # Validate target task ID (must be numeric to prevent path traversal)
                if [[ ! "$target_id" =~ ^[0-9]+$ ]]; then
                    trap - INT TERM
                    command rm -f "$tmp_file" "${tmp_file}.new"
                    release_file_lock
                    echo -e "${RED}Error: Invalid target task ID '${target_id}' (must be numeric)${NC}" >&2
                    return 1
                fi

                # Check for self-blocking
                if [[ "$task_id" == "$target_id" ]]; then
                    trap - INT TERM
                    command rm -f "$tmp_file" "${tmp_file}.new"
                    release_file_lock
                    echo -e "${RED}Error: Task #${task_id} cannot be blocked by itself${NC}" >&2
                    return 1
                fi

                # Check for direct cycle
                if check_direct_cycle "$team_name" "$task_id" "$target_id"; then
                    trap - INT TERM
                    command rm -f "$tmp_file" "${tmp_file}.new"
                    release_file_lock
                    echo -e "${RED}Error: Adding dependency would create a cycle (task #${target_id} is already blocked by task #${task_id})${NC}" >&2
                    return 1
                fi

                # Add dependency and remove duplicates
                if ! jq --arg val "$target_id" '.blockedBy += [$val] | .blockedBy |= unique' "$tmp_file" > "${tmp_file}.new"; then
                    trap - INT TERM
                    command rm -f "$tmp_file" "${tmp_file}.new"
                    release_file_lock
                    echo -e "${RED}Failed to update task dependencies${NC}" >&2
                    return 1
                fi
                command mv "${tmp_file}.new" "$tmp_file"
                shift 2
                ;;
            *)
                shift
                ;;
        esac
    done

    # Clear trap before final operations
    trap - INT TERM

    if command mv "$tmp_file" "$task_file"; then
        release_file_lock
        echo -e "${GREEN}Updated task #${task_id}${NC}"

        # Trigger webhook notification if task was completed
        if [[ "$task_completed" == "true" ]]; then
            webhook_task_completed "$team_name" "$task_id" "$task_owner" 2>/dev/null || true
        fi
    else
        command rm -f "$tmp_file"
        release_file_lock
        echo -e "${RED}Failed to update task #${task_id}${NC}" >&2
        return 1
    fi
}

list_tasks() {
    local team_name="${1:-${CLAUDE_CODE_TEAM_NAME:-default}}"
    shift

    # Parse filter options
    local filter_status=""
    local filter_owner=""
    local filter_blocked="false"

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --status)
                filter_status="$2"
                shift 2
                ;;
            --owner|--assignee)
                filter_owner="$2"
                shift 2
                ;;
            --blocked)
                filter_blocked="true"
                shift
                ;;
            *)
                shift
                ;;
        esac
    done

    local tasks_dir="${TASKS_DIR}/${team_name}"

    if [[ ! -d "$tasks_dir" ]]; then
        echo "No tasks found for team '${team_name}'"
        return
    fi

    # Build filter description
    local filter_desc=""
    if [[ -n "$filter_status" ]]; then
        filter_desc="${filter_desc} status=${filter_status}"
    fi
    if [[ -n "$filter_owner" ]]; then
        filter_desc="${filter_desc} owner=${filter_owner}"
    fi
    if [[ "$filter_blocked" == "true" ]]; then
        filter_desc="${filter_desc} blocked=true"
    fi

    if [[ -n "$filter_desc" ]]; then
        echo "Tasks for team '${team_name}' (filters:${filter_desc}):"
    else
        echo "Tasks for team '${team_name}':"
    fi
    echo "--------------------------------"

    # Use find instead of glob to avoid zsh "no matches found" error
    local task_count=0
    while IFS= read -r task_file; do
        [[ -z "$task_file" ]] && continue

        # Read task data once
        local task_json=$(cat "$task_file")
        local id=$(echo "$task_json" | jq -r '.id')
        local subject=$(echo "$task_json" | jq -r '.subject')
        local task_status=$(echo "$task_json" | jq -r '.status')
        local owner=$(echo "$task_json" | jq -r '.owner // "unassigned"')
        local blocked_by_array=$(echo "$task_json" | jq -r '.blockedBy')
        local blocked_by=$(echo "$blocked_by_array" | jq -r 'if length > 0 then " [blocked by #" + (. | join(", #")) + "]" else "" end')

        # Apply filters
        if [[ -n "$filter_status" ]] && [[ "$task_status" != "$filter_status" ]]; then
            continue
        fi

        if [[ -n "$filter_owner" ]] && [[ "$owner" != "$filter_owner" ]]; then
            continue
        fi

        if [[ "$filter_blocked" == "true" ]]; then
            local has_blockers=$(echo "$blocked_by_array" | jq 'length > 0')
            if [[ "$has_blockers" != "true" ]]; then
                continue
            fi
        fi

        ((task_count++))

        local status_color="${NC}"
        if [[ "$task_status" == "pending" ]]; then
            status_color="${NC}"  # white/default
        elif [[ "$task_status" == "in_progress" || "$task_status" == "in-progress" ]]; then
            status_color="${BLUE}"
        elif [[ "$task_status" == "blocked" ]]; then
            status_color="${RED}"
        elif [[ "$task_status" == "in_review" || "$task_status" == "in-review" ]]; then
            status_color="${YELLOW}"
        elif [[ "$task_status" == "completed" ]]; then
            status_color="${GREEN}"
        fi

        echo -e "#${id} ${status_color}[${task_status}]${NC} ${subject} (${owner})${blocked_by}"
    done < <(find "$tasks_dir" -maxdepth 1 -name "*.json" -type f 2>/dev/null | sort)

    if [[ $task_count -eq 0 ]]; then
        if [[ -n "$filter_desc" ]]; then
            echo "  (no tasks match filters)"
        else
            echo "  (no tasks yet)"
        fi
    fi
}

assign_task() {
    local team_name="${1:-${CLAUDE_CODE_TEAM_NAME:-default}}"
    local task_id="$2"
    local assignee="$3"

    update_task "$team_name" "$task_id" --owner "$assignee"

    # Notify assignee
    send_message "$team_name" "$assignee" "You have been assigned task #${task_id}. Use TaskGet to see full details."
}


# Export public API
export -f create_task get_task update_task list_tasks assign_task
