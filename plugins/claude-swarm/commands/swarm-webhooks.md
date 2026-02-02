---
description: Configure webhook notifications for team events
argument-hint: <team_name> <action> [args...]
---

# Swarm Webhooks

Configure outbound webhook notifications for team events.

## Arguments

- `$1` - Team name (required)
- `$2` - Action: add, remove, list, test (required)
- `$3+` - Additional arguments depending on action

## Actions

### add
Add a webhook endpoint for team events.

**Usage:** `/swarm-webhooks <team> add <url> [event_filter]`

- `url` - Webhook endpoint URL (must start with http:// or https://)
- `event_filter` - Event filter pattern (default: "*" for all events)

**Event types:**
- `team.created` - Team was created
- `team.suspended` - Team was suspended
- `team.resumed` - Team was resumed
- `teammate.joined` - New teammate joined
- `teammate.left` - Teammate left team
- `task.created` - New task created
- `task.completed` - Task marked completed
- `message.sent` - Message sent between teammates
- `*` - All events (default)

### remove
Remove a webhook endpoint.

**Usage:** `/swarm-webhooks <team> remove <url>`

### list
List all configured webhooks for the team.

**Usage:** `/swarm-webhooks <team> list`

### test
Send a test webhook event to verify configuration.

**Usage:** `/swarm-webhooks <team> test <url>`

## Instructions

Execute the following script using bash explicitly:

```bash
bash << 'SCRIPT_EOF'
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null

TEAM_NAME="$1"
ACTION="$2"

if [[ -z "$TEAM_NAME" ]]; then
    echo "Error: Team name required"
    echo "Usage: /swarm-webhooks <team_name> <action> [args...]"
    echo ""
    echo "Actions:"
    echo "  add <url> [event_filter]  - Add webhook endpoint"
    echo "  remove <url>              - Remove webhook endpoint"
    echo "  list                      - List configured webhooks"
    echo "  test <url>                - Send test webhook"
    exit 1
fi

if [[ -z "$ACTION" ]]; then
    echo "Error: Action required (add, remove, list, test)"
    echo "Usage: /swarm-webhooks <team_name> <action> [args...]"
    exit 1
fi

case "$ACTION" in
    add)
        WEBHOOK_URL="$3"
        EVENT_FILTER="${4:-*}"

        if [[ -z "$WEBHOOK_URL" ]]; then
            echo "Error: Webhook URL required"
            echo "Usage: /swarm-webhooks <team> add <url> [event_filter]"
            exit 1
        fi

        configure_webhooks "$TEAM_NAME" "$WEBHOOK_URL" "$EVENT_FILTER"
        ;;

    remove)
        WEBHOOK_URL="$3"

        if [[ -z "$WEBHOOK_URL" ]]; then
            echo "Error: Webhook URL required"
            echo "Usage: /swarm-webhooks <team> remove <url>"
            exit 1
        fi

        remove_webhook "$TEAM_NAME" "$WEBHOOK_URL"
        ;;

    list)
        validate_webhook_config "$TEAM_NAME"
        ;;

    test)
        WEBHOOK_URL="$3"

        if [[ -z "$WEBHOOK_URL" ]]; then
            echo "Error: Webhook URL required"
            echo "Usage: /swarm-webhooks <team> test <url>"
            exit 1
        fi

        echo "Sending test webhook to: $WEBHOOK_URL"

        # Send test event
        trigger_webhook_event "$TEAM_NAME" "webhook.test" \
            "message" "This is a test webhook from Claude Swarm" \
            "timestamp" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

        echo "Test webhook sent. Check your endpoint for delivery."
        ;;

    *)
        echo "Error: Unknown action '$ACTION'"
        echo "Valid actions: add, remove, list, test"
        exit 1
        ;;
esac
SCRIPT_EOF
```

Report:

1. Confirmation of the action taken
2. Current webhook configuration (for add/list actions)
3. Any errors encountered

## Examples

```bash
# Add webhook for all events
/swarm-webhooks my-team add https://example.com/webhook

# Add webhook for task events only
/swarm-webhooks my-team add https://example.com/tasks task.created

# List configured webhooks
/swarm-webhooks my-team list

# Remove webhook
/swarm-webhooks my-team remove https://example.com/webhook

# Test webhook
/swarm-webhooks my-team test https://example.com/webhook
```

## Webhook Payload Format

Webhooks receive POST requests with JSON payloads:

```json
{
  "team": "my-team",
  "event": "task.created",
  "timestamp": "2025-12-16T10:00:00Z",
  "data": {
    "teamName": "my-team",
    "taskId": "5",
    "subject": "Implement feature X"
  }
}
```
