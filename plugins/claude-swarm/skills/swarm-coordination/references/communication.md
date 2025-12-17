# Communication Patterns

Effective swarm coordination requires clear communication between teammates. This guide covers messaging patterns, best practices, and common workflows.

## Message Types

### Direct Messages

Send to specific teammate:

```bash
/claude-swarm:swarm-message "backend-dev" "API endpoints ready for testing"
```

Use for:
- Task handoffs
- Dependency notifications
- Status updates to specific teammates
- Questions requiring specific expertise

### Broadcast Messages

Using bash function (when you need to message all teammates):

```bash
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh"
broadcast_message "team-name" "Database schema updated - please pull latest" "true"
```

The third parameter (`"true"`) excludes the sender from receiving the message.

Use for:
- Team-wide announcements
- Breaking changes
- Status updates affecting everyone
- Coordination checkpoints

### Inbox Checking

All teammates should regularly check their inbox:

```bash
/claude-swarm:swarm-inbox
```

Recommended frequency:
- After completing each major task step
- Before starting new work
- When blocked or waiting
- Periodically during long-running tasks

## Communication Workflows

### Task Handoff Pattern

When Task A completes and Task B depends on it:

**Teammate A (completes Task A):**
```bash
# Update task status
/claude-swarm:task-update 1 --status "completed" --comment "API endpoints implemented and tested"

# Notify dependent teammate
/claude-swarm:swarm-message "teammate-b" "Task #1 complete. API is ready for integration. See endpoints.md for documentation."

# Notify team lead
/claude-swarm:swarm-message "team-lead" "Task #1 complete - API endpoints ready"
```

**Teammate B (waiting for Task A):**
```bash
# Check inbox regularly
/claude-swarm:swarm-inbox

# When notification arrives, acknowledge
/claude-swarm:swarm-message "teammate-a" "Thanks! Starting integration now."

# Update own task status
/claude-swarm:task-update 2 --status "in-progress"
```

### Blocked Task Pattern

When a teammate encounters a blocker:

```bash
# Update task with blocker information
/claude-swarm:task-update 3 --status "blocked" --comment "Missing database credentials for testing environment"

# Message team lead
/claude-swarm:swarm-message "team-lead" "Blocked on Task #3: need database credentials. Can you provide access?"

# Continue with other work if available
/claude-swarm:task-list  # Check for other unassigned tasks
```

### Progress Update Pattern

Regular progress updates to team lead:

```bash
# Add progress comment to task
/claude-swarm:task-update 4 --comment "70% complete - authentication working, implementing token refresh"

# Optional: message team lead for major milestones
/claude-swarm:swarm-message "team-lead" "Task #4 update: Auth core complete, working on token refresh. ETA: ready for review soon."
```

### Review Request Pattern

When work is ready for review:

```bash
# Mark task as in-review
/claude-swarm:task-update 5 --status "in-review" --comment "Implementation complete, ready for review"

# Message reviewer
/claude-swarm:swarm-message "reviewer" "Task #5 ready for review: User registration flow. Files changed: auth.ts, register.tsx, user.model.ts"

# Message team lead
/claude-swarm:swarm-message "team-lead" "Task #5 in review with reviewer"
```

### Integration Coordination Pattern

When multiple teammates need to integrate their work:

**Team Lead:**
```bash
# Broadcast integration checkpoint
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh"
broadcast_message "team-name" "Integration checkpoint: frontend-dev and backend-dev please coordinate on API contract before proceeding" "true"
```

**Teammates:**
```bash
# Frontend dev reaches out
/claude-swarm:swarm-message "backend-dev" "Ready to discuss API contract. I need endpoints for user CRUD operations."

# Backend dev responds
/claude-swarm:swarm-message "frontend-dev" "API contract draft in docs/api.md. Let me know if you need additional endpoints."
```

## Message Content Best Practices

### Clear and Actionable

**Good:**
```
"Task #3 complete. User authentication middleware added to /middleware/auth.ts. Protected routes configured. Ready for testing."
```

**Poor:**
```
"Done with the auth stuff."
```

### Include Context

**Good:**
```
"Blocked on Task #7: Need design mockups for dashboard layout. Current placeholder is in /components/Dashboard.tsx lines 45-120."
```

**Poor:**
```
"Blocked. Need designs."
```

### Reference Specifics

**Good:**
```
"Integration issue: API returns 401 on /api/users endpoint. Expected JWT in Authorization header. See auth.test.ts:89 for failing test case."
```

**Poor:**
```
"API not working."
```

### Proactive Communication

**Good:**
```
"Task #2 in progress (50%). Discovered existing auth library we should use instead of custom implementation. Recommend discussing before proceeding. See /lib/auth-library/README.md"
```

**Poor:**
```
"Working on it."
```

## Coordination Commands

### Check Team Status

```bash
/claude-swarm:swarm-status <team-name>
```

Shows:
- Active teammates and their status
- Task assignments
- Overall progress

### View Task List

```bash
/claude-swarm:task-list
```

Shows:
- All tasks with status
- Assignments
- Dependencies
- Comments

### Verify Team Health

```bash
/claude-swarm:swarm-verify <team-name>
```

Checks if all teammates are alive and responsive.

## Common Anti-Patterns

### Silent Work

**Problem:** Teammate works for long period without updates

**Solution:** Regular progress comments and milestone messages

### Message Overload

**Problem:** Too many trivial messages create noise

**Solution:** Batch minor updates in task comments, message only for important events

