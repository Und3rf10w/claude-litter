# Example: Authentication Feature Implementation

This example demonstrates orchestrating a realistic multi-component feature: adding JWT-based authentication to a web application. It covers complex coordination, dependencies, and communication patterns.

## Scenario

Your application needs user authentication with:
- Backend API endpoints (login, register, refresh token, logout)
- JWT token generation and validation
- Authentication middleware for protected routes
- Frontend login/register forms
- Protected route handling
- Comprehensive testing

## Team Structure

- **Team Lead** (you) - Orchestrate, coordinate, handle integration
- **API Developer** - Design and implement auth endpoints
- **Middleware Developer** - Create JWT validation middleware
- **Frontend Developer** - Build authentication UI
- **Tester** - Write comprehensive tests

## Step 1: Create Team and Tasks

```bash
# Create the team
/claude-swarm:swarm-create "auth-feature" "Team implementing JWT authentication system"

# Create tasks
/claude-swarm:task-create "Design authentication API" \
  "Design REST API for authentication: POST /api/auth/register, POST /api/auth/login, POST /api/auth/refresh, POST /api/auth/logout. Define request/response schemas, error codes, and security requirements."

/claude-swarm:task-create "Implement auth API endpoints" \
  "Implement authentication endpoints in Express: user registration with password hashing (bcrypt), login with JWT generation, token refresh, and logout. Use jsonwebtoken library. Store users in MongoDB."

/claude-swarm:task-create "Create JWT validation middleware" \
  "Create Express middleware to validate JWT tokens on protected routes. Extract token from Authorization header, verify signature, attach user to request object, handle expired tokens."

/claude-swarm:task-create "Build login and register forms" \
  "Create React components for login and registration with form validation (email format, password strength), error display, and loading states. Use react-hook-form and zod for validation."

/claude-swarm:task-create "Implement auth state management" \
  "Create React context for auth state: store user info and token, provide login/logout functions, persist to localStorage, handle token refresh."

/claude-swarm:task-create "Add protected route wrapper" \
  "Create ProtectedRoute component that checks auth state, redirects to login if unauthenticated, shows loading spinner during token refresh."

/claude-swarm:task-create "Write authentication tests" \
  "Write comprehensive tests: unit tests for middleware and API endpoints, integration tests for full auth flow, test token expiration and refresh, test error cases."
```

## Step 2: Set Up Dependencies

```bash
# API design must come first
/claude-swarm:task-update 2 --blocked-by 1  # API implementation depends on design
/claude-swarm:task-update 3 --blocked-by 2  # Middleware depends on API implementation

# Frontend depends on API design
/claude-swarm:task-update 4 --blocked-by 1  # Forms need API schema
/claude-swarm:task-update 5 --blocked-by 1  # State management needs API schema

# Protected routes depend on auth state
/claude-swarm:task-update 6 --blocked-by 5

# Tests depend on implementation being complete
/claude-swarm:task-update 7 --blocked-by 2  # Need API endpoints
/claude-swarm:task-update 7 --blocked-by 3  # Need middleware
/claude-swarm:task-update 7 --blocked-by 4  # Need forms
```

## Step 3: Spawn Team

