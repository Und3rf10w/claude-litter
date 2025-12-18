# Example: Coordinating with a Peer

## Scenario

You're `backend-dev` working on authentication API (task #5). Another teammate `frontend-dev` is working on the login UI (task #6). These tasks need to work together, so coordination is essential.

## Timeline

### T+0: Identify Related Work

```bash
# Check task list
/claude-swarm:task-list

# Output shows:
# #5 [pending] Implement authentication API (unassigned)
# #6 [pending] Implement login UI (unassigned)

# You read both task descriptions and realize they're tightly coupled
```

### T+1: Claim Your Task

```bash
# Claim task #5
/claude-swarm:task-update 5 --assign backend-dev
/claude-swarm:task-update 5 --status in-progress --comment "Starting auth API implementation"
```

### T+2: Proactively Reach Out

```bash
# Before deep implementation, coordinate with frontend-dev
/claude-swarm:swarm-message frontend-dev "Hi! I'm starting the auth API (task #5). I see you might be taking the login UI (task #6). These are related. Want to coordinate on the API contract and error handling before we both get too deep?"
```

### T+3: Receive Response

```bash
/claude-swarm:swarm-inbox

# Message from frontend-dev:
# "Yes! Was just about to claim task #6. Let's coordinate. For the UI, I'll need:
# - Login endpoint (POST /auth/login)
# - Token format (JWT?)
# - Response shape: {token, user, expires?}
# - Error format: {error, message}
# - Session handling approach
# Thoughts?"
```

### T+4: Discuss and Agree

```bash
# Respond with proposal
/claude-swarm:swarm-message frontend-dev "Great questions! Here's my proposal:
- Endpoint: POST /auth/login (body: {email, password})
- Response on success: {token: string (JWT), user_id: number, email: string, expires_at: ISO timestamp}
- Response on error: {code: string, message: string, field?: string}
- Token: JWT with 7-day expiry, include in header as 'Authorization: Bearer <token>'
- Rate limiting: 5 attempts per 15min per IP
Does this work for your UI?"
```

### T+5: Refine Agreement

```bash
/claude-swarm:swarm-inbox

# Message from frontend-dev:
# "Perfect! Two tweaks:
# 1. Can errors include 'field' for validation errors? (e.g., {code: 'INVALID_EMAIL', message: '...', field: 'email'})
# 2. Can you also return user.name in the success response?
# Then I'm good to go!"

# Respond with confirmation
/claude-swarm:swarm-message frontend-dev "Done! Adding 'field' to errors and 'name' to user object. Final contract:
Success: {token, user_id, email, name, expires_at}
Error: {code, message, field?}
I'll document this in docs/auth-api.md before I start coding. Check it out and let me know if anything else needed"
```

### T+6: Document Agreement

```bash
# Create API documentation
# (write docs/auth-api.md with full spec)

# Update task with coordination notes
/claude-swarm:task-update 5 --comment "Coordinated with frontend-dev on API contract. Documented in docs/auth-api.md. Agreed schema: Success={token,user_id,email,name,expires_at}, Error={code,message,field?}"

# Notify frontend-dev
/claude-swarm:swarm-message frontend-dev "API contract documented in docs/auth-api.md. Give it a quick review before I implement? Want to make sure we're aligned"
```

### T+7: Get Confirmation

```bash
/claude-swarm:swarm-inbox

# Message from frontend-dev:
# "Reviewed docs/auth-api.md. Looks perfect! I'm starting task #6 now with this contract. Will mock the API responses initially, then integrate when you're deployed"

# Confirm
/claude-swarm:swarm-message frontend-dev "Sounds good! I'll ping you when the API is deployed to staging so you can integrate"
```

### T+8-20: Parallel Development

```bash
# You implement the API
/claude-swarm:task-update 5 --comment "40% complete: authentication logic implemented, working on JWT generation"
/claude-swarm:task-update 5 --comment "70% complete: API endpoints done, writing tests"

# Meanwhile, frontend-dev is also working
# (They're using mocked responses based on the agreed contract)
```

### T+21: Complete and Deploy

```bash
# Complete your implementation
/claude-swarm:task-update 5 --status completed --comment "Auth API complete. Deployed to staging: https://staging.api.com. Docs: docs/auth-api.md. Tests: 98% coverage"

# Notify frontend-dev (they're waiting for this!)
/claude-swarm:swarm-message frontend-dev "Auth API deployed to staging! You can now integrate task #6. Endpoint: https://staging.api.com/auth/login. Let me know if you hit any issues. curl example in docs/auth-api.md"
```

### T+22: Integration and Issues

