# Example: Completing Tasks and Notifying Dependencies

## Scenario

You're `backend-dev` completing task #8 (user profile API). Multiple tasks and teammates depend on your work.

## Context

**Your Task:**
- Task #8: Implement user profile API
- Status: in_progress → completing

**Dependencies:**
- Task #10: User profile UI (frontend-dev) - BLOCKED by task #8
- Task #12: User profile tests (tester) - BLOCKED by task #8
- Task #15: Admin panel user management (admin-dev) - uses #8 but not blocked

**Relationships:**
- frontend-dev: Explicitly blocked, waiting for your API
- tester: Explicitly blocked, needs API to write tests
- admin-dev: Not blocked, but will use your API when available
- team-lead: Needs to know about completion

## Timeline

### T+0: Nearing Completion

```bash
# You're almost done
/claude-swarm:task-update 8 --comment "95% complete. API implemented, tests passing. Final: deploy to staging and documentation"
```

### T+1: Complete Implementation

```bash
# Finish the work
# - All tests passing (98% coverage)
# - API deployed to staging
# - Documentation written (docs/user-profile-api.md)
# - Example curl commands tested
```

### T+2: Mark Task Complete

```bash
# Mark as complete with comprehensive comment
/claude-swarm:task-update 8 --status completed --comment "User profile API complete.
Deployed to: https://staging.api.com/users
Documentation: docs/user-profile-api.md
Endpoints: GET /users/:id, PUT /users/:id, POST /users/:id/avatar, DELETE /users/:id
Test account: user_id=123
Test coverage: 98%
Ready for integration"
```

### T+3: Notify Blocked Teammates (CRITICAL)

```bash
# Notify frontend-dev (explicitly blocked)
/claude-swarm:swarm-message frontend-dev "Task #8 (user profile API) completed! Your task #10 is now unblocked.

API deployed to staging: https://staging.api.com/users
Full docs: docs/user-profile-api.md
Test account: user_id=123

Key endpoints:
- GET /users/:id - Fetch profile
- PUT /users/:id - Update profile
- POST /users/:id/avatar - Upload avatar
- DELETE /users/:id - Delete account

curl example:
curl https://staging.api.com/users/123 -H 'Authorization: Bearer <token>'

Let me know if you need any help integrating!"

# Notify tester (also explicitly blocked)
/claude-swarm:swarm-message tester "Task #8 (user profile API) completed! Your task #12 is now unblocked.

API deployed to staging: https://staging.api.com/users
Test docs: docs/user-profile-api.md#testing
Test account: user_id=123, token in docs

Focus areas for testing:
- Avatar upload (supports jpg, png, max 5MB)
- Field validation (email, phone, etc.)
- Authorization (users can only edit own profile)
- Edge cases documented in docs/user-profile-api.md#edge-cases

I'll be around if you need help!"
```

### T+4: Notify Related Teammates (Not Blocked But Interested)

```bash
# Notify admin-dev (uses your API but wasn't blocked)
/claude-swarm:swarm-message admin-dev "FYI: Task #8 (user profile API) is complete and deployed to staging. You mentioned task #15 (admin panel) would use this API.

The API is ready for your integration:
- Docs: docs/user-profile-api.md
- Admin-specific endpoints: GET /users (list all), PUT /users/:id (admin edit)
- Admin auth: requires 'admin' role in JWT

Let me know if you need admin-specific features!"
```

### T+5: Notify Team-Lead

```bash
# Always notify team-lead of completions
/claude-swarm:swarm-message team-lead "Task #8 completed. User profile API deployed to staging and ready for integration.

Unblocked tasks:
- Task #10 (frontend-dev) - notified
- Task #12 (tester) - notified

Also notified admin-dev (task #15 uses this API).

Docs: docs/user-profile-api.md
Coverage: 98%
All integration tests passing"
```

### T+6: Update Task List View

```bash
# Check that blocked tasks are now visible as unblocked
/claude-swarm:task-list

# Output should now show:
# #8 [completed] Implement user profile API (backend-dev)
# #10 [blocked] User profile UI (frontend-dev) ← No longer blocked in practice
# #12 [blocked] User profile tests (tester) ← No longer blocked in practice

# Note: Task status is still "blocked" because only frontend-dev/tester can change that
# But they now have what they need
```

### T+7-10: Field Integration Questions

```bash
# frontend-dev starts integrating and has questions
/claude-swarm:swarm-inbox

# Message from frontend-dev:
# "Started integration. Getting 400 on avatar upload. Tried POST /users/123/avatar with file in body. What's wrong?"

# Respond quickly with helpful details
/claude-swarm:swarm-message frontend-dev "Avatar upload needs multipart/form-data, not JSON.

Example curl:
curl -X POST https://staging.api.com/users/123/avatar \\
  -H 'Authorization: Bearer <token>' \\
  -F 'avatar=@photo.jpg'

In fetch:
const formData = new FormData();
formData.append('avatar', file);
fetch(..., { body: formData })

Let me know if still having issues!"
```

### T+11: Confirmation of Successful Integration

```bash
/claude-swarm:swarm-inbox

# Message from frontend-dev:
# "That worked! Avatar upload now functional. Task #10 is moving forward smoothly. Thanks for the quick help!"

# Acknowledge
/claude-swarm:swarm-message frontend-dev "Great! Glad it's working. Ping me if you hit any other issues"
```

