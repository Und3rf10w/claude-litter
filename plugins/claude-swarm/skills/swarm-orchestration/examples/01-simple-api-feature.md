# Example 1: Simple API Feature (Delegated)

**Complexity:** ⭐ Simple
**Your Actions:** 5 steps
**Team Size:** 2 workers (spawned by team-lead)
**Prerequisites:** Express.js backend, existing API structure

## Scenario

You need to add a new REST API endpoint to fetch user profile data:

- GET `/api/users/:id/profile`
- Return user profile with name, email, bio, avatar
- Include error handling for missing users
- Have unit tests with 80%+ coverage

## Your Workflow (Delegation Mode)

### Step 1: Create Team

```bash
/claude-swarm:swarm-create "profile-api" "Add user profile endpoint"
```

**Output:**
```
Created team 'profile-api'
Spawning team-lead window...
Team-lead spawned successfully
```

Team-lead now has a window open with coordination guidance.

### Step 2: Brief Team-Lead

```bash
/claude-swarm:swarm-message team-lead "Add GET /api/users/:id/profile endpoint.

Requirements:
- Return user profile data (name, email, bio, avatar)
- 404 handling for missing users
- Unit tests with 80%+ coverage

Files:
- Route: routes/users.js
- Controller: controllers/userController.js
- Tests: tests/userProfile.test.js

Suggested team:
- backend-dev (sonnet) for implementation
- qa-engineer (haiku) for tests

Proceed when ready."
```

### Step 3: Monitor Progress

Wait ~20-30 minutes, then check in:

```bash
/claude-swarm:swarm-status profile-api
/claude-swarm:swarm-inbox
```

**Typical inbox message from team-lead:**
```
<teammate-message teammate_id="team-lead">
Progress update: backend-dev completed endpoint, qa-engineer writing tests.
All going smoothly. Will notify when complete.
</teammate-message>
```

### Step 4: Handle Any Consults

Team-lead may ask questions:

```bash
# Check inbox
/claude-swarm:swarm-inbox

# Example consult:
# "Should the endpoint support query params for partial profile data?"

# Respond
/claude-swarm:swarm-message team-lead "No query params needed for v1. Return full profile always."
```

### Step 5: Cleanup

When team-lead reports completion:

```bash
# Verify all tasks complete
/claude-swarm:task-list

# Clean up
/claude-swarm:swarm-cleanup profile-api
```

**Report to user:**
```
Completed! User profile endpoint added:
- Endpoint: GET /api/users/:id/profile
- Files: routes/users.js, controllers/userController.js
- Tests: tests/userProfile.test.js (87% coverage)
- Ready for code review
```

## What Team-Lead Does (Behind the Scenes)

For reference, here's what team-lead handles:

1. **Creates detailed tasks:**
   - Task #1: Implement profile endpoint
   - Task #2: Write tests (blocked by #1)

2. **Spawns workers:**
   ```bash
   /claude-swarm:swarm-spawn "backend-dev" "backend-developer" "sonnet" "Implement profile endpoint..."
   /claude-swarm:swarm-spawn "qa-engineer" "tester" "haiku" "Write profile tests..."
   ```

3. **Assigns tasks and monitors:**
   - Assigns backend-dev to Task #1
   - Monitors progress, unblocks qa-engineer when #1 completes
   - Handles worker questions

4. **Reports completion to you**

You didn't need to do any of this coordination - team-lead handled it.

## Timeline

**Total time:** ~35-45 minutes

| Phase | Time | Your involvement |
|-------|------|------------------|
| Create team | 2 min | `/swarm-create` |
| Brief team-lead | 3 min | Write requirements |
| Implementation | 20-25 min | None (team-lead coordinates) |
| Check progress | 2 min | `/swarm-status`, `/swarm-inbox` |
| Cleanup | 3 min | `/swarm-cleanup` |

**Your active time:** ~10 minutes

## Key Differences from Direct Mode

| Aspect | Delegation (this example) | Direct Mode |
|--------|---------------------------|-------------|
| You spawn workers | No | Yes |
| You create detailed tasks | No (optional high-level) | Yes |
| You assign tasks | No | Yes |
| You unblock dependencies | No | Yes |
| You message workers | No (team-lead does) | Yes |
| Commands you run | 5-6 | 15+ |

## When to Use Direct Mode Instead

Consider `--no-lead` if:
- This is your first swarm and you want to learn
- The task is very quick (~15 min)
- You need fine-grained control over worker prompts
- Team-lead overhead doesn't make sense

For direct mode, see the **swarm-team-lead** skill.

## Troubleshooting

### Team-lead doesn't respond

```bash
# Check if team-lead is alive
/claude-swarm:swarm-status profile-api

# If not alive, diagnose
/claude-swarm:swarm-diagnose profile-api
```

See **swarm-troubleshooting** skill for recovery procedures.

### Want to check worker status directly

```bash
# View task assignments and status
/claude-swarm:task-list

# Ask team-lead for details
/claude-swarm:swarm-message team-lead "Please provide status update on worker progress"
```

### Need to add requirements mid-stream

```bash
/claude-swarm:swarm-message team-lead "Additional requirement: Also add input validation for ID parameter. Please coordinate with workers."
```

## Quick Command Reference

```bash
# Your complete command set for this example:
/claude-swarm:swarm-create "profile-api" "Add user profile endpoint"
/claude-swarm:swarm-message team-lead "<requirements>"
/claude-swarm:swarm-status profile-api
/claude-swarm:swarm-inbox
/claude-swarm:task-list
/claude-swarm:swarm-cleanup "profile-api"
```
