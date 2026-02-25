#!/bin/bash
# Module: 05-team.sh
# Description: Team creation and member management
# Dependencies: 00-globals, 01-utils, 02-file-lock, 03-multiplexer
# Exports: create_team, add_member, get_team_config, list_team_members

[[ -n "${SWARM_05_TEAM_LOADED}" ]] && return 0
SWARM_05_TEAM_LOADED=1

if [[ -z "$TEAMS_DIR" ]]; then
    echo "Error: 00-globals.sh must be sourced first" >&2
    return 1
fi

create_team() {
    local team_name="$1"
    local description="${2:-Team $team_name}"

    # Validate team name
    validate_name "$team_name" "team" || return 1

    local team_dir="${TEAMS_DIR}/${team_name}"

    # Atomically create team directory (prevents TOCTOU race condition)
    # mkdir without -p fails if directory exists, making this atomic
    if ! command mkdir "$team_dir" 2>/dev/null; then
        if [[ -d "$team_dir" ]]; then
            echo -e "${YELLOW}Team '${team_name}' already exists${NC}"
        else
            echo -e "${RED}Failed to create team directory (check permissions)${NC}" >&2
        fi
        return 1
    fi

    # Create subdirectories (team_dir now exclusively ours)
    if ! command mkdir -p "${team_dir}/inboxes"; then
        command rm -rf "$team_dir"
        echo -e "${RED}Failed to create team inboxes directory${NC}" >&2
        return 1
    fi

    if ! command mkdir -p "${TASKS_DIR}/${team_name}"; then
        command rm -rf "$team_dir"
        echo -e "${RED}Failed to create tasks directory${NC}" >&2
        return 1
    fi

    # Create config with current session as team-lead
    local lead_id="${CLAUDE_CODE_AGENT_ID:-$(generate_uuid)}"
    local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    # Use jq to properly escape values and prevent JSON injection
    # Write both swarm and CC native field names for compatibility:
    #   - "name" (CC native) + "teamName" (swarm legacy)
    #   - "agentType" (CC native) + "type" (swarm legacy)
    #   - "createdAt" as ISO string (swarm) - CC uses epoch ms but reads JSON generically
    #   - "joinedAt" (CC native) + "lastSeen" (swarm-only)
    if ! jq -n \
        --arg teamName "$team_name" \
        --arg description "$description" \
        --arg leadId "$lead_id" \
        --arg timestamp "$timestamp" \
        '{
            name: $teamName,
            teamName: $teamName,
            description: $description,
            status: "active",
            leadAgentId: $leadId,
            members: [{
                agentId: $leadId,
                name: "team-lead",
                agentType: "team-lead",
                type: "team-lead",
                color: "cyan",
                model: "sonnet",
                status: "active",
                joinedAt: $timestamp,
                lastSeen: $timestamp
            }],
            createdAt: $timestamp,
            suspendedAt: null,
            resumedAt: null
        }' > "${team_dir}/config.json"; then
        command rm -rf "$team_dir" "${TASKS_DIR}/${team_name}"
        echo -e "${RED}Failed to create team config${NC}" >&2
        return 1
    fi

    # Initialize team-lead inbox
    if ! echo "[]" > "${team_dir}/inboxes/team-lead.json"; then
        command rm -rf "$team_dir" "${TASKS_DIR}/${team_name}"
        echo -e "${RED}Failed to create team-lead inbox${NC}" >&2
        return 1
    fi

    echo -e "${GREEN}Created team '${team_name}'${NC}"
    echo "  Config: ${team_dir}/config.json"
    echo "  Tasks: ${TASKS_DIR}/${team_name}/"

    # Trigger webhook notification
    webhook_team_created "$team_name" "$description" 2>/dev/null || true
}

