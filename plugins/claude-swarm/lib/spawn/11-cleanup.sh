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

        # Kill sessions based on multiplexer
        case "$SWARM_MULTIPLEXER" in
            kitty)
                # Use registry + live query for comprehensive cleanup
                declare -A closed_agents

                # First, close all registered windows
                while IFS= read -r line; do
                    [[ -n "$line" ]] || continue
                    local agent=$(echo "$line" | jq -r '.agent')
                    local swarm_var=$(echo "$line" | jq -r '.swarm_var')
                    if kitten_cmd close-window --match "var:${swarm_var}" 2>/dev/null; then
                        echo -e "${YELLOW}  Closed (registry): ${agent}${NC}"
                        closed_agents["$agent"]=1
                        unregister_window "$team_name" "$agent"
                    fi
                done < <(get_registered_windows "$team_name" | jq -c '.[]')

                # Then, query live windows to catch any unregistered ones
                while IFS= read -r agent; do
                    [[ -n "$agent" ]] || continue
                    if [[ -z "${closed_agents[$agent]}" ]]; then
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
export -f cleanup_team
