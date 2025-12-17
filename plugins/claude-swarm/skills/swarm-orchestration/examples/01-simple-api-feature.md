# Example 1: Simple API Feature

**Complexity:** ⭐ Simple
**Team Size:** 2 teammates
**Duration:** ~30-60 minutes
**Prerequisites:** Express.js backend, existing API structure

## Scenario

You need to add a new REST API endpoint to fetch user profile data. The endpoint should:

- Accept GET requests at `/api/users/:id/profile`
- Return user profile with name, email, bio, avatar
- Include error handling for missing users
- Have unit tests with 80%+ coverage

## Analysis

This is a simple feature that divides cleanly:

**Task Breakdown:**

1. **Implement Profile Endpoint** (backend-developer)
   - Dependencies: None
   - Deliverables: Route handler, controller, validation
   - Files: `routes/users.js`, `controllers/userController.js`

2. **Write Tests** (tester)
   - Dependencies: Task 1
   - Deliverables: Unit tests, integration tests
   - Files: `tests/userProfile.test.js`

**Team:**
- backend-dev (backend-developer, sonnet)
- qa-engineer (tester, haiku) - simple tests don't need opus

## Complete Workflow

### 1. Create Team

```bash
/claude-swarm:swarm-create "profile-api" "Add user profile endpoint"
```

**Output:**
```
Created team 'profile-api'
  Config: ~/.claude/teams/profile-api/config.json
  Tasks: ~/.claude/tasks/profile-api/
```

### 2. Create Tasks

```bash
/claude-swarm:task-create "Implement profile endpoint" "Add GET /api/users/:id/profile endpoint. Return user profile data (name, email, bio, avatar). Include 404 handling for missing users. Validate ID parameter. Add to routes/users.js and controllers/userController.js"

/claude-swarm:task-create "Write profile endpoint tests" "Write unit and integration tests for /api/users/:id/profile endpoint. Test success case, 404 case, invalid ID. Aim for 80%+ coverage. Use Jest. Add to tests/userProfile.test.js"
```

**Output:**
```
Created task #1: Implement profile endpoint
1
Created task #2: Write profile endpoint tests
2
```

### 3. Set Dependency

```bash
/claude-swarm:task-update 2 --blocked-by 1
```

**Why:** Tests depend on implementation being complete.

### 4. Spawn Teammates

```bash
/claude-swarm:swarm-spawn "backend-dev" "backend-developer" "sonnet" "You are the backend developer. Work on Task #1: Implement profile endpoint. Add GET /api/users/:id/profile route. See task list for full requirements (/claude-swarm:task-list). Message team-lead when complete."

/claude-swarm:swarm-spawn "qa-engineer" "tester" "haiku" "You are the QA engineer. Work on Task #2: Write profile endpoint tests. Wait for Task #1 to complete (check task list). Once backend-dev finishes the endpoint, write comprehensive tests. Message team-lead when done."
```

**Output:**
```
Spawned: backend-dev
Spawned: qa-engineer
```

### 5. Verify Spawns

```bash
/claude-swarm:swarm-verify profile-api
```

**Output:**
```
Verifying team 'profile-api'...
✓ backend-dev is alive
✓ qa-engineer is alive
All teammates verified successfully.
```

**If verification fails:** See swarm-troubleshooting skill.

### 6. Assign Tasks

```bash
/claude-swarm:task-update 1 --assign "backend-dev"
/claude-swarm:task-update 2 --assign "qa-engineer"
```

**Output:**
```
Updated task #1
Updated task #2
```

### 7. Monitor Progress

```bash
/claude-swarm:task-list
```

**Initial Output:**
```
Tasks for team 'profile-api':
--------------------------------
#1 [pending] Implement profile endpoint (backend-dev)
#2 [blocked] Write profile endpoint tests (qa-engineer) [blocked by #1]
```

Wait a few minutes for backend-dev to work...

```bash
/claude-swarm:swarm-inbox
```

