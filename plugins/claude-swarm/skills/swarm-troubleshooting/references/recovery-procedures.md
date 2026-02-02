# Recovery Procedures and Advanced Troubleshooting

This reference provides detailed recovery strategies, performance troubleshooting, and emergency procedures for swarm coordination issues.

## Recovery Strategies

Choosing the right recovery strategy depends on the severity of the issue, how much work would be lost, and whether the team can continue working. This section provides decision-making guidance for recovery scenarios.

### Recovery Decision Tree

```
Problem Diagnosed
│
├─ Are teammates still working successfully?
│  └─ YES → Use Soft Recovery (minimal disruption)
│     ├─ 1-2 teammates offline → Respawn just those teammates
│     ├─ Status mismatch only → Run reconcile
│     └─ Communication issue → Fix inbox, notify teammates
│
├─ Is critical work in progress?
│  └─ YES → Evaluate data loss risk
│     ├─ Work saved to files/commits? → Safe to use Hard Recovery
│     ├─ Work only in memory/history? → Try Partial Recovery first
│     └─ Uncertain? → Ask teammates to save work first
│
├─ Is the team completely non-functional?
│  └─ YES → Assess what can be salvaged
│     ├─ Tasks/config readable? → Use Partial Recovery
│     ├─ Files corrupted? → Use Hard Recovery
│     └─ Everything broken? → Nuclear option (full reset)
│
└─ Is this a persistent/recurring issue?
   └─ YES → After recovery, investigate root cause
      ├─ Check system resources (disk, memory, CPU)
      ├─ Review multiplexer logs
      └─ Consider reducing team size
```

### Soft Recovery

**When to use**:

- 1-3 teammates offline, rest working fine
- Status mismatch after manual session kill
- Communication failures that don't affect work
- Post-crash recovery where work is saved

**What's preserved**:

- All task data and comments
- Inbox messages
- Team configuration
- Work completed by active teammates

**What's affected**:

- Offline teammates lose in-memory history (but can resume from files)
- May need to re-explain context to respawned teammates

**Step-by-step soft recovery**:

1. **Identify offline teammates**:

```bash
/claude-swarm:swarm-status <team-name>
# Look for members showing "no window" with config "active"
```

2. **Run reconcile to update status**:

```bash
/claude-swarm:swarm-reconcile <team-name>
# This marks offline sessions as offline in config
```

3. **Decide on respawn strategy**:

```bash
# Option A: Respawn specific teammate
/claude-swarm:swarm-spawn "agent-name" "agent-type" "model" "Continue where you left off: [context]"

# Option B: Resume entire team (respawns all offline)
/claude-swarm:swarm-resume <team-name>
```

4. **Verify recovery**:

```bash
/claude-swarm:swarm-verify <team-name>
# All teammates should show as active
```

5. **Notify team of recovery**:

```bash
# Via bash function
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null
broadcast_message "<team-name>" "Recovery complete. Team member [name] has been respawned. Continue your work."
```

**Example soft recovery scenario**:

```
Situation: 5-teammate team, 2 teammates crashed mid-work

1. $ /claude-swarm:swarm-status my-team
   Output shows:
   - team-lead: active (you)
   - frontend-dev: active ✓
   - backend-dev: active ✗ (no window)
   - tester: active ✗ (no window)
   - reviewer: active ✓

2. $ /claude-swarm:swarm-reconcile my-team
   Output:
   - Marked backend-dev as offline
   - Marked tester as offline

3. $ /claude-swarm:swarm-resume my-team
   Output:
   - Respawning: backend-dev
   - Respawning: tester
   - Both spawned successfully

4. $ /claude-swarm:swarm-verify my-team
   Output: All teammates active ✓

5. Message team: "backend-dev and tester were respawned after crash. Please continue your assigned tasks."

Result: Team back to full capacity in ~60 seconds, no data lost
```

### Hard Recovery

**When to use**:

- Entire team is non-functional
- Config files corrupted or inconsistent
- After failed migration or upgrade
- When soft recovery fails multiple times
- Starting over is faster than debugging

**What's lost**:

- Task comments and progress notes
- Inbox messages (unread and read)
- lastSeen timestamps
- Team history

**What's preserved**:

- Task subjects and descriptions (if you note them first)
- Codebase changes (if committed to git)
- Your knowledge of work completed

**Before hard recovery checklist**:

```bash
# 1. Save task list for reference
/claude-swarm:task-list > tasks-backup.txt

# 2. Check for uncommitted work
git status

# 3. Ask teammates to commit their work (if any are responsive)
/claude-swarm:swarm-message "backend-dev" "Commit your work immediately, team restart needed"

# 4. Back up configs (optional)
cp ~/.claude/teams/<team-name>/config.json ~/config-backup.json

# 5. Document current state
/claude-swarm:swarm-status <team-name> > status-backup.txt
```

