#!/bin/bash
# Claude Swarm Onboarding Wizard
# One-time interactive setup for new users

# Source core utilities - use CLAUDE_PLUGIN_ROOT if set, otherwise detect from script location
if [[ -n "$CLAUDE_PLUGIN_ROOT" ]]; then
    source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null
else
    # Detect script directory (same robust method as swarm-utils.sh)
    if [[ -n "${BASH_SOURCE[0]}" ]]; then
        _ONBOARD_SCRIPT_PATH="${BASH_SOURCE[0]}"
    elif [[ -n "${ZSH_VERSION}" ]]; then
        _ONBOARD_SCRIPT_PATH="${(%):-%x}"
    else
        _ONBOARD_SCRIPT_PATH="$0"
    fi

    if [[ -n "$_ONBOARD_SCRIPT_PATH" ]]; then
        if command -v realpath &>/dev/null; then
            _ONBOARD_LIB_DIR="$(dirname "$(realpath "$_ONBOARD_SCRIPT_PATH")")"
        else
            _ONBOARD_LIB_DIR="$(cd "$(dirname "$_ONBOARD_SCRIPT_PATH")" 2>/dev/null && pwd)"
        fi
        source "${_ONBOARD_LIB_DIR}/swarm-utils.sh" 1>/dev/null
        unset _ONBOARD_SCRIPT_PATH _ONBOARD_LIB_DIR
    fi
fi

# ============================================
# PHASE 1: Prerequisites Check
# ============================================

check_swarm_prerequisites() {
    echo -e "${BLUE}=== Phase 1: Prerequisites Check ===${NC}"
    echo ""

    HAS_ERRORS=false
    KITTY_NEEDS_SETUP=false

    # Check multiplexer
    echo "Terminal Multiplexer:"
    MULTIPLEXER=$(detect_multiplexer)
    if [[ "$MULTIPLEXER" == "kitty" ]]; then
        echo -e "  ${GREEN}✓${NC} kitty detected"
    elif [[ "$MULTIPLEXER" == "tmux" ]]; then
        echo -e "  ${GREEN}✓${NC} tmux detected"
    else
        echo -e "  ${RED}✗${NC} No multiplexer detected"
        echo "    Install kitty (recommended) or tmux"
        HAS_ERRORS=true
    fi
    echo ""

    # Check jq
    echo "Dependencies:"
    if command -v jq &>/dev/null; then
        echo -e "  ${GREEN}✓${NC} jq installed"
    else
        echo -e "  ${RED}✗${NC} jq not found"
        echo "    Install: brew install jq (macOS) or apt install jq (Linux)"
        HAS_ERRORS=true
    fi
    echo ""

    # Check kitty socket if applicable
    if [[ "$MULTIPLEXER" == "kitty" ]]; then
        echo "Kitty Configuration:"
        SOCKET=$(find_kitty_socket)
        if [[ -n "$SOCKET" ]] && validate_kitty_socket "$SOCKET" 2>/dev/null; then
            echo -e "  ${GREEN}✓${NC} Socket found and healthy: ${SOCKET}"
        else
            echo -e "  ${RED}✗${NC} Socket not found or unhealthy"
            KITTY_NEEDS_SETUP=true
            HAS_ERRORS=true
        fi
        echo ""
    fi

    # Summary
    if [[ "$HAS_ERRORS" == "true" ]]; then
        echo -e "${YELLOW}⚠️  Some prerequisites need attention (see above)${NC}"
    else
        echo -e "${GREEN}✓ All prerequisites met!${NC}"
    fi
    echo ""

    # Return status via global variables (bash limitation for returning complex state)
    export ONBOARD_HAS_ERRORS="$HAS_ERRORS"
    export ONBOARD_KITTY_NEEDS_SETUP="$KITTY_NEEDS_SETUP"
}

# ============================================
# PHASE 2: Kitty Configuration Wizard
# ============================================

