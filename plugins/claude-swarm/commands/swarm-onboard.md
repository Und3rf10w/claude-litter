---
description: Interactive onboarding wizard for new Claude Swarm users - checks prerequisites, guides setup, and walks through first team creation
argument-hint: [--skip-demo]
---

# Claude Swarm Onboarding Wizard

Welcome new users to Claude Swarm with an interactive setup experience.

## Arguments

- `$1` - Optional: `--skip-demo` to skip the guided walkthrough

## Instructions

Execute the following script using bash explicitly:

```bash
bash << 'SCRIPT_EOF'
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-onboarding.sh" 1>/dev/null

SKIP_DEMO=false
[[ "$1" == "--skip-demo" ]] && SKIP_DEMO=true

# Run Phase 1: Prerequisites check
check_swarm_prerequisites

# Phase 2: Conditional kitty configuration
if [[ "${ONBOARD_KITTY_NEEDS_SETUP}" == "true" ]]; then
    # Ask user if they want help with kitty configuration
    # Use AskUserQuestion here
    # If yes, run: guide_kitty_configuration
    # Then verify with find_kitty_socket and validate_kitty_socket
    :
elif [[ "${ONBOARD_HAS_ERRORS}" == "true" ]]; then
    # Other errors (no multiplexer, missing jq)
    echo -e "${RED}Please resolve the issues above before continuing.${NC}"
    echo ""
    echo "After fixing prerequisites, run /claude-swarm:swarm-onboard again."
    exit 0
fi

# Phase 3: Explain concepts
explain_swarm_concepts

# Phase 4: Optional demo walkthrough
if [[ "$SKIP_DEMO" != "true" ]]; then
    # Ask user if they want the guided walkthrough
    # Use AskUserQuestion here
    # If yes, run: run_onboarding_demo
    :
fi

# Phase 5: Ready for real work
show_available_commands

# Ask if user wants to create first real team
# Use AskUserQuestion here
# If yes, get team name and description, then run:
# /claude-swarm:swarm-create <team-name> <description>
SCRIPT_EOF
```

---

## Phase 2 Guidance (Conditional)

**If `ONBOARD_KITTY_NEEDS_SETUP` is true:**

Use AskUserQuestion to ask: "Would you like help configuring kitty for Claude Swarm?"

If yes:

```bash
bash << 'PHASE2_EOF'
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-onboarding.sh" 1>/dev/null
guide_kitty_configuration
PHASE2_EOF
```

Then ask: "Have you added the configuration and restarted kitty?"

If yes, verify:

```bash
bash << 'VERIFY_EOF'
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-onboarding.sh" 1>/dev/null
SOCKET=$(find_kitty_socket)
if [[ -n "$SOCKET" ]] && validate_kitty_socket "$SOCKET" 2>/dev/null; then
    echo -e "${GREEN}✓ Kitty socket is now working!${NC}"
else
    echo -e "${RED}✗ Socket still not detected. Please ensure you completely restarted kitty.${NC}"
fi
VERIFY_EOF
```

---

## Phase 4 Guidance (Conditional)

**If `SKIP_DEMO` is false:**

Use AskUserQuestion to ask: "Would you like a guided walkthrough of the full delegation workflow? This will spawn a team-lead and let it autonomously create a worker."

If yes:

```bash
bash << 'DEMO_EOF'
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-onboarding.sh" 1>/dev/null
run_onboarding_demo
DEMO_EOF
```

**Important:** The demo does NOT auto-cleanup. After the demo completes:
1. Let the user observe the team-lead and demo-buddy interacting in their terminal windows
2. When the user is ready, offer to clean up with: `/claude-swarm:swarm-cleanup <team-name>`
3. The demo exports `ONBOARD_DEMO_TEAM` with the test team name for cleanup

---

## Phase 5 Guidance

After showing available commands, use AskUserQuestion to ask: "Would you like me to help you create your first real team now?"

If yes, ask for team name and description, then run:

```
/claude-swarm:swarm-create <team-name> <description>
```

---

## Reporting

After completing onboarding, summarize:

1. Prerequisites status (all met / issues found)
2. Whether kitty was configured (if applicable)
3. Whether the demo walkthrough was completed (and if team-lead successfully spawned a worker)
4. Whether the demo team is still running (remind to cleanup)
5. Suggest next steps based on their response to creating a real team
