# Example 2: Full-Stack Feature (Delegated)

**Complexity:** ⭐⭐⭐ Moderate
**Your Actions:** 6-7 steps
**Team Size:** 4 workers (spawned by team-lead)
**Prerequisites:** React frontend, Express backend, existing auth patterns

## Scenario

Implement a complete user authentication system:

- JWT-based authentication
- Login and signup endpoints
- Protected route middleware
- Login/signup UI forms
- Session management in frontend
- Comprehensive tests (unit + integration)

## Your Workflow (Delegation Mode)

### Step 1: Create Team

```bash
/claude-swarm:swarm-create "auth-system" "Complete user authentication with JWT"
```

Team-lead spawns automatically.

### Step 2: Brief Team-Lead

```bash
/claude-swarm:swarm-message team-lead "Build complete JWT authentication system.

Requirements:
- Backend: Login/signup endpoints, JWT generation, refresh tokens
- Middleware: Protected route authentication
- Frontend: Login/signup forms, session management hook
- Tests: Unit tests (backend), component tests (frontend), E2E tests

Architecture:
- Backend auth service: backend/auth/
- Frontend pages: frontend/pages/auth/
- Auth hook: frontend/hooks/useAuth.ts
- Tests: backend/tests/, frontend/tests/, e2e/

Suggested team structure:
- researcher (opus) - Design auth architecture first
- backend-dev (sonnet) - Implement backend after design
- frontend-dev (sonnet) - Build UI after design (parallel with backend)
- qa-lead (sonnet) - Write tests after implementations

Dependency flow:
Design → Backend + Frontend (parallel) → Tests

Let me know if you have questions, otherwise proceed with spawning."
```

### Step 3: Answer Design Questions

Team-lead will likely consult you during the design phase:

```bash
/claude-swarm:swarm-inbox
```

**Example consults:**
```
<teammate-message teammate_id="team-lead">
Auth design question: Should we use HTTP-only cookies or localStorage for tokens?
Researcher recommends cookies for security. Confirm?
</teammate-message>
```

```bash
/claude-swarm:swarm-message team-lead "Confirmed: Use HTTP-only cookies. Also ensure CSRF protection is included in the design."
```

### Step 4: Periodic Check-ins

Check progress every 30-45 minutes:

```bash
/claude-swarm:swarm-status auth-system
/claude-swarm:swarm-inbox
```

**Typical progress message:**
```
<teammate-message teammate_id="team-lead">
Progress update:
- Design complete ✓
- Backend 80% done, implementing refresh logic
- Frontend 60% done, forms complete, working on session hook
- QA waiting for implementations

On track. No blockers.
</teammate-message>
```

If no messages and status looks good, let them work.

### Step 5: Handle Escalations

Team-lead escalates major decisions:

```bash
# Example escalation
/claude-swarm:swarm-inbox

# <teammate-message teammate_id="team-lead">
# Backend and frontend disagree on error response format.
# Backend wants: { error: { code, message } }
# Frontend wants: { error: string }
# Which should we use?
# </teammate-message>

/claude-swarm:swarm-message team-lead "Use structured format: { error: { code, message } }. It's more extensible. Frontend should adapt."
```

### Step 6: Final Review

When team-lead reports completion:

```bash
# Verify completion
/claude-swarm:task-list

# Review deliverables (optional - trust team-lead's verification)
cat docs/auth-design.md
npm test backend/tests/auth.test.js
```

### Step 7: Cleanup

```bash
/claude-swarm:swarm-cleanup auth-system
```

**Report to user:**
```
Completed! Full authentication system implemented:

Backend:
- JWT auth with refresh tokens
- Endpoints: login, signup, refresh, logout
- Protected route middleware
- 91% test coverage

Frontend:
- Login and signup forms with validation
- Session management hook (useAuth)
- Protected route component
- 88% test coverage

E2E Tests:
- All flows passing

Files:
- Backend: backend/auth/, middleware/auth.js, routes/auth.js
- Frontend: frontend/pages/auth/, frontend/hooks/useAuth.ts
- Documentation: docs/auth-design.md
- Tests: backend/tests/, frontend/tests/, e2e/

Ready for code review and deployment.
```

