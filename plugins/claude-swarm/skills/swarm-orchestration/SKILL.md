---
name: swarm-orchestration
description: This skill should be used when the user asks to "set up a team", "create a swarm", "spawn teammates", "assign tasks", "coordinate agents", "work in parallel", "divide work among agents", "orchestrate multiple agents", or describes a complex task that would benefit from multiple Claude Code instances working together. Provides comprehensive guidance for team leads on creating teams, spawning teammates, assigning work, and monitoring progress across tmux/kitty terminal multiplexers.
---

# Swarm Orchestration

This skill guides you through orchestrating teams of Claude Code instances working in parallel. By default, you **delegate** coordination to a spawned team-lead, keeping your involvement minimal.

## Two Orchestration Modes

### Delegation Mode (Default, Recommended)

When you run `/swarm-create`, a team-lead is automatically spawned who handles all coordination:

```
You (orchestrator)
  └── /swarm-create "team" → team-lead auto-spawns
  └── /task-create (high-level goals)
  └── /swarm-message team-lead "Brief with requirements..."
  └── [Team-lead handles everything]
        ├── Spawns workers
        ├── Creates detailed tasks
        ├── Monitors progress
        └── Handles consults
  └── /swarm-status (periodic check-ins)
  └── /swarm-cleanup (when done)
```

**Your role:** Set direction, provide high-level goals, monitor progress, answer escalations.

### Direct Mode (`--no-lead`)

If you want full control, use `--no-lead` to coordinate everything yourself:

```bash
/swarm-create "team" "description" --no-lead
```

For direct mode guidance, see the **swarm-team-lead** skill.

## Quick Start: Delegation Mode

```bash
# 1. Create team (team-lead spawns automatically)
/claude-swarm:swarm-create "auth-feature" "Implement user authentication"

# 2. Create high-level tasks (team-lead will break these down)
/claude-swarm:task-create "Backend Auth" "JWT endpoints with login/signup"
/claude-swarm:task-create "Frontend UI" "Login and signup forms"

# 3. Brief team-lead
/claude-swarm:swarm-message team-lead "Please coordinate implementation. Use sonnet for workers. Let me know if you need architectural decisions."

# 4. Monitor progress (periodically)
/claude-swarm:swarm-status auth-feature
/claude-swarm:swarm-inbox

# 5. Cleanup when done
/claude-swarm:swarm-cleanup auth-feature
```

That's it! The team-lead handles spawning workers, assigning tasks, and coordinating execution.

## When to Use Swarms

**Good candidates:**

- **Large features** with independent components (backend + frontend + tests)
- **Parallel execution** would significantly speed up completion
- **Work naturally divides** by expertise or module boundaries
- **Multi-file refactoring** spans distinct subsystems

**Not ideal for:**

- Simple single-file changes
- Tasks requiring tight coordination at every step
- Quick fixes or trivial features

## Choosing Your Mode

| Factor | Delegation | Direct (`--no-lead`) |
|--------|------------|----------------------|
| Your involvement | Low - check in periodically | High - constant coordination |
| Context switching | Minimal | Frequent |
| Control | Less direct, trust team-lead | Full control |
| Best for | Large/long tasks | Quick tasks, learning swarms |

**Recommendation:** Use delegation mode for most work. Switch to direct mode only if you need fine-grained control or want to learn the swarm mechanics.

## Delegation Mode Workflow

### Step 1: Analyze the Task

Before creating a team, briefly analyze the work:

- What are the high-level goals?
- Can work be parallelized?
- What constraints should team-lead know about?

You don't need a detailed task breakdown - team-lead will do that.

**Example:**

User: "Implement payment processing system"

Your analysis:
- Goal: Stripe integration with checkout UI
- Parallelizable: Backend and frontend can work concurrently
- Constraints: Must use existing auth middleware, target staging environment

### Step 2: Create Team

```bash
/claude-swarm:swarm-create "team-name" "Brief description"
```

**What happens:**
- Team directories created in `~/.claude/teams/` and `~/.claude/tasks/`
- Team-lead spawns automatically in a new window/session
- Team-lead receives coordination guidance via the swarm-team-lead skill

**Options:**
- `--lead-model <model>` - Model for team-lead (haiku/sonnet/opus, default: sonnet)
- `--no-lead` - Skip auto-spawn, you become team-lead (direct mode)

**Examples:**

```bash
# Standard team with auto-spawned team-lead
/claude-swarm:swarm-create "payment-system" "Stripe integration"

# Complex work - use opus for team-lead
/claude-swarm:swarm-create "architecture-refactor" "Major refactoring" --lead-model opus
```

### Step 3: Create Initial Tasks (Optional)

Create high-level tasks that define the goals:

```bash
/claude-swarm:task-create "Backend API" "Implement Stripe payment endpoints"
/claude-swarm:task-create "Checkout UI" "Build payment form and confirmation pages"
```

