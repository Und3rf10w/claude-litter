// Every shape the swarm packages share (plan section 15). Each type says who
// writes it and who reads it; the package letters are COMMON.md's.
//
// Contract owner: phase 2b-1, package C. Read-only for J to P: a field you
// need that isn't here is a contract change for your report. Phase 2b-2 adds
// to these (`authority.verify` and `land`, a type's `verdicts: true`, admission
// counting `repairAgents`), so every addition is an optional field and nothing
// here is closed against one.

import type { TurnUsage } from 'claude-code'
import type { SettingsSourceName, SubagentLimits } from '../ports'

// ---------------------------------------------------------------------------
// The spec (plan 15.3). Written by the store (J) from the builder or an
// accepted proposal; read by everyone.

/** The effort levels a node's type may set (the engine's own names). */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** The events a node messages its parent about (`report`; litter-prompts.md, `{report_events}`). */
export type ReportEvent = 'ready-to-push' | 'belongs-elsewhere' | 'blocked' | 'done'

/** What the lead may push for a node (15.4, "Pushes go through the lead"): a node never pushes itself. */
export type PushAuthority = 'none' | 'own-branch' | 'any'

/**
 * A node's authority, each field enforced by the guard when set (15.3). Unset
 * means unchecked by litter, which is more than any set value when J compares
 * a worker with its parents.
 */
export type Authority = {
  commit?: boolean
  push?: PushAuthority
  forcePush?: boolean
  rewriteHistory?: boolean
  worktreeOps?: boolean
  /**
   * Phase 2b-2 (15.10): the node may record a `verify`, which the mod runs in
   * its own directory. Unlike the fields above, unset means not given: these
   * two are grants the mod's gates check, not limits the guard enforces.
   */
  verify?: boolean
  /** Phase 2b-2 (15.10): the node may record a `land` of its run's repaired tree. Unset means not given. */
  land?: boolean
}

/**
 * Where a node works (15.3, "`worktree` values"): `inherit` its parent's
 * directory; `own` one worktree per instance (workers only); `none` the
 * session's directory; an `existing` registered worktree (yours, never
 * removed); or a `new` one Launch makes from `from` on `branch`.
 */
export type WorktreeSpec =
  | 'inherit'
  | 'own'
  | 'none'
  | { existing: string }
  | { new: { from: string; branch: string } }

/** One node of the spec: an orchestrator (its parent is the lead) or a worker template. 15.3's table. */
export type SwarmNode = {
  /** NODE_ID (layout.ts). */
  id: string
  kind: 'orchestrator' | 'worker'
  /** `briefs/<id>.md`, relative to the swarm's folder. */
  brief?: string
  /** Orchestrators: the first task. */
  task?: string
  /** An alias or a model id; unset, the parent's applies. */
  model?: string
  effort?: Effort
  tools?: { allow?: string[]; deny?: string[] }
  maxTurns?: number
  /** One of the engine's permission modes. */
  permissionMode?: string
  /** Worker id → how many may run at once under one instance of this node. */
  spawns?: Record<string, number>
  /** False: no non-swarm agent types either. Unset is true. */
  spawnOther?: boolean
  /** Writing workers: one instance per directory at a time (admission enforces it). */
  serial?: boolean
  /** Unset is `inherit`. */
  worktree?: WorktreeSpec
  /** Relative to the node's directory; a trailing `/` is a folder. Unset: anywhere. */
  paths?: string[]
  authority?: Authority
  /** Command prefixes the guard denies in Bash. */
  bash?: { deny?: string[] }
  /** Unset: report only when blocked. */
  report?: ReportEvent[]
  /**
   * Phase 2b-2 (15.10): its `verdict` records are the critic's veto a land
   * needs. Such a node writes nothing (Z's spec rule), so it's never the agent
   * that changed the tree it judges.
   */
  verdicts?: boolean
}

/** `<litterDir>/swarms/<name>/swarm.json` and each `revisions/<n>.json`. */
export type SwarmSpec = {
  /** SWARM_NAME (layout.ts). */
  name: string
  goal: string
  nodes: SwarmNode[]
  limits?: { maxAgentsAtOnce?: number }
}

