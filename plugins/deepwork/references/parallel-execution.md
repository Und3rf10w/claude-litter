# Parallel-pair worktree isolation

When the orchestrator decides to run multiple implementer/reviewer pairs in parallel (e.g., W16a + W16b, or multiple plan gates with different implementers), each pair MUST run in a dedicated git worktree to avoid branch stomping.

## Pattern

**Caller** (operator or orchestrator) pre-creates worktrees before spawning agents:

```bash
git worktree add .claude/worktrees/<phase-id> -b <branch-name>
```

**Spawn** each agent with `cwd:` set to the worktree's absolute path:

```
Agent({
  team_name: "...",
  name: "impl-<phase-id>",
  cwd: "/abs/path/to/.claude/worktrees/<phase-id>",
  subagent_type: "general-purpose",
  prompt: "Implement <spec>. Commit before pinging reviewer."
})
Agent({
  team_name: "...",
  name: "reviewer-<phase-id>",
  cwd: "/abs/path/to/.claude/worktrees/<phase-id>",
  subagent_type: "Explore",
  prompt: "Wait for impl-<phase-id>'s SendMessage handoff, then review."
})
```

## Hard rules

- **Use `cwd`, not `isolation: "worktree"`.** `cwd` places an agent in a pre-existing worktree. `isolation: "worktree"` creates an ephemeral throwaway worktree — the two parameters are mutually exclusive (CC source line 399544). Use `cwd` for pre-created worktrees.
- **One writer per worktree at a time.** Two writers in the same worktree race `.git/index.lock`, interleave commits, and produce lost writes. An implementer (general-purpose) + a read-only reviewer (Explore) in the same worktree is safe.
- **Reviewer gates on commit, not on file timestamp.** The reviewer should wait for the implementer's `git commit` + `SendMessage` handoff before reading files. Mid-edit reads give inconsistent multi-file views.
- **Settings/hooks/skills are CWD-scoped.** When an agent's `cwd` is a worktree containing `.claude/settings.json`, those hooks and skills fire from that worktree — exactly the isolation deepwork needs.
- **`.claude/deepwork/<id>/` must be gitignored.** Scratch state at `.claude/deepwork/` pollutes `git status` in the impl's worktree. Verified via `git check-ignore`. See `.gitignore` at repo root.
- **Caller owns cleanup.** The CC system never removes worktrees it didn't create. The operator or orchestrator is responsible for `git worktree remove .claude/worktrees/<phase-id>` after both branches are merged or abandoned.

## EnterWorktree vs cwd

`EnterWorktree` is for the *current session* switching directories (e.g., lead navigation). It hard-rejects if already inside a worktree session. Never use it in spawn prompts when `cwd` is available — `cwd` is the spawn-time primitive.

## Failure modes for two writers in the same worktree

- `.git/index.lock` "Another git process seems to be running"
- File-level lost writes (last writer wins on overlapping `Write`/`Edit`)
- HEAD interleaving on the shared branch
- Half-staged state visible to teammates via `git status`

None are corruption-class (git locks prevent index corruption), but all break the "I know what state I'm reviewing" contract.

## Source maintenance note

This recipe was verified against `cli_formatted_2.1.119.js` on 2026-04-26 and documented in `/tmp/deepwork-worktree-recipe.md`. If this reference seems stale, re-verify against the current `cli_formatted_*.js` source and update.

This PR (W16d) was itself implemented via worktree-isolated impl+reviewer pair using `cwd:` — the recipe is dogfooded. The impl ran in `.claude/worktrees/w16d` on branch `und3rf10w/hard-real-gates-w16d` without conflicting with the parallel W16a/W16b worktrees.
