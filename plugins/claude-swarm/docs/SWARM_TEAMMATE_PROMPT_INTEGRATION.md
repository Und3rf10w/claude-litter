# SWARM_TEAMMATE_SYSTEM_PROMPT Integration Guide

This document specifies how to integrate the swarm-teammate skill with the teammate system prompt.

## Current Implementation

Located in `lib/core/00-globals.sh`:

```bash
SWARM_TEAMMATE_SYSTEM_PROMPT="You are a teammate in a Claude Code swarm. Follow these guidelines:

## Communication
- Use /claude-swarm:swarm-message <to> <message> to message ANY teammate (not just team-lead)
- Use /claude-swarm:swarm-inbox to check for messages from teammates
- Reply to messages by messaging the sender directly
- When tasks complete, notify both team-lead AND any teammates who may be waiting

## Slash Commands (PREFERRED)
ALWAYS use slash commands instead of bash functions:
- /claude-swarm:task-list - View all tasks
- /claude-swarm:task-update <id> --status <status> - Update task status
- /claude-swarm:task-update <id> --comment <text> - Add progress comment
- /claude-swarm:swarm-status <team> - View team status
- /claude-swarm:swarm-message <to> <message> - Send message to teammate
- /claude-swarm:swarm-inbox - Check your inbox

## Working Style
- Check your inbox regularly for messages from teammates
- Update task status as you progress (add comments for major milestones)
- When blocked, message the relevant teammate or team-lead
- Coordinate with teammates working on related tasks"
```

## Required Changes

### Step 1: Reference swarm-teammate skill

Update the prompt to explicitly reference the swarm-teammate skill, ensuring it auto-loads:

```bash
SWARM_TEAMMATE_SYSTEM_PROMPT="You are a teammate in a Claude Code swarm. You have access to the swarm-teammate skill which provides detailed coordination guidelines.

## Core Responsibilities

1. **Communication**: Use /claude-swarm:swarm-inbox and /claude-swarm:swarm-message to coordinate
2. **Task Management**: Update your task status with /claude-swarm:task-update
3. **Coordination**: Work with team-lead and peer teammates on shared goals

Refer to the swarm-teammate skill for complete coordination protocols, communication patterns, and best practices."
```

### Step 2: Remove Duplication

The new prompt should be **much shorter** because detailed guidance is now in the swarm-teammate skill. The system prompt should:

1. ✅ Establish teammate identity
2. ✅ Reference the swarm-teammate skill
3. ✅ Highlight core responsibilities
4. ❌ **NOT duplicate** detailed commands (those are in the skill)
5. ❌ **NOT duplicate** communication patterns (those are in the skill)

### Step 3: Skill Auto-Trigger Mechanism

The swarm-teammate skill should auto-trigger based on environment variables, not just the system prompt reference. Ensure:

```yaml
# In skills/swarm-teammate/SKILL.md frontmatter
---
name: swarm-teammate
when: |
  Load this skill automatically when CLAUDE_CODE_TEAM_NAME environment variable is set.
  This indicates Claude Code is running as a spawned swarm teammate.
---
```

## Integration Benefits

### Before (Current System Prompt)
- **Token cost**: ~400 tokens
- **Maintainability**: Hard to update (bash variable)
- **Duplication**: Commands repeated in prompt + skill
- **Total teammate context**: 3,500 tokens (old swarm-coordination)

### After (New System Prompt + Skill)
- **Prompt token cost**: ~100 tokens (75% reduction)
- **Skill token cost**: ~1,200 tokens
- **Total teammate context**: ~1,300 tokens (63% reduction)
- **Maintainability**: Easy to update (skill file)
- **No duplication**: Commands only in skill

## Implementation Checklist

When integrating swarm-teammate skill with system prompt:

- [ ] Create skills/swarm-teammate/SKILL.md with auto-trigger condition
- [ ] Update `lib/core/00-globals.sh` SWARM_TEAMMATE_SYSTEM_PROMPT
- [ ] Reduce prompt to ~100 tokens (remove detailed commands)
- [ ] Add explicit skill reference in prompt
- [ ] Test spawning teammate: verify skill loads automatically
- [ ] Verify prompt + skill total ≤ 1,500 tokens
- [ ] Confirm no command duplication between prompt and skill
- [ ] Test teammate can access all coordination commands
- [ ] Verify team-lead does NOT get swarm-teammate skill

## Testing Integration

### Test 1: Verify Auto-Load
```bash
# Spawn a teammate
/claude-swarm:swarm-spawn test-worker worker sonnet "check if swarm-teammate skill loaded"

# In teammate session, verify:
# 1. swarm-teammate skill is loaded
# 2. Skill loaded automatically (no manual trigger)
# 3. CLAUDE_CODE_TEAM_NAME environment variable is set
```

### Test 2: Verify Token Reduction
```bash
# In teammate session, check context window
# Total tokens should be:
# - System prompt: ~100 tokens
# - swarm-teammate skill: ~1,200 tokens
# - Total: ~1,300 tokens (vs 3,900 before: 400 prompt + 3,500 old skill)
```

### Test 3: Verify No Duplication
```bash
# Compare system prompt to skill SKILL.md
# Ensure slash commands NOT listed in both places
# Communication patterns should be in skill only
# Prompt should just reference the skill
```

## Example: Updated lib/core/00-globals.sh

```bash
#!/bin/bash
# Global variables and configuration for swarm system

# ... [other globals] ...

# System prompt for spawned teammates
# This prompt establishes teammate identity and references swarm-teammate skill
# The skill provides detailed coordination protocols (auto-loads via CLAUDE_CODE_TEAM_NAME)
SWARM_TEAMMATE_SYSTEM_PROMPT="You are a teammate in a Claude Code swarm. The swarm-teammate skill has been loaded automatically and provides complete coordination guidelines.

Your core responsibilities:
- Communication: Check inbox and message teammates regularly
- Task Management: Update task status and add progress comments
- Coordination: Work collaboratively with team-lead and peers

Refer to the swarm-teammate skill for detailed protocols, slash commands, and best practices."
```

## Migration Notes

### Breaking Changes
- None (system prompt is internal, not user-facing API)

### Backward Compatibility
- Existing teammates will continue working with old prompt
- New spawns will use new prompt + skill
- Can deploy without disruption

### Rollback Plan
If integration has issues:
1. Revert `lib/core/00-globals.sh` to previous version
2. Keep swarm-teammate skill (won't auto-load without env trigger)
3. Team-lead can still manually load skill if needed

## Success Criteria

Integration is successful when:
1. ✅ Teammates auto-load swarm-teammate skill on spawn
2. ✅ System prompt reduced to ~100 tokens
3. ✅ No command duplication between prompt and skill
4. ✅ Total teammate context ≤ 1,500 tokens
5. ✅ All coordination commands accessible
6. ✅ No regression in teammate functionality
7. ✅ Token savings: ~2,500 tokens per teammate

## Questions / Issues

If you encounter issues during integration:
- Check that CLAUDE_CODE_TEAM_NAME is set correctly in spawn commands
- Verify skill frontmatter has correct `when:` condition
- Test with fresh Claude Code session (avoid caching)
- Compare actual token counts to expected (use Claude API)
