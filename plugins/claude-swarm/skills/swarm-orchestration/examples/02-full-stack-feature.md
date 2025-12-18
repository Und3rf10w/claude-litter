# Example 2: Full-Stack Feature

**Complexity:** ⭐⭐⭐ Moderate
**Team Size:** 4 teammates
**Duration:** ~2-4 hours
**Prerequisites:** React frontend, Express backend, existing auth patterns

## Scenario

You need to implement a complete user authentication system:

**Requirements:**
- JWT-based authentication
- Login and signup endpoints
- Protected route middleware
- Login/signup UI forms
- Session management in frontend
- Comprehensive tests (unit + integration)

This is a realistic full-stack feature requiring coordination across layers.

## Analysis

### Task Breakdown

**Task 1: Design Auth Architecture** (researcher)
- No dependencies
- Deliverables: Design document, API contracts, security considerations
- File: `docs/auth-design.md`

**Task 2: Implement Backend Auth** (backend-developer)
- Depends on: Task 1
- Deliverables: JWT auth, login/signup endpoints, middleware
- Files: `backend/auth/`, `middleware/auth.js`

**Task 3: Build Auth UI** (frontend-developer)
- Depends on: Task 1
- Deliverables: Login form, signup form, session management
- Files: `frontend/pages/Login.tsx`, `frontend/pages/Signup.tsx`, `frontend/hooks/useAuth.ts`

**Task 4: Write Auth Tests** (tester)
- Depends on: Tasks 2 & 3
- Deliverables: Backend unit tests, frontend component tests, E2E tests
- Files: `backend/tests/auth.test.js`, `frontend/tests/auth.test.tsx`, `e2e/auth.spec.js`

### Dependency Graph

```
Task 1 (researcher) - Design
     ├──> Task 2 (backend)  ──┐
     └──> Task 3 (frontend) ──┤
                               ├──> Task 4 (tester)
```

**Key insight:** Tasks 2 & 3 can run in parallel after Task 1.

### Team

- **auth-architect** (researcher, opus) - Complex design needs best model
- **backend-dev** (backend-developer, sonnet)
- **frontend-dev** (frontend-developer, sonnet)
- **qa-lead** (tester, sonnet) - Complex E2E tests need sonnet

## Complete Workflow

### 1. Create Team

```bash
/claude-swarm:swarm-create "auth-system" "Implement complete user authentication system with JWT"
```

### 2. Create Tasks

```bash
/claude-swarm:task-create "Design auth architecture" "Design JWT-based authentication system. Define API contracts (login, signup, token refresh), security considerations, token storage strategy, session management approach. Document in docs/auth-design.md with endpoint specs, request/response schemas, error handling."

/claude-swarm:task-create "Implement backend auth" "Build JWT authentication system. Implement login/signup endpoints, token generation/validation, refresh logic. Create auth middleware for protected routes. Files: backend/auth/authService.js, backend/auth/tokenService.js, middleware/auth.js, routes/auth.js"

/claude-swarm:task-create "Build auth UI" "Create login and signup forms. Implement session management hooks. Handle token storage (localStorage/cookies per design). Build protected route component. Files: frontend/pages/Login.tsx, frontend/pages/Signup.tsx, frontend/hooks/useAuth.ts, frontend/components/ProtectedRoute.tsx"

/claude-swarm:task-create "Write auth tests" "Comprehensive testing: Backend unit tests (auth service, token service, middleware), Frontend component tests (forms, hooks), E2E tests (full login/signup flows). Aim for 85%+ coverage. Files: backend/tests/auth.test.js, frontend/tests/auth.test.tsx, e2e/auth.spec.js"
```

### 3. Set Dependencies

```bash
/claude-swarm:task-update 2 --blocked-by 1
/claude-swarm:task-update 3 --blocked-by 1
/claude-swarm:task-update 4 --blocked-by 2
/claude-swarm:task-update 4 --blocked-by 3
```

**Explanation:**
- Tasks 2 & 3 wait for design (Task 1)
- Task 4 waits for both implementations (Tasks 2 & 3)

### 4. Spawn Teammates

