#!/bin/bash
# Module: 07-messaging.sh
# Description: Message inbox system for team communication
# Dependencies: Various (see implementation plan)
# Exports: send_message, notify_active_teammate, read_inbox, read_unread_messages, mark_messages_read, broadcast_message, format_messages_xml

[[ -n "${SWARM_07_MESSAGING_LOADED}" ]] && return 0
SWARM_07_MESSAGING_LOADED=1

if [[ -z "$TEAMS_DIR" ]]; then
    echo "Error: 00-globals.sh must be sourced first" >&2
    return 1
fi

send_message() {
    local team_name="$1"
    local to="$2"
    local message="$3"
    local from="${CLAUDE_CODE_AGENT_NAME:-$(get_current_window_var 'swarm_agent' 2>/dev/null || echo 'team-lead')}"
    local color="${4:-blue}"

    # Validate recipient name (prevent path traversal)
    validate_name "$to" "recipient" || return 1

    local inbox_file="${TEAMS_DIR}/${team_name}/inboxes/${to}.json"

    if [[ ! -f "$inbox_file" ]]; then
        echo -e "${RED}Inbox for '${to}' not found in team '${team_name}'${NC}"
        return 1
    fi

    # Acquire lock for concurrent access protection
    if ! acquire_file_lock "$inbox_file"; then
        echo -e "${RED}Failed to acquire lock for inbox${NC}" >&2
        return 1
    fi

    local tmp_file=$(mktemp)
    if [[ -z "$tmp_file" ]]; then
        echo -e "${RED}Failed to create temp file${NC}" >&2
        release_file_lock
        return 1
    fi

    # Add trap to ensure cleanup on interrupt
    trap "rm -f '$tmp_file'; release_file_lock" EXIT INT TERM

    local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    if jq --arg from "$from" \
          --arg text "$message" \
          --arg color "$color" \
          --arg ts "$timestamp" \
          '. += [{"from": $from, "text": $text, "color": $color, "read": false, "timestamp": $ts}]' \
          "$inbox_file" >| "$tmp_file" && command mv "$tmp_file" "$inbox_file"; then
        trap - EXIT INT TERM
        release_file_lock
        echo -e "${GREEN}Message sent to '${to}'${NC}"

        # # Send real-time notification to active teammate
        # deprecated
        # notify_active_teammate "$team_name" "$to" "$from"
    else
        trap - EXIT INT TERM
        command rm -f "$tmp_file"
        release_file_lock
        echo -e "${RED}Failed to update inbox${NC}" >&2
        return 1
    fi
}

# DEPRECATED: Notify an active teammate via multiplexer
# Called after message is queued to provide real-time notification
notify_active_teammate() {
    local team_name="$1"
    local agent_name="$2"
    local from="$3"

    # Skip if messaging self
    if [[ "$agent_name" == "$from" ]]; then
        return 0
    fi

    # Check if teammate is active
    local live_agents=$(get_live_agents "$team_name")
    if ! echo "$live_agents" | grep -q "^${agent_name}$"; then
        return 0  # Not active, skip notification
    fi

    case "$SWARM_MULTIPLEXER" in
        kitty)
            local swarm_var="swarm_${team_name}_${agent_name}"
            kitten_cmd send-text --match "var:${swarm_var}" $'/claude-swarm:swarm-inbox\r'
            ;;
        tmux)
            local safe_team="${team_name//[^a-zA-Z0-9_-]/_}"
            local safe_agent="${agent_name//[^a-zA-Z0-9_-]/_}"
            local session="swarm-${safe_team}-${safe_agent}"
            tmux display-message -t "$session" "📬 New message from ${from}" 2>/dev/null || true
            ;;
    esac
}

read_inbox() {
    local team_name="$1"
    local agent_name="${2:-${CLAUDE_CODE_AGENT_NAME:-team-lead}}"
    local inbox_file="${TEAMS_DIR}/${team_name}/inboxes/${agent_name}.json"

    if [[ ! -f "$inbox_file" ]]; then
        echo "[]"
        return
    fi

    command cat "$inbox_file"
}

read_unread_messages() {
    local team_name="$1"
    local agent_name="${2:-${CLAUDE_CODE_AGENT_NAME:-team-lead}}"
    local inbox_file="${TEAMS_DIR}/${team_name}/inboxes/${agent_name}.json"

    if [[ ! -f "$inbox_file" ]]; then
        echo "[]"
        return
    fi

    jq '[.[] | select(.read == false)]' "$inbox_file"
}

mark_messages_read() {
    local team_name="$1"
    local agent_name="${2:-${CLAUDE_CODE_AGENT_NAME:-team-lead}}"
    local inbox_file="${TEAMS_DIR}/${team_name}/inboxes/${agent_name}.json"

    if [[ ! -f "$inbox_file" ]]; then
        return 1
    fi

    # Acquire lock for concurrent access protection
    if ! acquire_file_lock "$inbox_file"; then
        echo -e "${RED}Failed to acquire lock for inbox${NC}" >&2
        return 1
    fi

    local tmp_file=$(mktemp)

    if [[ -z "$tmp_file" ]]; then
        release_file_lock
        echo -e "${RED}Failed to create temp file${NC}" >&2
        return 1
    fi

    # Add trap to ensure cleanup on interrupt
    trap "rm -f '$tmp_file'; release_file_lock" EXIT INT TERM

    if jq '[.[] | .read = true]' "$inbox_file" >| "$tmp_file" && command mv "$tmp_file" "$inbox_file"; then
        trap - EXIT INT TERM
        release_file_lock
        return 0
    else
        trap - EXIT INT TERM
        command rm -f "$tmp_file"
        release_file_lock
        return 1
    fi
}

broadcast_message() {
    local team_name="$1"
    local message="$2"
    local exclude="${3:-}"  # Agent to exclude (usually self)
    local fail_fast="${4:-true}"
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        echo -e "${RED}Team '${team_name}' not found${NC}"
        return 1
    fi

    local failed_count=0
    local success_count=0

    # Read members using while loop (handles names with spaces/special chars)
    while IFS= read -r member; do
        [[ -n "$member" ]] || continue
        if [[ "$member" != "$exclude" ]]; then
            if send_message "$team_name" "$member" "$message"; then
                ((success_count++))
            else
                echo -e "${RED}Error: Failed to send message to '${member}'${NC}" >&2
                ((failed_count++))
                if [[ "$fail_fast" == "true" ]]; then
                    echo -e "${RED}Aborting broadcast due to failure (fail-fast mode)${NC}" >&2
                    return 1
                fi
            fi
        fi
    done < <(jq -r '.members[].name' "$config_file")

    if [[ $failed_count -gt 0 ]]; then
        echo -e "${YELLOW}Broadcast completed with ${failed_count} failure(s) and ${success_count} success(es)${NC}" >&2
        return 1
    fi

    return 0
}

format_messages_xml() {
    local messages="$1"

    echo "$messages" | jq -r '.[] | "<teammate-message teammate_id=\"\(.from)\" color=\"\(.color)\">\n\(.text)\n</teammate-message>\n"'
}


# Export public API
export -f send_message notify_active_teammate read_inbox read_unread_messages mark_messages_read broadcast_message format_messages_xml
