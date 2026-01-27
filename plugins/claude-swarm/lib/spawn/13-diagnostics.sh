#!/bin/bash
# Module: 13-diagnostics.sh
# Description: Health checks and diagnostics
# Dependencies: 00-globals, 06-status, 03-multiplexer, 05-team
# Exports: check_heartbeats, detect_crashed_agents, reconcile_team_status, list_teams, delete_task

[[ -n "${SWARM_DIAGNOSTICS_LOADED}" ]] && return 0
SWARM_DIAGNOSTICS_LOADED=1

if [[ -z "$TEAMS_DIR" ]]; then
    echo "Error: 00-globals.sh must be sourced first" >&2
    return 1
fi

check_heartbeats() {
    local team_name="$1"
    local stale_threshold="${2:-300}"  # Default: 5 minutes (300 seconds)
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        echo "[]"
        return 1
    fi

    local now=$(date +%s)
    local stale_agents="[]"

    # Find members with stale heartbeats
    while IFS='|' read -r name last_seen status; do
        if [[ "$status" == "active" ]] && [[ -n "$last_seen" ]]; then
            # Convert ISO timestamp to epoch
            local last_seen_epoch
            if ! last_seen_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$last_seen" +%s 2>/dev/null); then
                if ! last_seen_epoch=$(date -d "$last_seen" +%s 2>/dev/null); then
                    echo -e "${YELLOW}Warning: Cannot parse timestamp '$last_seen' for $name, skipping${NC}" >&2
                    continue
                fi
            fi
            local elapsed=$((now - last_seen_epoch))

            if [[ $elapsed -gt $stale_threshold ]]; then
                stale_agents=$(echo "$stale_agents" | jq --arg name "$name" --arg elapsed "$elapsed" '. += [{"name": $name, "staleSec": ($elapsed | tonumber)}]')
            fi
        fi
    done < <(jq -r '.members[] | "\(.name)|\(.lastSeen // "")|\(.status)"' "$config_file")

    echo "$stale_agents"
}

detect_crashed_agents() {
    local team_name="$1"
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        echo "[]"
        return 1
    fi

    local crashed_agents="[]"

    # Get active members from config
    local active_members=$(jq -r '.members[] | select(.status == "active") | .name' "$config_file")

    # Check each active member for live session
    while IFS= read -r member_name; do
        [[ -z "$member_name" ]] && continue

        local has_session=false

        case "$SWARM_MULTIPLEXER" in
            kitty)
                local swarm_var="swarm_${team_name}_${member_name}"
                if kitten_cmd ls 2>/dev/null | jq -e --arg var "$swarm_var" '.[].tabs[].windows[] | select(.user_vars[$var] != null)' &>/dev/null; then
                    has_session=true
                fi
                ;;
            tmux)
                local safe_team="${team_name//[^a-zA-Z0-9_-]/_}"
                local safe_member="${member_name//[^a-zA-Z0-9_-]/_}"
                local session_name="swarm-${safe_team}-${safe_member}"
                if tmux has-session -t "$session_name" 2>/dev/null; then
                    has_session=true
                fi
                ;;
        esac

        if [[ "$has_session" == "false" ]]; then
            crashed_agents=$(echo "$crashed_agents" | jq --arg name "$member_name" '. += [$name]')
        fi
    done <<< "$active_members"

    echo "$crashed_agents"
}

reconcile_team_status() {
    local team_name="$1"
    local config_file="${TEAMS_DIR}/${team_name}/config.json"
    local verbose="${2:-false}"

    if [[ ! -f "$config_file" ]]; then
        [[ "$verbose" == "true" ]] && echo -e "${RED}Team '${team_name}' not found${NC}" >&2
        return 1
    fi

    local changes=0

    # Detect crashed agents
    local crashed=$(detect_crashed_agents "$team_name")
    local crashed_count=$(echo "$crashed" | jq 'length')

    if [[ "$crashed_count" -gt 0 ]]; then
        [[ "$verbose" == "true" ]] && echo -e "${YELLOW}Found ${crashed_count} crashed agent(s)${NC}" >&2

        # Mark crashed agents as offline
        while IFS= read -r member_name; do
            [[ -z "$member_name" ]] && continue
            update_member_status "$team_name" "$member_name" "offline"
            [[ "$verbose" == "true" ]] && echo -e "${YELLOW}  Marked ${member_name} as offline (no session found)${NC}" >&2
            ((changes++))
        done < <(echo "$crashed" | jq -r '.[]')
    fi

    # Check for stale heartbeats
    local stale=$(check_heartbeats "$team_name")
    local stale_count=$(echo "$stale" | jq 'length')

    if [[ "$stale_count" -gt 0 ]]; then
        [[ "$verbose" == "true" ]] && echo -e "${YELLOW}Found ${stale_count} stale agent(s)${NC}" >&2

        while IFS='|' read -r name stale_sec; do
            [[ -z "$name" ]] && continue
            [[ "$verbose" == "true" ]] && echo -e "${YELLOW}  ${name} stale for ${stale_sec}s${NC}" >&2
        done < <(echo "$stale" | jq -r '.[] | "\(.name)|\(.staleSec)"')
    fi

    [[ "$verbose" == "true" ]] && [[ "$changes" -eq 0 ]] && echo -e "${GREEN}Team status is consistent${NC}" >&2

    return 0
}

list_teams() {
    if [[ ! -d "$TEAMS_DIR" ]]; then
        echo "No teams directory found at ${TEAMS_DIR}"
        return 0
    fi

    local team_count=0
    echo "Available teams:"
    echo "----------------"

    while IFS= read -r team_dir; do
        [[ -z "$team_dir" ]] && continue
        local team_name=$(basename "$team_dir")
        local config_file="${team_dir}/config.json"

        if [[ -f "$config_file" ]]; then
            ((team_count++))
            local team_status=$(jq -r '.status // "unknown"' "$config_file")
            local member_count=$(jq -r '.members | length' "$config_file")
            local description=$(jq -r '.description // ""' "$config_file" | head -c 50)

            local status_color="${NC}"
            if [[ "$team_status" == "active" ]]; then
                status_color="${GREEN}"
            elif [[ "$team_status" == "suspended" ]]; then
                status_color="${YELLOW}"
            fi

            echo -e "  ${team_name} ${status_color}[${team_status}]${NC} - ${member_count} members"
            [[ -n "$description" ]] && echo "    ${description}"
        fi
    done < <(find "$TEAMS_DIR" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort)

    if [[ $team_count -eq 0 ]]; then
        echo "  (no teams found)"
    fi
    echo ""
    echo "Total: ${team_count} team(s)"
}

delete_task() {
    local team_name="${1:-${CLAUDE_CODE_TEAM_NAME:-default}}"
    local task_id="$2"
    local task_file="${TASKS_DIR}/${team_name}/${task_id}.json"

    if [[ -z "$task_id" ]]; then
        echo -e "${RED}Error: task_id is required${NC}"
        echo "Usage: delete_task [team_name] <task_id>"
        return 1
    fi

    if [[ ! -f "$task_file" ]]; then
        echo -e "${RED}Task #${task_id} not found in team '${team_name}'${NC}"
        return 1
    fi

    # Get task info before deletion for confirmation message
    local subject=$(jq -r '.subject // "Unknown"' "$task_file")

    if command rm -f "$task_file"; then
        echo -e "${GREEN}Deleted task #${task_id}: ${subject}${NC}"
    else
        echo -e "${RED}Failed to delete task #${task_id}${NC}"
        return 1
    fi
}


# Export public API
export -f check_heartbeats detect_crashed_agents reconcile_team_status list_teams delete_task