add_member() {
    local team_name="$1"
    local agent_id="$2"
    local agent_name="$3"
    local agent_type="${4:-worker}"
    local agent_color="${5:-blue}"
    local agent_model="${6:-sonnet}"

    # Validate names
    validate_name "$team_name" "team" || return 1
    validate_name "$agent_name" "agent" || return 1

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

    # Add member to config with status tracking
    local tmp_file=$(mktemp)

    if [[ -z "$tmp_file" ]]; then
        release_file_lock
        echo -e "${RED}Failed to create temp file${NC}" >&2
        return 1
    fi

    # Add trap to ensure cleanup on interrupt
    trap "rm -f '$tmp_file'" INT TERM

    local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    # Write both swarm and CC native field names for compatibility
    if jq --arg id "$agent_id" \
       --arg name "$agent_name" \
       --arg type "$agent_type" \
       --arg color "$agent_color" \
       --arg model "$agent_model" \
       --arg ts "$timestamp" \
       '.members += [{"agentId": $id, "name": $name, "agentType": $type, "type": $type, "color": $color, "model": $model, "status": "active", "joinedAt": $ts, "lastSeen": $ts}]' \
       "$config_file" >| "$tmp_file" && command mv "$tmp_file" "$config_file"; then
        trap - INT TERM
        release_file_lock

        # Initialize inbox for new member
        echo "[]" > "${TEAMS_DIR}/${team_name}/inboxes/${agent_name}.json"

        echo -e "${GREEN}Added '${agent_name}' to team '${team_name}'${NC}"

        # Trigger webhook notification
        webhook_teammate_joined "$team_name" "$agent_name" "$agent_type" 2>/dev/null || true
    else
        trap - INT TERM
        command rm -f "$tmp_file"
        release_file_lock
        echo -e "${RED}Failed to add member to team config${NC}" >&2
        return 1
    fi
}

get_team_config() {
    local team_name="$1"
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ -f "$config_file" ]]; then
        command cat "$config_file"
    else
        echo "{}"
    fi
}

list_team_members() {
    local team_name="$1"
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        echo -e "${RED}Team '${team_name}' not found${NC}"
        return 1
    fi

    jq -r '.members[] | "\(.name) (\(.agentType // .type)) - \(.agentId)"' "$config_file"
}

update_agent_color() {
    local team_name="$1"
    local agent_name="$2"
    local new_color="$3"

    # Validate names
    validate_name "$team_name" "team" || return 1
    validate_name "$agent_name" "agent" || return 1

    # Validate color
    case "$new_color" in
        blue|green|yellow|red|cyan|magenta|white) ;;
        *)
            echo -e "${RED}Invalid color '${new_color}'. Must be one of: blue, green, yellow, red, cyan, magenta, white${NC}" >&2
            return 1
            ;;
    esac

    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        echo -e "${RED}Team '${team_name}' not found${NC}" >&2
        return 1
    fi

    # Check if agent exists
    if ! jq -e --arg name "$agent_name" '.members[] | select(.name == $name)' "$config_file" &>/dev/null; then
        echo -e "${RED}Agent '${agent_name}' not found in team '${team_name}'${NC}" >&2
        return 1
    fi

    # Acquire lock for concurrent access protection
    if ! acquire_file_lock "$config_file"; then
        echo -e "${RED}Failed to acquire lock for team config${NC}" >&2
        return 1
    fi

    # Update agent color in config
    local tmp_file=$(mktemp)

    if [[ -z "$tmp_file" ]]; then
        release_file_lock
        echo -e "${RED}Failed to create temp file${NC}" >&2
        return 1
    fi

    # Add trap to ensure cleanup on interrupt
    trap "rm -f '$tmp_file'" INT TERM

    if jq --arg name "$agent_name" \
       --arg color "$new_color" \
       '(.members[] | select(.name == $name) | .color) = $color' \
       "$config_file" >| "$tmp_file" && command mv "$tmp_file" "$config_file"; then
        trap - INT TERM
        release_file_lock
        echo -e "${GREEN}Updated color for '${agent_name}' to '${new_color}'${NC}"
    else
        trap - INT TERM
        command rm -f "$tmp_file"
        release_file_lock
        echo -e "${RED}Failed to update agent color${NC}" >&2
        return 1
    fi
}


# Export public API
export -f create_team add_member get_team_config list_team_members update_agent_color