```bash
# API Designer (starts immediately)
/claude-swarm:swarm-spawn "api-designer" "researcher" "sonnet" \
  "You are the API designer. Work on Task #1: Design the authentication API. Create a comprehensive API specification document in docs/auth-api.md with endpoints, schemas, error codes, and security considerations. When complete, message frontend-dev and backend-dev with the design details."

# Backend Developer (waits for design)
/claude-swarm:swarm-spawn "backend-dev" "backend-developer" "sonnet" \
  "You are the backend developer. Work on Task #2: Implement auth API endpoints. Wait for the API design to complete (check your inbox). Use Express, MongoDB, bcrypt, and jsonwebtoken. When complete, message middleware-dev and notify team-lead."

# Middleware Developer (waits for backend)
/claude-swarm:swarm-spawn "middleware-dev" "backend-developer" "haiku" \
  "You are the middleware developer. Work on Task #3: Create JWT validation middleware. Wait for backend-dev to complete the API endpoints (check your inbox). Create middleware in src/middleware/auth.ts. Message team-lead when complete."

# Frontend Developer (waits for design)
/claude-swarm:swarm-spawn "frontend-dev" "frontend-developer" "sonnet" \
  "You are the frontend developer. Work on Tasks #4 and #5: Build login/register forms and auth state management. Wait for the API design (check inbox). Use React, react-hook-form, and zod. When complete, message protected-route-dev and team-lead."

# Protected Route Developer (waits for auth state)
/claude-swarm:swarm-spawn "protected-route-dev" "frontend-developer" "haiku" \
  "You are the protected route developer. Work on Task #6: Create ProtectedRoute component. Wait for frontend-dev to complete auth state management (check inbox). Create component in src/components/ProtectedRoute.tsx. Message team-lead when complete."

# Tester (waits for everything)
/claude-swarm:swarm-spawn "tester" "tester" "sonnet" \
  "You are the tester. Work on Task #7: Write comprehensive authentication tests. Wait for all implementation to complete (check inbox regularly). Write unit tests, integration tests, and test edge cases. Message team-lead with test results."
```

## Step 4: Assign Tasks

```bash
/claude-swarm:task-update 1 --assign "api-designer"
/claude-swarm:task-update 2 --assign "backend-dev"
/claude-swarm:task-update 3 --assign "middleware-dev"
/claude-swarm:task-update 4 --assign "frontend-dev"
/claude-swarm:task-update 5 --assign "frontend-dev"
/claude-swarm:task-update 6 --assign "protected-route-dev"
/claude-swarm:task-update 7 --assign "tester"
```

## Step 5: Verify Team

```bash
/claude-swarm:swarm-verify auth-feature
```

**Expected output:**
```
✓ api-designer - online
✓ backend-dev - online
✓ middleware-dev - online
✓ frontend-dev - online
✓ protected-route-dev - online
✓ tester - online

All teammates verified successfully.
```

## Step 6: Monitor and Coordinate

### Initial Status Check

```bash
/claude-swarm:swarm-status auth-feature
```

**Output:**
```
Team: auth-feature
Description: Team implementing JWT authentication system
Lead: team-lead (you)

Teammates:
  • api-designer (researcher) - online
    Assigned: Task #1 - Design authentication API
    Status: working

  • backend-dev (backend-developer) - online
    Assigned: Task #2 - Implement auth API endpoints
    Status: waiting for Task #1

  • middleware-dev (backend-developer) - online
    Assigned: Task #3 - Create JWT validation middleware
    Status: waiting for Task #2

  • frontend-dev (frontend-developer) - online
    Assigned: Tasks #4, #5
    Status: waiting for Task #1

  • protected-route-dev (frontend-developer) - online
    Assigned: Task #6 - Add protected route wrapper
    Status: waiting for Task #5

  • tester (tester) - online
    Assigned: Task #7 - Write authentication tests
    Status: waiting for Tasks #2, #3, #4

Tasks: 7 total (6 pending, 1 in-progress, 5 blocked, 0 completed)
```

### Workflow: API Design Complete

**You receive a message from api-designer:**
```
Task #1 complete. Authentication API design documented in docs/auth-api.md.
Includes complete schemas, error codes, and security requirements.
Messaged backend-dev and frontend-dev with details.
```

**Check inbox:**
```bash
/claude-swarm:swarm-inbox
```

**Update task:**
```bash
/claude-swarm:task-update 1 --status "completed" --comment "API design complete in docs/auth-api.md"
```

**Result:** Tasks #2, #4, and #5 are now unblocked. Backend-dev and frontend-dev can proceed.

### Workflow: Backend Complete

**Message from backend-dev:**
```
Task #2 complete. Auth API endpoints implemented:
- POST /api/auth/register - User registration with bcrypt hashing
- POST /api/auth/login - Login with JWT generation (15min expiry)
- POST /api/auth/refresh - Token refresh (checks refresh token)
- POST /api/auth/logout - Invalidates refresh token

Files: src/routes/auth.ts, src/controllers/authController.ts, src/models/User.ts
Tests: Basic endpoint tests in tests/auth.test.ts
Messaged middleware-dev and tester.
```