```bash
/claude-swarm:swarm-inbox

# Message from frontend-dev:
# "Integrating now... Quick question: getting 401 on valid credentials. Is there a test account I can use?"

# Respond quickly
/claude-swarm:swarm-message frontend-dev "Good catch! Test account: email=test@example.com, password=test123. Also check that you're sending Content-Type: application/json header. Let me know if still having issues"
```

### T+23: Successful Integration

```bash
/claude-swarm:swarm-inbox

# Message from frontend-dev:
# "That was it! Needed the Content-Type header. Integration complete! Task #6 done. Auth flow working end-to-end. Great coordination!"

# Acknowledge
/claude-swarm:swarm-message frontend-dev "Awesome! Glad it worked out. Nice working with you on this!"

# Notify team-lead
/claude-swarm:swarm-message team-lead "FYI: Task #5 (auth API) and task #6 (login UI) both complete. Full auth feature is working end-to-end on staging"
```

## Key Takeaways

1. **Identify related work early** - Check task list for coupled tasks
2. **Reach out before deep implementation** - Align on contracts early
3. **Be specific in proposals** - Concrete examples, not vague descriptions
4. **Document agreements** - Write it down (docs/api.md)
5. **Get confirmation** - Make sure they reviewed and agreed
6. **Notify when ready** - Tell them when your part is deployable
7. **Be responsive to integration issues** - Help them integrate quickly
8. **Acknowledge successful collaboration** - Thank your peer

## What NOT to Do

❌ **Don't implement in isolation**
```bash
# Bad: Just start coding without talking to frontend-dev
/claude-swarm:task-update 5 --status in-progress --comment "Starting auth API"
# Problem: You might make assumptions that don't work for the UI
```

❌ **Don't use vague communication**
```bash
# Bad: "Let's coordinate on the API"
# Problem: What specifically? No concrete proposal
```

❌ **Don't skip documentation**
```bash
# Bad: Agreeing verbally but not writing it down
# Problem: Both might remember differently; no reference during implementation
```

❌ **Don't forget to notify**
```bash
# Bad: Complete task #5 but don't tell frontend-dev it's deployed
# Problem: They're waiting to integrate; you're blocking them unknowingly
```

❌ **Don't disappear during integration**
```bash
# Bad: Not checking inbox when frontend-dev is integrating
# Problem: They hit issues and you're not there to help; delays completion
```

## Variations

### Variation 1: Discover Conflict Mid-Implementation

```bash
# You're halfway through when frontend-dev messages
/claude-swarm:swarm-inbox

# Message from frontend-dev:
# "Hey, I started task #6 yesterday with a different API shape. I'm using {username, token, expiry}. Can you match this?"

# Respond quickly
/claude-swarm:swarm-message frontend-dev "Ah! I'm already halfway through with {email, token, expires_at}. Can we sync? My approach aligns with task #7 (password reset) which also uses email. Want to jump on a quick call or align via messages?"

# Coordinate resolution
# (Either you adapt, they adapt, or you both meet in the middle)
# (Update tasks with new agreement)
```

### Variation 2: Breaking Change Needed

```bash
# Midway through, you realize the API needs a breaking change
/claude-swarm:swarm-message frontend-dev "Update on task #5: I need to make a breaking change. Token needs to be returned in response.data.token (not top-level) due to middleware requirements. Can your UI handle this? Can change if it's a problem"

# Wait for response and adjust based on their needs
```

### Variation 3: Three-Way Coordination

```bash
# task #5 (your auth API) relates to both task #6 (login UI) AND task #7 (mobile app login)

/claude-swarm:swarm-message frontend-dev "Starting auth API (task #5). I see this relates to both your task #6 (web login) and mobile-dev's task #7 (mobile login). Should we three coordinate on a unified API contract?"

# Set up three-way coordination
# (All three review and agree on docs/auth-api.md)
# (Document that it serves both web and mobile)
```

## Communication Templates

### Initial Reach-Out
```bash
/claude-swarm:swarm-message <teammate> "I'm starting task #<yours> which relates to your task #<theirs>. Want to coordinate on <interface/approach> before we both get deep into implementation?"
```

### Proposing Contract
```bash
/claude-swarm:swarm-message <teammate> "Here's my proposed <API/interface/approach>:
- <detail 1>
- <detail 2>
- <detail 3>
Does this work for your <component>?"
```

### Confirming Agreement
```bash
/claude-swarm:swarm-message <teammate> "Documented our agreement in <file>. Please review when you can. Starting implementation assuming this is correct"
```

### Notifying Completion
```bash
/claude-swarm:swarm-message <teammate> "My part (task #<id>) is done and deployed to <environment>. You can now integrate. <Test instructions or examples>"
```

### Helping with Integration
```bash
/claude-swarm:swarm-message <teammate> "Let me know when you start integrating. Happy to help debug any issues"
```