// ---------------------------------------------------------------------------
// Validation (J's spec.ts). The builder (N), Launch (K) and swarm_propose (J) read it.

/** One problem, naming the field (a path into the spec, `nodes.<id>.authority.commit`) and the node. */
export type SpecError = { field: string; node?: string; error: string }

/** Every error and every warning, never the first only. A warning doesn't fail the check. */
export type SpecCheck = { ok: boolean; errors: SpecError[]; warnings: SpecError[] }

/** What validation needs from outside the spec. Built by its caller (N's builder, K's Launch, J's propose). */
export type ValidateCtx = {
  /** A directory git runs in for the repository (lifecycle.ts, repoOf). */
  repo: string
  litterDir: string
  /** `p.limits()`, for the depth and peak checks (15.7). */
  limits: SubagentLimits
  /** A node's brief as it would be used: the proposal's, the draft's or the saved one. Null when there's none. */
  briefText(node: string): Promise<string | null>
  /** policy.json's active run's `checkout`, or null: no `existing` worktree may be it (15.4, "Coexisting with runs"). */
  activeRunCheckout: string | null
}

/**
 * The tree's shape (15.7, "How the needs are computed"): the lead is 0, a node
 * its parent's depth plus one. Written by J's `treeShape`, read by the doctor and N.
 */
export type TreeShape = {
  /** Node id → its deepest depth (a worker under several parents takes the deepest). */
  depth: Record<string, number>
  /** The deepest node's depth: the spawn depth limit must be at least this. */
  maxDepth: number
  /** The most agents that can run at once, capped by `limits.maxAgentsAtOnce` when it's set. */
  peak: number
  /** The same before that cap. */
  uncapped: number
}

/** Where an instance would work, as validation can tell before Launch. */
export type PlannedDir =
  /** The session's directory: `none`, or `inherit` up to the lead. */
  | { kind: 'session' }
  /** An `existing` or `new` worktree, as validation resolved its path, and the node it belongs to. */
  | { kind: 'worktree'; path: string; node: string }
  /** `own`: a worktree of its own, so never shared. */
  | { kind: 'own' }

/**
 * One writing template under one parent, expanded (15.3, tenth review):
 * `count` instances at once, each in `dir`. Written by J's `instancesOf`.
 */
export type InstancePlan = {
  node: string
  /** The parent node's id; null for an orchestrator (the lead). */
  parent: string | null
  count: number
  dir: PlannedDir
  /** May commit (`authority.commit`), so its scope is the whole directory. */
  commits: boolean
  serial: boolean
}

// ---------------------------------------------------------------------------
// The store (J's store.ts). The builder (N), Launch (K) and the doctor read it.

/** A swarm as saved: the spec at `revision`, and its briefs (node id → text). */
export type SavedSwarm = { spec: SwarmSpec; revision: number; briefs: Record<string, string> }

/** One row of the start screen and `/litter swarms`'s list. */
export type SwarmListing = { name: string; goal: string; revision: number; nodes: number; live: boolean }

/** One edit the builder made to a draft: the field's path (as SpecError's) or `brief:<node>`, and when. */
export type DraftEdit = { path: string; at: number }

/**
 * The builder's unsaved work, in `$.store` under `litter.swarm.draft.<litterDir>.<name>`
 * (a /clear wipes `$.state`). Written by J's `writeDraft` from N's edits.
 */
export type Draft = {
  /** The saved revision it started from; 0 for a swarm never saved. */
  base: number
  /** In order: what's yours since `base`, so a proposal over it can mark conflicts. */
  edits: DraftEdit[]
  spec: SwarmSpec
  /** Node id → brief text, as edited. */
  briefs: Record<string, string>
  updatedAt: number
}

/** How a revision came to be (`swarm.revision`'s `from`); `repair` is the spec the failed-fanout bridge generates (2b-2, X). */
export type RevisionFrom = 'save' | 'proposal' | 'template' | 'repair'

