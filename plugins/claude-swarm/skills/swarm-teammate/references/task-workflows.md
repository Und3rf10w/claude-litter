# Task Workflows for Swarm Teammates

## Basic Task Lifecycle

```
pending → in_progress → completed
                ↓
              blocked
                ↓
            in_progress
```

## Detailed Workflows

### Workflow 1: Simple Independent Task

**Scenario:** Task has no dependencies, straightforward implementation

```bash
# 1. Check for messages
/claude-swarm:swarm-inbox

# 2. View available tasks
/claude-swarm:task-list

# 3. Select and claim task
/claude-swarm:task-update 7 --assign backend-dev
/claude-swarm:task-update 7 --status in_progress --comment "Starting API endpoint implementation"

# 4. Do the work
# (implement feature)

# 5. Add progress comment
/claude-swarm:task-update 7 --comment "Endpoint implemented, writing unit tests"

# 6. Complete work
# (finish tests, verify)

# 7. Mark complete
/claude-swarm:task-update 7 --status completed --comment "API endpoint complete. Tests: src/api/__tests__/endpoint.test.ts. Coverage: 95%"

# 8. Notify team
/claude-swarm:swarm-message team-lead "Task #7 completed. API endpoint ready at /api/v1/users"
```

**Duration:** Varies by task complexity
**Key Points:** Regular updates, complete notification

### Workflow 2: Task with Dependencies

**Scenario:** Task #10 depends on task #8 completing first

**As the blocked teammate:**

```bash
# 1. Review task and identify dependency
/claude-swarm:task-list
# See: Task #10 depends on #8 (API schema needed)

# 2. Check if dependency is complete
# Task #8 shows "in_progress"

# 3. Mark your task with dependency
/claude-swarm:task-update 10 --blocked-by 8
/claude-swarm:task-update 10 --assign frontend-dev
/claude-swarm:task-update 10 --status blocked --comment "Waiting for API schema from task #8"

# 4. Notify the blocking teammate
/claude-swarm:swarm-message backend-dev "I'm assigned to task #10 (UI implementation). Blocked waiting for API schema from your task #8. ETA?"

# 5. Find other work while waiting
/claude-swarm:task-list
# Pick up task #11 (independent work)

# 6. When notified that #8 is complete
/claude-swarm:swarm-inbox
# Message from backend-dev: "Task #8 done, schema at docs/api.json"

# 7. Unblock and proceed
/claude-swarm:task-update 10 --status in_progress --comment "Unblocked, starting UI implementation with schema"
```

**As the blocking teammate:**

```bash
# When you complete the blocking task
/claude-swarm:task-update 8 --status completed --comment "API schema complete, documented in docs/api.json"

# Notify all blocked teammates
/claude-swarm:swarm-message frontend-dev "Task #8 completed. API schema available at docs/api.json lines 15-45. Your task #10 can proceed"

# Verify they received it
# (check inbox later for confirmation)
```

### Workflow 3: Parallel Coordination

**Scenario:** Two teammates working on related components that need coordination

**Initial Coordination:**

```bash
# Teammate A (backend-dev) - Task #5
/claude-swarm:task-update 5 --assign backend-dev
/claude-swarm:task-update 5 --status in_progress --comment "Starting auth API implementation"

# Proactively reach out to frontend teammate
/claude-swarm:swarm-message frontend-dev "I'm starting auth API (task #5). I see you have login UI (task #6). Want to coordinate on token format and error handling?"

# Teammate B (frontend-dev) - Task #6
/claude-swarm:swarm-inbox
# Sees message from backend-dev

/claude-swarm:swarm-message backend-dev "Yes! For task #6, I need: token (string), user_id (number), expires_at (ISO timestamp). For errors: prefer {code, message, field?} format"

# Backend-dev responds
/claude-swarm:swarm-message frontend-dev "Perfect. Will implement exactly that. API will return 401 for invalid creds, 429 for rate limit. Documenting in docs/auth-api.md"

# Both update tasks with coordination notes
/claude-swarm:task-update 5 --comment "Coordinated with frontend-dev. API returns {token, user_id, expires_at}, errors as {code, message, field?}"

/claude-swarm:task-update 6 --comment "Coordinated with backend-dev. Expecting {token, user_id, expires_at} on success, {code, message, field?} on error"

# Work proceeds in parallel...

# Backend completes first
/claude-swarm:task-update 5 --status completed --comment "Auth API complete. Docs: docs/auth-api.md, Tests: tests/auth.test.ts"
/claude-swarm:swarm-message frontend-dev "Auth API done. Deployed to staging. curl examples in docs/auth-api.md"

# Frontend completes
/claude-swarm:task-update 6 --status completed --comment "Login UI complete. Integrated with auth API, tested on staging"
/claude-swarm:swarm-message backend-dev "Login UI done. Everything working with your API!"
```

