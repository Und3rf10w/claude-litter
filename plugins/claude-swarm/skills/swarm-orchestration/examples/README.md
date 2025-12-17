# Swarm Orchestration Examples

Practical, real-world examples of swarm orchestration workflows. Each example demonstrates best practices for different scenarios.

## Available Examples

### 1. Simple API Feature (`01-simple-api-feature.md`)

**Scenario:** Add a new REST API endpoint with tests

**Team Size:** 2 teammates (backend + tester)

**Complexity:** ⭐ Simple

**Duration:** ~30-60 minutes

**Best For:**
- Learning swarm basics
- Small feature additions
- Simple backend work

---

### 2. Full-Stack Feature (`02-full-stack-feature.md`)

**Scenario:** Complete user authentication system with UI, backend, and tests

**Team Size:** 4 teammates (researcher + backend + frontend + tester)

**Complexity:** ⭐⭐⭐ Moderate

**Duration:** ~2-4 hours

**Best For:**
- Features spanning multiple layers
- Learning dependency management
- Coordinating frontend/backend integration

---

## How to Use These Examples

1. **Read the scenario** - Understand the problem being solved
2. **Review the breakdown** - See how work is divided
3. **Follow the commands** - Copy/adapt the exact commands used
4. **Study the coordination** - Notice when/how team lead intervenes
5. **Adapt for your project** - Modify team names, tasks, and prompts

## Example Structure

Each example includes:

- **Scenario** - What we're building
- **Analysis** - How we break down the work
- **Complete Command Sequence** - Every command, in order
- **Coordination Points** - When/how team lead acts
- **Key Learnings** - Takeaways and patterns

## Quick Start

Never orchestrated a swarm before? Start here:

1. Read [Swarm Orchestration Skill](../SKILL.md) for concepts
2. Set up your terminal (see [Setup Guide](../references/setup-guide.md))
3. Try **Example 1** (Simple API Feature) first
4. Once comfortable, move to **Example 2** (Full-Stack Feature)
5. Adapt patterns to your own projects

## Tips for Following Examples

- **Don't blindly copy** - Adapt names, paths, and prompts to your project
- **Understand each step** - Know why each command is run
- **Watch for patterns** - Notice when to verify, when to message, when to check status
- **Practice coordination** - Pay attention to how team lead unblocks teammates
- **Start small** - Begin with 2-3 teammates before larger teams

## Common Patterns Across Examples

### Pattern 1: Dependency Chain

```
Task A (researcher) → Task B (backend) → Task C (tester)
```

- A finishes → message B → B starts
- B finishes → message C → C starts

### Pattern 2: Parallel After Foundation

```
Task A (researcher)
         ↓
Task B (backend) | Task C (frontend)  ← parallel
         ↓            ↓
         Task D (tester)
```

- A finishes → message both B and C → they work in parallel
- Both B and C finish → message D → D starts

### Pattern 3: Review Cycle

```
Task assigned → In progress → Submit for review → Revise → Complete
```

Team lead reviews, requests changes, teammate revises, team lead approves.

## Troubleshooting Examples

If spawns fail or teammates get stuck:

1. See **swarm-troubleshooting** skill for diagnostics
2. Review [Setup Guide](../references/setup-guide.md) for configuration
3. Check [Slash Commands Reference](../references/slash-commands.md) for command details

## Contributing Examples

Have a great swarm workflow? Document it! Include:

- Clear scenario and goals
- Complete command sequence
- Coordination notes
- Key learnings

## Next Steps

After working through examples:

1. Try orchestrating your own small feature
2. Experiment with different team sizes
3. Practice handling blockers and dependencies
4. Refine your prompts for better teammate behavior

Happy orchestrating!