```bash
/claude-swarm:swarm-spawn "auth-architect" "researcher" "opus" "You are the authentication architect. Work on Task #1: Design auth architecture. Research JWT best practices, design secure token flow, define API contracts. Create comprehensive design doc in docs/auth-design.md. Message team-lead when complete so backend and frontend can start."

/claude-swarm:swarm-spawn "backend-dev" "backend-developer" "sonnet" "You are the backend developer. Work on Task #2: Implement backend auth. Wait for Task #1 (design) to complete. Check task list periodically. Once auth-architect finishes design, implement JWT system per the spec. Message team-lead when done."

/claude-swarm:swarm-spawn "frontend-dev" "frontend-developer" "sonnet" "You are the frontend developer. Work on Task #3: Build auth UI. Wait for Task #1 (design) to complete. Once design ready, build login/signup forms and session management. Coordinate with backend-dev on API integration. Message team-lead when complete."

/claude-swarm:swarm-spawn "qa-lead" "tester" "sonnet" "You are the QA lead. Work on Task #4: Write comprehensive auth tests. Wait for Tasks #2 and #3 (implementations) to complete. Once both backend and frontend are done, write unit, component, and E2E tests. Message team-lead with results."
```

### 5. Verify Spawns

```bash
/claude-swarm:swarm-verify auth-system
```

**Expected Output:**
```
Verifying team 'auth-system'...
✓ auth-architect is alive
✓ backend-dev is alive
✓ frontend-dev is alive
✓ qa-lead is alive
All teammates verified successfully.
```

### 6. Assign Tasks

```bash
/claude-swarm:task-update 1 --assign "auth-architect"
/claude-swarm:task-update 2 --assign "backend-dev"
/claude-swarm:task-update 3 --assign "frontend-dev"
/claude-swarm:task-update 4 --assign "qa-lead"
```

### 7. Monitor - Design Phase

```bash
/claude-swarm:task-list
```

**Initial State:**
```
Tasks for team 'auth-system':
--------------------------------
#1 [in-progress] Design auth architecture (auth-architect)
#2 [blocked] Implement backend auth (backend-dev) [blocked by #1]
#3 [blocked] Build auth UI (frontend-dev) [blocked by #1]
#4 [blocked] Write auth tests (qa-lead) [blocked by #2, #3]
```

**Wait ~30-45 minutes for design...**

```bash
/claude-swarm:swarm-inbox
```

**After design completes:**
```
<teammate-message teammate_id="auth-architect" color="cyan">
Task #1 complete. Authentication design finished in docs/auth-design.md.

Key decisions:
- JWT tokens with 1h expiry, refresh tokens with 7d expiry
- Endpoints: POST /auth/login, POST /auth/signup, POST /auth/refresh, POST /auth/logout
- Token storage: HTTP-only cookies for security
- Middleware: authenticateToken() for protected routes

API contracts fully documented. Backend and frontend can start implementation.
Message me if you have questions about the design.
</teammate-message>
```

### 8. Unblock Backend and Frontend

This is a **critical coordination point** - two teammates waiting to be unblocked.

```bash
# Mark design complete
/claude-swarm:task-update 1 --status "completed"

# Unblock backend
/claude-swarm:swarm-message "backend-dev" "Task #1 complete! Auth design ready in docs/auth-design.md. Key info: JWT with 1h expiry, HTTP-only cookies, see endpoint specs in doc. You're unblocked - start backend implementation now."

# Unblock frontend
/claude-swarm:swarm-message "frontend-dev" "Task #1 complete! Auth design ready in docs/auth-design.md. Important: using HTTP-only cookies (not localStorage), endpoints defined in doc. You're unblocked - start UI implementation. Coordinate with backend-dev on API details."
```

**Check Status:**

```bash
/claude-swarm:task-list
```

**Now:**
```
Tasks for team 'auth-system':
--------------------------------
#1 [completed] Design auth architecture (auth-architect)
#2 [in-progress] Implement backend auth (backend-dev)
#3 [in-progress] Build auth UI (frontend-dev)
#4 [blocked] Write auth tests (qa-lead) [blocked by #2, #3]
```

**Notice:** Tasks 2 & 3 now running in parallel! This is the speedup benefit.

### 9. Monitor - Implementation Phase

Backend and frontend work in parallel. Check for questions:

```bash
/claude-swarm:swarm-inbox
```

**~20 minutes later:**
```
<teammate-message teammate_id="frontend-dev" color="green">
Question for backend-dev: What will the login endpoint return on success? Need to know the exact response shape for my useAuth hook.
Should I message backend-dev directly or coordinate through you?
</teammate-message>
```

**Facilitate coordination:**

