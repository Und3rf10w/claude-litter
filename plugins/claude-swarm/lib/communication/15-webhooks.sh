#!/bin/bash
# Module: 15-webhooks.sh
# Description: Webhook notifications for team events
# Dependencies: 00-globals.sh, 01-utils.sh
# Exports: configure_webhooks, send_webhook, validate_webhook_config, trigger_webhook_event

[[ -n "${SWARM_15_WEBHOOKS_LOADED}" ]] && return 0
SWARM_15_WEBHOOKS_LOADED=1

if [[ -z "$TEAMS_DIR" ]]; then
    echo "Error: 00-globals.sh must be sourced first" >&2
    return 1
fi

# ============================================
# WEBHOOK CONFIGURATION
# ============================================

# Configure webhook endpoints for a team
# Usage: configure_webhooks <team_name> <webhook_url> [event_filter]
configure_webhooks() {
    local team_name="$1"
    local webhook_url="$2"
    local event_filter="${3:-*}"  # Default: all events
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        echo -e "${RED}Team '${team_name}' not found${NC}" >&2
        return 1
    fi

    # Validate webhook URL
    if [[ ! "$webhook_url" =~ ^https?:// ]]; then
        echo -e "${RED}Error: Webhook URL must start with http:// or https://${NC}" >&2
        return 1
    fi

    # Acquire lock for concurrent access protection
    if ! acquire_file_lock "$config_file"; then
        echo -e "${RED}Failed to acquire lock for config${NC}" >&2
        return 1
    fi

    local tmp_file=$(mktemp)
    if [[ -z "$tmp_file" ]]; then
        echo -e "${RED}Failed to create temp file${NC}" >&2
        release_file_lock
        return 1
    fi

    trap "rm -f '$tmp_file'; release_file_lock" EXIT INT TERM

    # Add webhook configuration to team config
    if jq --arg url "$webhook_url" \
          --arg filter "$event_filter" \
          --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
          '.webhooks = (.webhooks // []) + [{url: $url, events: $filter, enabled: true, addedAt: $timestamp}]' \
          "$config_file" >| "$tmp_file" && command mv "$tmp_file" "$config_file"; then
        trap - EXIT INT TERM
        release_file_lock
        echo -e "${GREEN}Webhook configured for team '${team_name}'${NC}"
        echo "  URL: ${webhook_url}"
        echo "  Events: ${event_filter}"
        return 0
    else
        trap - EXIT INT TERM
        command rm -f "$tmp_file"
        release_file_lock
        echo -e "${RED}Failed to configure webhook${NC}" >&2
        return 1
    fi
}

# Validate webhook configuration
# Usage: validate_webhook_config <team_name>
validate_webhook_config() {
    local team_name="$1"
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        echo -e "${RED}Team '${team_name}' not found${NC}" >&2
        return 1
    fi

    local webhooks=$(jq -r '.webhooks // []' "$config_file")
    local webhook_count=$(echo "$webhooks" | jq 'length')

    if [[ "$webhook_count" -eq 0 ]]; then
        echo -e "${YELLOW}No webhooks configured for team '${team_name}'${NC}"
        return 0
    fi

    echo -e "${CYAN}Webhook configuration for team '${team_name}':${NC}"
    echo "$webhooks" | jq -r '.[] | "  [\(.enabled | if . then "✓" else "✗" end)] \(.url) (events: \(.events))"'

    return 0
}

# Remove a webhook from team configuration
# Usage: remove_webhook <team_name> <webhook_url>
remove_webhook() {
    local team_name="$1"
    local webhook_url="$2"
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        echo -e "${RED}Team '${team_name}' not found${NC}" >&2
        return 1
    fi

    # Acquire lock for concurrent access protection
    if ! acquire_file_lock "$config_file"; then
        echo -e "${RED}Failed to acquire lock for config${NC}" >&2
        return 1
    fi

    local tmp_file=$(mktemp)
    if [[ -z "$tmp_file" ]]; then
        echo -e "${RED}Failed to create temp file${NC}" >&2
        release_file_lock
        return 1
    fi

    trap "rm -f '$tmp_file'; release_file_lock" EXIT INT TERM

    # Remove webhook from configuration
    if jq --arg url "$webhook_url" \
          '.webhooks = (.webhooks // [] | map(select(.url != $url)))' \
          "$config_file" >| "$tmp_file" && command mv "$tmp_file" "$config_file"; then
        trap - EXIT INT TERM
        release_file_lock
        echo -e "${GREEN}Webhook removed from team '${team_name}'${NC}"
        return 0
    else
        trap - EXIT INT TERM
        command rm -f "$tmp_file"
        release_file_lock
        echo -e "${RED}Failed to remove webhook${NC}" >&2
        return 1
    fi
}

# ============================================
# WEBHOOK DELIVERY
# ============================================

# Send webhook event to configured endpoints
# Usage: send_webhook <team_name> <event_type> <event_data_json>
send_webhook() {
    local team_name="$1"
    local event_type="$2"
    local event_data="$3"
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        # Silently skip if team not found (may be during cleanup)
        return 0
    fi

    # Check if curl is available
    if ! command -v curl &>/dev/null; then
        return 0  # Silently skip if curl not available
    fi

    # Get webhooks for this team
    local webhooks=$(jq -r --arg event "$event_type" \
        '.webhooks // [] | map(select(.enabled == true and (.events == "*" or .events == $event)))' \
        "$config_file" 2>/dev/null)

    if [[ -z "$webhooks" ]] || [[ "$webhooks" == "[]" ]]; then
        return 0  # No webhooks configured or no matching webhooks
    fi

    # Build webhook payload
    local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    local payload=$(jq -n \
        --arg team "$team_name" \
        --arg event "$event_type" \
        --arg timestamp "$timestamp" \
        --argjson data "$event_data" \
        '{
            team: $team,
            event: $event,
            timestamp: $timestamp,
            data: $data
        }')

    # Send to each webhook endpoint
    echo "$webhooks" | jq -r '.[] | .url' | while IFS= read -r webhook_url; do
        [[ -z "$webhook_url" ]] && continue

        # Send webhook asynchronously (background)
        (
            curl -X POST \
                -H "Content-Type: application/json" \
                -H "User-Agent: Claude-Swarm/1.0" \
                -d "$payload" \
                --max-time 10 \
                --silent \
                --show-error \
                "$webhook_url" &>/dev/null
        ) &
    done
}

# ============================================
# EVENT TRIGGERS
# ============================================

# Trigger a webhook event with proper data formatting
# Usage: trigger_webhook_event <team_name> <event_type> <key1> <value1> [<key2> <value2> ...]
trigger_webhook_event() {
    local team_name="$1"
    local event_type="$2"
    shift 2

    # Build event data from key-value pairs
    local event_data_pairs=""
    while [[ $# -gt 0 ]]; do
        local key="$1"
        local value="$2"
        if [[ -n "$key" ]] && [[ -n "$value" ]]; then
            if [[ -n "$event_data_pairs" ]]; then
                event_data_pairs+=","
            fi
            # Properly escape and quote values
            event_data_pairs+="\"${key}\": $(echo "$value" | jq -R .)"
        fi
        shift 2
    done

    local event_data="{${event_data_pairs}}"

    # Validate JSON
    if ! echo "$event_data" | jq empty 2>/dev/null; then
        echo -e "${YELLOW}Warning: Invalid webhook event data, skipping${NC}" >&2
        return 1
    fi

    send_webhook "$team_name" "$event_type" "$event_data"
}

# Convenience functions for common events

webhook_team_created() {
    local team_name="$1"
    local description="$2"
    trigger_webhook_event "$team_name" "team.created" \
        "teamName" "$team_name" \
        "description" "$description"
}

webhook_team_suspended() {
    local team_name="$1"
    trigger_webhook_event "$team_name" "team.suspended" \
        "teamName" "$team_name"
}

webhook_team_resumed() {
    local team_name="$1"
    trigger_webhook_event "$team_name" "team.resumed" \
        "teamName" "$team_name"
}

webhook_teammate_joined() {
    local team_name="$1"
    local teammate_name="$2"
    local teammate_type="$3"
    trigger_webhook_event "$team_name" "teammate.joined" \
        "teamName" "$team_name" \
        "teammate" "$teammate_name" \
        "type" "$teammate_type"
}

webhook_teammate_left() {
    local team_name="$1"
    local teammate_name="$2"
    trigger_webhook_event "$team_name" "teammate.left" \
        "teamName" "$team_name" \
        "teammate" "$teammate_name"
}

webhook_task_created() {
    local team_name="$1"
    local task_id="$2"
    local subject="$3"
    trigger_webhook_event "$team_name" "task.created" \
        "teamName" "$team_name" \
        "taskId" "$task_id" \
        "subject" "$subject"
}

webhook_task_completed() {
    local team_name="$1"
    local task_id="$2"
    local owner="$3"
    trigger_webhook_event "$team_name" "task.completed" \
        "teamName" "$team_name" \
        "taskId" "$task_id" \
        "owner" "$owner"
}

webhook_message_sent() {
    local team_name="$1"
    local from="$2"
    local to="$3"
    local message_preview="${4:0:100}"  # First 100 chars
    trigger_webhook_event "$team_name" "message.sent" \
        "teamName" "$team_name" \
        "from" "$from" \
        "to" "$to" \
        "preview" "$message_preview"
}

# Export public API
export -f configure_webhooks validate_webhook_config remove_webhook
export -f send_webhook trigger_webhook_event
export -f webhook_team_created webhook_team_suspended webhook_team_resumed
export -f webhook_teammate_joined webhook_teammate_left
export -f webhook_task_created webhook_task_completed webhook_message_sent
