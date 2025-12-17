# Quick Start: Your First Swarm Team

This guide walks you through creating your first swarm team for a simple task. You'll learn the basic workflow and core commands.

## Scenario

You need to add a simple feature: a contact form with backend API. This involves frontend (React form) and backend (Express endpoint) work that can be done in parallel.

## Prerequisites

- Claude Code installed
- tmux or kitty installed (`brew install tmux` or `brew install --cask kitty`)
- A project directory

## Step-by-Step

### 1. Create the Team

```bash
/claude-swarm:swarm-create "contact-form" "Team implementing contact form feature"
```

**What happens:**
- Creates team directory: `~/.claude/teams/contact-form/`
- Creates config file with team metadata
- Creates inbox directory for team communication
- Creates task directory: `~/.claude/tasks/contact-form/`

**Output:**
```
✓ Team 'contact-form' created
✓ You are now team-lead
```

### 2. Create Tasks

Break down the work into parallel tasks:

```bash
/claude-swarm:task-create "Build contact form UI" \
  "Create React component with name, email, message fields. Include validation and submit button."

/claude-swarm:task-create "Implement contact API endpoint" \
  "Create POST /api/contact endpoint in Express. Validate input, send email, return success response."

/claude-swarm:task-create "Add form integration" \
  "Connect frontend form to backend API. Handle loading states and error messages."
```

**What happens:**
- Three tasks created with IDs: 1, 2, 3
- All start with status "pending"
- Tasks appear in task list

**Verify:**
```bash
/claude-swarm:task-list
```

**Output:**
```
Task List for team 'contact-form':

#1 [pending] Build contact form UI
   No assignment

#2 [pending] Implement contact API endpoint
   No assignment

#3 [pending] Add form integration
   No assignment
   Blocked by: none yet
```

### 3. Set Dependencies

Task 3 depends on tasks 1 and 2 being complete:

```bash
/claude-swarm:task-update 3 --blocked-by 1
/claude-swarm:task-update 3 --blocked-by 2
```

**Why:** Integration can't start until both frontend and backend are ready.

### 4. Spawn Teammates

Create two teammates to work in parallel:

```bash
/claude-swarm:swarm-spawn "frontend-dev" "frontend-developer" "sonnet" \
  "You are the frontend developer. Work on Task #1: Build the contact form UI component. Use React with TypeScript. Include form validation."

/claude-swarm:swarm-spawn "backend-dev" "backend-developer" "sonnet" \
  "You are the backend developer. Work on Task #2: Implement the contact API endpoint. Use Express. Validate inputs and send emails."
```

**What happens:**
- Two tmux (or kitty) sessions spawn
- Each runs Claude Code with the initial prompt
- Sessions named: `swarm-contact-form-frontend-dev` and `swarm-contact-form-backend-dev`
- Teammates registered in team config

**Important:** Verify they spawned successfully:

```bash
/claude-swarm:swarm-verify contact-form
```

**Expected output:**
```
✓ frontend-dev - online
✓ backend-dev - online

All teammates verified successfully.
```

**If spawn fails:** See troubleshooting section below.

### 5. Assign Tasks

Assign the tasks to your teammates:

```bash
/claude-swarm:task-update 1 --assign "frontend-dev"
/claude-swarm:task-update 2 --assign "backend-dev"
```

**What happens:**
- Task ownership is set
- Teammates can now see their assigned work

### 6. Check Team Status

View your team at any time:

```bash
/claude-swarm:swarm-status contact-form
```

**Output:**
```
Team: contact-form
Description: Team implementing contact form feature
Lead: team-lead (you)

Teammates:
  • frontend-dev (frontend-developer) - online
    Assigned: Task #1 - Build contact form UI
    Model: sonnet

  • backend-dev (backend-developer) - online
    Assigned: Task #2 - Implement contact API endpoint
    Model: sonnet

Tasks: 3 total (2 pending, 0 in-progress, 0 blocked, 1 waiting)
```

### 7. Monitor Progress

Your teammates are now working. Check their progress:

