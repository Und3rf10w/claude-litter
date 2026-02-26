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
  • Delegate coordination to an auto-spawned team-lead
  • Track tasks and communicate via file-based inboxes
  • Suspend and resume teams across sessions

📦 CORE CONCEPTS:
  • Team: A group of Claude instances with shared tasks and messages
  • Team-lead: A spawned Claude instance that coordinates workers
  • Teammates: Spawned Claude instances with specific roles (workers)
  • Tasks: Work items that can be assigned and tracked
  • Messages: File-based inbox system for coordination

🔄 DELEGATION WORKFLOW (default):
  1. You create a team (a team-lead is auto-spawned)
  2. You brief the team-lead with your requirements
  3. Team-lead spawns workers and assigns tasks
  4. Workers execute in parallel, reporting to team-lead
  5. Team-lead coordinates, unblocks, and reports back to you
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
    echo -e "${BLUE}=== Phase 4: Guided Walkthrough (Full Delegation Demo) ===${NC}"
    echo ""

    # Use PID to create unique test team name
    TEST_TEAM="onboarding-test-$$"

    echo "This demo shows the full delegation workflow:"
    echo "  You → create team → team-lead spawns → brief team-lead → team-lead spawns worker"
    echo ""

    # Step 1: Create team (creates config, directories, pre-seeds team-lead member)
    echo -e "${CYAN}[1/8] Creating test team...${NC}"
    create_team "$TEST_TEAM" "Onboarding walkthrough demo team"
    echo -e "  ${GREEN}✓${NC} Team created at ~/.claude/teams/${TEST_TEAM}/"
    echo ""
    sleep 1

    # Step 2: Create a task for the team-lead to delegate
    echo -e "${CYAN}[2/8] Creating a demo task...${NC}"
    TASK_ID=$(create_task "$TEST_TEAM" "Say hello" "A simple test task: print a friendly greeting. This demonstrates the task lifecycle.")
    echo -e "  ${GREEN}✓${NC} Created task #${TASK_ID}"
    echo ""
    sleep 1

    # Step 3: Spawn team-lead (mirrors /swarm-create default behavior)
    echo -e "${CYAN}[3/8] Spawning team-lead...${NC}"
    echo "  This will open a new ${SWARM_MULTIPLEXER:-kitty} window with a Claude Code team-lead."
    echo "  The team-lead will coordinate workers autonomously."
    echo ""

    # Use haiku for the demo to keep it fast and cheap
    LEAD_PROMPT="You are the team-lead for an onboarding demo team called '${TEST_TEAM}'.

This is a quick onboarding demo to show the user how swarm delegation works.

Your instructions:
1. First, load the swarm-team-lead skill: /claude-swarm:swarm-team-lead
2. Check your inbox: /claude-swarm:swarm-inbox
3. Follow the briefing message you receive there.

Keep responses brief - this is a demo."

    if spawn_teammate "$TEST_TEAM" "team-lead" "team-lead" "haiku" "$LEAD_PROMPT" "" "" "" "${CLAUDE_PLUGIN_ROOT:-}" "CLAUDE_CODE_IS_TEAM_LEAD=true"; then
        echo -e "  ${GREEN}✓${NC} Team-lead spawned"
    else
        echo -e "  ${RED}✗${NC} Failed to spawn team-lead"
        echo "  Cleaning up..."
        cleanup_team "$TEST_TEAM" "force"
        return 1
    fi
    echo ""

    # Step 4: Wait for team-lead to initialize
    echo -e "${CYAN}[4/8] Waiting for team-lead to initialize...${NC}"
    sleep 5

    LIVE_AGENTS=$(get_live_agents "$TEST_TEAM")
    if echo "$LIVE_AGENTS" | grep -q "team-lead"; then
        echo -e "  ${GREEN}✓${NC} Team-lead is alive"
    else
        echo -e "  ${YELLOW}⚠️${NC}  Team-lead not detected yet (might still be starting)"
        echo "     Check your ${SWARM_MULTIPLEXER:-kitty} for the new window"
        sleep 5
    fi
    echo ""

    # Step 5: Brief the team-lead via message (this is what the user does in real workflows)
    echo -e "${CYAN}[5/8] Briefing team-lead via inbox message...${NC}"
    echo "  In real use, you brief the team-lead with your requirements."
    echo "  The team-lead then autonomously spawns workers and assigns tasks."
    echo ""

    BRIEFING="ONBOARDING DEMO BRIEFING:

This is a quick demo. Please do the following:
1. Spawn one worker named 'demo-buddy' using: /claude-swarm:swarm-spawn demo-buddy worker haiku
2. Once demo-buddy is spawned, assign task #${TASK_ID} to demo-buddy using: /claude-swarm:task-update ${TASK_ID} --assign demo-buddy --status in_progress
3. Send demo-buddy a message telling them to complete task #${TASK_ID} using: /claude-swarm:swarm-message demo-buddy Please complete task #${TASK_ID} - just say hello!
4. After sending the message, report back your status using: /claude-swarm:swarm-message team-lead Demo delegation complete

