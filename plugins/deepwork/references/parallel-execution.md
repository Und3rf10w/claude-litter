# Parallel-pair worktree isolation

When the orchestrator decides to run multiple implementer/reviewer pairs in parallel (e.g., W16a + W16b, or multiple plan gates with different implementers), each pair MUST run in a dedicated git worktree to avoid branch stomping.

## `cwd` parameter — availability note

The `Agent` tool's public schema in CC 2.1.118+ does NOT expose `cwd` as a parameter. Internal CC source accepts `cwd` at line 399540, but it is not surfaced to spawn-time callers in the public tool schema. Until that changes, teammate spawns into a pre-existing worktree must use the prompt-based pattern: instruct the teammate to `cd <abs worktree path>` at the start of every Bash command and verify with `pwd`.

This was discovered during W16d: the team-lead's `cwd:` in the `Agent` spawn did not take effect — the spawned agent inherited the team-lead's cwd instead.

## Pattern

**Caller** (operator or orchestrator) pre-creates worktrees before spawning agents:

```bash
git worktree add .claude/worktrees/<phase-id> -b <branch-name>
```

**Spawn** each agent with a prompt that instructs the `cd` workaround:

```
Agent({
  team_name: "...",
  name: "impl-<phase-id>",
  subagent_type: "general-purpose",
  prompt: "YOUR CWD IS THE WORKTREE. Prepend `cd /abs/path/to/.claude/worktrees/<phase-id> &&` to every Bash command. Verify with `pwd` before any other action. Implement <spec>. Commit before pinging reviewer."
})
Agent({
  team_name: "...",
  name: "reviewer-<phase-id>",
  subagent_type: "Explore",
  prompt: "YOUR CWD IS THE WORKTREE. Prepend `cd /abs/path/to/.claude/worktrees/<phase-id> &&` to every Bash command. Verify with `pwd` before any other action. Wait for impl-<phase-id>'s SendMessage handoff, then review."
})
```

If/when `cwd` becomes available in the public schema, replace the prompt-based workaround with `cwd: "/abs/path/to/.claude/worktrees/<phase-id>"` on the `Agent` call and drop the `cd` instructions from the prompt.

## Hard rules

- **Use prompt-based `cd`, not `isolation: "worktree"`.** `isolation: "worktree"` creates an ephemeral throwaway worktree — not what we want for pre-created ones. `cwd` on `Agent` is the intended primitive (CC source line 399540 vs 399544 mutual-exclusion check) but is not in the public schema as of CC 2.1.118+; use the prompt `cd` workaround instead (see Pattern section).
- **One writer per worktree at a time.** Two writers in the same worktree race `.git/index.lock`, interleave commits, and produce lost writes. An implementer (general-purpose) + a read-only reviewer (Explore) in the same worktree is safe.
- **Reviewer gates on commit, not on file timestamp.** The reviewer should wait for the implementer's `git commit` + `SendMessage` handoff before reading files. Mid-edit reads give inconsistent multi-file views.
- **Settings/hooks/skills are CWD-scoped.** When an agent's `cwd` is a worktree containing `.claude/settings.json`, those hooks and skills fire from that worktree — exactly the isolation deepwork needs.
- **`.claude/deepwork/<id>/` must be gitignored.** Scratch state at `.claude/deepwork/` pollutes `git status` in the impl's worktree. Verified via `git check-ignore`. See `.gitignore` at repo root.
- **Caller owns cleanup.** The CC system never removes worktrees it didn't create. The operator or orchestrator is responsible for `git worktree remove .claude/worktrees/<phase-id>` after both branches are merged or abandoned.

## EnterWorktree vs cwd vs cd

`EnterWorktree` is for the *current session* switching directories (e.g., lead navigation). It hard-rejects if already inside a worktree session. Do not use it in spawn prompts.

`cwd` on `Agent` is the intended spawn-time primitive (CC source line 399540), but as of CC 2.1.118+ it is not exposed in the public schema and does not take effect. Use the prompt-based `cd` pattern until `cwd` is surfaced publicly.

## Failure modes for two writers in the same worktree

- `.git/index.lock` "Another git process seems to be running"
- File-level lost writes (last writer wins on overlapping `Write`/`Edit`)
- HEAD interleaving on the shared branch
- Half-staged state visible to teammates via `git status`

None are corruption-class (git locks prevent index corruption), but all break the "I know what state I'm reviewing" contract.

## Source maintenance note

This recipe was verified against `cli_formatted_2.1.119.js` on 2026-04-26 and documented in `/tmp/deepwork-worktree-recipe.md`. If this reference seems stale, re-verify against the current `cli_formatted_*.js` source and update.

This PR (W16d) was itself implemented via worktree-isolated impl+reviewer pair — the recipe is dogfooded. The impl ran in `.claude/worktrees/w16d` on branch `und3rf10w/hard-real-gates-w16d` without conflicting with the parallel W16a/W16b worktrees. However, the `cwd:` parameter did not take effect at spawn time (see availability note above) — the agent used absolute paths throughout instead of relying on inherited cwd.
