# Example: Handling Dependency Blockers

## Scenario

You're `frontend-dev` assigned to implement the user profile UI (task #10). This task depends on the user profile API (task #8) being completed by `backend-dev`.

## Timeline

### T+0: Discover Dependency

```bash
# Check available tasks
/claude-swarm:task-list

# Output shows:
# #8 [in-progress] Create user profile API (backend-dev)
# #10 [pending] Create user profile UI (unassigned)

# You read task #10 description:
# "Implement user profile UI. Requires user profile API (task #8) to be complete first."
```

### T+1: Claim and Mark Blocked

```bash
# Claim the task
/claude-swarm:task-update 10 --assign frontend-dev
/claude-swarm:task-update 10 --status blocked --comment "Task claimed. Blocked waiting for user profile API from task #8"

# Mark the dependency relationship
/claude-swarm:task-update 10 --blocked-by 8
```

### T+2: Notify the Blocking Teammate

```bash
# Proactively reach out to backend-dev
/claude-swarm:swarm-message backend-dev "Hi! I've taken task #10 (user profile UI) which depends on your task #8 (user profile API). What's your ETA? Also, can you share the API schema when available so I can start planning?"
```

### T+3: Receive Response

```bash
# Check inbox
/claude-swarm:swarm-inbox

# Message from backend-dev:
# "Hey! Task #8 is about 60% done. API schema is draft-complete, see docs/api-draft.json.
# Should be fully done by end of day. Let me know if you need anything specific in the API!"
```

### T+4: Review Draft and Find Alternative Work

```bash
# Thank them and review draft
/claude-swarm:swarm-message backend-dev "Thanks! Reviewing docs/api-draft.json now. If I have questions, I'll message you. Will wait for completion before starting implementation"

# Update task with new info
/claude-swarm:task-update 10 --comment "Received draft API schema from backend-dev (docs/api-draft.json). Reviewed design. Ready to implement once task #8 is complete (ETA: end of day)"

# Find other work while waiting
/claude-swarm:task-list

# See task #11 (style updates) is unblocked
/claude-swarm:task-update 11 --assign frontend-dev
/claude-swarm:task-update 11 --status in-progress --comment "Working on this while task #10 is blocked"

# Work on task #11...
```

### T+10: Receive Completion Notification

```bash
# backend-dev completes their task
/claude-swarm:swarm-inbox

# Message from backend-dev:
# "Task #8 completed! User profile API is live on staging.
# Final schema: docs/api-schema.json
# Endpoints: GET /users/:id, PUT /users/:id, POST /users/:id/avatar
# Test with: curl https://staging.api.com/users/123
# Your task #10 is unblocked!"
```

### T+11: Unblock and Start Work

```bash
# Finish current work first (task #11)
/claude-swarm:task-update 11 --status completed --comment "Style updates complete"

# Now switch to task #10
/claude-swarm:task-update 10 --status in-progress --comment "Unblocked! backend-dev completed task #8. Starting UI implementation with API schema from docs/api-schema.json"

# Confirm with backend-dev
/claude-swarm:swarm-message backend-dev "Perfect timing! Just finished task #11. Starting task #10 now with your API. Thanks!"
```

### T+15: Complete and Acknowledge

```bash
# Complete your task
/claude-swarm:task-update 10 --status completed --comment "User profile UI complete. Integrated with user profile API from task #8. Tested on staging"

# Thank the person who unblocked you
/claude-swarm:swarm-message backend-dev "Task #10 done! Your API worked perfectly. Smooth integration"

# Notify team-lead
/claude-swarm:swarm-message team-lead "Task #10 completed. User profile feature (API + UI) fully integrated"
```

## Key Takeaways

1. **Claim blocked tasks early** - Mark them as blocked but assign to yourself to signal intent
2. **Proactively reach out** - Don't just wait silently; ask for ETAs and draft schemas
3. **Find alternative work** - Don't idle while blocked; pick up other tasks
4. **Acknowledge when unblocked** - Thank the person who completed the blocking work
5. **Update task comments** - Keep a clear record of the blocking situation
6. **Coordinate actively** - Review drafts, ask questions, stay engaged

## What NOT to Do

❌ **Don't start work without the dependency**
```bash
# Bad: Trying to implement without the API
/claude-swarm:task-update 10 --status in-progress --comment "Starting UI with mock data"
# Problem: You'll have to rewrite everything when the real API is ready
```

❌ **Don't stay silent**
```bash
# Bad: Just marking blocked and waiting
/claude-swarm:task-update 10 --status blocked --comment "Waiting for task #8"
# Problem: backend-dev doesn't know you're waiting; no ETA
```

❌ **Don't idle**
```bash
# Bad: Not picking up other work
# Problem: Team loses productivity while you wait
```

❌ **Don't forget to notify**
```bash
# Bad: Complete task #10 without messaging backend-dev or team-lead
# Problem: Missed opportunity to acknowledge help and inform team
```

## Variations

### Variation 1: Partial Unblocking

```bash
# backend-dev messages: "Task #8 is 90% done. API schema is stable, but deployment pending. You can start coding now, just can't test until tonight"

/claude-swarm:task-update 10 --status in-progress --comment "Partially unblocked. API schema stable, starting implementation. Will test when task #8 deploys tonight"
```

### Variation 2: Blocker Takes Longer Than Expected

```bash
# After 2 days, backend-dev messages: "Task #8 running into issues. ETA now +2 days"

/claude-swarm:task-update 10 --comment "Updated blocker ETA: +2 more days. Continuing work on task #11 and #12"

# Continue picking up other work
```

### Variation 3: Blocker is Urgent

```bash
# Your task #10 is urgent (customer-facing)

/claude-swarm:swarm-message backend-dev "Task #10 is urgent (customer escalation). Can task #8 be prioritized? What can I do to help?"

# If backend-dev is also blocked:
/claude-swarm:swarm-message team-lead "Escalation: Task #10 (urgent customer request) blocked by task #8. backend-dev says #8 is blocked by external API. Need help prioritizing or finding workaround"
```