### T+12: Second Teammate Completes

```bash
/claude-swarm:swarm-inbox

# Message from tester:
# "Task #12 completed. Wrote comprehensive tests for your API. Found one edge case: avatar upload fails for files exactly 5MB (should be <=5MB). Can you fix?"

# Respond and address
/claude-swarm:swarm-message tester "Good catch! That's a bug. I'll fix it now"

/claude-swarm:task-update 8 --comment "Bug fix: avatar upload now accepts files exactly 5MB (was rejecting). Deployed to staging"

/claude-swarm:swarm-message tester "Fixed! Avatar upload now correctly handles files up to and including 5MB. Can you retest?"
```

## Key Takeaways

1. **Mark complete with detailed comment** - Include deployment URL, docs, test info
2. **Notify ALL blocked teammates** - Don't assume they'll check task list
3. **Provide actionable information** - URLs, test accounts, curl examples
4. **Notify related teammates** - Even if not blocked, they might care
5. **Always notify team-lead** - They need visibility
6. **Be available for integration help** - Stick around to answer questions
7. **Address issues quickly** - When teammates hit problems integrating

## Notification Priority

**Priority 1: Blocked teammates**
- They've been waiting specifically for you
- They can't proceed without your notification
- Include detailed integration info

**Priority 2: Team-lead**
- Needs to track overall progress
- Needs to know what's unblocked
- Include summary of impact

**Priority 3: Related teammates**
- Might use your work
- Should know it's available
- Can be briefer

## What NOT to Do

❌ **Don't just mark complete and stay silent**
```bash
# Bad:
/claude-swarm:task-update 8 --status completed --comment "Done"
# Problem: Blocked teammates don't know; they're still waiting
```

❌ **Don't send vague notifications**
```bash
# Bad:
/claude-swarm:swarm-message frontend-dev "Task #8 done"
# Problem: Not enough info to integrate; they'll have to ask questions
```

❌ **Don't forget some dependencies**
```bash
# Bad: Only notifying frontend-dev, forgetting tester
# Problem: Tester is still blocked unknowingly
```

❌ **Don't disappear after completion**
```bash
# Bad: Mark complete, notify, then go offline
# Problem: Teammates try to integrate, hit issues, can't reach you
```

❌ **Don't assume they'll see the task list update**
```bash
# Bad: "They can just check /claude-swarm:task-list"
# Problem: They might not check for hours; explicit message is faster
```

## Complete Message Template

```bash
/claude-swarm:swarm-message <blocked-teammate> "Task #<id> (<description>) completed! Your task #<their-id> is now unblocked.

<deployment-info>
<documentation-links>
<test-accounts-or-credentials>

<key-endpoints-or-interfaces>

<example-usage>

Let me know if you need any help integrating!"
```

## Variations

### Variation 1: Completion with Known Issues

```bash
/claude-swarm:task-update 8 --status completed --comment "User profile API complete with one known limitation: avatar uploads limited to 5MB (will increase to 10MB in future enhancement)"

/claude-swarm:swarm-message frontend-dev "Task #8 done. Note: avatar uploads capped at 5MB for now. Let me know if this blocks you and I can prioritize increasing the limit"
```

### Variation 2: Completion with Follow-Up Task

```bash
/claude-swarm:task-update 8 --status completed --comment "Core API complete. Created follow-up task #16 for performance optimization (caching)"

/claude-swarm:swarm-message frontend-dev "Task #8 done and ready for integration! FYI: Created task #16 for adding caching later, but current version is fully functional"
```

### Variation 3: Partial Completion

```bash
# You've completed enough to unblock others, but have more work
/claude-swarm:task-update 8 --comment "Core API complete and deployed. Unblocks dependent tasks. Still working on: admin-specific endpoints (due EOD)"

/claude-swarm:swarm-message frontend-dev "Good news: Task #8 core API is done. Your task #10 is unblocked (endpoints: GET, PUT, POST /users/:id). I'm still adding admin endpoints (doesn't affect you)"

/claude-swarm:swarm-message admin-dev "Task #8 core done, but I'm still working on admin-specific endpoints (GET /users list, bulk operations). ETA: EOD. You can start with core endpoints if helpful"
```

### Variation 4: Completion Unblocks a Chain

```bash
# Task #8 completion unblocks #10, which unblocks #14

/claude-swarm:task-update 8 --status completed --comment "API complete"

/claude-swarm:swarm-message frontend-dev "Task #8 done, your task #10 unblocked"

/claude-swarm:swarm-message mobile-dev "Task #8 done. This unblocks frontend-dev's task #10, which I believe unblocks your task #14. Frontend-dev will notify you when #10 is done"

# Also notify team-lead about the chain
/claude-swarm:swarm-message team-lead "Task #8 complete. Unblocks chain: #10 (frontend-dev) → #14 (mobile-dev)"
```

## Summary

Completing a task is not just about marking it done. It's about:

1. **Documenting what you did** - Detailed completion comment
2. **Unblocking others** - Notify everyone waiting
3. **Providing integration help** - Be available for questions
4. **Keeping team-lead informed** - Visibility into progress
5. **Enabling the chain** - Your completion may unblock multiple downstream tasks

The goal is to maximize team velocity. Your completion notification directly enables others to start their work immediately.
