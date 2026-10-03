// A swarm's records (plan 15.8): the bodies of every swarm kind, the two
// ledgers' helpers, and the swarm tools' inputs and replies. Both ledgers go
// through ledgercore, like a run's:
//  - the spec ledger, `<litterDir>/swarms/<name>/ledger/`, `run` `swarm:<name>`,
//    for swarm.revision, swarm.proposal and swarm.proposal.decided;
//  - one ledger per launch, `<litterDir>/swarms/<name>/launches/<launch>/ledger/`,
//    `run` `swarm:<name>/<launch>`, for everything else.
//
// Contract owner: phase 2b-1, package C. Each body names its writer. Branches
// in worktree records are short names, as `git worktree add -b` takes them;
// everywhere else (bindings, swarm.start, swarm.instance, swarm.node) a bound
// branch is a full ref, `refs/heads/<name>`.

import type { ModelUsage } from 'claude-code'
import type { Ports } from '../ports'
import type { Author, StoredRecord } from './core'
import type { LedgerRead } from '../ledgercore'
import type {
  BindingKind,
  DiffCounts,
  NodeDir,
  RevisionFrom,
  SendOutcome,
  SpecError,
  SwarmRoots,
  SwarmSpec,
  TokenCount,
} from '../swarm/types'
import { appendRecord, readLedger } from '../ledgercore'
import { launchDir, launchesDir, launchRun, LAUNCH_ID, specRun, swarmDir } from '../layout'
import { mkdirp, serial } from '../fsx'

const MOD: Author = { source: 'mod' }

/** The spec ledger's kinds. */
export const SWARM_SPEC_KINDS = ['swarm.revision', 'swarm.proposal', 'swarm.proposal.decided'] as const
/** A launch ledger's kinds. `session.rebind` also goes into an open run's ledger (O). */
export const SWARM_LAUNCH_KINDS = [
  'swarm.start',
  'swarm.worktree.intent',
  'swarm.worktree',
  'swarm.worktree.failed',
  'swarm.worktree.removed',
  'swarm.worktree.kept',
  'swarm.instance',
  'swarm.node',
  'swarm.bind',
  'swarm.event',
  'swarm.summary',
  'swarm.stop',
  'swarm.stopping',
  'swarm.handover',
  'swarm.end',
  'session.rebind',
] as const
export type SwarmSpecKind = (typeof SWARM_SPEC_KINDS)[number]
export type SwarmLaunchKind = (typeof SWARM_LAUNCH_KINDS)[number]

// ---------------------------------------------------------------------------
// The spec ledger's bodies (J)

/** swarm.revision (J's saveRevision and acceptProposal): revision `n` was written. */
export type SwarmRevisionBody = {
  n: number
  from: RevisionFrom
  /** `from: 'proposal'`: the proposal's number. */
  proposal?: number
  /** `from: 'template'`: the template's name. */
  template?: string
  /** What changed, in words or field paths, for the goal history. */
  changes: string[]
}

/** One change a proposal makes, with the lead's reason. */
export type ProposedChange = { path: string; reason: string }

/** swarm.proposal (J's stageProposal): the lead's whole spec, staged under `proposals/<n>/`. */
export type SwarmProposalBody = {
  n: number
  baseRevision: number
  spec: SwarmSpec
  /** Node id → sha256 of the staged brief. */
  briefs: Record<string, string>
  changes: ProposedChange[]
}

/** swarm.proposal.decided (J): the one decision every proposal gets, after its revision when there is one. */
export type SwarmProposalDecidedBody = {
  proposal: number
  accepted: 'all' | 'some' | 'none'
  /** `some`: the change paths taken. */
  picked?: string[]
  revision?: number
}

// ---------------------------------------------------------------------------
// A launch ledger's bodies

/** swarm.start (K, Launch step 6): the swarm goes live. Recovery rebuilds the LiveSwarm from it. */
export type SwarmStartBody = {
  swarm: string
  launch: string
  revision: number
  /** sha256 of the spec's JSON at `revision`. */
  specHash: string
  nonce: string
  /** Node id → served type, `litter:sw-<swarm>-<node>`. */
  types: Record<string, string>
  /** Node id → directory, for `existing`, `new` and `none`. */
  nodes: Record<string, NodeDir>
  /** Node id → the authority line you confirmed for it, as the prompt box got it. */
  authority: Record<string, string>
  /** `refs/heads/<name>` → oid at Launch. */
  tips: Record<string, string>
  owner: { ref: string; oid: string; generation: number }
  sessionCwd: string
  worktreeRoot: string
  commonDir: string
  roots: SwarmRoots
}