**Note:** You can also let team-lead create all tasks based on your brief. Either approach works.

### Step 4: Brief Team-Lead

Send your requirements, constraints, and context:

```bash
/claude-swarm:swarm-message team-lead "Here's what we need:

Goal: Integrate Stripe payments
- Backend: Use stripe npm package, add to existing backend/services/
- Frontend: Build checkout form matching our design system
- Tests: Integration tests required

Constraints:
- Must use existing auth middleware
- Target staging environment for testing
- Use sonnet for workers (haiku for simple tests OK)

Let me know if you have questions before spawning workers."
```

**Good briefs include:**
- Clear goals and deliverables
- File paths and existing patterns to follow
- Constraints and requirements
- Model recommendations
- Offer to answer questions

### Step 5: Monitor Progress

Check in periodically without micromanaging:

```bash
# High-level status
/claude-swarm:swarm-status payment-system

# Check for messages (team-lead reports milestones)
/claude-swarm:swarm-inbox

# View task progress
/claude-swarm:task-list
```

**Monitoring cadence:**
- After initial setup: Check status after ~15-30 minutes
- During execution: Check every 30-60 minutes for long tasks
- When notified: Respond to inbox messages promptly

**Trust the team-lead** - They'll reach out when they need you.

### Step 6: Respond to Consults

Team-lead will consult you for:
- Scope decisions
- Architectural choices
- Resource questions
- Major blockers

```bash
# Check your inbox
/claude-swarm:swarm-inbox

# You might see:
# <teammate-message teammate_id="team-lead">
# Question: Should we support guest checkout or require login?
# Context: Design doc doesn't specify this...
# </teammate-message>

# Respond with guidance
/claude-swarm:swarm-message team-lead "Require login for v1. Guest checkout can be a follow-up task."
```

**Be responsive** - Team-lead and workers wait on your decisions.

### Step 7: Cleanup

When work is complete:

```bash
# Verify completion
/claude-swarm:task-list

# Graceful cleanup (recommended - notifies teammates)
/claude-swarm:swarm-cleanup payment-system --graceful

# Or immediate cleanup (suspends without notification)
/claude-swarm:swarm-cleanup payment-system

# Or permanent deletion
/claude-swarm:swarm-cleanup payment-system --force
```

## Team Discovery (External Agents)

External Claude instances can discover and join your team:

```bash
# External agent discovers available teams
/claude-swarm:swarm-discover

# External agent requests to join
/claude-swarm:swarm-join payment-system backend-developer

# You (team-lead) see request in inbox
/claude-swarm:swarm-inbox

# Approve or reject
/claude-swarm:swarm-approve-join <request-id> new-backend-dev blue
/claude-swarm:swarm-reject-join <request-id> "Team at capacity"
```

## Communication with Team-Lead

### Giving Initial Direction

**Good brief:**
```
/claude-swarm:swarm-message team-lead "Implementing user dashboard:

Requirements:
- Dashboard page at /dashboard showing user stats
- Widget components for activity, notifications, settings
- API endpoint to fetch dashboard data

Patterns to follow:
- See existing pages in frontend/pages/ for structure
- Use backend/services/userService.ts as API pattern

Team composition suggestion:
- 1 backend-dev for API
- 1 frontend-dev for UI
- 1 tester for integration tests

Let me know if you need clarification before starting."
```

**Poor brief:**
```
/claude-swarm:swarm-message team-lead "Build a dashboard"
```

### Checking In Without Micromanaging

**Good check-in:**
```bash
/claude-swarm:swarm-status my-team
/claude-swarm:swarm-inbox
```

If status looks good and no messages, let them work.

**Avoid:**
- Messaging every 10 minutes asking for updates
- Reassigning tasks team-lead already assigned
- Spawning workers yourself when team-lead is coordinating

### Responding to Escalations

When team-lead consults you, respond with:
- Clear decisions
- Context if helpful
- Permission to proceed

```bash
# Team-lead asks: "Backend and frontend disagree on API format. Which approach?"
/claude-swarm:swarm-message team-lead "Use JSON:API format per our standards. Backend should adjust. Let me know if they need examples from existing endpoints."
```

## Slash Commands Reference

**Core commands for orchestrators:**

| Command | Purpose |
|---------|---------|
| `/claude-swarm:swarm-create <team> [desc]` | Create team (auto-spawns team-lead) |
| `/claude-swarm:task-create <subject> [desc]` | Create high-level task |
| `/claude-swarm:swarm-status <team>` | View team status |
| `/claude-swarm:swarm-inbox` | Check messages from team-lead |
| `/claude-swarm:swarm-message <to> <msg>` | Message team-lead |
| `/claude-swarm:task-list` | View task progress |
| `/claude-swarm:swarm-cleanup <team> [--graceful\|--force]` | Clean up team |