### Assuming Knowledge

**Problem:** "It's done" without explaining what or where

**Solution:** Always include file paths, line numbers, and specific changes

### Ignoring Inbox

**Problem:** Teammate misses critical coordination messages

**Solution:** Check inbox after each task step and periodically during work

### Broadcasting Everything

**Problem:** Using broadcast for messages relevant to specific teammates

**Solution:** Use direct messages for targeted communication, broadcast only for team-wide information

## Team Lead Responsibilities

As team lead, you should:

1. **Monitor inbox actively** - Teammates report to you
2. **Check team status regularly** - Use `/claude-swarm:swarm-status`
3. **Respond to blockers quickly** - Unblock teammates promptly
4. **Coordinate handoffs** - Ensure dependencies are communicated
5. **Provide clarity** - Answer questions, resolve ambiguity
6. **Track overall progress** - Maintain visibility of team state

## Teammate Responsibilities

As a teammate, you should:

1. **Check inbox regularly** - Don't miss coordination messages
2. **Update task status** - Keep task list current
3. **Communicate proactively** - Report progress, blockers, and completion
4. **Message dependencies** - Notify teammates waiting on your work
5. **Ask questions** - Don't work in uncertainty
6. **Acknowledge messages** - Confirm receipt of important information

## Example: Full Workflow

**Initial Setup (Team Lead):**
```bash
/claude-swarm:swarm-create "feature-team" "Implementing payment processing"
/claude-swarm:task-create "Design payment API" "Design REST endpoints for payment processing"
/claude-swarm:task-create "Implement payment gateway" "Integrate Stripe payment gateway"
/claude-swarm:task-create "Build payment UI" "Create checkout form and payment status pages"
/claude-swarm:swarm-spawn "api-designer" "researcher" "sonnet" "You are the API designer. Work on Task #1: Design payment API endpoints."
/claude-swarm:swarm-spawn "backend-dev" "backend-developer" "sonnet" "You are backend developer. Work on Task #2: Implement Stripe integration. Wait for API design to complete."
/claude-swarm:swarm-spawn "frontend-dev" "frontend-developer" "sonnet" "You are frontend developer. Work on Task #3: Build payment UI. Coordinate with API designer."
```

**Workflow:**

1. API Designer completes design:
```bash
/claude-swarm:task-update 1 --status "completed" --comment "API design complete in docs/payment-api.md"
/claude-swarm:swarm-message "backend-dev" "Task #1 complete. API spec ready in docs/payment-api.md. You can start implementation."
/claude-swarm:swarm-message "frontend-dev" "API design ready. See docs/payment-api.md for endpoints."
/claude-swarm:swarm-message "team-lead" "Task #1 complete - API design delivered"
```

2. Backend Dev starts work:
```bash
/claude-swarm:task-update 2 --status "in-progress"
/claude-swarm:swarm-message "api-designer" "Starting implementation based on your design. Will reach out if I have questions."
```

3. Frontend Dev coordinates:
```bash
/claude-swarm:swarm-message "api-designer" "Question about payment-api.md: Should error responses include retry-after header?"
```

4. Backend Dev hits blocker:
```bash
/claude-swarm:task-update 2 --status "blocked" --comment "Need Stripe API keys for development environment"
/claude-swarm:swarm-message "team-lead" "Blocked on Task #2: Need Stripe test API keys. Where can I find these?"
```

5. Team Lead resolves:
```bash
/claude-swarm:swarm-message "backend-dev" "Stripe keys are in .env.example. Copy to .env and I'll fill in the test keys."
```

6. Backend Dev continues:
```bash
/claude-swarm:task-update 2 --status "in-progress" --comment "Unblocked - continuing implementation"
```

7. Backend Dev completes:
```bash
/claude-swarm:task-update 2 --status "completed" --comment "Stripe integration complete with tests in tests/payment.test.ts"
/claude-swarm:swarm-message "frontend-dev" "Task #2 complete. Payment API endpoints ready at /api/payment/*. See tests for usage examples."
/claude-swarm:swarm-message "team-lead" "Task #2 complete - Stripe integration done and tested"
```

8. Frontend Dev integrates and completes:
```bash
/claude-swarm:task-update 3 --status "completed" --comment "Payment UI complete. Checkout flow in /pages/checkout.tsx, status page in /pages/payment-status.tsx"
/claude-swarm:swarm-message "team-lead" "Task #3 complete - Payment UI ready for review"
```

This example demonstrates:
- Clear task handoffs with file references
- Proactive blocker communication
- Coordination between dependent teammates
- Regular status updates to team lead
- Specific, actionable messages

## Environment Variables

Teammates have access to these environment variables for coordination:

| Variable | Description |
|----------|-------------|
| `CLAUDE_CODE_TEAM_NAME` | Current team name |
| `CLAUDE_CODE_AGENT_ID` | Your unique UUID |
| `CLAUDE_CODE_AGENT_NAME` | Your agent name |
| `CLAUDE_CODE_AGENT_TYPE` | Your role type |
| `CLAUDE_CODE_TEAM_LEAD_ID` | Team lead's UUID |
| `CLAUDE_CODE_AGENT_COLOR` | Your display color |

## Kitty vs Tmux

Spawn mode affects how teammates appear:

| Mode | Behavior |
|------|----------|
| `split` | Vertical splits in current tab (default) |
| `tab` | Separate tabs |
| `window` | Separate OS windows |

Set with: `export SWARM_KITTY_MODE=split`