/** swarm.worktree.intent (C's addSwarmWorktree): recorded before `git worktree add`. */
export type SwarmWorktreeIntentBody = {
  node: string
  /** An `own` worker's instance; absent for a `new` worktree. */
  n?: number
  path: string
  /** Short name. */
  branch: string
  /** The commit it's made from. */
  from: string
}

/** swarm.worktree (C's addSwarmWorktree): made and set up. */
export type SwarmWorktreeBody = SwarmWorktreeIntentBody & {
  /** The launch that made it: cleanup removes only these (15.4). */
  created_by: string
  /** The top-level ignored paths its setup left, so cleanup can tell what a node added. */
  ignored: string[]
}

/** swarm.worktree.failed (C's addSwarmWorktree): an intent that won't be finished, with why. */
export type SwarmWorktreeFailedBody = {
  node: string
  n?: number
  path: string
  /** Where it stopped: the checks before git, `git worktree add` and its checks, linkDirs, or the setup command. */
  step: 'check' | 'add' | 'links' | 'setup'
  reason: string
  /** The setup log, when the setup ran. */
  log?: string
}

/** swarm.worktree.removed (P's cleanup). */
export type SwarmWorktreeRemovedBody = { path: string; branch: string; branchDeleted?: boolean }
/** swarm.worktree.kept (P's cleanup): listed in summary.md with the reason. */
export type SwarmWorktreeKeptBody = { path: string; branch: string; reason: string }

/** swarm.instance (L): recorded before an instance's spawn is dispatched, with its random bind token. */
export type SwarmInstanceBody = {
  node: string
  n: number
  /** The spawning loop; null for an orchestrator (the lead). */
  parentAgentId: string | null
  tool_use_id: string
  cwd: string
  /** Full ref, or null. */
  branch: string | null
  token: string
  /**
   * The nonce of this instance's `<instance>` and `<rules>` blocks, made at
   * its spawn, after its parent's task was fixed. Its own, never the
   * launch's: every node sees its own blocks, so a nonce it knows would let
   * it forge whole blocks for a child. Absent in older ledgers.
   */
  nonce?: string
}

/** swarm.node (L at binding, `adopted` after a reload; K re-spawns record a new one): agentId → instance. */
export type SwarmNodeBody = {
  node: string
  /** 0 for a child. */
  n: number
  agentId: string
  parentAgentId: string | null
  kind: BindingKind
  /** A child's node's agentId. */
  of?: string
  cwd: string
  branch: string | null
  /** The spawn's model when the spec set one. */
  model: string | null
  adopted?: boolean
  /** The swarm's revision and the owner's generation when bound, so recovery rebuilds the binding whole. */
  revision: number
  generation: number
}

/** swarm.bind's input through the record tool: a node with no binding presents its `<instance>` token (15.4). */
export type SwarmBindInput = { kind: 'swarm.bind'; token: string }
/** swarm.bind (L's recordSwarmBind), in the launch ledger. */
export type SwarmBindBody = { token: string; agentId: string; node: string; n: number }

/** The kinds of `swarm.event`. */
export type SwarmEventKind =
  | 'message'
  | 'readdressed'
  | 'queued'
  | 'queue-sent'
  | 'queue-cancelled'
  | 'send-refused'
  | 'resume-refused'
  | 'wake-refused'
  | 'denied'
  | 'report'
  | 'report-to-lead'
  | 'question'
  | 'worker-ended-early'
  | 'held'
  | 'isolation-lost'
  | 'branch-moved'
  | 'branch-moved-ack'
  | 'rule-commit'
  | 'head-moved'
  | 'type-missing'
  | 'ready-to-push'
  | 'pushed'
  | 'clear-killed'