/** How one proposed change reads against the draft. */
export type ProposalChange = {
  /** The field's path, as the lead's `changes` name it. */
  path: string
  node?: string
  kind: 'added' | 'removed' | 'changed'
  before?: unknown
  after?: unknown
  /** The lead's reason for it, or null when its `changes` don't name this path. */
  reason: string | null
  /** You changed it after the proposal's base revision too. */
  conflict: boolean
  /** Your value, when `conflict`. */
  yours?: unknown
}

/** One brief's line diff against the base revision. */
export type BriefDiff = {
  node: string
  kind: 'added' | 'removed' | 'changed'
  lines: { op: ' ' | '+' | '-'; text: string }[]
  reason: string | null
  conflict: boolean
  /** Your draft's line diff against the same base, when `conflict` (15.5: a brief conflict is "two diffs"). */
  yoursLines?: { op: ' ' | '+' | '-'; text: string }[]
}

/** The counts swarm_propose answers with, and N's header shows. */
export type DiffCounts = { added: number; removed: number; changed: number; briefs: number; conflicts: number }

/** A staged proposal as N draws it (J's readProposal). */
export type ProposalView = {
  swarm: string
  n: number
  baseRevision: number
  changes: ProposalChange[]
  briefs: BriefDiff[]
  counts: DiffCounts
  /** Its one decision once made (`swarm.proposal.decided`), else null. */
  decided: 'all' | 'some' | 'none' | null
}

// ---------------------------------------------------------------------------
// Templates (J's templates.ts, 15.5).

/** A template parameter: `{name}` in the spec and briefs. A `list` drives `repeat`. */
export type TemplateParam = { name: string; type: 'string' | 'list'; description?: string; default?: string | string[] }

/** A built-in, a user template (`<config dir>/litter/swarm-templates/`) or a project one (`<litterDir>/swarm-templates/`). */
export type Template = {
  name: string
  description: string
  scope: 'builtin' | 'user' | 'project'
  params: TemplateParam[]
  /** Node id → the list parameter it repeats over: one copy per item, `{item}` in its id, brief, task and worktree. */
  repeat?: Record<string, string>
  spec: SwarmSpec
  briefs: Record<string, string>
}

/** One template as the start screen lists it. */
export type TemplateListing = {
  name: string
  description: string
  /** Its spec's goal, as written (its `{param}`s unfilled): the start screen's list shows its first line when there's no description (WP-DA2). */
  goal: string
  scope: Template['scope']
  params: TemplateParam[]
  /** The file, or null for a built-in. */
  path: string | null
}

// ---------------------------------------------------------------------------
// The health check (J's doctor.ts, 15.7). The builder's strip, Launch and the doctor pane read it.

/** Where a limit's value comes from: this process, and each settings file apart. */
export type HealthValues = {
  /** What the swarm needs, when the row computes a need. */
  need?: number
  /** This process's value (`p.limits()`); absent when unset. */
  process?: string
  /** Each source's value for the same variable; a source that doesn't set it is left out. */
  sources?: Partial<Record<SettingsSourceName, string>>
}

export type HealthRow = {
  id: string
  severity: 'ok' | 'info' | 'warning' | 'error'
  title: string
  detail: string
  values?: HealthValues
}

/**
 * One row per check. `errors` and `warnings` count the rows. `snippet` holds
 * only the variables that fall short, at the need plus headroom, as an `env`
 * block for your user settings; null when nothing does.
 */
export type HealthReport = { rows: HealthRow[]; errors: number; warnings: number; snippet: { env: Record<string, string> } | null }

/** What `checkHealth` checks: a spec (or none, for /litter doctor without one). */
export type HealthInput = {
  spec: SwarmSpec | null
  litterDir: string | null
  /** The doctor's [Test]: one `p.complete` call to `summaryModel`. */
  testSummaryModel?: boolean
}

// ---------------------------------------------------------------------------
// The live state (state.ts holds these; plan 15.4). Written by the owners
// through state.ts's changers; read by everyone.

/** A node's directory when its `worktree` is `existing`, `new` or `none` (inherit and own are per instance). */
export type NodeDir = {
  /** Absolute and resolved. */
  dir: string
  /** The bound branch as a full ref (`refs/heads/<name>`), for a node with `commit` set; null otherwise. */
  branch: string | null
  /** Launch made it (`new`): only such worktrees are ever removed (15.4, "Cleanup"). */
  created: boolean
}