```bash
/claude-swarm:swarm-message "frontend-dev" "Message backend-dev directly: /claude-swarm:swarm-message backend-dev 'your question'. You two should coordinate on API contract details. CC me if you need arbitration."

/claude-swarm:swarm-message "backend-dev" "frontend-dev has a question about login response format. Please respond directly to them. See design doc for spec, but clarify if needed."
```

**~15 minutes later:**
```
<teammate-message teammate_id="backend-dev" color="blue">
Task #2 complete. Backend auth implemented:
- Auth service with JWT generation: backend/auth/authService.js
- Token service with validation: backend/auth/tokenService.js
- Auth middleware: middleware/auth.js
- Routes: routes/auth.js (login, signup, refresh, logout)
- All endpoints tested with Postman, working correctly
- Coordinated with frontend-dev on response formats

Ready for frontend integration and testing.
</teammate-message>
```

**~10 minutes after that:**
```
<teammate-message teammate_id="frontend-dev" color="green">
Task #3 complete. Auth UI implemented:
- Login form: frontend/pages/Login.tsx (with validation)
- Signup form: frontend/pages/Signup.tsx (with validation)
- Auth hook: frontend/hooks/useAuth.ts (login, signup, logout, session management)
- Protected route component: frontend/components/ProtectedRoute.tsx
- Integrated with backend API, tested manually - working end-to-end

Ready for comprehensive testing.
</teammate-message>
```

### 10. Unblock QA

Both implementations done! Time for comprehensive testing.

```bash
# Mark backend complete
/claude-swarm:task-update 2 --status "completed" --comment "JWT auth system implemented and manually tested"

# Mark frontend complete
/claude-swarm:task-update 3 --status "completed" --comment "Auth UI forms and session management implemented"

# Unblock QA
/claude-swarm:swarm-message "qa-lead" "Tasks #2 and #3 complete! Backend auth and frontend UI both done. You're unblocked - start comprehensive testing now. Backend in backend/auth/, frontend in frontend/pages/ and frontend/hooks/. Test the full integration flow."
```

**Check Status:**

```bash
/claude-swarm:task-list
```

**Now:**
```
Tasks for team 'auth-system':
--------------------------------
#1 [completed] Design auth architecture (auth-architect)
#2 [completed] Implement backend auth (backend-dev)
#3 [completed] Build auth UI (frontend-dev)
#4 [in-progress] Write auth tests (qa-lead)
```

### 11. Monitor - Testing Phase

```bash
/claude-swarm:swarm-inbox
```

**~45-60 minutes later:**
```
<teammate-message teammate_id="qa-lead" color="yellow">
Task #4 in progress. Found integration issue:

Frontend sending wrong content-type header on signup.
Backend expecting application/json but receiving application/x-www-form-urlencoded.
Signup endpoint returns 400.

Should I:
A) Fix frontend to send correct header
B) Ask frontend-dev to fix it
C) Have backend-dev handle both content types

Please advise.
</teammate-message>
```

**Handle blocker:**

```bash
/claude-swarm:swarm-message "qa-lead" "Option B - ask frontend-dev to fix the header. That's the clean solution."

/claude-swarm:swarm-message "frontend-dev" "qa-lead found an issue: signup form sending wrong content-type. Please fix to send application/json header. Quick fix in Login.tsx and Signup.tsx fetch calls. Update task #3 when fixed."
```

**~10 minutes later:**
```
<teammate-message teammate_id="frontend-dev" color="green">
Fixed content-type header issue. Updated both Login.tsx and Signup.tsx.
Tested - now sending application/json correctly.
Task #3 updated with fix.
</teammate-message>
```

```bash
/claude-swarm:swarm-message "qa-lead" "frontend-dev fixed the header issue. Please re-test signup flow and continue with test suite."
```

**~30 minutes later:**
```
<teammate-message teammate_id="qa-lead" color="yellow">
Task #4 complete. Comprehensive test suite written:

Backend tests (backend/tests/auth.test.js):
- Auth service unit tests: 15 tests, all passing
- Token service unit tests: 10 tests, all passing
- Middleware tests: 8 tests, all passing
- Route integration tests: 12 tests, all passing
Coverage: 91%

Frontend tests (frontend/tests/auth.test.tsx):
- Login component tests: 8 tests, all passing
- Signup component tests: 8 tests, all passing
- useAuth hook tests: 12 tests, all passing
- ProtectedRoute tests: 6 tests, all passing
Coverage: 88%

E2E tests (e2e/auth.spec.js):
- Full signup flow: passing
- Full login flow: passing
- Protected route access: passing
- Logout flow: passing
- Token refresh: passing

All tests passing. Ready for code review and deployment.
</teammate-message>
```