/**
 * Each event's own fields, beside `kind`, `node` and `agentId` (writer in brackets).
 * A route is `direct`, `lead`, `parent`, or `reply` (a readdress to the parent);
 * `from` and `to` are `user`, `lead` or an agentId.
 *
 * | kind | fields |
 * |---|---|
 * | message (L) | from, to, route, delivery (`interject` or `queue`), text (cut) |
 * | readdressed (L) | from, to (the worker), parent, why |
 * | queued (L) | id, from |
 * | queue-sent (L) | id |
 * | queue-cancelled (L) | id |
 * | send-refused (L) | from, to, reason |
 * | resume-refused (L) | from, reason |
 * | wake-refused (L) | turnId, reason |
 * | denied (P) | tool, reason |
 * | report (P, L) | via, text (cut) |
 * | report-to-lead (P) | |
 * | question (L) | text |
 * | worker-ended-early (P) | children |
 * | held (P) | children |
 * | isolation-lost (P) | tool, cwd, expected |
 * | branch-moved (P) | ref, from, to, running (node ids) |
 * | branch-moved-ack (P) | seq (the branch-moved event's) |
 * | rule-commit (P) | from, to, files |
 * | head-moved (P) | expected, actual |
 * | type-missing (K, L) | type |
 * | ready-to-push (P) | branch, commit |
 * | pushed (P) | branch, commit |
 * | clear-killed (O) | tool, detail |
 *
 * A stale owner's stand-down records nothing: it may race the new owner's
 * appends, and the new owner's swarm.handover already says it.
 */
export type SwarmEventFields = {
  message: { from: string; to: string; route: string; delivery: 'interject' | 'queue'; text: string }
  readdressed: { from: string; to: string; parent: string; why: string }
  queued: { id: string; from: string }
  'queue-sent': { id: string }
  'queue-cancelled': { id: string }
  'send-refused': { from: string; to: string; reason: string }
  'resume-refused': { from: string; reason: string }
  'wake-refused': { turnId: string; reason: string }
  denied: { tool: string; reason: string }
  report: { via: 'handback' | 'answer' | 'message'; text: string }
  'report-to-lead': Record<never, never>
  question: { text: string }
  'worker-ended-early': { children: string[] }
  held: { children: string[] }
  'isolation-lost': { tool: string; cwd: string; expected: string | null }
  'branch-moved': { ref: string; from: string | null; to: string | null; running: string[] }
  'branch-moved-ack': { seq: number }
  'rule-commit': { from: string; to: string; files: string[] }
  'head-moved': { expected: string; actual: string | null }
  'type-missing': { type: string }
  'ready-to-push': { branch: string; commit: string }
  pushed: { branch: string; commit: string }
  'clear-killed': { tool: string; detail: string }
}

/** swarm.event (L, P, O, K): one body per kind. */
export type SwarmEventBody = {
  [K in SwarmEventKind]: { kind: K; node?: string; agentId?: string } & SwarmEventFields[K]
}[SwarmEventKind]

/** swarm.summary (O): recorded only when the goal line changes. */
export type SwarmSummaryBody = { text: string; goal: string; inputsHash: string; usage: ModelUsage | null }

/** swarm.stop (P's stopNode): the node and its descendants, by agentId. */
export type SwarmStopBody = { nodes: string[]; how: 'soft' | 'hard' }
/** swarm.stopping (P's endSwarm, step 1). */
export type SwarmStoppingBody = { by: 'browser' | 'lead' }
/** swarm.handover (K): the ref moved to another session, at the next generation. */
export type SwarmHandoverBody = { from: string; to: string; generation: number }

/** One worktree as swarm.end and summary.md list it. */
export type SwarmWorktreeLeft = { path: string; branch: string; node: string; removed: boolean; reason?: string }

/** swarm.end's input through the record tool: the lead's end request (P's recordSwarmEnd answers `{ ok: true, status: 'stopping' }`). */
export type SwarmEndInput = { kind: 'swarm.end'; swarm: string }
/** swarm.end (P when the swarm settles; K with `launch_failed`). */
export type SwarmEndBody = {
  status: 'ended' | 'launch_failed'
  /** False after [End, keep everything]: nothing was removed. */
  settled: boolean
  reason?: string
  nodes: Record<string, { agentIds: string[]; lastReport: string | null; tokens: TokenCount }>
  worktrees: SwarmWorktreeLeft[]
  /** The branches left behind (`own` workers' included), short names. */
  branches: string[]
}