/** As lifecycle.ts's policyFor computes them for a run: resolved real paths, compared exactly by the guard. */
export type SwarmRoots = {
  litterDir: string
  /** Every `.claude/litter/` copy the mod knows of, the canonical one included. */
  litterCopies: string[]
  /** The rule folders under the primary checkout (plan 16.1). */
  ruleDirs: string[]
}

/**
 * A repair swarm's budget (plan 15.11, "The repair budget"): the rounds (one
 * verdict on a distinct verify each) and the agents (the workers and children
 * its nodes spawn; not the orchestrator, not resumes). From the run's
 * `run.json.repair` at the bridge, raised only by `repair.budget` and your
 * answer to the mod's ask (2b-2, decision 8).
 */
export type RepairBudget = { rounds: number; agents: number }

/**
 * The run a repair swarm works for (2b-2): its gate records go to that run's
 * ledger, in `generation`, the one its `run.repair` opened (decision 1).
 * `runDir` is absolute.
 */
export type RunLink = { runDir: string; run: string; generation: number }

/**
 * A live swarm. Put by K at Launch (step 6) and recovery, patched by K
 * (`lost`, `owner`, `typesReady`), P (`state`, `tips`, `flags`) and O (`owner.session`).
 * 2b-2: X puts a repair swarm with `run` and `budget`, and raises `budget`.
 */
export type LiveSwarm = {
  name: string
  launch: string
  /** The revision launched; L and K read the spec from here, not swarm.json (a save while live is a new revision). */
  revision: number
  spec: SwarmSpec
  /** The swarm's nonce for the instance and rules blocks: `crypto.randomUUID()` without dashes. */
  nonce: string
  /** Node id → its type as the engine serves it, `litter:sw-<swarm>-<node>`. */
  types: Record<string, string>
  /** Every type is registered at `revision` in this process: admission refuses a resume until then (15.4). */
  typesReady: boolean
  /** Node id → its directory, for `existing`, `new` and `none`. */
  dirs: Record<string, NodeDir>
  /** The session's directory at Launch (`p.cwd()`): `none` nodes, and `inherit` under the lead. */
  sessionCwd: string
  /** Resolved: where `new` and `own` worktrees go (`<worktreeRoot>/<name>`). */
  worktreeRoot: string
  /** Resolved `git rev-parse --git-common-dir`. */
  commonDir: string
  roots: SwarmRoots
  /** `refs/heads/<name>` → oid: every local branch's tip at Launch, then after each node turn (P). */
  tips: Record<string, string>
  owner: { ref: string; oid: string; generation: number; session: string }
  state: 'live' | 'stopping'
  /** Another session owns it: shown, never acted on, never mirrored. */
  readOnly: boolean
  /** This session's ownership was lost (a handover): spawns and sends are refused, nothing is written or mirrored. */
  lost: boolean
  flags: { isolationLost: boolean }
  startedAt: number
  /** A repair swarm's run (2b-2): only a swarm with one may verify, judge or land. */
  run?: RunLink
  /** A repair swarm's budget (2b-2); a swarm without one has none to count. */
  budget?: RepairBudget
}

export type BindingKind = 'orchestrator' | 'worker' | 'child'

/**
 * agentId → the instance it runs. Put by L at binding (and `swarm.bind`), and
 * by K's recovery from `swarm.node` records. A child is a non-swarm agent a
 * node spawned: it carries its node's scope.
 */
export type NodeBinding = {
  agentId: string
  swarm: string
  launch: string
  /** The node id; for a child, its node's. */
  node: string
  /** The instance number, from 1 over the swarm's life; 0 for a child. */
  n: number
  kind: BindingKind
  /** A child's node: that node's agentId; null otherwise. */
  of: string | null
  /** The spawning loop's agentId; null for an orchestrator, whose parent is the lead. */
  parent: string | null
  /** The node's served type, `litter:sw-<swarm>-<node>` (a child's is its node's). */
  type: string
  /** Absolute and resolved: the directory the spawn check pinned. */
  cwd: string
  /** The bound branch as a full ref, or null. */
  branch: string | null
  /** The `<instance>` block's bind token; null for a child. */
  token: string | null
  /** The swarm's revision when it was bound. */
  revision: number
  /** The owner's generation when it was bound (NodePolicy.generation). */
  generation: number
  boundAt: number
  /** Bound by adoption or `swarm.bind` after a reload, not at its spawn. */
  adopted: boolean
}

