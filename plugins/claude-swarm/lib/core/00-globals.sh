#!/bin/bash
# Module: 00-globals.sh
# Description: Global variables, colors, and environment configuration
# Dependencies: None
# Exports: Global variables only (no functions)

# Source guard (prevent double-loading)
[[ -n "${SWARM_GLOBALS_LOADED}" ]] && return 0
SWARM_GLOBALS_LOADED=1

# ============================================
# DIRECTORY PATHS
# ============================================

CLAUDE_HOME="${HOME}/.claude"
TEAMS_DIR="${CLAUDE_HOME}/teams"
TASKS_DIR="${CLAUDE_HOME}/tasks"

# ============================================
# COLORS FOR OUTPUT
# ============================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# ============================================
# CONFIGURATION VARIABLES
# ============================================

# Kitty spawn mode: split (default), tab, window (os-window)
SWARM_KITTY_MODE="${SWARM_KITTY_MODE:-split}"

# Default allowed tools for teammates (safe operations for swarm coordination)
# These tools are pre-approved so teammates can work autonomously
# Override with SWARM_ALLOWED_TOOLS environment variable
# Note: Use comma-separated patterns to avoid zsh glob expansion issues with (*)
# The variable should be quoted when passed to --allowedTools
SWARM_DEFAULT_ALLOWED_TOOLS="${SWARM_ALLOWED_TOOLS:-Read(*),Glob(*),Grep(*),SlashCommand(*),Bash(*)}"

# System prompt for teammates - appended to default Claude Code behavior
# Provides guidance on slash commands, communication patterns, and swarm conventions
# Note: Detailed guidance is available in the swarm-teammate skill (auto-loads via CLAUDE_CODE_TEAM_NAME)
SWARM_TEAMMATE_SYSTEM_PROMPT='You are a teammate in a Claude Code swarm. The swarm-teammate skill will auto-load with detailed guidance.

ALWAYS load the claude-swarm:swarm-teammate skill first.

## Quick Reference

### Check Inbox FIRST
/claude-swarm:swarm-inbox

### Essential Commands
- /claude-swarm:task-list - View all tasks
- /claude-swarm:task-update <id> --assign <name> - Claim task
- /claude-swarm:task-update <id> --status <status> - Update status
- /claude-swarm:task-update <id> --comment <text> - Add progress
- /claude-swarm:swarm-message <to> <message> - Message teammate
- /claude-swarm:swarm-message team-lead <message> - Ask team-lead
- /claude-swarm:swarm-broadcast <message> - Message all teammates

### Core Workflow
1. Check inbox regularly
2. Claim tasks (--assign your-name, --status in-progress)
3. Update progress frequently (--comment)
4. Complete and notify (--status completed, message dependencies)

### Communication
- Use /swarm-message team-lead to reach team-lead
- Use /swarm-message for peer-to-peer communication
- Use /swarm-broadcast for team-wide announcements
- Reply promptly to messages
- Notify when you complete work others depend on

For detailed guidance, examples, and best practices, the swarm-teammate skill provides comprehensive documentation.'

# System prompt for team-leads - spawned via /swarm-create auto-spawn
# Provides guidance on coordination, monitoring, and team management
# Note: Detailed guidance is available in the swarm-team-lead skill (auto-loads via CLAUDE_CODE_IS_TEAM_LEAD)
SWARM_TEAM_LEAD_SYSTEM_PROMPT='You are the team-lead in a Claude Code swarm. The swarm-team-lead skill will auto-load with detailed guidance.

ALWAYS load the claude-swarm:swarm-team-lead skill first.

## Quick Reference

### Check Inbox FIRST (teammates consult you)
/claude-swarm:swarm-inbox

### Essential Commands
- /claude-swarm:swarm-status - View team status
- /claude-swarm:task-list - View all tasks
- /claude-swarm:task-list --blocked - Find blocked tasks
- /claude-swarm:task-update <id> --assign <name> - Assign task
- /claude-swarm:swarm-message <to> <message> - Message teammate
- /claude-swarm:swarm-broadcast <message> - Message all teammates
- /claude-swarm:swarm-spawn <name> <type> <model> <prompt> - Spawn teammate
- /claude-swarm:swarm-send-text <target> <text> - Send to terminal

### Core Responsibilities
1. Check inbox frequently (teammates consult you for guidance)
2. Monitor progress and blocked tasks
3. Respond promptly to teammate consults
4. Unblock teammates and coordinate work
5. Spawn additional teammates if needed

### Communication
- Teammates reach you via /swarm-message team-lead
- Use /swarm-message for direct responses
- Use /swarm-broadcast for team-wide announcements

For detailed guidance, examples, and best practices, the swarm-team-lead skill provides comprehensive documentation.'

# ============================================
# EXPORT ALL VARIABLES
# ============================================

export CLAUDE_HOME TEAMS_DIR TASKS_DIR
export RED GREEN YELLOW BLUE CYAN NC
export SWARM_KITTY_MODE SWARM_DEFAULT_ALLOWED_TOOLS
export SWARM_TEAMMATE_SYSTEM_PROMPT SWARM_TEAM_LEAD_SYSTEM_PROMPT