/** session.rebind (O): after a /clear, in each live launch's ledger and in the open run's. */
export type SessionRebindBody = { from: string; to: string }

/** Every kind's body, for the typed helpers below. */
export type SwarmBodies = {
  'swarm.revision': SwarmRevisionBody
  'swarm.proposal': SwarmProposalBody
  'swarm.proposal.decided': SwarmProposalDecidedBody
  'swarm.start': SwarmStartBody
  'swarm.worktree.intent': SwarmWorktreeIntentBody
  'swarm.worktree': SwarmWorktreeBody
  'swarm.worktree.failed': SwarmWorktreeFailedBody
  'swarm.worktree.removed': SwarmWorktreeRemovedBody
  'swarm.worktree.kept': SwarmWorktreeKeptBody
  'swarm.instance': SwarmInstanceBody
  'swarm.node': SwarmNodeBody
  'swarm.bind': SwarmBindBody
  'swarm.event': SwarmEventBody
  'swarm.summary': SwarmSummaryBody
  'swarm.stop': SwarmStopBody
  'swarm.stopping': SwarmStoppingBody
  'swarm.handover': SwarmHandoverBody
  'swarm.end': SwarmEndBody
  'session.rebind': SessionRebindBody
}

// ---------------------------------------------------------------------------
// The two ledgers

/** Appends to the spec ledger; `by` is the mod unless a handler says otherwise. */
export function appendSpecRecord<K extends SwarmSpecKind>(
  p: Ports,
  litterDir: string,
  name: string,
  kind: K,
  body: SwarmBodies[K],
  by: Author = MOD,
): Promise<StoredRecord<SwarmBodies[K]>> {
  return appendRecord(p, swarmDir(litterDir, name), { run: specRun(name), kind, by, body })
}

/** Appends to one launch's ledger; `by` is the mod unless a handler says otherwise (swarm.bind, swarm.end). */
export function appendLaunchRecord<K extends SwarmLaunchKind>(
  p: Ports,
  litterDir: string,
  name: string,
  launch: string,
  kind: K,
  body: SwarmBodies[K],
  by: Author = MOD,
): Promise<StoredRecord<SwarmBodies[K]>> {
  return appendRecord(p, launchDir(litterDir, name, launch), { run: launchRun(name, launch), kind, by, body })
}

/** The spec ledger, checked as a run's is (`tampered` stops acting on it). */
export function readSpecLedger(p: Ports, litterDir: string, name: string): Promise<LedgerRead> {
  return readLedger(p, swarmDir(litterDir, name), specRun(name))
}

export function readLaunchLedger(p: Ports, litterDir: string, name: string, launch: string): Promise<LedgerRead> {
  return readLedger(p, launchDir(litterDir, name, launch), launchRun(name, launch))
}

/** The launch ids `<yyyymmdd-hhmmss>[-n]`, as `[stamp, n]` for sorting (1 for an id without a suffix). */
function launchOrder(id: string): [string, number] {
  const m = /^([0-9]{8}-[0-9]{6})(?:-([0-9]+))?$/.exec(id)
  return [m?.[1] ?? id, m?.[2] ? Number(m[2]) : 1]
}

/** The swarm's launches, oldest first. Folders only; anything else under `launches/` is ignored. */
export async function listLaunches(p: Ports, litterDir: string, name: string): Promise<string[]> {
  const dir = launchesDir(litterDir, name)
  if (!(await p.fs.exists(dir))) return []
  const ids = (await p.fs.list(dir)).filter(e => e.kind === 'dir' && !e.isLink && LAUNCH_ID.test(e.name)).map(e => e.name)
  return ids.sort((a, b) => {
    const [sa, na] = launchOrder(a)
    const [sb, nb] = launchOrder(b)
    return sa < sb ? -1 : sa > sb ? 1 : na - nb
  })
}

const two = (n: number) => String(n).padStart(2, '0')