/** A writing instance's scope (15.4, tenth review): its directory and `paths`, or the whole directory when it may commit. */
export type WriteScope = { dir: string; paths: string[] | null; commit: boolean }

/** One running, settling or reserved writer's scope, as `activeScopes` lists them. */
export type ActiveScope = WriteScope & {
  swarm: string
  node: string
  /** The running agent, or null for a reservation. */
  agentId: string | null
  /** The reservation's key, or null for a running agent. */
  key: string | null
}

/**
 * A place taken before anything awaits (15.4, "It reserves the place"): a
 * spawn's, keyed by its `tool_use_id`, or a resume's. Put by L; process-local
 * (a reload ends the hook that held it), so never mirrored.
 */
export type Reservation = {
  key: string
  swarm: string
  node: string
  /** The spawning or resuming parent's agentId; null for the lead. */
  parent: string | null
  kind: BindingKind
  /** The instance number taken for a spawn; the instance's own for a resume; null for a child. */
  n: number | null
  scope: WriteScope | null
  at: number
  /** A resume's agent. */
  agentId?: string
}

/**
 * An agent's place in the admission table: `running` from its spawn or
 * admitted resume, `settling` from its turn.complete until the list stops
 * showing it running, `idle` when it holds no place.
 */
export type AdmissionStatus = 'running' | 'settling' | 'idle'

/** A message held until its node settles (15.4, "Messages from you"). Put by L; mirrored. */
export type QueuedMessage = {
  /** Assigned by state.ts's `enqueue`. */
  id: string
  swarm: string
  agentId: string
  node: string
  /** At most 16 KiB (cut by state.ts). */
  text: string
  /** `user` (the browser), `lead`, or the sending node's agentId. */
  from: string
  at: number
}

/** An open tool call, from guard.sh's `call` start until its end, a deny, a stop or an aborted turn (P's consumer). */
export type InflightCall = {
  agentId: string
  toolUseId: string
  tool: string
  /** A Bash or Monitor call's command as its `call` line had it (first 80 characters), or ''. */
  detail: string
  at: number
  /** The agent's swarm, or null for a run agent. */
  swarm: string | null
}

/** A background shell a node started (PostToolUse names it), until TaskStop or the list confirms it stopped. */
export type Shell = { shellId: string; agentId: string; swarm: string | null; at: number }

/** A node's last report (P from hand-backs and answers, L from messages). At most 4 KiB (cut by state.ts). */
export type NodeReport = { text: string; via: 'handback' | 'answer' | 'message'; at: number }

/** Summed from each turn.complete's `e.usage` (P). */
export type TokenCount = { input: number; output: number; cacheRead: number; cacheCreation: number; turns: number }

/**
 * A swarm's spend (WP-DH): how far the session's cost total (`$.session.usage`)
 * grew while the swarm was live here, every agent's responses and the lead's
 * included, since the engine prices no agent alone. `base` and `seen`: the
 * total in `session` when the count began there and when it was last read;
 * `carried`: what earlier totals grew (a /clear's new session, a takeover, a
 * restart whose ledger began again). Spent: carried + seen - base. `since`:
 * when the count began, in `p.now()`'s milliseconds (its launch, or the first
 * reading of a swarm launched before litter counted).
 */
export type SwarmSpend = { session: string; base: number; seen: number; carried: number; since: number }

/** A question a node asked its parent or the lead (L), open until answered. */
export type Question = {
  swarm: string
  agentId: string
  node: string
  text: string
  at: number
  closedAt: number | null
  /** Where it went (WP-DG): `lead`, or the parent node's id. Absent in a question kept before WP-DG. */
  to?: string
}