guide_kitty_configuration() {
    echo -e "${BLUE}=== Phase 2: Kitty Configuration ===${NC}"
    echo ""
    echo "Claude Swarm needs these settings in your kitty.conf:"
    echo ""
    echo -e "${CYAN}# Add to ~/.config/kitty/kitty.conf${NC}"
    echo -e "${GREEN}allow_remote_control yes${NC}"
    echo -e "${GREEN}listen_on unix:/tmp/kitty-\$USER${NC}"
    echo ""
    echo -e "${YELLOW}Note: Kitty automatically appends -PID to the socket path.${NC}"
    echo -e "${YELLOW}So the actual socket will be /tmp/kitty-username-12345${NC}"
    echo ""
    echo "After adding these lines, you must:"
    echo "1. Save the file"
    echo "2. Completely restart kitty (Cmd+Q on macOS, close all windows on Linux)"
    echo "3. Reopen kitty and run Claude Code again"
    echo ""
}

# ============================================
# PHASE 3: Concept Introduction
# ============================================

explain_swarm_concepts() {
    echo -e "${BLUE}=== Phase 3: Understanding Claude Swarm ===${NC}"
    echo ""
    command cat <<'CONCEPTS'
Claude Swarm enables you to run multiple Claude Code instances working together:

🎯 WHAT IT DOES:
  • Spawn parallel Claude instances in separate terminal windows
  • Assign different tasks to specialized teammates
  • Coordinate work through messages and task tracking
  • Suspend and resume teams across sessions

📦 CORE CONCEPTS:
  • Team: A group of Claude instances with shared tasks and messages
  • Team-lead: Your current session (you coordinate the work)
  • Teammates: Spawned Claude instances with specific roles
  • Tasks: Work items that can be assigned and tracked
  • Messages: File-based inbox system for coordination

🔄 TYPICAL WORKFLOW:
  1. Create a team for your project
  2. Break down work into tasks
  3. Spawn teammates (backend-dev, frontend-dev, tester, etc.)
  4. Assign tasks to teammates
  5. Teammates work in parallel, report progress
  6. Suspend team when done, resume later if needed

💡 WHEN TO USE:
  • Large features with independent components
  • Tasks that benefit from parallel execution
  • Work requiring different specializations
  • Projects spanning multiple sessions

CONCEPTS
    echo ""
}

# ============================================
# PHASE 4: Guided Demo Walkthrough
# ============================================

run_onboarding_demo() {
    echo -e "${BLUE}=== Phase 4: Guided Walkthrough ===${NC}"
    echo ""

    # Use PID to create unique test team name
    TEST_TEAM="onboarding-test-$$"

    echo "Creating a test team to demonstrate swarm features..."
    echo ""

    # Step 1: Create team
    echo -e "${CYAN}[1/6] Creating test team...${NC}"
    create_team "$TEST_TEAM" "Test team for onboarding walkthrough"
    echo -e "  ${GREEN}✓${NC} Team created at ~/.claude/teams/${TEST_TEAM}/"
    echo ""
    sleep 1

    # Step 2: Create task
    echo -e "${CYAN}[2/6] Creating a test task...${NC}"
    TASK_ID=$(create_task "$TEST_TEAM" "Test Task" "This is a demonstration task")
    echo -e "  ${GREEN}✓${NC} Created task #${TASK_ID}"
    echo ""
    sleep 1

    # Step 3: Spawn teammate
    echo -e "${CYAN}[3/6] Spawning a test teammate...${NC}"
    echo "  This will open a new ${SWARM_MULTIPLEXER} window/session"
    echo "  Look for a new Claude Code instance starting up..."
    echo ""

    spawn_teammate "$TEST_TEAM" "demo-buddy" "worker" "haiku" \
      "You are a test teammate for the onboarding walkthrough. Please respond with: Hello from demo-buddy! I am ready to work. Then wait for further instructions."

    echo -e "  ${GREEN}✓${NC} Spawned 'demo-buddy'"
    echo ""

    # Step 4: Wait and verify
    echo -e "${CYAN}[4/6] Verifying teammate is alive...${NC}"
    echo "  Waiting for teammate to initialize..."
    sleep 4

    LIVE_AGENTS=$(get_live_agents "$TEST_TEAM")
    if echo "$LIVE_AGENTS" | grep -q "demo-buddy"; then
        echo -e "  ${GREEN}✓${NC} demo-buddy is alive and ready!"
    else
        echo -e "  ${YELLOW}⚠️${NC}  demo-buddy not detected yet (might still be starting)"
        echo "     Check your ${SWARM_MULTIPLEXER} for the new session"
    fi
    echo ""

    # Step 5: Show status
    echo -e "${CYAN}[5/6] Team status:${NC}"
    echo ""
    swarm_status "$TEST_TEAM"
    echo ""

    # Step 6: Cleanup
    echo -e "${CYAN}[6/6] Cleanup${NC}"
    echo ""
    echo "The test is complete! Cleaning up the test team..."
    echo ""
    cleanup_team "$TEST_TEAM" "force"
    echo -e "${GREEN}✓ Test team cleaned up${NC}"
    echo ""
}