**Step-by-step hard recovery**:

1. **Full cleanup** (kills all sessions, optionally removes files):

```bash
/claude-swarm:swarm-cleanup <team-name> --force
```

2. **Verify cleanup**:

```bash
# Check no sessions remain
tmux list-sessions | grep <team-name>  # Should be empty
# or for kitty:
kitten @ ls | grep swarm-<team-name>   # Should be empty

# Check team directory
ls ~/.claude/teams/<team-name>/
# Should not exist if --force was used
```

3. **Recreate team**:

```bash
/claude-swarm:swarm-create <team-name> "Team description"
```

4. **Recreate tasks** from backup:

```bash
# Recreate each task manually
/claude-swarm:task-create "Implement API endpoints" "Full description..."
/claude-swarm:task-create "Write unit tests" "Test coverage for..."
# ... repeat for all tasks
```

5. **Respawn teammates**:

```bash
/claude-swarm:swarm-spawn "backend-dev" "backend-developer" "sonnet" "You are the backend developer. Focus on: [task details]"
/claude-swarm:swarm-spawn "frontend-dev" "frontend-developer" "sonnet" "You are the frontend developer. Focus on: [task details]"
# ... repeat for all teammates
```

6. **Assign tasks**:

```bash
/claude-swarm:task-update 1 --assign "backend-dev"
/claude-swarm:task-update 2 --assign "frontend-dev"
```

7. **Verify team health**:

```bash
/claude-swarm:swarm-verify <team-name>
/claude-swarm:swarm-status <team-name>
```

**Timeline**: Hard recovery typically takes 5-10 minutes for a 5-teammate team.

### Partial Recovery

**When to use**:

- Specific component broken (one inbox, one task file)
- Soft recovery too cautious, hard recovery too destructive
- You know exactly what's broken and how to fix it
- Testing fixes before full recovery

**Techniques**:

#### Reset Specific Inbox

**When**: Inbox file corrupted, messages malformed, inbox command errors

```bash
# Back up current inbox first
cp ~/.claude/teams/<team-name>/inboxes/<agent>.json ~/.claude/teams/<team-name>/inboxes/<agent>.json.bak

# Reset to empty inbox
echo '[]' > ~/.claude/teams/<team-name>/inboxes/<agent>.json

# Verify format
cat ~/.claude/teams/<team-name>/inboxes/<agent>.json
# Should output: []

# Notify affected teammate
/claude-swarm:swarm-message "<agent>" "Your inbox was reset due to corruption. Please check your backup if you need message history."
```

#### Fix Specific Task

**When**: Task file has invalid status, corrupted JSON, missing fields

```bash
# Back up task file
cp ~/.claude/tasks/<team-name>/<id>.json ~/.claude/tasks/<team-name>/<id>.json.bak

# Fix manually with jq
jq '.status = "in-progress"' ~/.claude/tasks/<team-name>/<id>.json > /tmp/task-fixed.json
mv /tmp/task-fixed.json ~/.claude/tasks/<team-name>/<id>.json

# Or edit directly
# Edit the JSON file to fix the issue

# Verify task is valid
cat ~/.claude/tasks/<team-name>/<id>.json | jq '.'
# Should output valid JSON
```

#### Respawn Single Teammate

**When**: One teammate crashed, others working fine

```bash
# 1. Check teammate is really offline
/claude-swarm:swarm-verify <team-name>

# 2. Update their status
/claude-swarm:swarm-reconcile <team-name>

# 3. Check their assigned tasks
/claude-swarm:task-list
# Note which tasks were assigned to this teammate

# 4. Respawn with context
/claude-swarm:swarm-spawn "<agent-name>" "<agent-type>" "<model>" "You crashed mid-work. Resume: [describe what they were doing, which files they were editing, what tasks to continue]"

# 5. Reassign their tasks
/claude-swarm:task-update <task-id> --assign "<agent-name>"
/claude-swarm:task-update <task-id> --comment "Teammate respawned, resuming work"

# 6. Notify teammate of their context
/claude-swarm:swarm-message "<agent-name>" "You were working on: [specific context]. Check Task #<id> for details."
```

#### Fix Config-Reality Mismatch

**When**: Config shows wrong status, but files and sessions are fine

```bash
# Use reconcile for automatic fixing
/claude-swarm:swarm-reconcile <team-name> --auto-fix

# Or manual fix if you know the issue
# Edit config.json directly:
# 1. Back up: cp ~/.claude/teams/<team-name>/config.json ~/config-backup.json
# 2. Edit: jq '(.members[] | select(.name == "agent-name")) |= (.status = "active")' config.json > config-fixed.json
# 3. Replace: mv config-fixed.json ~/.claude/teams/<team-name>/config.json
```

