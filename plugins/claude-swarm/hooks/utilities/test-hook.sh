#!/bin/bash
# test-hook.sh - Tests individual hook execution with simulated inputs
# Usage: test-hook.sh <hook-script-path> [--tool-input <json>] [--reason <text>]
#
# Tests a hook script by:
# - Setting up environment variables
# - Optionally providing simulated tool input
# - Measuring execution time
# - Capturing and displaying output
# - Reporting exit status
#
# Examples:
#   test-hook.sh ../session-start.sh
#   test-hook.sh ../exit-plan-swarm.sh --tool-input '{"parameters":{"path":"/test"}}'
#   test-hook.sh ../session-stop.sh --reason "Testing shutdown"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source guard - prevent sourcing
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
    echo "Error: This script should be executed, not sourced" >&2
    return 1
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Usage
show_usage() {
    cat <<EOF
Usage: test-hook.sh <hook-script-path> [options]

Options:
  --tool-input <json>    Simulated tool input JSON (sets TOOL_INPUT env var)
  --reason <text>        Reason text (sets REASON env var)
  --team <name>          Team name (sets CLAUDE_CODE_TEAM_NAME)
  --agent <name>         Agent name (sets CLAUDE_CODE_AGENT_NAME)
  --async                Run in async mode (don't wait for output)
  --help                 Show this help message

Examples:
  # Test session start hook
  test-hook.sh ../session-start.sh

  # Test with team context
  test-hook.sh ../session-start.sh --team "test-team" --agent "researcher"

  # Test exit plan mode hook with tool input
  test-hook.sh ../exit-plan-swarm.sh --tool-input '{"parameters":{"path":"/test"}}'

  # Test session stop with reason
  test-hook.sh ../session-stop.sh --reason "Testing shutdown"

EOF
}

# Parse arguments
if [[ $# -eq 0 ]] || [[ "$1" == "--help" ]]; then
    show_usage
    exit 0
fi

HOOK_SCRIPT="$1"
shift

# Check if hook script exists
if [[ ! -f "$HOOK_SCRIPT" ]]; then
    echo -e "${RED}Error: Hook script not found: $HOOK_SCRIPT${NC}" >&2
    exit 1
fi

# Check if hook script is executable
if [[ ! -x "$HOOK_SCRIPT" ]]; then
    echo -e "${YELLOW}Warning: Hook script is not executable: $HOOK_SCRIPT${NC}" >&2
    echo "Making it executable..."
    chmod +x "$HOOK_SCRIPT"
fi

# Parse optional arguments
TOOL_INPUT=""
REASON=""
TEAM_NAME=""
AGENT_NAME=""
ASYNC_MODE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --tool-input)
            TOOL_INPUT="$2"
            shift 2
            ;;
        --reason)
            REASON="$2"
            shift 2
            ;;
        --team)
            TEAM_NAME="$2"
            shift 2
            ;;
        --agent)
            AGENT_NAME="$2"
            shift 2
            ;;
        --async)
            ASYNC_MODE=true
            shift
            ;;
        *)
            echo -e "${RED}Error: Unknown option: $1${NC}" >&2
            show_usage
            exit 1
            ;;
    esac
done

# Display test header
echo -e "${CYAN}=============================================="
echo "Hook Test Runner"
echo -e "==============================================${NC}"
echo ""
echo -e "${BLUE}Hook script:${NC} $HOOK_SCRIPT"

if [[ -n "$TEAM_NAME" ]]; then
    echo -e "${BLUE}Team:${NC} $TEAM_NAME"
fi

if [[ -n "$AGENT_NAME" ]]; then
    echo -e "${BLUE}Agent:${NC} $AGENT_NAME"
fi

if [[ -n "$TOOL_INPUT" ]]; then
    echo -e "${BLUE}Tool input:${NC}"
    echo "$TOOL_INPUT" | jq . 2>/dev/null || echo "$TOOL_INPUT"
fi