## What Team-Lead Handles

For reference, team-lead manages all this coordination:

### Phase 1: Design (~30-45 min)
- Spawns researcher (opus)
- Creates design task
- Reviews design when complete
- Notifies you of any decisions needed

### Phase 2: Implementation (~45-60 min)
- Spawns backend-dev and frontend-dev
- Creates implementation tasks with dependencies
- Coordinates API contract alignment between them
- Handles their questions directly when possible
- Escalates to you for major decisions

### Phase 3: Testing (~30-45 min)
- Spawns qa-lead when implementations complete
- Creates testing tasks
- Coordinates bug fixes between developers and QA
- Reports completion

### Phase 4: Handoff
- Verifies all tasks complete
- Sends final summary to you

## Timeline

**Total time:** ~3-4 hours

| Phase | Time | Your involvement |
|-------|------|------------------|
| Create & brief | 10 min | Write detailed requirements |
| Design phase | 30-45 min | Answer 1-2 design questions |
| Implementation | 45-60 min | Check in once, handle any escalations |
| Testing | 30-45 min | Minimal (team-lead handles coordination) |
| Review & cleanup | 15 min | Verify and cleanup |

**Your active time:** ~30-45 minutes
**Without delegation:** 2-3 hours of active coordination

## Key Coordination Points

### You Handle

1. **Design decisions** - Token storage, security patterns
2. **Architectural choices** - Error formats, API structure
3. **Scope clarifications** - What's in v1 vs later

### Team-Lead Handles

1. **Worker spawning** - Right roles, models, prompts
2. **Task management** - Creating, assigning, unblocking
3. **Day-to-day coordination** - Worker questions, dependencies
4. **Bug coordination** - Developer-QA iteration loops
5. **Progress reporting** - Keeping you informed

## Delegation vs Direct Mode

| Aspect | This Example (Delegated) | Direct Mode |
|--------|--------------------------|-------------|
| Your messages | ~5-8 | ~25-35 |
| Context switches | 3-4 check-ins | Constant |
| Design decisions | You make | You make |
| Worker coordination | Team-lead | You |
| Recommended for | Complex features | Learning, quick tasks |

## When Direct Mode Makes Sense

- You want to learn swarm mechanics hands-on
- The feature is smaller (< 30 min)
- You need specific control over each worker's instructions
- You're debugging swarm coordination issues

For direct mode, see the **swarm-team-lead** skill.

## Troubleshooting

### Team-lead seems stuck

```bash
/claude-swarm:swarm-status auth-system
/claude-swarm:swarm-message team-lead "Status check: Any blockers I can help with?"
```

### Need to intervene directly

If team-lead is unresponsive:

```bash
# Check what's happening
/claude-swarm:swarm-diagnose auth-system

# You can message workers directly if needed
/claude-swarm:swarm-message backend-dev "Team-lead may be stuck. What's your current status?"
```

### Want to add scope mid-project

```bash
/claude-swarm:swarm-message team-lead "Adding requirement: Implement password reset flow. Please add tasks and coordinate. Use same patterns as login/signup."
```

## Quick Command Reference

```bash
# Your complete command set:
/claude-swarm:swarm-create "auth-system" "Complete user authentication"
/claude-swarm:swarm-message team-lead "<detailed requirements>"
/claude-swarm:swarm-inbox                    # Check for consults
/claude-swarm:swarm-message team-lead "<response>"  # Answer questions
/claude-swarm:swarm-status auth-system       # Periodic check
/claude-swarm:task-list                      # View progress
/claude-swarm:swarm-cleanup auth-system      # Finish
```

## Next Steps

After completing this example:

1. Try delegating your own full-stack feature
2. Experiment with more specific briefs vs letting team-lead decide
3. Note which decisions you want involved in vs delegating
4. Consider when direct mode might serve you better