Keep it fast and brief - this is just a demo walkthrough."

    # Export CLAUDE_CODE_AGENT_NAME temporarily so send_message uses 'orchestrator' as sender
    local old_agent_name="${CLAUDE_CODE_AGENT_NAME:-}"
    export CLAUDE_CODE_AGENT_NAME="orchestrator"
    send_message "$TEST_TEAM" "team-lead" "$BRIEFING"
    export CLAUDE_CODE_AGENT_NAME="$old_agent_name"

    echo ""

    # Step 6: Wait for team-lead to process and spawn demo-buddy
    echo -e "${CYAN}[6/8] Waiting for team-lead to spawn demo-buddy...${NC}"
    echo "  Watch the team-lead window - it should read the briefing and spawn a worker."
    echo "  This may take 30-60 seconds as the team-lead processes the request."
    echo ""

    local max_wait=90
    local waited=0
    local interval=5
    local buddy_found=false

    while [[ $waited -lt $max_wait ]]; do
        sleep $interval
        waited=$((waited + interval))

        LIVE_AGENTS=$(get_live_agents "$TEST_TEAM")
        if echo "$LIVE_AGENTS" | grep -q "demo-buddy"; then
            buddy_found=true
            echo -e "  ${GREEN}✓${NC} demo-buddy spawned by team-lead! (${waited}s)"
            break
        fi

        # Show progress every 15 seconds
        if (( waited % 15 == 0 )); then
            echo -e "  ${CYAN}...${waited}s elapsed, still waiting for demo-buddy${NC}"
        fi
    done

    if [[ "$buddy_found" != "true" ]]; then
        echo -e "  ${YELLOW}⚠️${NC}  demo-buddy not detected after ${max_wait}s"
        echo "     The team-lead may still be processing. Check the team-lead window."
    fi
    echo ""

    # Step 7: Show team status
    echo -e "${CYAN}[7/8] Team status:${NC}"
    echo ""
    swarm_status "$TEST_TEAM"
    echo ""

    # Step 8: Return team name for cleanup (don't auto-cleanup - let user observe)
    echo -e "${CYAN}[8/8] Demo complete!${NC}"
    echo ""
    echo "The demo team '${TEST_TEAM}' is still running so you can observe the agents."
    echo ""
    echo "Things to try:"
    echo "  • Watch the team-lead and demo-buddy windows interact"
    echo "  • Run /claude-swarm:swarm-status ${TEST_TEAM} to check status"
    echo "  • Run /claude-swarm:task-list to see task assignments"
    echo "  • Run /claude-swarm:swarm-inbox to check messages"
    echo ""
    echo "When done observing, clean up with:"
    echo "  /claude-swarm:swarm-cleanup ${TEST_TEAM}"
    echo ""

    # Export team name so the command can reference it
    export ONBOARD_DEMO_TEAM="$TEST_TEAM"
}

# ============================================
# PHASE 5: Ready for Real Work
# ============================================

show_available_commands() {
    echo -e "${BLUE}=== Phase 5: You're Ready! ===${NC}"
    echo ""
    echo -e "${GREEN}🎉 You're all set to use Claude Swarm!${NC}"
    echo ""
    echo "Quick Start (delegation mode - recommended):"
    echo "  /claude-swarm:swarm-create <team> [desc]     Create team + auto-spawn team-lead"
    echo "  → Brief the team-lead via message, then let it coordinate!"
    echo ""
    echo "Available Commands:"
    echo ""
    echo "  Team Management:"
    echo "    /claude-swarm:swarm-create <team> [desc]     Create a new team (auto-spawns lead)"
    echo "    /claude-swarm:swarm-spawn <name> [type]      Spawn a teammate"
    echo "    /claude-swarm:swarm-status [team]            View team status"
    echo "    /claude-swarm:swarm-cleanup [team]           Suspend/delete team"
    echo "    /claude-swarm:swarm-resume [team]            Resume suspended team"
    echo ""
    echo "  Task Management:"
    echo "    /claude-swarm:task-create <subject>          Create a task"
    echo "    /claude-swarm:task-list                      List all tasks"
    echo "    /claude-swarm:task-update <id> [opts]        Update a task"
    echo ""
    echo "  Communication:"
    echo "    /claude-swarm:swarm-message <to> <msg>       Send a message"
    echo "    /claude-swarm:swarm-inbox                    Check your inbox"
    echo "    /claude-swarm:swarm-broadcast <msg>          Message all teammates"
    echo ""
    echo "  Diagnostics:"
    echo "    /claude-swarm:swarm-diagnose [team]          Diagnose issues"
    echo "    /claude-swarm:swarm-verify [team]            Verify teammates"
    echo "    /claude-swarm:swarm-reconcile [team]         Fix mismatches"
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