if [[ -n "$REASON" ]]; then
    echo -e "${BLUE}Reason:${NC} $REASON"
fi

if [[ "$ASYNC_MODE" == true ]]; then
    echo -e "${BLUE}Mode:${NC} Async"
fi

echo ""
echo -e "${CYAN}==============================================${NC}"
echo ""

# Create temporary files for output capture
TEMP_STDOUT=$(mktemp)
TEMP_STDERR=$(mktemp)

# Cleanup on exit
cleanup() {
    rm -f "$TEMP_STDOUT" "$TEMP_STDERR"
}
trap cleanup EXIT

# Set up environment variables
export CLAUDE_PLUGIN_ROOT="${SCRIPT_DIR}/../.."

if [[ -n "$TOOL_INPUT" ]]; then
    # Validate JSON if tool input provided
    if ! echo "$TOOL_INPUT" | jq empty 2>/dev/null; then
        echo -e "${RED}Error: Invalid JSON in --tool-input${NC}" >&2
        exit 1
    fi
    export TOOL_INPUT
fi

if [[ -n "$REASON" ]]; then
    export REASON
fi

if [[ -n "$TEAM_NAME" ]]; then
    export CLAUDE_CODE_TEAM_NAME="$TEAM_NAME"
fi

if [[ -n "$AGENT_NAME" ]]; then
    export CLAUDE_CODE_AGENT_NAME="$AGENT_NAME"
fi

# Execute hook and measure time
echo -e "${YELLOW}Running hook...${NC}"
echo ""

START_TIME=$(date +%s%N)

if [[ "$ASYNC_MODE" == true ]]; then
    # Run in background, capture PID
    bash "$HOOK_SCRIPT" >"$TEMP_STDOUT" 2>"$TEMP_STDERR" &
    HOOK_PID=$!

    echo -e "${BLUE}Started hook in background (PID: $HOOK_PID)${NC}"
    echo "Use 'ps $HOOK_PID' to check if still running"

    EXIT_CODE=0
    ELAPSED_TIME=0
else
    # Run synchronously
    set +e
    bash "$HOOK_SCRIPT" >"$TEMP_STDOUT" 2>"$TEMP_STDERR"
    EXIT_CODE=$?
    set -e

    END_TIME=$(date +%s%N)
    ELAPSED_TIME=$(( (END_TIME - START_TIME) / 1000000 )) # Convert to milliseconds
fi

# Display output
if [[ "$ASYNC_MODE" != true ]]; then
    echo -e "${CYAN}=============================================="
    echo "Hook Output"
    echo -e "==============================================${NC}"
    echo ""

    # Display stdout
    if [[ -s "$TEMP_STDOUT" ]]; then
        echo -e "${BLUE}STDOUT:${NC}"
        cat "$TEMP_STDOUT"
        echo ""
    else
        echo -e "${YELLOW}(No stdout output)${NC}"
        echo ""
    fi

    # Display stderr
    if [[ -s "$TEMP_STDERR" ]]; then
        echo -e "${BLUE}STDERR:${NC}"
        cat "$TEMP_STDERR"
        echo ""
    fi

    echo -e "${CYAN}=============================================="
    echo "Test Results"
    echo -e "==============================================${NC}"
    echo ""

    echo -e "${BLUE}Execution time:${NC} ${ELAPSED_TIME}ms"

    if [[ $EXIT_CODE -eq 0 ]]; then
        echo -e "${BLUE}Exit code:${NC} ${GREEN}$EXIT_CODE (success)${NC}"
    else
        echo -e "${BLUE}Exit code:${NC} ${RED}$EXIT_CODE (failure)${NC}"
    fi

    echo ""

    if [[ $EXIT_CODE -eq 0 ]]; then
        echo -e "${GREEN}✓ Hook executed successfully${NC}"
    else
        echo -e "${RED}✗ Hook execution failed${NC}"
    fi

    exit $EXIT_CODE
fi