/** `<yyyymmdd-hhmmss>` in UTC. */
export function launchStamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}-${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}`
}

/**
 * A new launch id, `<yyyymmdd-hhmmss>` in UTC from `p.now()`, with `-2`, `-3`…
 * when that folder exists. It creates the folder with a plain `mkdir` (no
 * `-p`), which fails when another session made it first, so two launches can
 * never take one id, in this process or another.
 */
export function newLaunchId(p: Ports, litterDir: string, name: string): Promise<string> {
  return serial(`swarm-launch:${litterDir}:${name}`, async () => {
    const stamp = launchStamp(await p.now())
    await mkdirp(p, launchesDir(litterDir, name))
    for (let n = 1; n <= 100; n++) {
      const id = n === 1 ? stamp : `${stamp}-${n}`
      const dir = launchDir(litterDir, name, id)
      const r = await p.run(['mkdir', '--', dir])
      if (r.code === 0) return id
      if (!(await p.fs.exists(dir))) throw new Error(`mkdir ${dir} failed (exit ${r.code}): ${r.stderr.trim()}`)
    }
    throw new Error(`litter: 100 launches of ${name} at ${stamp}; try again in a second`)
  })
}

// ---------------------------------------------------------------------------
// The swarm tools' inputs and replies (tools.ts serves them; J, K and L answer)

/** mcp__litter__swarm_propose (J): the lead only. `spec` is checked by J's schema before anything else. */
export type SwarmProposeInput = {
  swarm: string
  baseRevision: number
  spec: unknown
  /** Node id → the full text of every new or changed brief, at most 16 KiB each. */
  briefs: Record<string, string>
  changes: ProposedChange[]
}

/** Staged (`proposal`, with the diff's counts), or every error with its field, or a refusal (not the lead, no litter directory). */
export type SwarmProposeReply =
  | { ok: true; proposal: number; diff: DiffCounts }
  | { ok: false; errors: SpecError[] }
  | { ok: false; error: string }

/** mcp__litter__swarm_read (K): the lead only. */
export type SwarmReadInput = {
  swarm: string
  /** The builder's draft (or the saved spec) instead of the launch. */
  draft?: boolean
  /** With `for`: whose continuation. */
  node?: string
  for?: 'resume' | 'respawn'
}

/** The draft read: J's draft, or the saved spec, with its revision. */
export type SwarmReadDraft = {
  ok: true
  swarm: string
  draft: boolean
  revision: number
  spec: SwarmSpec
  briefs: Record<string, string>
}

/** What `/litter:swarm start` spawns: one Agent call per orchestrator, with no name, isolation or model. */
export type SwarmReadOrchestrator = { node: string; subagent_type: string; description: string; task: string }

/** One instance as the launch read lists it. */
export type SwarmReadInstance = {
  n: number
  agentId: string
  status: string
  lastReport: string | null
  openQuestions: string[]
  queued: { id: string; text: string }[]
}

/** The launch read: the authority lines, the orchestrators to spawn, and each node's instances. */
export type SwarmReadLaunch = {
  ok: true
  swarm: string
  launch: string
  revision: number
  /** Another session owns it: nothing to spawn. */
  readOnly: boolean
  authority: string[]
  orchestrators: SwarmReadOrchestrator[]
  nodes: { node: string; kind: 'orchestrator' | 'worker'; instances: SwarmReadInstance[] }[]
}

/** A continuation (`for`): the text the lead sends (resume) or spawns with (respawn). */
export type SwarmReadContinuation = {
  ok: true
  swarm: string
  node: string
  for: 'resume' | 'respawn'
  text: string
  /** Respawn: what the Agent call takes. */
  subagent_type?: string
  description?: string
  /** Resume: the agents to send it to. */
  agentIds?: string[]
}

export type SwarmReadReply = SwarmReadDraft | SwarmReadLaunch | SwarmReadContinuation | { ok: false; error: string }

/**
 * mcp__litter__swarm_send (L): the lead only. `node` by name, or `<node>#<n>`
 * for one instance; `swarm` when two live swarms share a node name. With
 * `queued`, the stored message is sent as it is, and `node`, `text` and
 * `deliver` are left out.
 */
export type SwarmSendInput = {
  swarm?: string
  node?: string
  text?: string
  deliver?: 'interject' | 'queue'
  queued?: string
}

/** What happened to the send, or why it couldn't be judged at all. */
export type SwarmSendReply =
  | { ok: true; node: string; agentId: string | null; outcome: SendOutcome }
  | { ok: false; error: string; outcome?: SendOutcome }