```bash
# View task list
/claude-swarm:task-list

# Check inbox for messages from teammates
/claude-swarm:swarm-inbox
```

Teammates will message you when:
- They complete their tasks
- They encounter blockers
- They have questions

### 8. Coordinate Integration

When tasks 1 and 2 complete, you'll receive messages:

**Message from frontend-dev:**
```
Task #1 complete. Contact form component created in src/components/ContactForm.tsx
with validation using react-hook-form. Ready for integration.
```

**Message from backend-dev:**
```
Task #2 complete. API endpoint implemented at POST /api/contact with validation
and email sending. See tests in tests/contact.test.ts for usage.
```

Now you can handle the integration yourself or spawn another teammate:

```bash
/claude-swarm:swarm-spawn "integrator" "worker" "haiku" \
  "You are the integrator. Work on Task #3: Connect the frontend form to the backend API. Both components are ready."

/claude-swarm:task-update 3 --assign "integrator"
```

### 9. Verify Completion

When all tasks are done:

```bash
/claude-swarm:task-list
```

**Output:**
```
Task List for team 'contact-form':

#1 [completed] Build contact form UI
   Assigned to: frontend-dev
   Comments:
     - Component created with full validation

#2 [completed] Implement contact API endpoint
   Assigned to: backend-dev
   Comments:
     - API tested and working

#3 [completed] Add form integration
   Assigned to: integrator
   Comments:
     - Integration complete, form submits successfully
```

### 10. Clean Up

When work is complete:

```bash
# Soft cleanup (keeps data for reference)
/claude-swarm:swarm-cleanup contact-form

# Hard cleanup (removes everything)
/claude-swarm:swarm-cleanup contact-form --force
```

## Viewing Teammate Sessions

Want to see what a teammate is doing?

```bash
# Attach to their tmux session
tmux attach-session -t swarm-contact-form-frontend-dev

# Detach without killing: Press Ctrl+B then D
```

For kitty, click on the teammate's window tab.

## Troubleshooting

### Spawn Failed

If spawn_teammate fails:

1. Check if multiplexer is installed:
```bash
which tmux    # or: which kitty
```

2. Run diagnostics:
```bash
/claude-swarm:swarm-diagnose contact-form
```

3. Try spawning again (may be transient)

### Teammates Not Responding

```bash
# Verify they're alive
/claude-swarm:swarm-verify contact-form

# Check for status issues
/claude-swarm:swarm-reconcile contact-form
```

### Messages Not Received

Teammates must check their inbox regularly:

```bash
/claude-swarm:swarm-inbox
```

Remind them in their initial prompt to check inbox periodically.

## Key Commands Summary

| Command | Purpose |
|---------|---------|
| `/claude-swarm:swarm-create <team> [desc]` | Create team |
| `/claude-swarm:task-create <subject> [desc]` | Create task |
| `/claude-swarm:swarm-spawn <name> <type> <model> <prompt>` | Spawn teammate |
| `/claude-swarm:task-update <id> --assign <agent>` | Assign task |
| `/claude-swarm:swarm-status <team>` | View team status |
| `/claude-swarm:task-list` | View all tasks |
| `/claude-swarm:swarm-inbox` | Check messages |
| `/claude-swarm:swarm-message <to> <msg>` | Send message |
| `/claude-swarm:swarm-verify <team>` | Verify health |
| `/claude-swarm:swarm-cleanup <team>` | Clean up |

## Next Steps

Now that you've created your first team, learn about:

1. **[Auth Feature Example](auth-feature.md)** - More complex multi-task coordination
2. **[Communication Patterns](../references/communication.md)** - Effective team messaging
3. **[Error Handling](../references/error-handling.md)** - Troubleshooting guide

## Tips for Success

1. **Keep teams small** - 2-6 teammates optimal
2. **Clear initial prompts** - Tell teammates exactly what to do
3. **Set dependencies** - Use `--blocked-by` to prevent premature work
4. **Verify spawns** - Always run `swarm-verify` after spawning
5. **Check inbox regularly** - Both you and teammates
6. **Clean up properly** - Use cleanup commands, not manual deletion