### Recovery Strategy Selection Guide

| Symptom              | Data Loss Risk | Recommended Strategy      | Recovery Time |
| -------------------- | -------------- | ------------------------- | ------------- |
| 1 teammate offline   | None           | Soft (respawn one)        | 30 seconds    |
| Multiple offline     | None           | Soft (resume team)        | 1-2 minutes   |
| Status mismatch only | None           | Soft (reconcile)          | 10 seconds    |
| Inbox corruption     | Messages lost  | Partial (reset inbox)     | 30 seconds    |
| Task file corrupt    | Comments lost  | Partial (fix task)        | 1-2 minutes   |
| Config corrupt       | History lost   | Hard (recreate)           | 5-10 minutes  |
| Everything broken    | All lost       | Hard (full reset)         | 10-15 minutes |
| Persistent failures  | Depends        | Diagnose root cause first | Varies        |

### When to Escalate

Some issues require more than recovery:

**Signs you need to investigate deeper**:

- Recovery works but issue recurs within minutes
- Multiple teammates crash simultaneously
- Errors mention "out of memory" or "too many open files"
- System becomes unresponsive during spawning
- Kitty/tmux behaves erratically

**Investigation steps**:

```bash
# Check system resources
top
# Look for: high CPU usage, low free memory, swap usage

# Check disk space
df -h ~/.claude
# Ensure adequate free space (>1GB recommended)

# Check file descriptor limits
ulimit -n
# Should be >=256, ideally >=1024

# Check for zombie processes
ps aux | grep claude
# Kill any orphaned Claude Code processes

# Review system logs
# macOS: Console.app, filter for "claude" or "kitty"
# Linux: journalctl --user | grep claude
```

## Performance Troubleshooting

### Slow or Unresponsive Teammates

**Symptoms**:

- Teammates take >30 seconds to respond to messages
- Commands timeout frequently
- High CPU or memory usage
- System fans running constantly

**Diagnosis**:

```bash
# Check Claude Code process resource usage
ps aux | grep claude | sort -k3 -r  # Sort by CPU%
ps aux | grep claude | sort -k4 -r  # Sort by memory%

# Check individual teammate resource usage
# Find PID of specific teammate:
ps aux | grep "CLAUDE_CODE_AGENT_NAME=backend-dev"

# Monitor live resource usage
top -pid $(pgrep -f "CLAUDE_CODE_AGENT_NAME=backend-dev")
```

**Common causes and solutions**:

1. **Too many teammates for system resources**:

```bash
# Solution: Reduce team size, use lighter models
# Replace opus with sonnet, sonnet with haiku for non-critical tasks
/claude-swarm:swarm-spawn "tester" "tester" "haiku" "Run existing tests"
```

2. **Memory leaks in long-running teammates**:

```bash
# Solution: Periodic restarts for long-lived teammates (>4 hours)
# 1. Ask teammate to commit work
# 2. Kill and respawn
# 3. Reassign tasks
```

3. **Disk I/O bottleneck**:

```bash
# Check disk I/O
iostat -x 1 5  # Run 5 samples, 1 second apart
# Look for high %util on disk with ~/.claude

# Solution: Move ~/.claude to faster disk (SSD)
# Or reduce concurrent file operations
```

### Multiplexer Performance Issues

**Kitty slowness**:

```bash
# Check kitty window count
kitten @ ls | jq '[.[].tabs[].windows[]] | length'
# If >50 windows total, kitty may slow down

# Solution: Use SWARM_KITTY_MODE=os-window for separate processes
export SWARM_KITTY_MODE=os-window
/claude-swarm:swarm-spawn ...
```

**Tmux slowness**:

```bash
# Check tmux session count
tmux list-sessions | wc -l
# If >20 sessions, consider cleanup

# Solution: Clean up old swarm sessions
for session in $(tmux list-sessions -F '#{session_name}' | grep swarm-); do
    # Check if session is active in a team
    # If not, kill it
    tmux kill-session -t "$session"
done
```

### Network or API Rate Limiting

**Symptoms**:

- Claude API errors mentioning "rate limit"
- Teammates getting "429 Too Many Requests"
- Intermittent connection failures

**Solutions**:

```bash
# 1. Reduce team size to stay under rate limits
# 2. Stagger teammate spawning (wait 10s between spawns)
for agent in backend frontend tester; do
    /claude-swarm:swarm-spawn "$agent" ...
    sleep 10
done

# 3. Use haiku model for lightweight tasks (lower API load)
/claude-swarm:swarm-spawn "tester" "tester" "haiku" "Run unit tests"
```