**Update task:**
```bash
/claude-swarm:task-update 2 --status "completed" --comment "API endpoints implemented with JWT generation"
```

**Result:** Task #3 unblocked, middleware-dev can proceed.

### Workflow: Blocker Encountered

**Message from frontend-dev:**
```
Blocked on Tasks #4 and #5. The API design doesn't specify refresh token storage location.
Should refresh tokens be stored in httpOnly cookie or localStorage?
Need clarification before implementing auth state management.
```

**Your response:**
```bash
/claude-swarm:swarm-message "frontend-dev" "Use httpOnly cookies for refresh tokens (more secure). Access tokens in memory only. Check with backend-dev if cookies are already implemented."

# Copy backend-dev for coordination
/claude-swarm:swarm-message "backend-dev" "Frontend-dev needs refresh tokens in httpOnly cookies. Can you add cookie handling to the refresh endpoint?"
```

**Backend-dev response:**
```
Cookie handling added. Refresh endpoint now sets httpOnly cookie with refresh token.
Frontend can use credentials: 'include' in fetch requests.
```

**Notify frontend-dev:**
```bash
/claude-swarm:swarm-message "frontend-dev" "Blocker resolved. Backend-dev added httpOnly cookie support. You can proceed with implementation."
```

**Frontend-dev updates:**
```bash
/claude-swarm:task-update 4 --status "in-progress"
/claude-swarm:task-update 5 --status "in-progress"
```

### Workflow: Frontend Complete

**Message from frontend-dev:**
```
Tasks #4 and #5 complete.

Task #4 - Forms created:
- LoginForm in src/components/LoginForm.tsx
- RegisterForm in src/components/RegisterForm.tsx
- Both with validation, error display, loading states

Task #5 - Auth state management:
- AuthContext in src/contexts/AuthContext.tsx
- Provides: user, login, logout, refreshToken functions
- Persists tokens, auto-refresh on mount
- Error handling for network issues

Messaged protected-route-dev. Ready for integration.
```

**Result:** Task #6 unblocked, protected-route-dev can proceed.

### Workflow: All Implementation Complete

**You receive completion messages from:**
- middleware-dev: "Task #3 complete. Middleware in src/middleware/auth.ts"
- protected-route-dev: "Task #6 complete. ProtectedRoute component ready"

**Testing phase begins:**

**Message from tester:**
```
Starting Task #7. Running all tests...

Found issue: Token refresh fails when access token is expired.
frontend-dev: AuthContext doesn't handle 401 responses to trigger refresh.
Can you add automatic token refresh on 401?
```

**Coordinate fix:**
```bash
/claude-swarm:swarm-message "frontend-dev" "Tester found issue: need automatic token refresh on 401. Can you add an axios interceptor to handle this?"
```

**Frontend-dev responds quickly (haiku model for simple fix):**
```
Fixed. Added axios interceptor that catches 401, refreshes token, and retries request.
Updated in src/api/axios.ts. Tester can re-run tests.
```

**Final testing:**

**Message from tester:**
```
Task #7 complete. All tests passing:
✓ User registration and login
✓ Token generation and validation
✓ Middleware protection on routes
✓ Automatic token refresh
✓ Logout and token invalidation
✓ Error handling for invalid credentials
✓ Security: Password hashing verified

Test files:
- tests/auth.test.ts (backend)
- tests/middleware.test.ts (middleware)
- tests/components/LoginForm.test.tsx (frontend)
- tests/integration/authFlow.test.ts (full flow)

All 47 tests passing. Feature ready for review.
```

## Step 7: Final Status

```bash
/claude-swarm:task-list
```