/** A command the /clear killed, for the next `<swarm>` block's "Cut short by the clear" line (O). */
export type ClearKill = {
  agentId: string
  /** A node's name and instance (`fixer #2 under part-b`) or a run role. */
  who: string
  tool: string
  /** What it was running, as the in-flight table had it (`npm test`; the line renders `Bash (npm test)`), or ''. */
  detail: string
}

/**
 * Why the next `<swarm>` block opens with the cleared lines (O): a /clear
 * whose session.end the mod saw, or a session id that moved with none (a
 * missed clear's, or backgrounding's), where the lead may still remember.
 */
export type ClearReason = 'clear' | 'session-moved'

/** The usage a turn reports, as addTokens takes it. */
export type { TurnUsage }

// ---------------------------------------------------------------------------
// What the panes draw from other packages (N reads these).

/** One node instance on K's recovery card. */
export type RecoveryNode = {
  node: string
  n: number
  agentId: string
  kind: BindingKind
  /** By `$.agent.list()`: still running, finished, or not in the list (evicted, or another process's). */
  state: 'alive' | 'settled' | 'gone'
  lastReport: string | null
  /** Bound under an older generation: only re-spawn is offered (a handover). */
  respawnOnly: boolean
}

/** K's recovery card for a swarm this session owns after a restart (15.4, "Recreating a swarm"). */
export type RecoveryCard = {
  swarm: string
  launch: string
  /** A swarm that was stopping: the card offers only to finish ending it. */
  stopping: boolean
  nodes: RecoveryNode[]
  at: number
}

/** P's settle wait, for N's unsettled report (15.4, "Ending"). */
export type SettleProgress = {
  swarm: string
  /** When the stopping began. */
  since: number
  /** Nodes whose last turn hasn't ended. */
  nodes: { agentId: string; node: string; n: number; status: string }[]
  /** Open calls, with their tool and start, for the age N shows. */
  calls: { agentId: string; node: string; tool: string; toolUseId: string; at: number }[]
  /** Shells not yet confirmed stopped. */
  shells: { shellId: string; agentId: string; node: string; at: number }[]
  reservations: number
}

/**
 * O's generated summary (15.6, "The summary"): display-only, three parts.
 * `blocked` (WP-DG) was `waitingOnYou`: which members wait on something, and
 * on what. The model can't tell what waits on the person, so nothing here is
 * a ⚑; a summary kept or recorded before reads its `Waiting on you` as this.
 */
export type SwarmSummary = {
  goalNow: string
  progress: string[]
  blocked: string[]
  at: number
  /** A newer event exists than the ones it summarised. */
  stale: boolean
}

/** The ownership ref's blob (15.4): built by K. */
export type OwnerBlob = {
  swarm: string
  launch: string
  session: string
  generation: number
  host: string
  pid: string
  acquiredAt: number
}

/** K's readOwner, for the doctor's row and the read-only browser's [Take over]. */
export type OwnerView = {
  swarm: string
  ref: string
  /** The ref's oid, or null when it doesn't exist. */
  oid: string | null
  blob: OwnerBlob | null
  /** Since the lease file was last beaten; null when there's none. */
  leaseAgeMs: number | null
  /** The blob names this session. */
  mine: boolean
  /** 15.4's three conditions hold as far as this session can tell (your confirmation still to come). */
  canHandOver: boolean
  /** Why not, when not. */
  why: string | null
}

/**
 * What a send did (L): delivered; readdressed to the node's parent (the reply
 * route); queued until the node settles; or refused, with whether it can queue.
 */
export type SendOutcome =
  | { kind: 'delivered' }
  | { kind: 'readdressed'; to: string; parentNode: string; why: string }
  | { kind: 'queued'; id: string }
  | { kind: 'refused'; reason: string; canQueue: boolean }

/** What the browser's composer sends (N to L's sendFromBrowser). */
export type BrowserSend = {
  swarm: string
  /** The node's id, or `<node>#<n>` for one instance. */
  node: string
  text: string
  when: 'interject' | 'queue'
  route: 'direct' | 'lead' | 'parent'
}