**Key Points:**
- Coordinate early (before deep implementation)
- Document coordination in task comments
- Notify when each part completes

### Workflow 4: Review Cycle

**Scenario:** Task requires review before completion

**As the implementer:**

```bash
# 1. Complete implementation
/claude-swarm:task-update 12 --status in_progress --comment "Implementation complete, running final tests"

# 2. Verify quality
# (run tests, check code quality, update docs)

# 3. Request review
/claude-swarm:task-update 12 --status in_review --comment "Ready for review. Focus areas: error handling (lines 45-60), async logic (lines 100-120)"
/claude-swarm:swarm-message reviewer "Task #12 ready for code review. Files: src/services/payment.ts, tests in __tests__/payment.test.ts. Main concerns: error handling and race conditions"

# 4. Wait for review
# (work on other tasks)

# 5. Receive feedback
/claude-swarm:swarm-inbox
# Message from reviewer: "Task #12 feedback: error handling good, but need null check on line 55, and add test for concurrent requests"

# 6. Address feedback
/claude-swarm:task-update 12 --status in_progress --comment "Addressing review feedback: adding null check and concurrency test"

# (make changes)

# 7. Re-request review
/claude-swarm:task-update 12 --status in_review --comment "Review feedback addressed. Added null check (line 55) and concurrency test (test line 89)"
/claude-swarm:swarm-message reviewer "Task #12 updated per your feedback. Please re-review"

# 8. Approved
/claude-swarm:swarm-inbox
# Message from reviewer: "Task #12 approved. Looks good!"

/claude-swarm:task-update 12 --status completed --comment "Reviewed and approved by reviewer. Changes merged"
/claude-swarm:swarm-message team-lead "Task #12 completed and reviewed"
```

**As the reviewer:**

```bash
# 1. Receive review request
/claude-swarm:swarm-inbox
# Message from backend-dev: "Task #12 ready for review..."

# 2. Review the code
# (read files, run tests, check quality)

# 3. Provide feedback
/claude-swarm:task-update 12 --comment "Review: Error handling looks good. Need null check on line 55. Missing test for concurrent requests"
/claude-swarm:swarm-message backend-dev "Task #12 feedback: error handling good, but need null check on line 55, and add test for concurrent requests"

# 4. Wait for updates
# (work on other tasks)

# 5. Re-review
/claude-swarm:swarm-inbox
# Message: "Task #12 updated per your feedback..."

# (review changes)

# 6. Approve
/claude-swarm:task-update 12 --comment "Re-review: All feedback addressed. Approved"
/claude-swarm:swarm-message backend-dev "Task #12 approved. Looks good!"
```

### Workflow 5: Blocker Resolution

**Scenario:** Teammate gets blocked and needs to handle it

```bash
# 1. Working on task, discover blocker
/claude-swarm:task-update 15 --status in_progress --comment "50% complete, implementing data layer"

# (realize: need database migration that doesn't exist)

# 2. Mark as blocked immediately
/claude-swarm:task-update 15 --status blocked --comment "Blocked: need database migration to add user_preferences table. Cannot proceed without schema"

# 3. Identify who can unblock
# Check team to see who owns database migrations
# Likely backend-dev or team-lead

# 4. Request unblocking
/claude-swarm:swarm-message backend-dev "I'm blocked on task #15. Need migration for user_preferences table (columns: user_id, key, value, updated_at). Can you create this?"

# 5. Switch to other work
/claude-swarm:task-list
# Find another unblocked task

/claude-swarm:task-update 16 --assign frontend-dev
/claude-swarm:task-update 16 --status in_progress --comment "Working on this while task #15 is blocked"

# 6. Get notified blocker is resolved
/claude-swarm:swarm-inbox
# Message from backend-dev: "Migration created: migrations/003_user_preferences.sql. Run with: npm run migrate"

# 7. Unblock and resume
/claude-swarm:task-update 15 --status in_progress --comment "Unblocked. Migration available, resuming data layer implementation"

# Complete work on task #15...

# 8. Complete
/claude-swarm:task-update 15 --status completed --comment "Data layer complete with user_preferences table"
/claude-swarm:swarm-message team-lead "Task #15 completed"
/claude-swarm:swarm-message backend-dev "Thanks for the migration! Task #15 done"
```

