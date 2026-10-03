// Every path litter writes or reads, from litterDir down (plan section 10,
// "On disk"). All absolute: the mod never passes a relative path to $.fs,
// since EnterWorktree moves the session's working directory mid-session.
//
// Contract owner: phase 1a. The command hooks (lib.sh) mirror the hooks/ part.

export const SEP = '/'

const join = (...parts: string[]): string => parts.join(SEP)

/** `<primary checkout>/.claude/litter`, resolved once per session (litterdir.ts). */
export type LitterDir = string

// hooks/: shared with the command hooks (plan section 9, "Mod-to-hook state").
export const hooksDir = (litterDir: LitterDir) => join(litterDir, 'hooks')
/** Exists only while a run is active or a swarm is live. Every script's first test. */
export const activePath = (litterDir: LitterDir) => join(hooksDir(litterDir), 'active')
export const policyPath = (litterDir: LitterDir) => join(hooksDir(litterDir), 'policy.json')
export const worktreePolicyPath = (litterDir: LitterDir) => join(hooksDir(litterDir), 'worktree.json')
export const agentPolicyPath = (litterDir: LitterDir, agentId: string) => join(hooksDir(litterDir), 'agents', `${agentId}.json`)
export const outPath = (litterDir: LitterDir, agentId: string) => join(hooksDir(litterDir), 'out', `${agentId}.json`)
/** worktree.sh's step marker for one worktree name (hookfiles.WtMarker). */
export const wtMarkerPath = (litterDir: LitterDir, name: string) => join(hooksDir(litterDir), 'wt', name)
export const bindPath = (litterDir: LitterDir, agentId: string) => join(hooksDir(litterDir), 'bind', agentId)
export const modePath = (litterDir: LitterDir) => join(hooksDir(litterDir), 'mode')
export const spoolDir = (litterDir: LitterDir) => join(hooksDir(litterDir), 'spool')
export const spoolPath = (litterDir: LitterDir, sessionId: string) => join(spoolDir(litterDir), `${sessionId}.jsonl`)
/** Lines over 4 KiB go to a file here, named by the line's `file` field. */
export const spoolBlobDir = (litterDir: LitterDir) => join(spoolDir(litterDir), 'blobs')
/**
 * In a session started in a linked worktree, `$CLAUDE_PROJECT_DIR/.claude/litter/hooks/pointer`
 * holds the absolute path of the real hooks/ folder. lib.sh follows it.
 */
export const pointerPath = (projectDir: string) => join(projectDir, '.claude', 'litter', 'hooks', 'pointer')
// Phase 2b, the swarm markers (hookfiles.ts says who writes each).
/** A spawn the mod has reserved and not yet bound: one file per `tool_use_id`, so the guard waits for its binding. */
export const pendingDir = (litterDir: LitterDir) => join(hooksDir(litterDir), 'pending')
export const pendingPath = (litterDir: LitterDir, key: string) => join(pendingDir(litterDir), key)
/** A node or child that handed back, or whose stop hold.sh let go. */
export const donePath = (litterDir: LitterDir, agentId: string) => join(hooksDir(litterDir), 'done', agentId)
/** hold.sh's list of the children a worker was already held for. */
export const holdPath = (litterDir: LitterDir, agentId: string) => join(hooksDir(litterDir), 'hold', agentId)
/** The background tasks a bound agent started (watch.sh), so hold.sh counts only its own. */
export const shellsPath = (litterDir: LitterDir, agentId: string) => join(hooksDir(litterDir), 'shells', agentId)

// Runs.
export const runDir = (litterDir: LitterDir, run: string) => join(litterDir, run)
export const runJsonPath = (runDir: string) => join(runDir, 'run.json')
export const ledgerDir = (runDir: string) => join(runDir, 'ledger')
export const ledgerFileName = (seq: number, kind: string) => `${String(seq).padStart(6, '0')}-${kind}.json`
export const ledgerExportDir = (runDir: string) => join(runDir, 'ledger-export')
export const verifyLogDir = (runDir: string, verifyId: string) => join(runDir, 'verify', verifyId)
export const verifyLogPart = (runDir: string, verifyId: string, part: number) =>
  join(verifyLogDir(runDir, verifyId), `${String(part).padStart(4, '0')}.log`)