### 12. Mark Complete

```bash
/claude-swarm:task-update 4 --status "completed" --comment "Comprehensive test suite: 91% backend coverage, 88% frontend coverage, all E2E tests passing"
```

### 13. Final Verification

```bash
/claude-swarm:task-list
```

**Final State:**
```
Tasks for team 'auth-system':
--------------------------------
#1 [completed] Design auth architecture (auth-architect)
#2 [completed] Implement backend auth (backend-dev)
#3 [completed] Build auth UI (frontend-dev)
#4 [completed] Write auth tests (qa-lead)
```

```bash
/claude-swarm:swarm-status auth-system
```

### 14. Code Review

As team lead, review the deliverables:

```bash
# Check design doc
cat docs/auth-design.md

# Review backend implementation
ls -la backend/auth/
cat middleware/auth.js

# Review frontend implementation
ls -la frontend/pages/
cat frontend/hooks/useAuth.ts

# Run test suites
npm test backend/tests/auth.test.js
npm test frontend/tests/auth.test.tsx
npm run test:e2e e2e/auth.spec.js
```

If everything passes review, proceed to cleanup.

### 15. Cleanup

```bash
/claude-swarm:swarm-cleanup "auth-system"
```

### 16. Report to User

```
Completed! Full authentication system implemented:

**Backend:**
- JWT auth with refresh tokens
- Endpoints: login, signup, refresh, logout
- Protected route middleware
- 91% test coverage

**Frontend:**
- Login and signup forms with validation
- Session management hook
- Protected route component
- 88% test coverage

**Testing:**
- All E2E flows passing
- Full integration verified

**Files:**
- Backend: backend/auth/, middleware/auth.js, routes/auth.js
- Frontend: frontend/pages/, frontend/hooks/useAuth.ts
- Tests: backend/tests/, frontend/tests/, e2e/
- Documentation: docs/auth-design.md

Ready for code review and deployment!
```

## Timeline

**Total Time:** ~3.5 hours

- **Setup** (create, tasks, spawn): 10 min
- **Design phase** (Task 1): 30-45 min
- **Implementation phase** (Tasks 2 & 3 parallel): 45-60 min
- **Testing phase** (Task 4): 45-60 min (including fix iteration)
- **Review and cleanup**: 15 min

**Key insight:** Without parallelism, implementation would take 105-120 min (45+60). With parallel execution, only 60 min. **Saved 45+ minutes!**

## Key Coordination Points

### Point 1: After Spawn

**Action:** Verify all 4 teammates alive

**Why:** Catch spawn failures immediately

### Point 2: Design Complete (~45 min)

**Action:**
1. Mark Task #1 complete
2. Message BOTH backend-dev and frontend-dev
3. Verify they both start work

**Why:** This unblocks parallel work - critical for time savings

**Common mistake:** Forgetting to message one of them, leaving them blocked

### Point 3: Frontend Question (~65 min)

**Action:**
1. Facilitate direct communication between teammates
2. Ensure they resolve the question
3. Don't become a bottleneck

**Why:** Teammates can coordinate directly. Team lead facilitates but doesn't need to be in the middle of every discussion.

### Point 4: Both Implementations Complete (~105 min)

**Action:**
1. Mark Tasks #2 and #3 complete
2. Message qa-lead with context about what was built
3. Verify QA starts work

**Why:** QA needs both pieces complete. Provide context to help them test effectively.

### Point 5: QA Finds Bug (~2h mark)

**Action:**
1. Assess the issue
2. Decide who should fix it
3. Coordinate the fix
4. Ensure QA can continue

**Why:** Bugs during testing are normal. Quick coordination minimizes delay.

## Lessons Learned

### What Went Well

✓ **Parallel execution** - Tasks 2 & 3 saved 45 minutes
✓ **Clear dependencies** - Everyone knew what they were waiting for
✓ **Direct teammate communication** - frontend and backend coordinated directly
✓ **Proactive problem-solving** - QA asked how to handle bug before proceeding

### Challenges Faced

⚠️ **Integration bug** - Content-type mismatch caught during testing
*Why it's okay:* Testing phase exists to catch exactly this. Quick fix, no drama.

⚠️ **Coordination overhead** - More teammates = more messages to track
*Mitigation:* Check inbox regularly, respond promptly, keep messages organized

