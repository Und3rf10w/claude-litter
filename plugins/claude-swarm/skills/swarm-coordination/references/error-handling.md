# Error Handling and Recovery

This guide covers common issues in swarm coordination, diagnostic approaches, and recovery strategies.

## Diagnostic Commands

Before attempting recovery, diagnose the issue:

```bash
# Comprehensive health check
/claude-swarm:swarm-diagnose <team-name>

# Check teammate status
/claude-swarm:swarm-verify <team-name>

# Check for status mismatches
/claude-swarm:swarm-reconcile <team-name>

# View team status
/claude-swarm:swarm-status <team-name>
```

## Common Issues

### Spawn Failures

**Symptoms:**
- spawn_teammate or `/claude-swarm:swarm-spawn` fails
- Error messages about multiplexer not found
- Session creation fails

**Diagnosis:**

1. Check error output from spawn command
2. Run diagnostics:
```bash
/claude-swarm:swarm-diagnose <team-name>
```

**Common Causes:**

#### 1. Multiplexer Not Available

**Error:**
```
Error: Neither tmux nor kitty is available
```

**Solution:**
```bash
# Install tmux (macOS)
brew install tmux

# Or install kitty
brew install --cask kitty

# Verify installation
which tmux  # or: which kitty
```

#### 2. Duplicate Agent Names

**Error:**
```
Error: Agent name 'backend-dev' already exists in team
```

**Solution:**
```bash
# Use unique names
/claude-swarm:swarm-spawn "backend-dev-2" "backend-developer" "sonnet" "..."

# Or check existing teammates first
/claude-swarm:swarm-status <team-name>
```

#### 3. Kitty Socket Issues

**Error (kitty):**
```
Error: Could not find a valid kitty socket
```

**Solution:**
```bash
# 1. Verify kitty config has remote control enabled
grep -E 'allow_remote_control|listen_on' ~/.config/kitty/kitty.conf
# Should show:
#   allow_remote_control yes
#   listen_on unix:/tmp/kitty-$USER

# 2. Check socket exists (kitty appends -PID to path)
ls -la /tmp/kitty-$(whoami)-*

# 3. Test socket connectivity
kitten @ ls

# 4. Restart kitty completely if needed (not just reload)

# 5. Or manually set socket path
export KITTY_LISTEN_ON=unix:/tmp/kitty-$(whoami)-$KITTY_PID
```

**Note:** Kitty creates sockets at `/tmp/kitty-$USER-$PID`. The plugin auto-discovers the correct socket, but if you have multiple kitty instances, you may need to set `KITTY_LISTEN_ON` explicitly.

#### 4. Path Traversal Validation

**Error:**
```
Error: Invalid team name (path traversal detected)
```

**Solution:**
```bash
# Use simple team names without special characters
# Good: "auth-team", "feature-x", "bugfix_123"
# Bad: "../other-team", "team/name", "team..name"
```

#### 5. Session Creation Timeout

**Error:**
```
Error: Timeout waiting for teammate session to start
```

**Solution:**
```bash
# Retry once (may be transient)
/claude-swarm:swarm-spawn "agent-name" ...

# Check system resources
top  # Look for high CPU/memory usage

# Verify multiplexer is responsive
tmux list-sessions  # or: kitty @ ls
```

**Recovery Steps:**

1. **Identify which spawn failed** - Check error messages
2. **Run diagnostics** - Use swarm-diagnose
3. **Fix underlying issue** - Install multiplexer, fix permissions, etc.
4. **Retry spawn** - Same command should work after fix
5. **Verify success** - Use swarm-verify
6. **Adjust plan if persistent** - Reduce team size or reassign tasks

### Status Mismatches

**Symptoms:**
- Config shows teammate as "active" but session is dead
- Session exists but not in config
- Conflicting status information

**Diagnosis:**

```bash
/claude-swarm:swarm-reconcile <team-name>
```

This will report:
- Offline sessions still marked active
- Zombie config entries
- Active sessions not in config
- Status inconsistencies

**Common Causes:**

#### 1. Teammate Session Crashed

**Detection:**
```bash
# Config shows active, but session doesn't exist
/claude-swarm:swarm-verify <team-name>
# Output: "Error: Session swarm-team-agent not found"
```

**Solution:**
```bash
# Run reconcile to update status
/claude-swarm:swarm-reconcile <team-name>

# Respawn the teammate
/claude-swarm:swarm-spawn "agent-name" "agent-type" "model" "prompt"

# Or resume the team (respawns all offline)
/claude-swarm:swarm-resume <team-name>
```

#### 2. Manual Session Kill

**Detection:**
User manually killed tmux/kitty session outside of cleanup command

**Solution:**
```bash
# Reconcile will detect and fix
/claude-swarm:swarm-reconcile <team-name>

# Respawn if needed
/claude-swarm:swarm-spawn "agent-name" ...
```