### Debugging Hangs and Freezes

**Teammate completely frozen**:

```bash
# 1. Find the teammate's process
ps aux | grep "CLAUDE_CODE_AGENT_NAME=backend-dev"

# 2. Send SIGTERM (graceful shutdown)
kill <PID>

# 3. If still frozen after 30s, force kill
kill -9 <PID>

# 4. Clean up and respawn
/claude-swarm:swarm-reconcile <team-name>
/claude-swarm:swarm-spawn "backend-dev" ...
```

**Multiplexer frozen**:

```bash
# Kitty frozen
# 1. Try sending command
kitten @ ls
# If hangs, kill kitty: killall kitty

# Tmux frozen
# 1. Try listing sessions
tmux list-sessions
# If hangs, kill tmux server: tmux kill-server
```

## Emergency Procedures

### Nuclear Option: Full Reset

**When to use**: Everything is completely broken, no recovery methods work, starting over is the only option.

**WARNING**: This destroys ALL team data across ALL teams. Only use as absolute last resort.

**What gets destroyed**:

- All team configurations
- All task data and history
- All inbox messages
- All team directories
- Active sessions (teammates will crash)

**Before nuking**:

```bash
# 1. Save what you can
tar -czf ~/swarm-backup-$(date +%Y%m%d-%H%M%S).tar.gz ~/.claude/teams/ ~/.claude/tasks/

# 2. Document current state
/claude-swarm:swarm-list-teams > ~/teams-backup.txt
for team in $(cat ~/teams-backup.txt); do
    /claude-swarm:swarm-status "$team" > ~/${team}-status.txt
    /claude-swarm:task-list >> ~/${team}-tasks.txt
done

# 3. Notify any responsive teammates
# (They'll lose their work context)
```

**Full reset procedure**:

```bash
# 1. Kill all swarm sessions
tmux kill-server  # Kills ALL tmux sessions
# or for kitty:
for window in $(kitten @ ls | jq -r '.[].tabs[].windows[] | select(.user_vars | keys[] | startswith("swarm_")) | .id'); do
    kitten @ close-window --match "id:$window"
done

# 2. Remove all swarm data
rm -rf ~/.claude/teams/
rm -rf ~/.claude/tasks/

# 3. Verify cleanup
ls ~/.claude/teams/  # Should not exist
ls ~/.claude/tasks/  # Should not exist

# 4. Recreate directories with proper permissions
mkdir -p ~/.claude/teams/
mkdir -p ~/.claude/tasks/
chmod 700 ~/.claude/teams/
chmod 700 ~/.claude/tasks/

# 5. Start fresh with new team
/claude-swarm:swarm-create "new-team" "Fresh start after full reset"

# 6. Verify clean state
/claude-swarm:swarm-status "new-team"
```

**After nuclear reset**:

- All previous teams are gone
- Need to recreate tasks from memory/notes
- Teammates need complete context re-explanation
- Good opportunity to optimize team structure

**Recovery timeline**: 15-30 minutes to rebuild team from scratch.

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

## Resource Monitoring

### Why Monitoring Matters

Large teams (5+ teammates) can consume significant resources. Each Claude Code process uses:

- ~500MB RAM (varies by model)
- 1-2 CPU cores during active work
- File descriptors for sockets, logs, files

**Resource monitoring**:

```bash
# Check total Claude Code memory usage
ps aux | grep claude | awk '{sum+=$4} END {print "Total memory: " sum "%"}'

# Count active Claude processes
ps aux | grep claude | wc -l

# Check file descriptor usage
lsof -p $(pgrep claude) | wc -l

# Monitor system load
uptime
# Load average should be below CPU core count
```

**Resource limits**:

| Team Size      | RAM Needed | Recommended System              |
| -------------- | ---------- | ------------------------------- |
| 2-3 teammates  | 2-3 GB     | 8GB RAM minimum                 |
| 4-6 teammates  | 3-5 GB     | 16GB RAM recommended            |
| 7-10 teammates | 6-8 GB     | 32GB RAM recommended            |
| 10+ teammates  | 10+ GB     | Not recommended without testing |

**When to scale back**:

- System swap usage increases significantly
- CPU load average > number of cores
- Teammates become slow/unresponsive
- Frequent crashes or timeouts

```bash
# Reduce team size gracefully
# 1. Finish critical tasks
# 2. Have teammates commit work
# 3. Kill non-essential teammates
/claude-swarm:swarm-cleanup <team-name>  # Only kills sessions for specific agents

# 4. Consolidate work across fewer teammates
```