# ============================================
# PHASE 5: Ready for Real Work
# ============================================

show_available_commands() {
    echo -e "${BLUE}=== Phase 5: You're Ready! ===${NC}"
    echo ""
    echo -e "${GREEN}🎉 You're all set to use Claude Swarm!${NC}"
    echo ""
    echo "Available Commands:"
    echo ""
    echo "  Team Management:"
    echo "    /claude-swarm:swarm-create <team> [desc]     Create a new team"
    echo "    /claude-swarm:swarm-spawn <name> [type]      Spawn a teammate"
    echo "    /claude-swarm:swarm-status <team>            View team status"
    echo "    /claude-swarm:swarm-cleanup <team>           Suspend/delete team"
    echo "    /claude-swarm:swarm-resume <team>            Resume suspended team"
    echo ""
    echo "  Task Management:"
    echo "    /claude-swarm:task-create <subject>          Create a task"
    echo "    /claude-swarm:task-list                      List all tasks"
    echo "    /claude-swarm:task-update <id> [opts]        Update a task"
    echo ""
    echo "  Communication:"
    echo "    /claude-swarm:swarm-message <to> <msg>       Send a message"
    echo "    /claude-swarm:swarm-inbox                    Check your inbox"
    echo ""
    echo "  Diagnostics:"
    echo "    /claude-swarm:swarm-diagnose <team>          Diagnose issues"
    echo "    /claude-swarm:swarm-verify <team>            Verify teammates"
    echo "    /claude-swarm:swarm-reconcile <team>         Fix mismatches"
    echo ""
    echo "For detailed guidance anytime, use: /claude-swarm:swarm-guide"
    echo ""
}

# ============================================
# ORCHESTRATOR: Main Onboarding Flow
# ============================================

run_onboarding_wizard() {
    local skip_demo="${1:-false}"

    # Welcome banner
    echo -e "${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║           Welcome to Claude Swarm Onboarding!              ║${NC}"
    echo -e "${CYAN}╚════════════════════════════════════════════════════════════╝${NC}"
    echo ""

    # Phase 1: Check prerequisites
    check_swarm_prerequisites

    # Handle prerequisite errors
    if [[ "${ONBOARD_HAS_ERRORS}" == "true" ]]; then
        if [[ "${ONBOARD_KITTY_NEEDS_SETUP}" == "true" ]]; then
            # Offer kitty configuration help
            echo "Would you like help configuring kitty for Claude Swarm?"
            echo ""
            # Note: Command will use AskUserQuestion here
            # If user says yes, call: guide_kitty_configuration
        else
            # Other errors (no multiplexer, missing jq)
            echo -e "${RED}Please resolve the issues above before continuing.${NC}"
            echo ""
            echo "After fixing prerequisites, run /claude-swarm:swarm-onboard again."
            return 1
        fi
    fi

    # Phase 3: Explain concepts
    explain_swarm_concepts

    # Phase 4: Optional demo
    if [[ "$skip_demo" != "true" ]]; then
        # Note: Command will use AskUserQuestion: "Want guided walkthrough?"
        # If user says yes, call: run_onboarding_demo
        echo ""
    fi

    # Phase 5: Ready for real work
    show_available_commands

    # Note: Command will use AskUserQuestion: "Create first real team?"
    # If yes, command will call /claude-swarm:swarm-create with user input
}

# Export all functions for use in commands
export -f check_swarm_prerequisites
export -f guide_kitty_configuration
export -f explain_swarm_concepts
export -f run_onboarding_demo
export -f show_available_commands
export -f run_onboarding_wizard
