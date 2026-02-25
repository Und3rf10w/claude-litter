---
name: swarm-troubleshooting
description: Diagnostic and recovery guidance for swarm coordination issues. Use this skill when you encounter 'spawn failed', need to 'diagnose team', 'fix swarm', resolve 'status mismatch', perform 'recovery', troubleshoot kitty/tmux issues, or deal with session crashes, multiplexer problems, or teammate failures. Covers diagnostics, spawn failures, status mismatches, recovery procedures, and common error patterns.
---

# Swarm Troubleshooting

This skill provides comprehensive diagnostic and recovery procedures for swarm coordination issues.

## Quick Troubleshooting Examples

### Example 1: Spawn Failure

```bash
# You try to spawn a teammate
/claude-swarm:swarm-spawn "backend-dev" "backend-developer" "sonnet" "..."
# Error: Could not find a valid kitty socket

# 1. Run diagnostics to identify the issue
/claude-swarm:swarm-diagnose my-team

# Output shows: kitty socket not found at expected location

# 2. Check kitty config
grep -E 'allow_remote_control|listen_on' ~/.config/kitty/kitty.conf

# 3. Fix: Add to kitty.conf if missing
# allow_remote_control yes
# listen_on unix:/tmp/kitty-$USER

# 4. Restart kitty completely and retry spawn
```

### Example 2: Teammate Appears Active But Isn't Responding

```bash
# 1. Check if teammates are actually alive
/claude-swarm:swarm-verify my-team
# Output: backend-dev: not found (session crashed)

# 2. Find status mismatches
/claude-swarm:swarm-reconcile my-team
# Output: backend-dev marked active but session missing - recommend removal

# 3. Resume the team (respawns offline members)
/claude-swarm:swarm-resume my-team
```

### Example 3: Status Mismatch After System Restart

```bash
# After rebooting, team config shows active but all sessions are gone

# 1. Check current state
/claude-swarm:swarm-status my-team
# Shows: 3 members active, but multiplexer shows no sessions

# 2. Reconcile to auto-detect mismatches
/claude-swarm:swarm-reconcile my-team --auto-fix
# Automatically marks offline sessions as inactive

# 3. Resume team to respawn all members
/claude-swarm:swarm-resume my-team
```

**Quick diagnostic rule**: Always start with `/claude-swarm:swarm-diagnose <team>` - it runs all health checks and points you to the specific issue.

## Troubleshooting Delegated Teams

When using delegation mode (default), a spawned team-lead handles coordination. This affects how you troubleshoot.

### Who Diagnoses What?

| Issue Type | Who Should Diagnose | Commands |
|------------|---------------------|----------|
| Team-lead unresponsive | You (orchestrator) | `/swarm-diagnose`, `/swarm-status` |
| Worker issues | Team-lead (first), then you | Ask team-lead to run `/swarm-diagnose` |
| Communication failures | Team-lead (first) | Ask team-lead to check and report |
| Task management issues | Team-lead | Team-lead manages tasks |

### Diagnosing When Team-Lead Is Active

If team-lead is working, ask them to diagnose:

```bash
/claude-swarm:swarm-message team-lead "Please run /swarm-diagnose and report any issues"

# Or be more specific:
/claude-swarm:swarm-message team-lead "Worker backend-dev seems stuck. Can you verify they're alive and check their status?"
```

**Why delegate diagnosis?** Team-lead has full context of the team state and can both diagnose and fix issues directly.

### Diagnosing When Team-Lead Is Unresponsive

If team-lead isn't responding, diagnose directly:

```bash
# 1. Check team status
/claude-swarm:swarm-status my-team

# 2. Is team-lead alive?
# Look for "team-lead" in status output - does window exist?

# 3. Run full diagnostics
/claude-swarm:swarm-diagnose my-team

# 4. If team-lead crashed, respawn them
/claude-swarm:swarm-reconcile my-team
/claude-swarm:swarm-spawn "team-lead" "team-lead" "sonnet" "You are the team-lead. Check /swarm-inbox for context. Resume coordination."
```

### When to Intervene Directly

