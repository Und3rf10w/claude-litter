<div align="center">
  <img src="./assets/logo.png" alt="Claude Litter" width="320" />
  <br />
  <em>Verified multi-agent runs for Claude Code</em>
  <br /><br />

<a href="https://github.com/Und3rf10w/claude-litter/releases"><img src="https://img.shields.io/badge/version-4.0.0-22c55e?style=flat-square" alt="Version" /></a>
<a href="https://code.claude.com/"><img src="https://img.shields.io/badge/Claude_Code-2.1.288%2B-orange?style=flat-square" alt="Claude Code 2.1.288+" /></a>

</div>

---

**Claude Litter** is a marketplace that holds one plugin, **[litter](plugins/litter)**. litter runs multi-agent work as Claude Code workflows: designs, plan executions, parallel task fan-outs and swarms of agents led from your session. A hooks module (a mod) runs beside them. It records every step, runs your verify command itself, holds each agent to its role's files and tools, and lands only work that passed.

litter replaces this repository's earlier plugins (swarm-loop, deepwork and team-overlord) and its terminal UI. The last release with them is tagged [`legacy-3.8`](https://github.com/Und3rf10w/claude-litter/tree/legacy-3.8).

## Install

```
/plugin install litter --marketplace Und3rf10w/claude-litter
```

Or add the marketplace first, then install from it:

```
/plugin marketplace add Und3rf10w/claude-litter
/plugin install litter@claude-litter
```

litter needs:
- Claude Code 2.1.288 or later;
- git;
- jq on `PATH`, for the command hooks;
- a POSIX `sh`.

Runs start from a clean, committed tree, in auto or default permission mode. The mod refuses to launch under bypass-permissions or accept-edits.

## What it does

| Command | What runs |
| --- | --- |
| `/litter:design <problem>` | Independent investigators, a reframer that challenges the goal, and a critic with the only veto iterate against a written bar that you agree first. An approved plan comes back for review in plan mode. |
| `/litter:execute <plan.md \| goal>` | An approved plan, gate by gate. An independent critic must pass each gate, and the mod commits it only after its own run of the verify command passes. A goal is planned into gates first. |
| `/litter:fanout <tasks>` | Independent tasks in parallel, each task that writes in its own git worktree. A verifier checks each task, and the mod merges the results and verifies the combination before anything lands. |
| `/litter:amend <gate-id> <change>` | One gate reworked with a stated change, judged by the same critic and verified by the mod. |
| `/litter:swarm <description>` | A tree of agents: orchestrators that each own part of the work and delegate to their own workers. The swarm is drafted into the swarm builder, and starts when you press Launch there. |
| `/litter:rules list \| add \| show \| retire \| import` | Your standing rules and bans, which litter agents receive wherever they apply. They come in user, project and local scopes, and you accept each one in the Rules pane. They can be imported from deepwork's guardrails and exported as Claude Code rule files. |
| `/litter:wiki` | Rebuilds `.claude/litter/WIKI.md`, an index of every litter run and swarm and the decisions they produced. |

**When a run fails:** with `repair` set to `auto` (the default), a failed fanout, or an execute run that halted on a plan gap or ran out of attempts, continues as a repair swarm. The repair swarm works within its budget, and lands only verified and independently approved work. With `off`, the run stops, keeps everything, and offers you the routes.

**The pane:** `/litter [section]` opens litter's pane. It has eight sections:
- **Home;**
- **Runs**, the board of runs and gates;
- **Swarms**, the builder and the swarm browser;
- **Rules;**
- **Tasks**, which edits a team's tasks;
- **Agents**, which writes to an agent's inbox, broadcasts to a team and stops an agent;
- **Stats**, the spend and limits;
- **Doctor.**

`ctrl+x tab` gives the pane the keys, `1`–`8` switch sections, and `esc` goes back to the prompt.

litter keeps its state under `.claude/litter/` in your repository's main checkout: each run's plan, ledger and summary, the swarms, and the hooks' state. Project rules are kept in `.litter/rules/`, for you to commit.

## Options

Set litter's options with `/plugin`, or under `pluginConfigs.litter.options` in a settings file. They include:
- `verify`: the command that decides whether a gate is done, as an argument list;
- `goalCheck`: the final check for a run given a goal instead of a plan;
- `setup` and `linkDirs`: how each fresh worktree is prepared;
- `maxAttempts` and `maxRounds`;
- `repair`, with `repairRounds` and `repairAgents` for its budget;
- `widen`: who may add files to a gate during a run;
- `trailers`: commit trailers.

[`plugins/litter/.claude-plugin/plugin.json`](plugins/litter/.claude-plugin/plugin.json) describes each option and its default.

## Development

```bash
cd plugins/litter
claude plugin validate --strict .
claude plugin test .                         # tier 1: the engine's plugin tests
(cd tests/unit && bun install && bun run test)  # tier 2: bun specs
sh tests/hooks/run.sh                        # tier 3: the hook scripts (also SHELL_UNDER_TEST=dash)
sh tests/headless/run.sh                     # tier 4: live sessions; spends tokens, run by hand
```

To run Claude Code with your working copy of litter loaded, use `claude --plugin-dir plugins/litter`.

## Acknowledgements

- [Claude Code](https://code.claude.com) by Anthropic, the agent and the workflow engine litter runs on.
- [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps), the inspiration for the original swarm loop.
- [Geoffrey Huntley's Ralph Wiggum approach](https://ghuntley.com/ralph/), foundational research for iterative coding-agent loops.