**After ~15-20 minutes:**
```
=== Inbox for team-lead in team profile-api ===

Unread messages: 1

<teammate-message teammate_id="backend-dev" color="blue">
Task #1 complete. Profile endpoint implemented at GET /api/users/:id/profile.
Route added in routes/users.js:45-52.
Controller logic in controllers/userController.js:89-115.
Includes validation and 404 handling.
Tested manually with curl - working correctly.
</teammate-message>

(Messages marked as read)
```

### 8. Unblock QA Engineer

```bash
/claude-swarm:task-update 1 --status "completed"

/claude-swarm:swarm-message "qa-engineer" "Task #1 complete. Backend-dev finished the profile endpoint. Implementation in routes/users.js and controllers/userController.js. You're unblocked - start writing tests now."
```

**Check Progress:**

```bash
/claude-swarm:task-list
```

**Output:**
```
Tasks for team 'profile-api':
--------------------------------
#1 [completed] Implement profile endpoint (backend-dev)
#2 [in-progress] Write profile endpoint tests (qa-engineer)
```

### 9. Wait for Tests

Check inbox periodically:

```bash
/claude-swarm:swarm-inbox
```

**After ~10-15 minutes:**
```
=== Inbox for team-lead in team profile-api ===

Unread messages: 1

<teammate-message teammate_id="qa-engineer" color="green">
Task #2 complete. Tests written in tests/userProfile.test.js.
Covers: success case, 404 case, invalid ID validation.
All tests passing. Coverage: 87%.
Run with: npm test tests/userProfile.test.js
</teammate-message>

(Messages marked as read)
```

### 10. Mark Complete

```bash
/claude-swarm:task-update 2 --status "completed"
```

### 11. Final Verification

```bash
/claude-swarm:task-list
```

**Output:**
```
Tasks for team 'profile-api':
--------------------------------
#1 [completed] Implement profile endpoint (backend-dev)
#2 [completed] Write profile endpoint tests (qa-engineer)
```

```bash
/claude-swarm:swarm-status profile-api
```

**Output:**
```
=== Team: profile-api ===
Multiplexer: kitty

Description: Add user profile endpoint

Members (config vs live):
  backend-dev (backend-developer)     config: active   window exists ✓
  qa-engineer (tester)                config: active   window exists ✓

Tasks:
  Active: 0
  Completed: 2
```

### 12. Review and Test

As team lead, review the deliverables:

```bash
# In your main session, check the code
cat routes/users.js | grep -A 10 "/profile"
cat controllers/userController.js | grep -A 25 "getProfile"

# Run the tests
npm test tests/userProfile.test.js
```

If everything looks good, proceed to cleanup.

### 13. Cleanup

```bash
/claude-swarm:swarm-cleanup "profile-api"
```

**Output:**
```
Killing sessions for team 'profile-api'...
✓ Terminated backend-dev
✓ Terminated qa-engineer
Team data preserved. Use /claude-swarm:swarm-resume to restart.
```

### 14. Report to User

```
Completed! User profile endpoint added:
- Endpoint: GET /api/users/:id/profile
- Files changed: routes/users.js, controllers/userController.js
- Tests: tests/userProfile.test.js (87% coverage, all passing)
- Ready for code review and deployment
```

## Timeline

**Total Time:** ~35 minutes

- Setup (create team, tasks, spawn): **5 minutes**
- Backend implementation: **15-20 minutes**
- Test writing: **10-15 minutes**
- Review and cleanup: **5 minutes**

## Key Coordination Points

### Point 1: After Spawn (Immediate)

**Action:** Verify spawns succeeded

**Why:** Catch failures early before wasting time

**Command:** `/claude-swarm:swarm-verify profile-api`

### Point 2: Backend Completion (~20 minutes)

**Action:**
1. Check inbox for completion message
2. Mark Task #1 complete
3. Unblock qa-engineer

**Why:** QA is waiting for implementation

**Commands:**
```bash
/claude-swarm:task-update 1 --status "completed"
/claude-swarm:swarm-message "qa-engineer" "Task #1 complete. Start tests now."
```

### Point 3: Tests Complete (~35 minutes)

**Action:**
1. Check inbox for test results
2. Mark Task #2 complete
3. Review deliverables

**Why:** Verify everything is done before cleanup

## Lessons Learned

### What Went Well