Intervene yourself when:
- Team-lead is unresponsive or crashed
- Multiple workers are down and team-lead isn't handling it
- Critical issue needs immediate resolution
- You need to see raw status (not team-lead's summary)

Let team-lead handle when:
- Individual worker issues (they can respawn)
- Task reassignment (that's their job)
- Communication failures between workers
- Normal operational issues

### Direct Intervention Commands

```bash
# View raw team state (bypassing team-lead)
/claude-swarm:swarm-status my-team
/claude-swarm:task-list

# Diagnose directly
/claude-swarm:swarm-diagnose my-team

# Message workers directly (if team-lead down)
/claude-swarm:swarm-message backend-dev "Team-lead is unresponsive. What's your current status?"

# Broadcast to all (emergency)
/claude-swarm:swarm-broadcast "Team-lead is down. Please pause work and report status."
```

## Diagnostic Approach

### When Things Go Wrong

Swarm coordination involves multiple moving parts: multiplexers (tmux/kitty), Claude Code processes, file system state, and network communication. When issues arise, systematic diagnosis is essential.

**First, identify the symptom category**:

1. **Spawn Issues** - Can't create new teammates
2. **Status Issues** - Config doesn't match reality
3. **Communication Issues** - Messages not delivered
4. **Task Issues** - Task updates fail
5. **Performance Issues** - Slow response, high resource usage

### Diagnostic Commands

Always start with diagnostics before attempting fixes:

```bash
# Comprehensive health check - runs all diagnostics
/claude-swarm:swarm-diagnose <team-name>

# Check if teammates are actually alive
/claude-swarm:swarm-verify <team-name>

# Find and report status mismatches
/claude-swarm:swarm-reconcile <team-name>

# View current team state (members, tasks, multiplexer)
/claude-swarm:swarm-status <team-name>
```

**What these commands check**:

- **swarm-diagnose**: Multiplexer availability, socket connectivity, config validity, file permissions, session health
- **swarm-verify**: Compares config against live sessions, reports dead/zombie processes
- **swarm-reconcile**: Identifies offline sessions marked active, suggests cleanup actions
- **swarm-status**: Shows current state snapshot - use for quick health check

### Diagnostic Decision Tree

````
Issue Detected
│
├─ Can't spawn teammates?
│  └─ Run: /claude-swarm:swarm-diagnose <team>
│     ├─ "Multiplexer not found" → Install tmux/kitty
│     ├─ "Socket not found" → Check kitty config, restart kitty
│     ├─ "Duplicate name" → Use unique name or check existing teammates
│     └─ "Timeout" → Check system resources, retry
│
├─ Status shows teammates but they're not responding?
│  └─ Run: /claude-swarm:swarm-verify <team>
│     └─ Shows "not found" → Sessions crashed
│        └─ Run: /claude-swarm:swarm-reconcile <team>
│           └─ Then: /claude-swarm:swarm-resume <team>
│
├─ Messages not being received?
│  └─ Check: /claude-swarm:swarm-status <team>
│     ├─ Teammate shows "offline" → Respawn teammate
│     ├─ Wrong agent name used → Check exact names
│     └─ Teammate not checking inbox → Send reminder
│
└─ Task commands failing?
   └─ Run: /claude-swarm:task-list
      └─ Verify task ID exists, check status values
````

## Common Issues

### Spawn Failures

Spawn failures are the most common issue when creating swarm teams. Understanding the spawn process helps diagnose failures quickly.

**How spawning works**:
1. Validate team name and agent name (no path traversal, special chars)
2. Detect multiplexer (kitty or tmux)
3. For kitty: Find valid socket, create window with environment variables
4. For tmux: Create new session with environment variables
5. Launch Claude Code process with model and initial prompt
6. Register window/session and update config
7. Wait for Claude Code to become responsive

**Symptoms of spawn failure**:
- `spawn_teammate` or `/claude-swarm:swarm-spawn` returns error
- Error messages about multiplexer not found
- Session/window creation fails
- Timeout waiting for teammate to start
- Process starts but immediately crashes

**Immediate diagnostic steps**:

1. **Check error output** - The error message usually indicates root cause
2. **Run diagnostics**:
```bash
/claude-swarm:swarm-diagnose <team-name>
```

3. **Check system state**:

```bash
# For kitty users
kitten @ ls  # Should list windows without error

# For tmux users
tmux list-sessions  # Should list sessions without error

# Check Claude Code is working
claude --version  # Should show version number
```

**Troubleshooting workflow**:

```
Spawn Command Fails
│
├─ Error mentions "multiplexer"?
│  └─ YES → See "Multiplexer Not Available" below
│
├─ Error mentions "socket"?
│  └─ YES → See "Kitty Socket Issues" below
│
├─ Error mentions "duplicate" or "already exists"?
│  └─ YES → See "Duplicate Agent Names" below
│
├─ Error mentions "timeout"?
│  └─ YES → See "Session Creation Timeout" below
│
├─ Error mentions "invalid" or "path traversal"?
│  └─ YES → See "Path Traversal Validation" below
│
└─ No clear error but spawn fails silently?
   └─ Check: System resources, permissions, Claude Code installation
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

**Deep dive on kitty socket discovery**:

The spawn process tries sockets in this order:

1. `$KITTY_LISTEN_ON` environment variable (if set and valid)
2. Cached socket from previous successful connection
3. `/tmp/kitty-$USER-$KITTY_PID` (exact match for current kitty)
4. All `/tmp/kitty-$USER-*` sockets (newest first)
5. `/tmp/kitty-$USER` (fallback)
6. `/tmp/mykitty` and `/tmp/kitty` (alternative locations)

Each socket is validated with `kitten @ --to $socket ls` before use. If validation fails, the search continues.

**Multiple kitty instances troubleshooting**:

If you have multiple kitty windows open:

```bash
# List all kitty sockets
ls -la /tmp/kitty-$(whoami)-*

# Example output:
# /tmp/kitty-user-12345  (kitty window 1)
# /tmp/kitty-user-67890  (kitty window 2)

# Test each socket
kitten @ --to unix:/tmp/kitty-user-12345 ls
kitten @ --to unix:/tmp/kitty-user-67890 ls

# Set the correct socket for your team-lead window
export KITTY_LISTEN_ON=unix:/tmp/kitty-$(whoami)-$KITTY_PID
```

**Configuration file location varies**:

- Linux: `~/.config/kitty/kitty.conf`
- macOS: `~/.config/kitty/kitty.conf` or `~/Library/Preferences/kitty/kitty.conf`
- Check with: `kitty --debug-config | grep "Config file"`

**Common kitty config issues**:

1. **Config exists but not loaded**: Kitty requires full restart (CMD+Q, not just close window)
2. **Socket path has spaces**: Use quotes in listen_on directive
3. **Multiple listen_on directives**: Only the last one takes effect
4. **Incorrect syntax**: Must be `listen_on unix:/path`, not `listen_on /path`

**Example working kitty.conf**:

```
# ~/.config/kitty/kitty.conf
allow_remote_control yes
listen_on unix:/tmp/kitty-$USER
# Note: $USER expands at kitty startup, then -$PID is appended automatically
```

**Socket permission issues**:

```bash
# Check socket permissions
ls -la /tmp/kitty-$(whoami)-*
# Should show: srw------- (socket, owner read-write-execute only)

# If permissions are wrong:
# 1. Kill kitty completely
# 2. Remove old sockets: rm /tmp/kitty-$(whoami)-*
# 3. Restart kitty (will recreate with correct permissions)
```

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

# Check task files directly
ls ~/.claude/tasks/<team-name>/*.json
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
/claude-swarm:task-update 3 --status "in_progress"
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
# - in_progress
# - blocked
# - in_review
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

When issues are diagnosed, choose the appropriate recovery approach. Three main strategies exist:

**Soft Recovery** - For minor issues (1-3 teammates offline, status mismatches):
```bash
/claude-swarm:swarm-reconcile <team-name>  # Fix status mismatches
/claude-swarm:swarm-resume <team-name>     # Respawn offline teammates
```

**Partial Recovery** - For specific component failures (corrupted inbox, broken task):
```bash
# Reset specific inbox
echo '[]' > ~/.claude/teams/<team-name>/inboxes/<agent>.json

# Fix specific task with jq
jq '.status = "in_progress"' ~/.claude/tasks/<team-name>/<id>.json > /tmp/task-fixed.json
```

**Hard Recovery** - For complete team failure (corrupted config, non-functional team):
```bash
/claude-swarm:swarm-cleanup <team-name> --force
/claude-swarm:swarm-create <team-name> "Team description"
# Recreate tasks and respawn teammates
```

### When to Use Each Strategy

| Symptom              | Recommended Strategy      | Recovery Time |
| -------------------- | ------------------------- | ------------- |
| 1-3 teammates offline| Soft (reconcile + resume) | 30-120 seconds|
| Status mismatch only | Soft (reconcile)          | 10 seconds    |
| Inbox corruption     | Partial (reset inbox)     | 30 seconds    |
| Task file corrupt    | Partial (fix task)        | 1-2 minutes   |
| Config corrupt       | Hard (recreate)           | 5-10 minutes  |
| Everything broken    | Hard (full reset)         | 10-15 minutes |

**For detailed recovery procedures**, consult the Read tool to load **`references/recovery-procedures.md`**, which provides:
- Step-by-step recovery procedures for each strategy
- Recovery decision trees
- Before-recovery checklists
- Performance troubleshooting techniques
- Emergency procedures (nuclear option)
- Resource monitoring guidance

## Prevention Best Practices

Prevention is significantly easier than recovery. Key practices:

### 1. Verify After Creation

Always verify teammates spawned successfully:

```bash
# After spawning team, ALWAYS verify
/claude-swarm:swarm-verify <team-name>
/claude-swarm:swarm-status <team-name>
```

### 2. Use Slash Commands

Slash commands have built-in validation and error handling:

```bash
# Recommended: Use slash commands
/claude-swarm:swarm-spawn "backend-dev" "backend-developer" "sonnet" "Implement API"

# Avoid: Direct bash function calls (unless necessary)
```

### 3. Handle Errors Gracefully

Never retry blindly. Diagnose first, fix, then retry:

```bash
if ! /claude-swarm:swarm-spawn "agent" "worker" "sonnet" "prompt"; then
    /claude-swarm:swarm-diagnose <team-name>  # Diagnose the issue
    # Fix the underlying problem
    # Then retry once
fi
```

### 4. Regular Health Checks

For long-running teams (>1 hour), check health periodically:

```bash
# Every 15-30 minutes during active development
/claude-swarm:swarm-reconcile <team-name>
/claude-swarm:swarm-verify <team-name>
```

### 5. Clean Up Properly

Always use cleanup commands, never manual deletion:

```bash
# Standard cleanup (preserves files for reference)
/claude-swarm:swarm-cleanup <team-name>

# Force cleanup (removes everything)
/claude-swarm:swarm-cleanup <team-name> --force
```

### 6. Initialize Teammates With Clear Context

Provide comprehensive initial prompts:

```bash
/claude-swarm:swarm-spawn "backend-dev" "backend-developer" "sonnet" "You are the backend developer for team my-team. Your tasks: 1) Implement /api/users endpoint in src/api/users.ts, 2) Add database schema in migrations/. Current status: API routes defined, need implementation. Coordinate with frontend-dev for API contract. Check Task #3 for full requirements."
```

**For detailed prevention techniques**, consult **`references/recovery-procedures.md`** for:
- Resource monitoring guidance
- Team size recommendations
- Automated health check scripts
- Team architecture documentation templates

## Environment Variables

When debugging, these environment variables are set for spawned teammates:

| Variable                   | Description                      |
| -------------------------- | -------------------------------- |
| `CLAUDE_CODE_TEAM_NAME`    | Current team name                |
| `CLAUDE_CODE_AGENT_ID`     | Agent's unique UUID              |
| `CLAUDE_CODE_AGENT_NAME`   | Agent name (e.g., "backend-dev") |
| `CLAUDE_CODE_AGENT_TYPE`   | Agent role type                  |
| `CLAUDE_CODE_TEAM_LEAD_ID` | Team lead's UUID                 |
| `CLAUDE_CODE_AGENT_COLOR`  | Agent display color              |
| `KITTY_LISTEN_ON`          | Kitty socket path (kitty only)   |

User-configurable:

| Variable            | Description             | Default     |
| ------------------- | ----------------------- | ----------- |
| `SWARM_MULTIPLEXER` | Force "tmux" or "kitty" | Auto-detect |
| `SWARM_KITTY_MODE`  | Kitty spawn mode        | `split`     |

## Quick Reference

| Issue                  | Quick Fix                                      |
| ---------------------- | ---------------------------------------------- |
| Spawn fails            | Run `/claude-swarm:swarm-diagnose`             |
| Status mismatch        | Run `/claude-swarm:swarm-reconcile`            |
| Session crashed        | Run `/claude-swarm:swarm-resume`               |
| Messages not received  | Verify agent name, check inbox                 |
| Invalid task ID        | Run `/claude-swarm:task-list` to see IDs       |
| Team creation fails    | Check permissions, use valid name              |
| Kitty socket not found | Check `listen_on` in kitty.conf, restart kitty |
| Cleanup incomplete     | Use `--force` flag                             |

## Related Skills

- **swarm-orchestration** - User/orchestrator workflow for creating teams and delegating
- **swarm-team-lead** - Guidance for spawned team-leads on coordination
- **swarm-teammate** - Guidance for workers within a swarm

## Additional Resources

### Reference Files

For detailed recovery and performance guidance, consult:
- **`references/recovery-procedures.md`** - Comprehensive recovery strategies, performance troubleshooting, emergency procedures, and resource monitoring