**Team discovery commands:**

| Command | Purpose |
|---------|---------|
| `/claude-swarm:swarm-discover` | List joinable teams |
| `/claude-swarm:swarm-join <team>` | Request to join |
| `/claude-swarm:swarm-approve-join <id>` | Approve join (team-lead) |
| `/claude-swarm:swarm-reject-join <id>` | Reject join (team-lead) |

**Commands primarily used by team-lead:**

| Command | Purpose |
|---------|---------|
| `/claude-swarm:swarm-spawn` | Spawn workers |
| `/claude-swarm:swarm-verify` | Verify workers alive |
| `/claude-swarm:task-update` | Assign/update tasks |
| `/claude-swarm:swarm-broadcast` | Message all workers |
| `/claude-swarm:swarm-request-shutdown` | Request graceful shutdown |

See [Slash Commands Reference](references/slash-commands.md) for detailed options.

## Agent Roles and Models

When briefing team-lead, suggest appropriate roles and models:

**Roles:**

| Role | Use For |
|------|---------|
| `worker` | General-purpose tasks |
| `backend-developer` | API, server logic, database |
| `frontend-developer` | UI, styling, interactions |
| `reviewer` | Code review, quality assurance |
| `researcher` | Documentation, investigation |
| `tester` | Test writing, QA |

**Models:**

| Model | Use For |
|-------|---------|
| `haiku` | Simple, well-defined tasks |
| `sonnet` | Balanced complexity (recommended default) |
| `opus` | Complex reasoning, architecture |

## Example: Delegated Feature Development

**Scenario:** Implement user authentication

### Your Actions (5 steps)

```bash
# 1. Create team
/claude-swarm:swarm-create "auth-feature" "JWT authentication system"

# 2. Brief team-lead
/claude-swarm:swarm-message team-lead "Implement JWT authentication:

Requirements:
- Login/signup endpoints with JWT
- Frontend login/signup forms
- Protected route middleware
- Integration tests

Patterns:
- Backend in backend/auth/
- Frontend in frontend/pages/auth/
- Tests in tests/auth/

Suggest spawning: researcher for design, backend-dev, frontend-dev, tester
Use sonnet for all workers.

Questions? Let me know, otherwise proceed."

# 3. Check progress (after ~1 hour)
/claude-swarm:swarm-status auth-feature
/claude-swarm:swarm-inbox

# 4. Answer any consults
/claude-swarm:swarm-message team-lead "Use HTTP-only cookies for tokens, not localStorage."

# 5. Cleanup when complete
/claude-swarm:task-list  # Verify all done
/claude-swarm:swarm-cleanup auth-feature
```

### What Team-Lead Does (summarized)

1. Spawns researcher to design auth architecture
2. Creates detailed tasks with dependencies
3. Spawns backend-dev and frontend-dev after design completes
4. Coordinates implementation, handles questions
5. Spawns tester when implementations complete
6. Reports completion to you

You provided direction and monitored - team-lead handled the coordination details.

## Direct Mode

If you use `--no-lead` or want to coordinate yourself, see the **swarm-team-lead** skill for:

- Spawning and verifying workers
- Assigning tasks and managing dependencies
- Handling worker consults
- Communication patterns
- Monitoring and unblocking

## Troubleshooting

For issues with spawn failures, status mismatches, or team problems:

1. Run `/claude-swarm:swarm-diagnose <team>` to identify issues
2. See the **swarm-troubleshooting** skill for detailed recovery procedures
3. Ask team-lead to diagnose if they're active: `/claude-swarm:swarm-message team-lead "Please run /swarm-diagnose and report issues"`

## Environment Variables

**User-configurable:**

| Variable | Description |
|----------|-------------|
| `SWARM_MULTIPLEXER` | Force "tmux" or "kitty" |
| `SWARM_KITTY_MODE` | Kitty spawn mode: `split`, `tab`, or `window` |

## Best Practices

### For Delegation

- ✓ Provide clear, detailed briefs to team-lead
- ✓ Trust team-lead to coordinate - don't micromanage
- ✓ Respond promptly to consults
- ✓ Check status periodically, not constantly
- ✓ Let team-lead spawn and assign workers

### For Any Mode

- ✓ Keep teams small (2-6 workers optimal)
- ✓ Use appropriate models for task complexity
- ✓ Verify spawns succeeded
- ✓ Clean up when done

## See Also

- **swarm-team-lead** - Guidance for team-leads (direct mode or spawned team-leads)
- **swarm-teammate** - Guidance for workers on participation
- **swarm-troubleshooting** - Error handling and recovery
- [Setup Guide](references/setup-guide.md) - Terminal configuration
- [Slash Commands Reference](references/slash-commands.md) - Detailed command docs
