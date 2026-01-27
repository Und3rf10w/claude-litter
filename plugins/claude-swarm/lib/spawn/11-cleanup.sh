#!/bin/bash
# Module: 11-cleanup.sh
# Description: Team cleanup operations
# Dependencies: 00-globals, 03-multiplexer, 04-registry, 10-lifecycle
# Exports: cleanup_team

[[ -n "${SWARM_CLEANUP_LOADED}" ]] && return 0
SWARM_CLEANUP_LOADED=1

if [[ -z "$TEAMS_DIR" ]]; then
    echo "Error: 00-globals.sh must be sourced first" >&2
    return 1
fi

# ============================================
# GRACEFUL CLEANUP
# ============================================

# Graceful cleanup: send shutdown requests, wait for acknowledgment, then cleanup
graceful_cleanup() {
    local team_name="$1"
    local timeout="${2:-30}"  # Default 30 second timeout

    # Check if team exists
    if [[ ! -d "${TEAMS_DIR}/${team_name}" ]]; then
        echo -e "${RED}Team '${team_name}' not found${NC}"
        return 1
    fi

    echo -e "${CYAN}Graceful cleanup for team '${team_name}'...${NC}"

    local config_file="${TEAMS_DIR}/${team_name}/config.json"
    if [[ ! -f "$config_file" ]]; then
        echo -e "${RED}Team config not found${NC}"
        return 1
    fi

    # Get list of active members (excluding team-lead initially)
    local members
    members=$(jq -r '.members[] | select(.status == "active" and .name != "team-lead") | .name' "$config_file")

    if [[ -z "$members" ]]; then
        echo -e "${YELLOW}No active teammates to notify${NC}"
        # Fall back to regular cleanup
        cleanup_team "$team_name"
        return $?
    fi

    # Send shutdown requests to all active members
    local request_id=$(generate_uuid)
    local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    local shutdown_message="SHUTDOWN REQUEST: Team cleanup initiated. Request ID: ${request_id}. Please finish critical work and acknowledge shutdown."

    echo -e "${CYAN}Sending shutdown requests...${NC}"

    local notified_count=0
    while IFS= read -r member; do
        [[ -n "$member" ]] || continue
        if send_message "$team_name" "$member" "$shutdown_message" "red" 2>/dev/null; then
            echo -e "${YELLOW}  Notified: ${member}${NC}"
            ((notified_count++))
        fi
    done <<< "$members"

    if [[ $notified_count -eq 0 ]]; then
        echo -e "${YELLOW}No teammates could be notified, proceeding with regular cleanup${NC}"
        cleanup_team "$team_name"
        return $?
    fi

    echo -e "${CYAN}Waiting ${timeout}s for acknowledgments...${NC}"
    echo -e "${CYAN}(Teammates should check /swarm-inbox and respond)${NC}"

    # Wait for timeout period
    # In a real implementation, we'd poll for acknowledgments
    # For now, we just wait and then proceed
    local waited=0
    local interval=5
    while [[ $waited -lt $timeout ]]; do
        sleep $interval
        waited=$((waited + interval))
        echo -e "${CYAN}  ${waited}s / ${timeout}s elapsed...${NC}"
    done

    echo -e "${YELLOW}Timeout reached, proceeding with cleanup${NC}"

    # Proceed with regular cleanup (suspend mode - keeps data)
    cleanup_team "$team_name"
}

# ============================================
# IMMEDIATE CLEANUP
# ============================================

cleanup_team() {
    local team_name="$1"
    local force="${2:-false}"

    # Check if team exists
    if [[ ! -d "${TEAMS_DIR}/${team_name}" ]]; then
        echo -e "${RED}Team '${team_name}' not found${NC}"
        return 1
    fi

    if [[ "$force" == "true" ]] || [[ "$force" == "--force" ]]; then
        # Hard cleanup: kill sessions AND delete all data
        echo -e "${CYAN}Hard cleanup for team '${team_name}'...${NC}"

        # Acquire registry lock before cleanup to prevent races with spawns
        local registry_file="${TEAMS_DIR}/${team_name}/.window_registry.json"
        local registry_locked=false
        if [[ -f "$registry_file" ]] && acquire_file_lock "$registry_file" 10 30; then
            registry_locked=true
        fi

        # Kill sessions based on multiplexer
        case "$SWARM_MULTIPLEXER" in
            kitty)
                # Use registry for cleanup (close-window is idempotent - safe to retry)
                local closed_agents=""

                # First, close all registered windows
                while IFS= read -r line; do
                    [[ -n "$line" ]] || continue
                    local agent=$(echo "$line" | jq -r '.agent')
                    local swarm_var=$(echo "$line" | jq -r '.swarm_var')
                    if kitten_cmd close-window --match "var:${swarm_var}" 2>/dev/null; then
                        echo -e "${YELLOW}  Closed (registry): ${agent}${NC}"
                        closed_agents="${closed_agents}:${agent}:"
                        unregister_window "$team_name" "$agent"
                    fi
                done < <(get_registered_windows "$team_name" | jq -c '.[]')

                # Then, query live windows to catch any unregistered ones
                while IFS= read -r agent; do
                    [[ -n "$agent" ]] || continue
                    # Check if already closed (bash 3.2 compatible string search)
                    if [[ "$closed_agents" != *":${agent}:"* ]]; then
                        local swarm_var="swarm_${team_name}_${agent}"
                        if kitten_cmd close-window --match "var:${swarm_var}" 2>/dev/null; then
                            echo -e "${YELLOW}  Closed (live query): ${agent}${NC}"
                        fi
                    fi
                done < <(kitten_cmd ls 2>/dev/null | jq -r --arg team "$team_name" '.[].tabs[].windows[] | select(.user_vars.swarm_team == $team) | .user_vars.swarm_agent' 2>/dev/null)
                ;;
            tmux)
                # Use while read to handle session names properly
                while IFS= read -r session; do
                    [[ -n "$session" ]] || continue
                    tmux kill-session -t "$session"
                    echo -e "${YELLOW}  Closed: ${session}${NC}"
                done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep "swarm-${team_name}")
                ;;
        esac

        # Release registry lock before deleting files
        if [[ "$registry_locked" == "true" ]]; then
            release_file_lock
        fi

        # Remove team directory
        if [[ -d "${TEAMS_DIR}/${team_name}" ]]; then
            command rm -rf "${TEAMS_DIR}/${team_name}"
            echo -e "${YELLOW}  Removed team directory${NC}"
        fi

        # Remove tasks directory
        if [[ -d "${TASKS_DIR}/${team_name}" ]]; then
            command rm -rf "${TASKS_DIR}/${team_name}"
            echo -e "${YELLOW}  Removed tasks directory${NC}"
        fi

        echo -e "${GREEN}Team '${team_name}' deleted${NC}"
    else
        # Soft cleanup: suspend team (kill sessions, keep data)
        suspend_team "$team_name" "true"
    fi
}


# Export public API
export -f cleanup_team graceful_cleanup
