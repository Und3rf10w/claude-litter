#!/bin/bash
# Module: 10-lifecycle.sh
# Description: Team lifecycle (suspend/resume)
# Dependencies: Various (see implementation plan)
# Exports: get_member_context, suspend_team, resume_team

[[ -n "${SWARM_10_LIFECYCLE_LOADED}" ]] && return 0
SWARM_10_LIFECYCLE_LOADED=1

if [[ -z "$TEAMS_DIR" ]]; then
    echo "Error: 00-globals.sh must be sourced first" >&2
    return 1
fi

get_member_context() {
    local team_name="$1"
    local member_name="$2"
    local tasks_dir="${TASKS_DIR}/${team_name}"
    local inbox_file="${TEAMS_DIR}/${team_name}/inboxes/${member_name}.json"

    local context=""

    # Get assigned tasks
    if [[ -d "$tasks_dir" ]]; then
        local assigned_tasks=""
        # Use find instead of glob to avoid zsh "no matches found" error
        while IFS= read -r task_file; do
            [[ -z "$task_file" ]] && continue
            local owner=$(jq -r '.owner // ""' "$task_file")
            if [[ "$owner" == "$member_name" ]]; then
                local id=$(jq -r '.id' "$task_file")
                local subject=$(jq -r '.subject' "$task_file")
                local task_status=$(jq -r '.status' "$task_file")
                assigned_tasks="${assigned_tasks}\n  - Task #${id} [${task_status}]: ${subject}"
            fi
        done < <(find "$tasks_dir" -maxdepth 1 -name "*.json" -type f 2>/dev/null)
        if [[ -n "$assigned_tasks" ]]; then
            context="${context}Your assigned tasks:${assigned_tasks}\n\n"
        fi
    fi

    # Get unread message count
    if [[ -f "$inbox_file" ]]; then
        local unread_count=$(jq '[.[] | select(.read == false)] | length' "$inbox_file")
        if [[ "$unread_count" -gt 0 ]]; then
            context="${context}You have ${unread_count} unread message(s). Use /claude-swarm:swarm-inbox to read them.\n\n"
        fi
    fi

    echo -e "$context"
}

# ============================================
# TEAM LIFECYCLE
# ============================================

suspend_team() {
    local team_name="$1"
    local kill_sessions="${2:-true}"
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        echo -e "${RED}Team '${team_name}' not found${NC}"
        return 1
    fi

    local current_status=$(get_team_status "$team_name")
    if [[ "$current_status" == "suspended" ]]; then
        echo -e "${YELLOW}Team '${team_name}' is already suspended${NC}"
        return 0
    fi

    echo -e "${CYAN}Suspending team '${team_name}'...${NC}"

    # Read members into array (handles names with spaces/special chars)
    local -a members=()
    while IFS= read -r member; do
        [[ -n "$member" ]] && members+=("$member")
    done < <(jq -r '.members[].name' "$config_file")

    # Mark all members as offline
    for member in "${members[@]}"; do
        update_member_status "$team_name" "$member" "offline"
    done

    # Kill sessions if requested
    if [[ "$kill_sessions" == "true" ]]; then
        case "$SWARM_MULTIPLEXER" in
            kitty)
                # Use registry + live query for comprehensive cleanup
                for member in "${members[@]}"; do
                    if [[ "$member" != "team-lead" ]]; then
                        local swarm_var="swarm_${team_name}_${member}"
                        if kitten_cmd close-window --match "var:${swarm_var}" 2>/dev/null; then
                            echo -e "${YELLOW}  Closed: ${member}${NC}"
                            unregister_window "$team_name" "$member"
                        fi
                    fi
                done
                ;;
            tmux)
                for member in "${members[@]}"; do
                    if [[ "$member" != "team-lead" ]]; then
                        local session_name="swarm-${team_name}-${member}"
                        tmux kill-session -t "$session_name" 2>/dev/null && \
                            echo -e "${YELLOW}  Closed: ${member}${NC}"
                    fi
                done
                ;;
        esac
    fi

    # Update team status
    update_team_status "$team_name" "suspended"

    echo -e "${GREEN}Team '${team_name}' suspended${NC}"
    echo "  Data preserved in: ${TEAMS_DIR}/${team_name}/"
    echo "  Resume with: /claude-swarm:swarm-resume ${team_name}"
}

resume_team() {
    local team_name="$1"
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        echo -e "${RED}Team '${team_name}' not found${NC}"
        return 1
    fi

    local current_status=$(get_team_status "$team_name")
    if [[ "$current_status" == "active" ]]; then
        echo -e "${YELLOW}Team '${team_name}' is already active${NC}"
        return 0
    fi

    echo -e "${CYAN}Resuming team '${team_name}'...${NC}"

    # Mark team as active
    update_team_status "$team_name" "active"

    # Mark current session as active (using CLAUDE_CODE_AGENT_NAME if set, otherwise assume team-lead)
    local current_agent="${CLAUDE_CODE_AGENT_NAME:-team-lead}"
    update_member_status "$team_name" "$current_agent" "active"

    # Get offline members (excluding current agent)
    local offline_members=$(jq -r --arg current "$current_agent" '.members[] | select(.status == "offline" and .name != $current) | "\(.name)|\(.type)|\(.model // "sonnet")"' "$config_file")

    if [[ -z "$offline_members" ]]; then
        echo -e "${GREEN}Team '${team_name}' resumed (no teammates to respawn)${NC}"
        return 0
    fi

    # Respawn each offline member with context
    echo -e "${BLUE}Respawning teammates...${NC}"
    while IFS='|' read -r member_name member_type member_model; do
        if [[ -n "$member_name" ]]; then
            local context=$(get_member_context "$team_name" "$member_name")
            local resume_prompt="You are ${member_name} resuming work on team '${team_name}'. ${context}Check your inbox and tasks to continue where you left off."

            echo -e "  Spawning ${member_name} (${member_type}, ${member_model})..."

            # Spawn without re-adding to team (already exists)
            case "$SWARM_MULTIPLEXER" in
                kitty)
                    spawn_teammate_kitty_resume "$team_name" "$member_name" "$member_type" "$member_model" "$resume_prompt"
                    ;;
                tmux)
                    spawn_teammate_tmux_resume "$team_name" "$member_name" "$member_type" "$member_model" "$resume_prompt"
                    ;;
                *)
                    echo -e "${RED}No multiplexer available${NC}"
                    return 1
                    ;;
            esac
        fi
    done <<< "$offline_members"

    echo -e "${GREEN}Team '${team_name}' resumed${NC}"
}


# Export public API
export -f get_member_context suspend_team resume_team
