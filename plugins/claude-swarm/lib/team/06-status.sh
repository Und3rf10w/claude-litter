#!/bin/bash
# Module: 06-status.sh
# Description: Team and member status tracking, live agent detection
# Dependencies: 00-globals, 01-utils, 03-multiplexer, 05-team
# Exports: update_team_status, update_member_status, get_member_status, get_team_status, get_live_agents, format_member_status, get_task_summary, swarm_status

[[ -n "${SWARM_06_STATUS_LOADED}" ]] && return 0
SWARM_06_STATUS_LOADED=1

if [[ -z "$TEAMS_DIR" ]]; then
    echo "Error: 00-globals.sh must be sourced first" >&2
    return 1
fi

update_team_status() {
    local team_name="$1"
    local new_status="$2"  # active, suspended, archived
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        echo -e "${RED}Team '${team_name}' not found${NC}"
        return 1
    fi

    # Acquire lock for concurrent access protection
    if ! acquire_file_lock "$config_file"; then
        echo -e "${RED}Failed to acquire lock for team config${NC}" >&2
        return 1
    fi

    local tmp_file=$(mktemp)

    if [[ -z "$tmp_file" ]]; then
        release_file_lock
        echo -e "${RED}Failed to create temp file${NC}" >&2
        return 1
    fi

    # Add trap to ensure cleanup on interrupt
    trap "rm -f '$tmp_file'" INT TERM

    local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    local result=0

    case "$new_status" in
        suspended)
            jq --arg status "$new_status" --arg ts "$timestamp" \
               '.status = $status | .suspendedAt = $ts' \
               "$config_file" >| "$tmp_file" && command mv "$tmp_file" "$config_file" || result=1
            ;;
        active)
            jq --arg status "$new_status" --arg ts "$timestamp" \
               '.status = $status | .resumedAt = $ts' \
               "$config_file" >| "$tmp_file" && command mv "$tmp_file" "$config_file" || result=1
            ;;
        *)
            jq --arg status "$new_status" \
               '.status = $status' \
               "$config_file" >| "$tmp_file" && command mv "$tmp_file" "$config_file" || result=1
            ;;
    esac

    trap - INT TERM

    if [[ $result -eq 0 ]]; then
        release_file_lock
        echo -e "${CYAN}Team '${team_name}' status: ${new_status}${NC}"
    else
        command rm -f "$tmp_file"
        release_file_lock
        echo -e "${RED}Failed to update team status${NC}" >&2
        return 1
    fi
}

update_member_status() {
    local team_name="$1"
    local member_name="$2"
    local new_status="$3"  # active, offline
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        return 1
    fi

    # Acquire lock for concurrent access protection
    if ! acquire_file_lock "$config_file"; then
        echo -e "${RED}Failed to acquire lock for team config${NC}" >&2
        return 1
    fi

    local tmp_file=$(mktemp)

    if [[ -z "$tmp_file" ]]; then
        release_file_lock
        echo -e "${RED}Failed to create temp file${NC}" >&2
        return 1
    fi

    # Add trap to ensure cleanup on interrupt
    trap "rm -f '$tmp_file'" INT TERM

    local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    if jq --arg name "$member_name" --arg status "$new_status" --arg ts "$timestamp" \
       '(.members[] | select(.name == $name)) |= (.status = $status | .lastSeen = $ts)' \
       "$config_file" >| "$tmp_file" && command mv "$tmp_file" "$config_file"; then
        trap - INT TERM
        release_file_lock
    else
        trap - INT TERM
        command rm -f "$tmp_file"
        release_file_lock
        return 1
    fi
}

get_member_status() {
    local team_name="$1"
    local member_name="$2"
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        echo "unknown"
        return 1
    fi

    jq -r --arg name "$member_name" '.members[] | select(.name == $name) | .status // "unknown"' "$config_file"
}

get_team_status() {
    local team_name="$1"
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        echo "not_found"
        return 1
    fi

    jq -r '.status // "unknown"' "$config_file"
}

# Get live agents from the current multiplexer
# Returns newline-separated list of agent names with active sessions
get_live_agents() {
    local team_name="$1"
    local live_agents=""

    case "$SWARM_MULTIPLEXER" in
        kitty)
            # Query all tabs but filter by team name - this is intentional to find
            # all agents for this team regardless of which tab they're in.
            # The select filter prevents cross-team pollution.
            live_agents=$(kitten_cmd ls 2>/dev/null | jq -r --arg team "$team_name" \
                '.[].tabs[].windows[] | select(.user_vars.swarm_team == $team) | .user_vars.swarm_agent' \
                2>/dev/null || true)
            ;;
        tmux)
            live_agents=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | \
                grep "swarm-${team_name}" | sed 's/swarm-[^-]*-//' || true)
            ;;
    esac

    echo "$live_agents"
}

# ============================================
# STATUS FORMATTING AND SUMMARY
# ============================================