### Patterns to Reuse

1. **Parallel after foundation** - Common pattern: 1 design task → N implementation tasks → 1 integration task

2. **Facilitate direct communication** - Teammates can message each other, don't bottleneck through lead

3. **Expect and handle bugs** - Testing will find issues. Quick coordination cycle (identify → assign → fix → verify)

4. **Provide context when unblocking** - Don't just say "you're unblocked", explain what's ready and where to find it

## Adapting This Example

### Scaling Up

**Larger feature with 6 teammates:**

```
Design
   ├──> Backend API ──┐
   ├──> Frontend UI ──┤
   ├──> Mobile App ───┤
   └──> Documentation ┘
             ↓
      Integration Tests
```

Same patterns, just more parallel branches.

### Scaling Down

**3 teammates (skip researcher):**

- You (team lead) write design doc
- Spawn backend-dev and frontend-dev with design in initial prompt
- Add tester for integration tests

### Different Architectures

**Microservices:**

```
Auth Service Design
   ├──> Auth Service Implementation
   ├──> API Gateway Changes
   └──> Client Library
```

Same coordination patterns.

**GraphQL:**

```
Schema Design
   ├──> Resolvers
   ├──> Frontend Queries
   └──> Tests
```

## Troubleshooting

### Backend and Frontend APIs Don't Match

**Symptoms:** Integration errors, 400/500 responses

**Prevention:**
- Have researcher document API contract clearly
- Both implementations reference same design doc
- QA tests integration early

**Fix:**
1. Identify mismatch (request format? response format? endpoint path?)
2. Check design doc for source of truth
3. Fix the implementation that deviates
4. Re-test

### One Teammate Much Slower Than Expected

**Example:** Frontend takes 2x longer than backend

**Symptoms:** Task #2 complete, Task #3 still in-progress

**Actions:**
1. Check their progress: attach to their session
2. If stuck: offer guidance via message
3. If complexity underestimated: adjust expectations, possibly help
4. Update task with comments so you remember for next time

### QA Finds Major Design Flaw

**Example:** Realize tokens should be in headers, not cookies (after implementation)

**Tough decision:** Fix now or ship and refactor later?

**Options:**
1. **Fix now:** Mark tasks #2 and #3 back to in-progress, have both revise
2. **Tech debt:** Document the issue, ship with cookies, refactor in next sprint

**How to decide:** Consult user, assess impact/urgency

## Advanced Patterns

### Pattern: Phased Implementation

If implementation takes multiple days:

**Day 1:**
1. Design + Basic implementation
2. Cleanup with `/claude-swarm:swarm-cleanup auth-system` (soft)

**Day 2:**
1. Resume with `/claude-swarm:swarm-resume auth-system`
2. Teammates continue where they left off

### Pattern: Code Review Integration

Add review cycle:

```
Implementation → In-Review → Revisions → Approved
```

**Commands:**
```bash
# After implementation
/claude-swarm:task-update 2 --status "in-review"
/claude-swarm:swarm-spawn "reviewer" "reviewer" "sonnet" "Review Task #2 backend auth implementation. Check for security issues, code quality, test coverage. Provide feedback."

# After review
/claude-swarm:swarm-message "backend-dev" "Review feedback: [issues]. Please address and update task when done."

# After fixes
/claude-swarm:task-update 2 --status "completed"
```

## Next Steps

After mastering this example:

1. **Try your own full-stack feature** with 4 teammates
2. **Experiment with team structure** (5 teammates? Different roles?)
3. **Add code review cycle** to your workflow
4. **Optimize prompts** based on teammate behavior

## Quick Reference

```bash
# Key commands for complex features

# Critical: unblock multiple teammates
/claude-swarm:swarm-message "backend-dev" "Unblocked message"
/claude-swarm:swarm-message "frontend-dev" "Unblocked message"

# Facilitate teammate-to-teammate communication
/claude-swarm:swarm-message "frontend-dev" "Ask backend-dev directly: /claude-swarm:swarm-message backend-dev 'your question'"

# Handle bug found during testing
/claude-swarm:swarm-message "frontend-dev" "QA found issue: [details]. Please fix and update task."
/claude-swarm:task-update 3 --status "in-progress"  # Reopen task

# Monitor parallel work
/claude-swarm:task-list  # See both tasks in-progress
/claude-swarm:swarm-inbox  # Get updates from multiple teammates
```

Ready for larger, more complex orchestrations!