export const planPath = (runDir: string) => join(runDir, 'plan.md')
export const summaryPath = (runDir: string) => join(runDir, 'summary.md')
export const proposalPath = (runDir: string, version: string) => join(runDir, 'proposals', `${version}.md`)
export const verdictsDir = (runDir: string) => join(runDir, 'verdicts')
/**
 * An execute verdict, rendered from its ledger record (plan section 10): the
 * gate and attempt of the verify it cites. Both have passed `isPlanGate` (or
 * are `goal`) and are a whole number, so they join.
 */
export const verdictFile = (runDir: string, gate: string, attempt: number) => join(verdictsDir(runDir), `${gate}-${attempt}.md`)
/** An earlier `plan.md`, kept by plan.write and gate.amend (plan section 10), from 1. */
export const planVersionPath = (runDir: string, n: number) => join(runDir, `plan.${n}.md`)
/** A worktree's setup log, `verify/setup-<name>/0001.log`, written by worktree.sh or the mod. */
export const setupLogPart = (runDir: string, name: string) => verifyLogPart(runDir, `setup-${name}`, 1)

// Worktrees (plan section 7, fanout.js; section 9, "Run worktrees").
/** The integration worktree's name; its path is `<worktreeRoot>/<name>`. */
export const integrationName = (run: string) => `litter-${run}-integration`
/** `refs/heads/` is left off: these are branch names. */
export const integrationBranch = (run: string) => `litter/${run}-integration`
/** A workflow agent's worktree `<runId>-<n>` gets `litter/<run>-w<n>`. */
export const writerBranch = (run: string, n: number) => `litter/${run}-w${n}`

/** `<litterDir>/WIKI.md` (plan section 10, "On disk"). */
export const wikiPath = (litterDir: LitterDir) => join(litterDir, 'WIKI.md')

// Lock lease (plan section 9, "Launch preconditions", step 0).
export const leasePath = (litterDir: LitterDir, oid: string) => join(litterDir, `lock-lease-${oid}.json`)

// Swarms (plan 15.8). Every name below has passed SWARM_NAME, NODE_ID or
// LAUNCH_ID before it gets here: these join, they don't check.
export const swarmsDir = (litterDir: LitterDir) => join(litterDir, 'swarms')
export const swarmDir = (litterDir: LitterDir, name: string) => join(swarmsDir(litterDir), name)
/** The spec at its latest saved revision. */
export const swarmJsonPath = (litterDir: LitterDir, name: string) => join(swarmDir(litterDir, name), 'swarm.json')
export const swarmBriefPath = (litterDir: LitterDir, name: string, node: string) => join(swarmDir(litterDir, name), 'briefs', `${node}.md`)
/** Every saved or accepted revision, from 1. */
export const revisionPath = (litterDir: LitterDir, name: string, n: number) => join(swarmDir(litterDir, name), 'revisions', `${n}.json`)
export const revisionBriefPath = (litterDir: LitterDir, name: string, n: number, node: string) =>
  join(swarmDir(litterDir, name), 'revisions', String(n), 'briefs', `${node}.md`)
/** A lead proposal as staged: `spec.json` and `briefs/<node>.md` inside. */
export const swarmProposalDir = (litterDir: LitterDir, name: string, n: number) => join(swarmDir(litterDir, name), 'proposals', String(n))
export const launchesDir = (litterDir: LitterDir, name: string) => join(swarmDir(litterDir, name), 'launches')
/** One launch: its ledger is `ledgerDir(launchDir(…))`, as the spec's is `ledgerDir(swarmDir(…))`. */
export const launchDir = (litterDir: LitterDir, name: string, launch: string) => join(launchesDir(litterDir, name), launch)
/** Written at swarm.end: nodes, last reports, goal history, the branches and worktrees left. */
export const launchSummaryPath = (litterDir: LitterDir, name: string, launch: string) => join(launchDir(litterDir, name, launch), 'summary.md')
/** The owner's lease beside its ref's blob (plan 15.4, "One session owns a live swarm"). */
export const ownerLeasePath = (litterDir: LitterDir, name: string, oid: string) => join(swarmDir(litterDir, name), `owner-lease-${oid}.json`)
/** This project's templates; repository content, so listing one does nothing else. */
export const projectTemplatesDir = (litterDir: LitterDir) => join(litterDir, 'swarm-templates')
/** Yours, for every project: `configDir` is `CLAUDE_CONFIG_DIR` or `~/.claude` (ports.ts, configDir). */
export const userTemplatesDir = (configDir: string) => join(configDir, 'litter', 'swarm-templates')