format_member_status() {
    local name="$1"
    local type="$2"
    local config_status="$3"
    local live_agents="$4"  # newline-separated list

    local window_status=""
    local status_icon=""
    local is_mismatch=0

    if [[ "$name" == "team-lead" ]]; then
        window_status="(you)"
        status_icon=""
    elif echo "$live_agents" | grep -q "^${name}$"; then
        window_status="window exists"
        if [[ "$config_status" == "active" ]]; then
            status_icon="${GREEN}✓${NC}"
        else
            status_icon="${YELLOW}⚠️${NC}"
            is_mismatch=1
        fi
    else
        window_status="no window"
        if [[ "$config_status" == "offline" ]]; then
            status_icon="${GREEN}✓${NC}"
        else
            status_icon="${RED}✗${NC}"
            is_mismatch=1
        fi
    fi

    # Return format: display_line|is_mismatch
    printf "  %-25s config: %-8s %s %s|%d" "$name ($type)" "$config_status" "$window_status" "$status_icon" "$is_mismatch"
}

# Get task summary for a team
# Returns: active_count|completed_count
# Active = pending, in_progress (or in-progress), blocked, in_review (or in-review)
# Completed = completed
get_task_summary() {
    local team_name="$1"
    local tasks_dir="${TASKS_DIR}/${team_name}"

    if [[ ! -d "$tasks_dir" ]]; then
        echo "0|0"
        return 0
    fi

    # Count active tasks with better error handling
    local active=0
    local completed=0
    local errors=0

    while IFS= read -r -d '' task_file; do
        # Validate JSON and count tasks, logging errors instead of silently suppressing
        if ! jq -e . "$task_file" >/dev/null 2>&1; then
            echo -e "${YELLOW}Warning: Malformed JSON in task file: $task_file${NC}" >&2
            ((errors++))
            continue
        fi

        local status=$(jq -r '.status // ""' "$task_file" 2>/dev/null)
        case "$status" in
            pending|in_progress|in-progress|blocked|in_review|in-review)
                ((active++))
                ;;
            completed)
                ((completed++))
                ;;
        esac
    done < <(find "$tasks_dir" -name "*.json" -print0)

    # Return active|completed|errors so callers can handle error counts
    echo "${active}|${completed}|${errors}"
}

# ============================================
# STATUS DISPLAY
# ============================================

swarm_status() {
    local team_name="$1"
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    # Validate team exists
    if [[ ! -f "$config_file" ]]; then
        echo -e "${RED}Team '${team_name}' not found${NC}"
        return 1
    fi

    # Header
    echo -e "${CYAN}=== Team: ${team_name} ===${NC}"
    echo -e "${BLUE}Multiplexer:${NC} ${SWARM_MULTIPLEXER}"
    echo ""

    # Team description
    local description=$(jq -r '.description' "$config_file")
    echo -e "${BLUE}Description:${NC} ${description}"
    echo ""

    # Members section - using helper functions
    echo -e "${BLUE}Members (config vs live):${NC}"
    local live_agents=$(get_live_agents "$team_name")
    local mismatch_count=0

    while IFS='|' read -r name type config_status; do
        [[ -z "$name" ]] && continue

        local result=$(format_member_status "$name" "$type" "$config_status" "$live_agents")
        local display_line="${result%|*}"
        local is_mismatch="${result##*|}"

        echo "$display_line"
        mismatch_count=$((mismatch_count + is_mismatch))
    done < <(jq -r '.members[] | "\(.name)|\(.agentType // .type)|\(.status)"' "$config_file")

    # Mismatch warning
    if [[ $mismatch_count -gt 0 ]]; then
        echo ""
        echo -e "${YELLOW}  ⚠️  ${mismatch_count} status mismatch(es) detected. Run /claude-swarm:swarm-reconcile to fix.${NC}"
    fi
    echo ""

    # Session file (kitty only)
    if [[ "$SWARM_MULTIPLEXER" == "kitty" ]]; then
        local session_file="${TEAMS_DIR}/${team_name}/swarm.kitty-session"
        if [[ -f "$session_file" ]]; then
            echo -e "${BLUE}Session File:${NC} ${session_file}"
            echo ""
        fi
    fi

    # Task summary - using helper function
    echo -e "${BLUE}Tasks:${NC}"
    local task_summary=$(get_task_summary "$team_name")
    # Parse three-field format: active|completed|errors
    IFS='|' read -r active completed errors <<< "$task_summary"

    if [[ "$active" == "0" && "$completed" == "0" ]]; then
        echo "  (no tasks)"
    else
        echo "  Active: ${active}"
        echo "  Completed: ${completed}"
    fi

    if [[ "${errors:-0}" -gt 0 ]]; then
        echo -e "  ${YELLOW}Warning: $errors task file(s) have corrupt JSON${NC}"
    fi
}


# Export public API
export -f update_team_status update_member_status get_member_status get_team_status get_live_agents format_member_status get_task_summary swarm_status
