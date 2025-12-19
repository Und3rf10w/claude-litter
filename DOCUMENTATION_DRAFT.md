# Documentation Updates - DRAFT

## Overview

This document outlines the planned documentation updates for claude-swarm v1.7.0 enhancements. The update includes:

1. **Broadcast Command** (Task #1)
2. **Send-Text Command** (Task #2)
3. **Task List Filtering** (Task #3)
4. **Custom Environment Variables** (Task #4)
5. **Permission Mode Control** (Task #5)
6. **Generalize Send-Text Function** (Task #6)
7. **Team-Lead Spawn on Create** (Task #7)
8. **Consult Command** (Task #8)

## Files to Update

### 1. `SKILL.md` - swarm-orchestration skill

**Location**: `plugins/claude-swarm/skills/swarm-orchestration/SKILL.md`

**Current content**: Team lead orchestration guide with quick start, core concepts, and workflow

**Updates needed**:
- Add new command references to the "Slash Commands Reference" section
- Add new features to the "Communication Patterns" section (broadcast)
- Add new features to the "Environment Variables" section (custom env vars, permissions)
- Update Team Structure section if team-lead spawn changes architecture
- Add new use cases and scenarios

**New sections to add**:

#### Broadcasting Messages
- Explain broadcast command (Task #1)
- When to use broadcast vs individual messages
- Example: Coordinating across all teammates
- Best practices for broadcast communication

#### Send-Text Command
- Document send-text command (Task #2)
- Use cases: Sending file content, sharing outputs
- Integration with other commands
- Examples

#### Task List Filtering
- Document filtering capabilities (Task #3)
- Filter by status, assignee, blocker, etc.
- Example queries
- Use in monitoring workflows

#### Custom Environment Variables
- Document how to set custom env vars (Task #4)
- Use cases: Configuration, team-specific settings
- Integration with spawn command
- Security considerations

#### Permission Mode Control
- Document permission mode (Task #5)
- What permissions can be controlled
- Use cases and examples
- Best practices

#### Team-Lead Auto-Spawn
- Document new behavior (Task #7)
- How it affects team creation workflow
- Implications for orchestration
- When to use vs manual spawn

#### Consult Command
- Document consult command (Task #8)
- Query capabilities
- Examples of consulting the team

### 2. `CLAUDE.md` - Main project documentation

**Location**: `CLAUDE.md`

**Current content**: Project overview, architecture, requirements, implementation patterns

**Updates needed**:

#### Architecture Section Updates
- Add new features to the "Slash Commands Reference"
- Update "Skills Architecture" section if needed
- Document new library functions/modules (if any)
- Update environment variables table with new custom env vars

#### Repository Structure
- Update command count from 17 to potentially more
- Note new features added

#### Key Implementation Patterns
- Add patterns for broadcast functionality
- Add patterns for permission handling
- Add patterns for consult functionality

#### Shell Requirements
- Note any new shell requirements
- Update examples if needed

#### Command Development
- Add examples of new command types if applicable

#### Testing Changes
- Add testing guidance for new features

#### Common Operations
- Add new common operations for new features

## Documentation Structure Strategy

### 1. Progressive Disclosure Approach
- Core documentation in SKILL.md (primary guide)
- Detailed references in references/ subdirectory
- Practical examples in examples/ subdirectory

### 2. Command Documentation
Each new command should have:
- A command file in `commands/` directory (markdown with YAML frontmatter)
- Documentation in SKILL.md with basic explanation
- Detailed reference in `references/commands.md` or similar

### 3. Feature Documentation
For complex features:
- Basic explanation in SKILL.md
- Detailed guide in `references/` subdirectory
- Practical examples in `examples/` subdirectory

## Implementation Checklist

### Phase 1: Placeholder Structure (READY NOW)
- [ ] Add placeholder sections to SKILL.md for all new features
- [ ] Add new commands to "Slash Commands Reference" table
- [ ] Mark sections as "(To be completed after implementation)"

### Phase 2: Wait for Blocking Tasks
- [ ] Task #1: Broadcast Command implementation details
- [ ] Task #2: Send-Text Command implementation details
- [ ] Task #3: Task List Filtering implementation details
- [ ] Task #7: Team-Lead Spawn implementation details
- [ ] Task #8: Consult Command implementation details

### Phase 3: Fill in Documentation
- [ ] Add detailed documentation for each feature
- [ ] Add examples for each command
- [ ] Add best practices for each feature
- [ ] Cross-reference between features

### Phase 4: Update CLAUDE.md
- [ ] Update architecture sections
- [ ] Update repository structure
- [ ] Add new patterns and examples

### Phase 5: Validation
- [ ] Verify all commands documented
- [ ] Verify all features have examples
- [ ] Cross-check with implemented code
- [ ] Verify progressive disclosure structure

## Expected New Features Summary

### Task #1: Broadcast Command
- Command: `/claude-swarm:swarm-broadcast` (likely)
- Purpose: Send message to all team members at once
- Use case: Team-wide announcements, breaking changes

### Task #2: Send-Text Command
- Command: `/claude-swarm:swarm-send-text` (likely)
- Purpose: Send text content to team (file contents, outputs)
- Use case: Sharing configuration, sharing output results

### Task #3: Task List Filtering
- Enhancement to: `/claude-swarm:task-list`
- Purpose: Filter tasks by various criteria
- Use case: View only in-progress tasks, blocked tasks, specific assignee

### Task #4: Custom Environment Variables
- Enhancement to: `/claude-swarm:swarm-spawn`
- Purpose: Pass custom env vars to spawned teammates
- Use case: Team-specific configuration, API keys, feature flags

### Task #5: Permission Mode Control
- Purpose: Control what actions teammates can take
- Use case: Restrict deletions, restrict certain operations

### Task #6: Generalize Send-Text Function
- Library enhancement (may not need user-facing docs)
- Purpose: Refactor send-text functionality for reuse

### Task #7: Team-Lead Spawn on Create
- Enhancement to: `/claude-swarm:swarm-create`
- Purpose: Automatically spawn team-lead when creating team
- Use case: Simplify team creation workflow

### Task #8: Consult Command
- Command: `/claude-swarm:swarm-consult` (likely)
- Purpose: Query the team for information/status
- Use case: Team-lead consulting with teammates

## SKILL.md Sections to Potentially Reorganize

Current structure:
1. Quick Start Example
2. When to Use Swarm Orchestration
3. Core Concepts (Team Structure, Agent Roles, Model Selection)
4. Orchestration Workflow (Steps 1-9)
5. Slash Commands Reference
6. Communication Patterns
7. Monitoring Progress
8. Environment Variables
9. Best Practices
10. Terminal Support
11. Example: Complete Workflow

Proposed additions:
- New subsection in "Core Concepts": New Features Overview
- New subsection in "Orchestration Workflow": Advanced Features
- Expanded "Communication Patterns": Broadcasting
- Expanded "Environment Variables": Custom Variables, Permissions
- New section: Advanced Features (Broadcasting, Permissions, Consult)
- New section: Team-Lead Workflow Changes

## Notes for Implementation

1. **Wait for implementations**: Don't finalize docs until teammates complete their tasks
2. **Cross-reference**: Link new features to relevant use cases in existing docs
3. **Backward compatibility**: Ensure docs don't break for v1.6.2 users
4. **Version note**: Clearly mark new features as "v1.7.0+" in documentation
5. **Examples**: Add practical examples for each new feature
6. **Best practices**: Add best practices section for new features

## Progress Tracking

- [ ] Team-lead responds with implementation details
- [ ] Blocking tasks complete (1, 2, 3, 7, 8)
- [ ] Documentation drafted based on implementations
- [ ] SKILL.md updated
- [ ] CLAUDE.md updated
- [ ] Examples created
- [ ] Cross-references verified
- [ ] Final review and cleanup
