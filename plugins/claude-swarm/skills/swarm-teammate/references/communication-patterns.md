# Communication Patterns for Swarm Teammates

## Message Types

### 1. Status Updates

**When to use:** After completing major milestones or when status changes.

**Template:**
```bash
/claude-swarm:swarm-message team-lead "Task #<id>: <status>. <brief-details>"
```

**Examples:**
```bash
/claude-swarm:swarm-message team-lead "Task #5: 50% complete. API implemented, starting tests"
/claude-swarm:swarm-message team-lead "Task #5: Completed. All tests passing, PR #123"
```

### 2. Dependency Notifications

**When to use:** When you complete work that others are waiting for.

**Template:**
```bash
/claude-swarm:swarm-message <waiting-teammate> "Task #<id> completed. <what-they-need> is available at <location>"
```

**Examples:**
```bash
/claude-swarm:swarm-message frontend-dev "Task #5 completed. API schema available at docs/api.json"
/claude-swarm:swarm-message tester "Task #8 done. Feature deployed to staging, ready for testing"
```

### 3. Blocker Notifications

**When to use:** When you're blocked and need help or information.

**Template:**
```bash
/claude-swarm:swarm-message <blocking-teammate> "I'm blocked on task #<id>. Need: <what-you-need>. ETA?"
```

**Examples:**
```bash
/claude-swarm:swarm-message backend-dev "I'm blocked on task #12. Need database migration script. ETA?"
/claude-swarm:swarm-message team-lead "I'm blocked on task #3. Waiting for design approval from external team"
```

### 4. Coordination Requests

**When to use:** When you need to coordinate with a peer on related work.

**Template:**
```bash
/claude-swarm:swarm-message <teammate> "I'm working on <component A>. Are you handling <component B>? Need to coordinate <interface/approach>"
```

**Examples:**
```bash
/claude-swarm:swarm-message frontend-dev "I'm working on auth API. Are you handling login UI? Let's align on token format"
/claude-swarm:swarm-message backend-dev "I'm writing integration tests. Can we coordinate on test data setup?"
```

### 5. Questions

**When to use:** When you need clarification or information.

**Template:**
```bash
/claude-swarm:swarm-message <teammate> "<question>? Context: <relevant-context>"
```

**Examples:**
```bash
/claude-swarm:swarm-message team-lead "Should error messages be user-facing or debug-level? Context: working on API error handling"
/claude-swarm:swarm-message reviewer "Found inconsistent naming in existing code. Fix now or separate task?"
```

### 6. Review Requests

**When to use:** When your work is ready for review.

**Template:**
```bash
/claude-swarm:swarm-message reviewer "Task #<id> ready for review. Focus on: <key-areas>. Files: <file-list>"
```

**Examples:**
```bash
/claude-swarm:swarm-message reviewer "Task #5 ready for review. Focus on: error handling and edge cases. Files: src/api/*.ts"
/claude-swarm:swarm-message team-lead "Task #10 ready for final approval. All tests passing, docs updated"
```

## Communication Frequency

### Check Inbox

- **At start of session** - Always check first
- **After completing major work** - Others may have messaged
- **Every 30 minutes** - If working on long task
- **When notified** - Real-time if using kitty with notifications

### Send Updates

- **When claiming task** - Let team know you're starting
- **Every major milestone** - 25%, 50%, 75%, or logical breakpoints
- **When blocked** - Immediately when you realize
- **When completing** - Always notify team-lead and dependencies
- **When discovering issues** - Proactively share

## Message Quality Guidelines

### DO Write Messages That Are:

1. **Actionable** - Clear next steps or information
2. **Concise** - Respect teammates' time
3. **Specific** - Reference task IDs, file paths, concrete details
4. **Timely** - Send when relevant, not hours later
5. **Complete** - Include all context needed

### Examples of Good Messages:

```bash
# Good: Specific, actionable, references task ID
/claude-swarm:swarm-message frontend-dev "Task #5 done. API endpoint: POST /auth/login, schema in docs/api.json line 45"

# Good: Clear blocker with specific need
/claude-swarm:swarm-message backend-dev "Blocked on task #8. Need database migration #003. Can you prioritize?"

# Good: Coordination with concrete proposal
/claude-swarm:swarm-message tester "Working on user signup (task #6). Can you test happy path today and edge cases tomorrow?"
```

### Examples of Poor Messages:

```bash
# Bad: Vague, no actionable info
/claude-swarm:swarm-message team-lead "Making progress"

# Bad: No context, unclear request
/claude-swarm:swarm-message backend-dev "Need help"

# Bad: Too much detail, buries the key point
/claude-swarm:swarm-message frontend-dev "So I was working on the API and I tried this approach but it didn't work so I tried another approach and then I realized we need to coordinate. The first approach was..."
```

## Escalation Protocol

### When to Escalate to Team-Lead

1. **Major blockers** - Can't resolve with teammate directly
2. **Scope changes** - Task requirements unclear or changing
3. **Resource conflicts** - Two teammates need same resources
4. **Deadline concerns** - Won't complete on time
5. **Technical decisions** - Need architectural guidance

### Escalation Template

```bash
/claude-swarm:swarm-message team-lead "Escalation: <issue-summary>. Tried: <what-you-tried>. Impact: <who/what-affected>. Need: <decision/help-needed>"
```

### Example:

```bash
/claude-swarm:swarm-message team-lead "Escalation: API design conflict between tasks #5 and #8. Tried: coordinating with backend-dev, but approaches are incompatible. Impact: blocks both tasks, affects 3 dependent tasks. Need: architectural decision on REST vs GraphQL"
```

## Response Time Expectations

### Your Responses

- **Urgent questions** - Within 15 minutes if actively working
- **Blocker notifications** - Immediately if you can unblock
- **General questions** - Within 1 hour
- **Review requests** - Within 2 hours or set ETA

### Others' Responses

**Be patient but follow up** if no response:

```bash
# First message
/claude-swarm:swarm-message backend-dev "Need database schema for task #5"

# 2 hours later, no response
/claude-swarm:swarm-message backend-dev "Following up on database schema request. Still blocked on task #5"

# 4 hours later, still no response
/claude-swarm:swarm-message team-lead "Haven't heard from backend-dev on schema request (2 messages). Blocking task #5. Can you help?"
```

## Communication Anti-Patterns

### 1. The Silent Worker

**Problem:** Doesn't message anyone, surprises team with completed work (or failure)

**Solution:** Proactive status updates, notify dependencies

### 2. The Spammer

**Problem:** Sends 10 messages for every small update

**Solution:** Batch related updates, focus on milestones

### 3. The Assumpt Coordinator

**Problem:** Assumes others know what they're doing, doesn't communicate

**Solution:** Explicit coordination messages, confirm understanding

### 4. The Question Hoarder

**Problem:** Saves all questions for one big message

**Solution:** Ask questions when they arise, don't let unknowns accumulate

### 5. The One-Way Communicator

**Problem:** Sends messages but never checks inbox

**Solution:** Check inbox regularly, respond to others

## Summary

Good communication in swarms:
- **Is frequent** - Regular updates, not just at completion
- **Is proactive** - Don't wait to be asked
- **Is specific** - Task IDs, file paths, concrete details
- **Is actionable** - Clear next steps
- **Is responsive** - Reply promptly to others

The goal is to make the team's work transparent and coordinated. Over-communicate rather than under-communicate.