✓ **Clean dependency chain** - One task blocks the next, simple to coordinate
✓ **Right-sized team** - 2 teammates is manageable
✓ **Clear prompts** - Teammates knew exactly what to do
✓ **Good communication** - Teammates messaged with specific details

### What to Watch

⚠️ **Waiting time** - QA engineer idle while backend works
*Solution:* For larger projects, give QA engineer test planning work during wait

⚠️ **Limited parallelism** - Sequential tasks limit speed benefit
*Solution:* This is appropriate for small features. Larger features enable more parallelism.

### Patterns to Reuse

1. **Verify immediately after spawning** - Always run `swarm-verify`
2. **Message with file paths** - backend-dev included exact files/lines
3. **Unblock promptly** - Responded to completion immediately
4. **Check inbox regularly** - Caught updates as they happened

## Adapting This Example

### For Different Features

**Adding a DELETE endpoint:**
- Same structure, change task descriptions
- Still needs implementation + tests
- Same 2-person team works

**Adding multiple endpoints:**
- Create separate tasks for each endpoint
- Consider 1 backend-dev + 1 tester per endpoint pair
- Coordinate to avoid merge conflicts

**Adding middleware:**
- Insert middleware task before endpoint task
- Set dependency: endpoint blocked by middleware
- Same pattern applies

### For Different Tech Stacks

**Django/Flask (Python):**
- Replace `routes/users.js` with `views/users.py`
- Replace Jest with pytest
- Same workflow structure

**Rails (Ruby):**
- Replace with `app/controllers/users_controller.rb`
- Use RSpec for tests
- Same coordination pattern

## Troubleshooting This Example

### Backend-dev doesn't message back

**Check:**
1. Is session still alive? `/claude-swarm:swarm-status profile-api`
2. Attach to session (tmux/kitty) and see what they're doing
3. Did they hit an error? Check their output

**Fix:**
- If crashed: respawn with `/claude-swarm:swarm-spawn`
- If stuck: message them with guidance
- If confused: provide clearer instructions

### Tests fail

**Common causes:**
1. Backend implementation has bugs
2. Test expectations don't match implementation
3. Missing dependencies (database, test data)

**Fix:**
1. Review backend-dev's code
2. Message qa-engineer with corrections
3. Have backend-dev fix bugs, then qa-engineer re-run tests

### Want to add more work mid-stream

**Example:** Realized we also need PATCH endpoint for updating profile

**Solution:**
1. Create new task: `/claude-swarm:task-create "Add profile update endpoint"`
2. Assign to backend-dev: `/claude-swarm:task-update 3 --assign "backend-dev"`
3. Message backend-dev: "New task #3 added. After current work, implement PATCH endpoint."
4. Create test task: `/claude-swarm:task-create "Test profile update endpoint"`
5. Assign to qa-engineer: `/claude-swarm:task-update 4 --assign "qa-engineer"`
6. Set dependency: `/claude-swarm:task-update 4 --blocked-by 3`

## Next Steps

After completing this example:

1. Try **Example 2** (Full-Stack Feature) for a more complex scenario
2. Adapt this pattern to your own simple API features
3. Experiment with different team sizes (try 1 backend + 2 testers)
4. Practice your prompts to get better teammate behavior

## Quick Command Reference

```bash
# Setup
/claude-swarm:swarm-create "profile-api" "Add user profile endpoint"
/claude-swarm:task-create "<subject>" "<description>"
/claude-swarm:task-update 2 --blocked-by 1

# Spawn
/claude-swarm:swarm-spawn "backend-dev" "backend-developer" "sonnet" "<prompt>"
/claude-swarm:swarm-spawn "qa-engineer" "tester" "haiku" "<prompt>"
/claude-swarm:swarm-verify profile-api

# Coordinate
/claude-swarm:task-update 1 --assign "backend-dev"
/claude-swarm:swarm-inbox
/claude-swarm:task-update 1 --status "completed"
/claude-swarm:swarm-message "qa-engineer" "Unblocked. Start tests."

# Monitor
/claude-swarm:task-list
/claude-swarm:swarm-status profile-api

# Cleanup
/claude-swarm:swarm-cleanup "profile-api"
```