**Key Points:**
- Mark blocked immediately (don't waste time)
- Be specific about what's needed to unblock
- Find alternative work while waiting
- Thank the unblocking teammate

### Workflow 6: Emergency Priority Change

**Scenario:** Team-lead requests urgent priority change

```bash
# You're working on task #20
/claude-swarm:task-update 20 --status in_progress --comment "60% complete, implementing feature X"

# Receive urgent message
/claude-swarm:swarm-inbox
# Message from team-lead: "URGENT: Customer reported critical bug in auth. Task #25 created. Need you to drop task #20 and handle #25 immediately"

# 1. Save your current work
# (commit WIP, document state)

# 2. Update current task
/claude-swarm:task-update 20 --status pending --comment "Pausing at 60% for urgent task #25. WIP committed to branch feature-x-wip"

# 3. Confirm and take urgent task
/claude-swarm:swarm-message team-lead "Acknowledged. Pausing task #20, starting task #25 immediately"

/claude-swarm:task-update 25 --assign backend-dev
/claude-swarm:task-update 25 --status in_progress --comment "Starting urgent auth bug fix"

# 4. Work on urgent task
# (fix the bug quickly)

# 5. Complete urgent task
/claude-swarm:task-update 25 --status completed --comment "Auth bug fixed. Deployed to production. Root cause: token validation issue"
/claude-swarm:swarm-message team-lead "Task #25 completed. Auth bug fixed and deployed"

# 6. Resume original work
/claude-swarm:task-update 20 --status in_progress --comment "Resuming work after urgent task #25. Continuing from 60% (branch feature-x-wip)"
```

## Task Assignment Patterns

### Self-Assignment (Standard)

```bash
/claude-swarm:task-list
# Review tasks, select one that matches your skills

/claude-swarm:task-update 8 --assign backend-dev
/claude-swarm:task-update 8 --status in_progress
```

### Suggested Assignment (from team-lead)

```bash
/claude-swarm:swarm-inbox
# Message from team-lead: "Task #9 would be good for you. Similar to #5 you completed"

/claude-swarm:swarm-message team-lead "Sounds good, taking task #9"
/claude-swarm:task-update 9 --assign backend-dev
/claude-swarm:task-update 9 --status in_progress
```

### Reassignment (when stuck)

```bash
# You realize task is beyond your expertise
/claude-swarm:task-update 11 --status pending --comment "This requires deep knowledge of database internals. Recommending reassignment to someone with more DB experience"

/claude-swarm:swarm-message team-lead "Task #11 is beyond my expertise (needs deep database knowledge). Can you reassign to someone with that background?"

# Team-lead reassigns
# You pick up different work
```

## Progress Tracking

### Quantitative Updates

```bash
# At regular intervals (25%, 50%, 75%)
/claude-swarm:task-update 12 --comment "25% complete: data models defined"
/claude-swarm:task-update 12 --comment "50% complete: API endpoints implemented, starting tests"
/claude-swarm:task-update 12 --comment "75% complete: tests written, fixing edge cases"
/claude-swarm:task-update 12 --status completed --comment "100% complete: all tests passing, docs updated"
```

### Qualitative Updates

```bash
# Focus on what's done and what's next
/claude-swarm:task-update 12 --comment "Completed: API implementation. Next: writing tests and updating docs"
/claude-swarm:task-update 12 --comment "Completed: unit tests (95% coverage). Next: integration tests and docs"
/claude-swarm:task-update 12 --comment "Completed: all tests and docs. Final: code review"
```

## Summary

Key principles for task workflows:

1. **Communicate state changes** - Every status update, every blocker
2. **Update frequently** - Don't go dark for hours
3. **Notify dependencies** - Others are waiting on you
4. **Be specific in comments** - Concrete details, file paths, test results
5. **Handle blockers quickly** - Don't waste time when stuck
6. **Coordinate proactively** - Before deep implementation
7. **Follow review protocols** - Request, address, confirm
8. **Document coordination** - Task comments show the full picture

The goal is visibility. The team should always know what you're doing, how far along you are, and if you need help.