**Output:**
```
Task List for team 'auth-feature':

#1 [completed] Design authentication API
   Assigned to: api-designer
   Comments: API design complete in docs/auth-api.md

#2 [completed] Implement auth API endpoints
   Assigned to: backend-dev
   Comments: API endpoints implemented with JWT generation
   Comments: Cookie handling added for refresh tokens

#3 [completed] Create JWT validation middleware
   Assigned to: middleware-dev
   Comments: Middleware in src/middleware/auth.ts

#4 [completed] Build login and register forms
   Assigned to: frontend-dev
   Comments: Forms with validation in src/components/

#5 [completed] Implement auth state management
   Assigned to: frontend-dev
   Comments: AuthContext with auto-refresh
   Comments: Added axios interceptor for 401 handling

#6 [completed] Add protected route wrapper
   Assigned to: protected-route-dev
   Comments: ProtectedRoute component ready

#7 [completed] Write authentication tests
   Assigned to: tester
   Comments: All 47 tests passing, feature ready for review
```

## Step 8: Review and Cleanup

**Create review checklist:**
```bash
# You can review the code yourself or spawn a reviewer
/claude-swarm:swarm-spawn "reviewer" "reviewer" "sonnet" \
  "Review the authentication implementation. Check: security best practices, code quality, test coverage, documentation. Report findings to team-lead."

# Or do it yourself
# Review key files:
# - docs/auth-api.md
# - src/routes/auth.ts
# - src/middleware/auth.ts
# - src/contexts/AuthContext.tsx
# - tests/*
```

**When satisfied:**
```bash
# Soft cleanup (preserves logs and data)
/claude-swarm:swarm-cleanup auth-feature

# Or hard cleanup if you don't need the data
/claude-swarm:swarm-cleanup auth-feature --force
```

## Key Patterns Demonstrated

### 1. Sequential Dependencies
- API design → Implementation → Testing
- Each stage blocks the next

### 2. Parallel Work
- Frontend and backend work simultaneously after design phase
- Middleware and protected routes work in parallel

### 3. Cross-Team Communication
- API designer notifies multiple dependent teammates
- Tester coordinates fixes with developers
- Team lead facilitates blocker resolution

### 4. Progressive Complexity
- Start with research/design (researcher role)
- Complex implementation (sonnet model)
- Simple tasks (haiku model for middleware, protected routes)
- Comprehensive testing (sonnet for thorough coverage)

### 5. Iterative Fixes
- Tester finds issue → Developer fixes → Re-test
- Quick iteration cycle

### 6. Model Selection
- **Sonnet** for complex tasks (API implementation, auth state, testing)
- **Haiku** for straightforward tasks (middleware, protected routes, quick fixes)
- **Researcher** role for design phase

## Messages You Received

Over the course of the project, your inbox received:

1. **api-designer**: Design complete notification
2. **backend-dev**: Implementation complete + cookie support added
3. **middleware-dev**: Middleware complete
4. **frontend-dev**: Blocker about refresh token storage
5. **frontend-dev**: Forms and state management complete
6. **protected-route-dev**: Protected route component complete
7. **tester**: Issue found about 401 handling
8. **tester**: All tests passing, feature complete

You coordinated 8 messages, facilitating smooth collaboration.

## Lessons

1. **Clear dependencies prevent wasted work** - Blocking dependent tasks ensures correct sequencing
2. **Proactive communication is key** - Teammates messaging each other directly speeds up coordination
3. **Team lead facilitates, doesn't micromanage** - You resolved blockers but let teammates work autonomously
4. **Right model for the job** - Sonnet for complexity, haiku for simplicity saves time and cost
5. **Testing uncovers integration issues** - Dedicated tester found problems that unit tests missed
6. **Quick iteration on fixes** - Small issues resolved rapidly with good communication

## Estimated Time Savings

**Sequential approach:** ~8-12 hours (one developer doing everything)

**Swarm approach:** ~2-3 hours wall time (parallel execution)

**Speedup:** 3-4x faster with 5 teammates working in parallel

## Next Steps

Learn more about:
- [Communication Patterns](../references/communication.md) - Deep dive into coordination
- [Error Handling](../references/error-handling.md) - Troubleshooting team issues
- [Swarm Utils API](../references/swarm-utils-api.md) - Function reference