#### 3. Incomplete Cleanup

**Detection:**
Sessions killed but config files remain

**Solution:**
```bash
# Run cleanup properly
/claude-swarm:swarm-cleanup <team-name> --force

# Or manually remove config
rm ~/.claude/teams/<team-name>/config.json
```

### Communication Failures

**Symptoms:**
- Messages not received by teammates
- Inbox shows no messages when some were sent
- Message command succeeds but teammate never sees it

**Diagnosis:**

```bash
# Check team status
/claude-swarm:swarm-status <team-name>

# Verify teammate is alive
/claude-swarm:swarm-verify <team-name>

# Check inbox manually
cat ~/.claude/teams/<team-name>/inboxes/<agent-name>.json
```

**Common Causes:**

#### 1. Teammate Not Checking Inbox

**Solution:**
- Remind teammates to run `/claude-swarm:swarm-inbox` regularly
- Include inbox check in teammate initial prompts
- Send follow-up message or use broadcast

#### 2. Wrong Agent Name

**Error:**
```
Error: Agent 'backend' not found in team
```

**Solution:**
```bash
# Check exact agent names
/claude-swarm:swarm-status <team-name>

# Use exact name from status output
/claude-swarm:swarm-message "backend-dev" "message"  # Not "backend"
```

#### 3. Inbox File Corruption

**Symptoms:**
Inbox command fails or shows garbled output

**Solution:**
```bash
# Back up current inbox
cp ~/.claude/teams/<team-name>/inboxes/<agent>.json ~/.claude/teams/<team-name>/inboxes/<agent>.json.bak

# Reset inbox
echo '[]' > ~/.claude/teams/<team-name>/inboxes/<agent>.json

# Notify sender to resend messages
```

### Task Management Issues

**Symptoms:**
- Task updates not reflected in task list
- Cannot assign task to teammate
- Task IDs don't match

**Diagnosis:**

```bash
# View current tasks
/claude-swarm:task-list

# Check task file directly
cat ~/.claude/tasks/<team-name>/tasks.json
```

**Common Causes:**

#### 1. Invalid Task ID

**Error:**
```
Error: Task #99 not found
```

**Solution:**
```bash
# List tasks to see valid IDs
/claude-swarm:task-list

# Use correct ID from list
/claude-swarm:task-update 3 --status "in-progress"
```

#### 2. Invalid Status Value

**Error:**
```
Error: Invalid status 'done'
```

**Solution:**
```bash
# Use valid status values:
# - pending
# - in-progress
# - blocked
# - in-review
# - completed

/claude-swarm:task-update 3 --status "completed"  # Not "done"
```

#### 3. Assigning to Non-Existent Agent

**Error:**
```
Error: Agent 'frontend' not found in team
```

**Solution:**
```bash
# Check exact agent names
/claude-swarm:swarm-status <team-name>

# Use exact name
/claude-swarm:task-update 3 --assign "frontend-dev"
```

### Team Creation Issues

**Symptoms:**
- Team creation fails
- Directory permission errors
- Config file not created

**Diagnosis:**

```bash
# Check if team directory exists
ls -la ~/.claude/teams/<team-name>/

# Check permissions
ls -la ~/.claude/teams/
```

**Common Causes:**

#### 1. Team Already Exists

**Error:**
```
Error: Team 'my-team' already exists
```

**Solution:**
```bash
# Choose different name
/claude-swarm:swarm-create "my-team-2" "description"

# Or cleanup old team first
/claude-swarm:swarm-cleanup "my-team" --force
```

#### 2. Permission Denied

**Error:**
```
Error: Permission denied creating ~/.claude/teams/my-team/
```

**Solution:**
```bash
# Fix permissions on Claude directory
chmod 700 ~/.claude/
chmod 700 ~/.claude/teams/

# Retry creation
/claude-swarm:swarm-create "my-team" "description"
```

#### 3. Invalid Team Name

**Error:**
```
Error: Invalid team name
```

**Solution:**
```bash
# Use alphanumeric with hyphens/underscores
# Good: "feature-auth", "bugfix_123", "team2"
# Bad: "../team", "team name", "team/123"
```

## Recovery Strategies

### Soft Recovery

Fix issues without losing data:

```bash
# Update status to match reality
/claude-swarm:swarm-reconcile <team-name>

# Respawn failed teammates
/claude-swarm:swarm-spawn "agent-name" ...

# Resume entire team
/claude-swarm:swarm-resume <team-name>
```

### Hard Recovery

Start fresh (loses task comments, inbox messages):

```bash
# Full cleanup
/claude-swarm:swarm-cleanup <team-name> --force

# Recreate team
/claude-swarm:swarm-create <team-name> "description"

# Recreate tasks
/claude-swarm:task-create "subject" "description"

# Respawn teammates
/claude-swarm:swarm-spawn ...
```

