#!/bin/bash
# validate-hook-schema.sh - Validates hooks.json structure and configuration
# Usage: validate-hook-schema.sh [path-to-hooks.json]
#
# Validates:
# - JSON syntax
# - Required top-level fields (description, hooks)
# - Hook structure (type, command/prompt fields)
# - Matcher patterns for regex validity
# - File existence for command hooks
#
# Returns: 0 if valid, 1 if invalid

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source guard - prevent sourcing
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
    echo "Error: This script should be executed, not sourced" >&2
    return 1
fi

# Determine hooks.json path
if [[ $# -eq 1 ]]; then
    HOOKS_FILE="$1"
else
    HOOKS_FILE="${SCRIPT_DIR}/../hooks.json"
fi

# Check if file exists
if [[ ! -f "$HOOKS_FILE" ]]; then
    echo "Error: hooks.json not found at: $HOOKS_FILE" >&2
    exit 1
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

errors=0
warnings=0

echo "Validating hooks configuration: $HOOKS_FILE"
echo "=============================================="
echo ""

# Validate JSON syntax
if ! jq empty "$HOOKS_FILE" 2>/dev/null; then
    echo -e "${RED}✗ Invalid JSON syntax${NC}"
    jq . "$HOOKS_FILE" 2>&1 | head -5
    exit 1
fi
echo -e "${GREEN}✓ Valid JSON syntax${NC}"

# Validate required top-level fields
if ! jq -e '.description' "$HOOKS_FILE" >/dev/null 2>&1; then
    echo -e "${RED}✗ Missing required field: description${NC}"
    ((errors++))
else
    echo -e "${GREEN}✓ Found description field${NC}"
fi

if ! jq -e '.hooks' "$HOOKS_FILE" >/dev/null 2>&1; then
    echo -e "${RED}✗ Missing required field: hooks${NC}"
    ((errors++))
    exit 1
else
    echo -e "${GREEN}✓ Found hooks field${NC}"
fi

echo ""
echo "Validating hook definitions..."
echo "=============================================="

# Valid hook event types
VALID_EVENTS=("Notification" "SessionStart" "SessionEnd" "PostToolUse" "PreToolUse" "SubagentStop")

# Get all hook events
events=$(jq -r '.hooks | keys[]' "$HOOKS_FILE")

for event in $events; do
    echo ""
    echo "Event: $event"

    # Check if valid event type
    if [[ ! " ${VALID_EVENTS[@]} " =~ " ${event} " ]]; then
        echo -e "  ${YELLOW}⚠ Warning: Unknown event type '$event'${NC}"
        ((warnings++))
    fi

    # Get hook definitions for this event
    hook_count=$(jq ".hooks.${event} | length" "$HOOKS_FILE")

    for ((i=0; i<hook_count; i++)); do
        echo "  Hook definition #$((i+1)):"

        # Check matcher field (optional but should be valid if present)
        matcher=$(jq -r ".hooks.${event}[$i].matcher // \"null\"" "$HOOKS_FILE")
        if [[ "$matcher" != "null" ]]; then
            echo "    Matcher: $matcher"

            # Matchers are tool name patterns, not full regex
            # Common patterns: "ToolName", "Tool1|Tool2", "*" (wildcard)
            # Only warn on obviously invalid patterns
            if [[ "$matcher" =~ ^[*]$ ]] || [[ "$matcher" =~ ^[a-zA-Z0-9_|]+$ ]]; then
                # Valid pattern (wildcard or simple tool names with pipe)
                :
            else
                echo -e "    ${YELLOW}⚠ Warning: Unusual matcher pattern: $matcher${NC}"
                echo "       Expected: ToolName, Tool1|Tool2, or *"
                ((warnings++))
            fi
        fi

        # Check hooks array
        if ! jq -e ".hooks.${event}[$i].hooks" "$HOOKS_FILE" >/dev/null 2>&1; then
            echo -e "    ${RED}✗ Missing 'hooks' array${NC}"
            ((errors++))
            continue
        fi

        # Validate each hook in the hooks array
        hook_items_count=$(jq ".hooks.${event}[$i].hooks | length" "$HOOKS_FILE")

        for ((j=0; j<hook_items_count; j++)); do
            echo "    Hook item #$((j+1)):"

            # Check type field
            hook_type=$(jq -r ".hooks.${event}[$i].hooks[$j].type // \"null\"" "$HOOKS_FILE")
            if [[ "$hook_type" == "null" ]]; then
                echo -e "      ${RED}✗ Missing 'type' field${NC}"
                ((errors++))
                continue
            fi

            echo "      Type: $hook_type"

            # Validate based on type
            case "$hook_type" in
                "command")
                    # Check command field
                    command=$(jq -r ".hooks.${event}[$i].hooks[$j].command // \"null\"" "$HOOKS_FILE")
                    if [[ "$command" == "null" ]]; then
                        echo -e "      ${RED}✗ Missing 'command' field for command type${NC}"
                        ((errors++))
                    else
                        echo "      Command: $command"

                        # Expand environment variables if present
                        # Set CLAUDE_PLUGIN_ROOT if not set (for validation purposes)
                        if [[ -z "${CLAUDE_PLUGIN_ROOT:-}" ]]; then
                            export CLAUDE_PLUGIN_ROOT="${SCRIPT_DIR}/../.."
                        fi
                        expanded_command=$(eval echo "$command")

                        # Check if command file exists (basic check)
                        if [[ "$expanded_command" =~ ^/ ]] || [[ "$expanded_command" =~ ^\. ]]; then
                            # It's a path, check if it exists
                            if [[ ! -f "$expanded_command" ]]; then
                                echo -e "      ${YELLOW}⚠ Warning: Command file not found: $expanded_command${NC}"
                                ((warnings++))
                            else
                                # Check if executable
                                if [[ ! -x "$expanded_command" ]]; then
                                    echo -e "      ${YELLOW}⚠ Warning: Command file not executable: $expanded_command${NC}"
                                    ((warnings++))
                                else
                                    echo -e "      ${GREEN}✓ Command file exists and is executable${NC}"
                                fi
                            fi
                        fi
                    fi

                    # Check async field (optional)
                    async=$(jq -r ".hooks.${event}[$i].hooks[$j].async // \"null\"" "$HOOKS_FILE")
                    if [[ "$async" != "null" ]]; then
                        echo "      Async: $async"
                    fi
                    ;;

                "prompt")
                    # Check prompt field
                    prompt=$(jq -r ".hooks.${event}[$i].hooks[$j].prompt // \"null\"" "$HOOKS_FILE")
                    if [[ "$prompt" == "null" ]]; then
                        echo -e "      ${RED}✗ Missing 'prompt' field for prompt type${NC}"
                        ((errors++))
                    else
                        prompt_preview=$(echo "$prompt" | head -c 60)
                        echo "      Prompt: ${prompt_preview}..."

                        # Check for common placeholders
                        if [[ "$prompt" =~ \$TOOL_INPUT ]] || [[ "$prompt" =~ \$REASON ]]; then
                            echo -e "      ${GREEN}✓ Uses expected placeholders${NC}"
                        fi
                    fi

                    # Check timeout field (optional)
                    timeout=$(jq -r ".hooks.${event}[$i].hooks[$j].timeout // \"null\"" "$HOOKS_FILE")
                    if [[ "$timeout" != "null" ]]; then
                        echo "      Timeout: ${timeout}s"

                        # Validate timeout is a number
                        if ! [[ "$timeout" =~ ^[0-9]+$ ]]; then
                            echo -e "      ${RED}✗ Timeout must be a number${NC}"
                            ((errors++))
                        fi
                    fi
                    ;;

                *)
                    echo -e "      ${RED}✗ Unknown hook type: $hook_type${NC}"
                    ((errors++))
                    ;;
            esac
        done
    done
done

echo ""
echo "=============================================="
echo "Validation Summary:"
echo "=============================================="

if [[ $errors -eq 0 ]] && [[ $warnings -eq 0 ]]; then
    echo -e "${GREEN}✓ All checks passed!${NC}"
    exit 0
elif [[ $errors -eq 0 ]]; then
    echo -e "${YELLOW}⚠ ${warnings} warning(s) found${NC}"
    exit 0
else
    echo -e "${RED}✗ ${errors} error(s) found${NC}"
    if [[ $warnings -gt 0 ]]; then
        echo -e "${YELLOW}⚠ ${warnings} warning(s) found${NC}"
    fi
    exit 1
fi