// Rules (plan 16.1, 16.4; phase 3). `primary` is the primary checkout
// (lifecycle.ts, primaryOf); a bare repository has no project or local scope.
/** Your rules, for every project. */
export const userRulesDir = (configDir: string) => join(configDir, 'litter', 'rules')
/** The project's rules, committed. */
export const projectRulesDir = (primary: string) => join(primary, '.litter', 'rules')
/** Your rules for this repository, never committed (`/.litter.local/` in `<common dir>/info/exclude`). */
export const localRulesDir = (primary: string) => join(primary, '.litter.local', 'rules')
/** A rule folder's earlier and retired versions, `<id>@<v>.md`; never loaded. */
export const ruleHistoryDir = (rulesDir: string) => join(rulesDir, '.history')
/**
 * The rules ledgers (decision 17), each a ledgercore directory, so the
 * records are under its `ledger/`: the repository's holds every project and
 * local rule's records and every proposal made here; yours every user rule's.
 */
export const repoRulesLedgerDir = (litterDir: LitterDir) => join(litterDir, 'rules-ledger')
export const userRulesLedgerDir = (configDir: string) => join(configDir, 'litter', 'rules-ledger')
/** The rules ledgers' `run` field (ledgercore's records carry one). */
export const RULES_LEDGER_RUN = 'rules'

/** A swarm's ownership ref: create-only, at a blob naming the owning session (15.4). */
export const swarmRef = (name: string) => `refs/litter-swarm/${name}`
/** A node's type as `$.agent.register` takes it. The engine serves it as `litter:sw-<swarm>-<node>`. */
export const nodeTypeName = (swarm: string, node: string) => `sw-${swarm}-${node}`
/** The prefix of every swarm type as the engine serves it. Never split a type on it: look it up (state.ts, swarmOfType). */
export const SWARM_TYPE_PREFIX = 'litter:sw-'
/** A `new` worktree's folder under the worktree root (15.3). */
export const swarmNewWorktreeName = (swarm: string, node: string) => `sw-${swarm}-${node}`
/** An `own` worker's folder: one per instance. */
export const swarmOwnWorktreeName = (swarm: string, node: string, n: number) => `sw-${swarm}-${node}-${n}`
/** An `own` worker's branch, without `refs/heads/`. */
export const swarmOwnBranch = (swarm: string, node: string, n: number) => `sw/${swarm}/${node}-${n}`
/** The spec ledger's `run` field. */
export const specRun = (name: string) => `swarm:${name}`
/** A launch ledger's `run` field. */
export const launchRun = (name: string, launch: string) => `swarm:${name}/${launch}`

export const SWARM_NAME = /^[a-z0-9][a-z0-9-]{0,23}$/
export const NODE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
/** `<yyyymmdd-hhmmss>` in UTC, `-2`, `-3`… on a collision (records/swarm.ts, newLaunchId). */
export const LAUNCH_ID = /^[0-9]{8}-[0-9]{6}(-[0-9]+)?$/

/**
 * Paths the snapshot and the clean-tree check leave out (plan section 9, "Snapshot").
 * Relative to the checkout root, as git pathspecs.
 */
export const SNAPSHOT_EXCLUDES = [
  '.claude/litter',
  '.claude/worktrees',
  '.litter',
  '.litter.local',
  '.claude/rules/litter',
  '.claude/rules/litter-local',
] as const

/** A run id: `<yyyymmdd>-<slug>`. */
export const RUN_ID = /^[0-9]{8}-[a-z0-9][a-z0-9-]{0,62}$/