### Partial Recovery

Fix specific components:

```bash
# Reset specific inbox
echo '[]' > ~/.claude/teams/<team-name>/inboxes/<agent>.json

# Reset specific task
# Edit ~/.claude/tasks/<team-name>/tasks.json manually

# Respawn specific teammate
/claude-swarm:swarm-spawn "agent-name" ...
```

## Prevention Best Practices

### 1. Verify After Creation

```bash
# After spawning team, always verify
/claude-swarm:swarm-verify <team-name>

# Check status looks correct
/claude-swarm:swarm-status <team-name>
```

### 2. Use Slash Commands

Slash commands include built-in validation and error handling:

```bash
# Good
/claude-swarm:swarm-spawn "agent" "worker" "sonnet" "prompt"

# Riskier (less validation)
spawn_teammate "team" "agent" "worker" "sonnet" "prompt"
```

### 3. Handle Errors Gracefully

```bash
# Don't just retry blindly
if ! /claude-swarm:swarm-spawn "agent" ...; then
    # Diagnose first
    /claude-swarm:swarm-diagnose <team-name>

    # Then fix and retry
    # ...
fi
```

### 4. Regular Health Checks

During long-running coordination:

```bash
# Periodically verify team health
/claude-swarm:swarm-verify <team-name>

# Check for status drift
/claude-swarm:swarm-reconcile <team-name>
```

### 5. Clean Up Properly

Always use cleanup commands, not manual deletion:

```bash
# Good
/claude-swarm:swarm-cleanup <team-name>

# Bad
rm -rf ~/.claude/teams/<team-name>/  # May leave orphaned sessions
```

## Emergency Procedures

### Nuclear Option: Full Reset

If everything is broken:

```bash
# 1. Kill all swarm sessions
tmux kill-server  # or manually kill kitty windows

# 2. Remove all swarm data
rm -rf ~/.claude/teams/
rm -rf ~/.claude/tasks/

# 3. Recreate directories
mkdir -p ~/.claude/teams/
mkdir -p ~/.claude/tasks/

# 4. Start fresh
/claude-swarm:swarm-create "new-team" "description"
```

**WARNING:** This destroys all team data. Only use as last resort.

### Debugging Commands

For deep investigation:

```bash
# List all tmux sessions
tmux list-sessions

# Attach to specific teammate session (view their work)
tmux attach-session -t swarm-<team>-<agent>

# Check socket status
ls -la ~/.claude/sockets/

# View raw config
cat ~/.claude/teams/<team-name>/config.json

# View raw tasks
cat ~/.claude/tasks/<team-name>/tasks.json

# View raw inbox
cat ~/.claude/teams/<team-name>/inboxes/<agent>.json
```

## Getting Help

If you can't resolve an issue:

1. **Run diagnostics** and save output:
```bash
/claude-swarm:swarm-diagnose <team-name> > diagnosis.txt
```

2. **Capture team state**:
```bash
/claude-swarm:swarm-status <team-name> > status.txt
cat ~/.claude/teams/<team-name>/config.json > config.txt
```

3. **Document steps to reproduce**:
- What commands were run
- What error messages appeared
- What the expected behavior was

4. **Report issue** with diagnostic information to maintainers

## Environment Variables

When debugging, these environment variables are set for spawned teammates:

| Variable | Description |
|----------|-------------|
| `CLAUDE_CODE_TEAM_NAME` | Current team name |
| `CLAUDE_CODE_AGENT_ID` | Agent's unique UUID |
| `CLAUDE_CODE_AGENT_NAME` | Agent name (e.g., "backend-dev") |
| `CLAUDE_CODE_AGENT_TYPE` | Agent role type |
| `CLAUDE_CODE_TEAM_LEAD_ID` | Team lead's UUID |
| `CLAUDE_CODE_AGENT_COLOR` | Agent display color |
| `KITTY_LISTEN_ON` | Kitty socket path (kitty only) |

User-configurable:

| Variable | Description | Default |
|----------|-------------|---------|
| `SWARM_MULTIPLEXER` | Force "tmux" or "kitty" | Auto-detect |
| `SWARM_KITTY_MODE` | Kitty spawn mode | `split` |

## Quick Reference

| Issue | Quick Fix |
|-------|-----------|
| Spawn fails | Run `/claude-swarm:swarm-diagnose` |
| Status mismatch | Run `/claude-swarm:swarm-reconcile` |
| Session crashed | Run `/claude-swarm:swarm-resume` |
| Messages not received | Verify agent name, check inbox |
| Invalid task ID | Run `/claude-swarm:task-list` to see IDs |
| Team creation fails | Check permissions, use valid name |
| Kitty socket not found | Check `listen_on` in kitty.conf, restart kitty |
| Cleanup incomplete | Use `--force` flag |
