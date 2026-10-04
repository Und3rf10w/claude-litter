// WP-L: the spawn check on agent.spawn (15.4, "The spawn check"): check and
// reserve in one synchronous step, the pending marker, `own` worktrees, the
// instance and rules blocks, the rewrite, the binding before the parent sees
// the result, and a node's non-swarm children. For a repair swarm (2b-2,
// package Y), its budget: a worker or child spawn is counted against
// `repairAgents` in the step that reserves and given back on undo; past the
// agents or the rounds it's refused (gate.ts). Phase 3 (package AE): the
// rules block holds the node's accepted rules and its swarm's proposals
// (16.5, 15.10), selected before the check and reservation.
//
// The check applies when `subagentType` is a live swarm's type, or the
// spawning loop is a bound node or a node's child. Anything else passes to
// `next(e)` unchanged. Every failure after the reservation releases it,
// removes the marker and any fresh `own` worktree, and denies; the catch in
// wiring.ts only covers a throw past all of that.

import type { Ports } from '../ports'
import type { PortHook, SpawnHook } from '../hooktypes'
import type { PendingMarker } from '../hookfiles'
import type { SwarmInstanceBody, SwarmNodeBody } from '../records/swarm'
import type { BindingKind, LiveSwarm, NodeBinding, SwarmNode, WriteScope } from './types'
import { appendLaunchRecord } from '../records/swarm'
import { getOptions, session } from '../session'
import { pendingPath, SWARM_TYPE_PREFIX, swarmOwnBranch, swarmOwnWorktreeName } from '../layout'
import { atomicWriteJson, remove } from '../fsx'
import { git, litterWorktreeRoot, revParse } from '../worktrees'
import { addSwarmWorktree, inspectWorktree } from './worktrees'
import { renderSlots } from '../prompts/slots'
import {
  PARENT_LEAD,
  PARENT_ROUTE_ORCHESTRATOR,
  PARENT_ROUTE_WORKER,
  REPAIR_BUDGET_LEFT,
  REPAIR_BUDGET_LEFT_PLAN,
  RULES_NONE,
  SPAWNS_LEFT_ITEM,
  SPAWNS_LEFT_NONE,
  SPAWNS_LEFT_WORKER_HOLD,
  SWARM_INSTANCE,
  SWARM_RULES,
} from '../prompts/swarm-instance'
import { nodePolicyFor, patchNodePolicy, writeNodePolicy } from './guard'
import { capRefusal, delegatorsOf, labelOf, nodeOf, scopeConflict, scopeOf, spawnsText, swarmRefusal, waitBudget } from './admit'
import { budgetCounted, budgetLeft, budgetRefusal, countsAgainstBudget } from './gate'
import { readRunFacts } from '../verify'
import { RULES_CAP, selectForSpawn } from '../rules/select'
import { proposalsOf } from '../rules/store'
import * as state from './state'

// Phase 3's rules (AE's selection, AD's proposals), through one table so tier 2 can stand in for them
// (COMMON, "Another package's module"). The mod never changes it.
export const deps = {
  selectForSpawn: (...a: Parameters<typeof selectForSpawn>) => selectForSpawn(...a),
  proposalsOf: (...a: Parameters<typeof proposalsOf>) => proposalsOf(...a),
}

type Spawn = Parameters<PortHook<SpawnHook>>[1]
type Next = Parameters<PortHook<SpawnHook>>[2]
type SpawnResult = Awaited<ReturnType<PortHook<SpawnHook>>>

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const deny = (reason: string): SpawnResult => ({ deny: reason.startsWith('litter') ? reason : `litter: ${reason}` })

/** A tool_use_id as a marker's file name takes it: one plain name. */
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/

const NEVER_NAMED = 'swarm agents are never named: leave name unset (litter addresses nodes by node name, through mcp__litter__swarm_send)'
// With agent teams on, a named call starts a teammate (2.1.289): the engine puts back a rewrite's cwd and
// background, so it would run in the session's directory, outside the swarm's.
const NEVER_TEAMMATE =
  "swarm agents are never teammates: with name set, this call starts a teammate, which runs in the session's directory and ignores the cwd and background litter gives a swarm agent. Leave name unset"
const CHILD_NEVER_TEAMMATE =
  "an agent a node starts is never a teammate: with name set, this call starts a teammate, which runs in the session's directory and ignores the cwd (its node's directory) and background litter gives it. Leave name unset"
const NO_ISOLATION = "swarm agents never take isolation: the swarm sets each one's directory"

/** What the synchronous step decided and reserved. */
type Plan = {
  s: LiveSwarm
  key: string
  kind: BindingKind
  /** The spec node: the instance's own, or a child's node's. */
  node: SwarmNode
  /** The instance number; 0 for a child. */
  n: number
  /** The spawning binding; null for the lead. */
  parent: NodeBinding | null
  /** A child's node's binding. */
  of: NodeBinding | null
  /** The directory it runs in (for `own`, the worktree's path, made after the reservation). */
  dir: string
  own: boolean
  /** The bound branch as a full ref, when known now; `pending` when it's read from the directory after the reservation. */
  branch: string | null | 'pending'
  scope: WriteScope | null
}

/** `isolation` isn't in agent.spawn's input (the 2.1.289 d.ts and engine), but refused if a call carries it. */
const isolated = (e: Spawn): boolean => {
  const v = (e as unknown as Record<string, unknown>).isolation
  return v !== undefined && v !== null && v !== ''
}

/**
 * A node's directory when it isn't `own` (15.3, "`worktree` values"):
 * `inherit` its parent's (the node's from Launch, or the session's, under
 * the lead), `none` the session's, else the one Launch set. Null when there's none.
 */
function sharedDir(s: LiveSwarm, node: SwarmNode, parentB: NodeBinding | null): string | null {
  const wt = node.worktree ?? 'inherit'
  const dirOf = s.dirs[node.id]
  if (wt === 'inherit') return node.kind === 'worker' ? (parentB?.cwd ?? null) : (dirOf?.dir ?? s.sessionCwd)
  if (wt === 'none') return dirOf?.dir ?? s.sessionCwd
  return dirOf?.dir ?? null
}

/**
 * The check and the reservation, with no await between them (15.4, "It
 * reserves the place before it awaits anything"): a deny's text, or the plan
 * with its place held under the call's tool_use_id.
 */
function planSpawn(e: Spawn, root: string, at: number): Plan | string {
  if (!TOOL_USE_ID.test(e.tool_use_id)) return `this Agent call's id '${e.tool_use_id}' isn't one litter can key a reservation by`
  const hit = state.swarmOfType(e.subagentType)
  const parentB = e.parentAgentId !== undefined ? state.binding(e.parentAgentId) : null
  const plan = hit ? planNode(e, hit, parentB, root) : planChild(e, parentB!)
  if (typeof plan === 'string') return plan
  try {
    state.reserve({
      key: plan.key,
      swarm: plan.s.name,
      node: plan.node.id,
      parent: e.parentAgentId ?? null,
      kind: plan.kind,
      n: plan.kind === 'child' ? null : plan.n,
      scope: plan.scope,
      at,
    })
  } catch (err) {
    return errText(err)
  }
  // A repair swarm's worker or child counts against its agents from here, in the step that reserved (decision 7).
  if (countsAgainstBudget(plan.s, plan.kind)) state.noteSpawned(plan.s.name, plan.key)
  return plan
}

/** A spawn of a swarm type: an orchestrator from the lead, or a worker from a node that lists it. */
function planNode(e: Spawn, hit: { swarm: string; node: string }, parentB: NodeBinding | null, root: string): Plan | string {
  const s = state.liveSwarm(hit.swarm)
  const off = swarmRefusal(s, hit.swarm, true)
  if (off || !s) return off ?? `swarm ${hit.swarm} isn't live`
  const node = nodeOf(s, hit.node)
  if (!node) return `${hit.node} isn't in swarm ${s.name}'s revision ${s.revision}`
  if (e.isTeammate === true) return NEVER_TEAMMATE
  if (e.name !== undefined && e.name !== '') return NEVER_NAMED
  if (isolated(e)) return NO_ISOLATION
  const listedBy = s.spec.nodes.filter(x => x.spawns?.[node.id] !== undefined).map(x => x.id)

  if (node.kind === 'orchestrator') {
    if (e.parentAgentId !== undefined) return `${node.id} is an orchestrator of swarm ${s.name}: only the lead spawns it`
    if (state.countFor(s.name, null, node.id) > 0) {
      return `${node.id} is running already, and each orchestrator runs once at a time; send to it with mcp__litter__swarm_send`
    }
  } else {
    const who = listedBy.length > 0 ? listedBy.join(', ') : 'no node'
    if (e.parentAgentId === undefined) return `${node.id} is a worker of swarm ${s.name}: its parent node spawns it (${who} may)`
    if (!parentB || parentB.swarm !== s.name) return `${node.id} is a worker of swarm ${s.name}: only its nodes spawn it (${who} may)`
    if (parentB.kind === 'child') return `an agent a node started can't spawn swarm agents; its node ${parentB.node} spawns ${node.id}`
    if (state.isStopped(parentB.agentId)) return `${labelOf(parentB)} was stopped; it starts nothing`
    const pn = nodeOf(s, parentB.node)
    const max = pn?.spawns?.[node.id]
    if (!pn || max === undefined) return `${parentB.node} may spawn ${pn ? spawnsText(pn) : 'nothing in this revision'}, not ${node.id}`
    const k = state.countFor(s.name, parentB.agentId, node.id)
    if (k >= max) return `${labelOf(parentB)} already runs ${k} of its max ${max} ${node.id} at once; wait for one to finish`
  }
  const cap = capRefusal(s)
  if (cap) return cap
  const budget = budgetRefusal(s.name, node.kind)
  if (budget) return budget

  // Its directory: own per instance, inherit its parent's, else the node's from Launch.
  const wt = node.worktree ?? 'inherit'
  const own = wt === 'own'
  if (own && (node.kind !== 'worker' || !parentB)) return `${node.id} uses own worktrees, which only workers do`
  const dirOf = s.dirs[node.id]
  let dir: string
  if (own) dir = '' // per instance, below, once its number is taken
  else {
    const shared = sharedDir(s, node, parentB)
    if (shared === null) return `swarm ${s.name} has no directory for ${node.id}; end it and launch again`
    dir = shared
  }

  const commit = node.authority?.commit === true
  let branch: Plan['branch'] = null
  let scope: WriteScope | null = null
  let n: number
  if (own) {
    n = state.nextInstance(s.name, node.id)
    dir = `${root}/${swarmOwnWorktreeName(s.name, node.id, n)}`
    branch = commit ? `refs/heads/${swarmOwnBranch(s.name, node.id, n)}` : null
    scope = scopeOf(node, dir)
  } else {
    scope = scopeOf(node, dir)
    if (scope) {
      const clash = scopeConflict(s.name, scope, delegatorsOf(e.parentAgentId ?? null))
      if (clash) return `another ${clash.node} is writing in ${clash.dir}; wait for it, or use own worktrees`
    }
    if (commit) {
      const known = dirOf?.branch ?? (wt === 'inherit' && node.kind === 'worker' ? parentB!.branch : null)
      branch = known ?? 'pending'
    }
    n = state.nextInstance(s.name, node.id)
  }
  return { s, key: e.tool_use_id, kind: node.kind, node, n, parent: parentB, of: null, dir, own, branch, scope }
}

/** A non-swarm agent a node (or one of its children) starts: its node's directory and scope, counted toward the cap. */
function planChild(e: Spawn, parentB: NodeBinding): Plan | string {
  const s = state.liveSwarm(parentB.swarm)
  const off = swarmRefusal(s, parentB.swarm, false)
  if (off || !s) return off ?? `swarm ${parentB.swarm} isn't live`
  const of = parentB.kind === 'child' ? (parentB.of === null ? null : state.binding(parentB.of)) : parentB
  if (!of) return `the node that started ${parentB.agentId} isn't bound any more, so it starts nothing`
  if (state.isStopped(of.agentId)) return `${labelOf(of)} was stopped; it starts nothing`
  const node = nodeOf(s, of.node)
  if (!node) return `${of.node} isn't in swarm ${s.name}'s revision ${s.revision}`
  if (node.spawnOther === false) return `${of.node} starts no other agents (spawnOther is false); it may spawn ${spawnsText(node)}`
  if (e.isTeammate === true) return CHILD_NEVER_TEAMMATE
  if (e.name !== undefined && e.name !== '') return NEVER_NAMED
  if (isolated(e)) return NO_ISOLATION
  const cap = capRefusal(s)
  if (cap) return cap
  const budget = budgetRefusal(s.name, 'child')
  if (budget) return budget
  const scope = scopeOf(node, of.cwd)
  if (scope) {
    const clash = scopeConflict(s.name, scope, delegatorsOf(parentB.agentId))
    if (clash) return `another ${clash.node} is writing in ${clash.dir}; wait for it, or use own worktrees`
  }
  return { s, key: e.tool_use_id, kind: 'child', node, n: 0, parent: parentB, of, dir: of.cwd, own: false, branch: of.branch, scope }
}

/**
 * The swarm's and the parent's refusals again, right before dispatch. An
 * `own` worktree's setup can take minutes after the reservation, and a Stop
 * of the parent meanwhile can't name an instance that has no binding yet
 * (end.ts, stopNode, by descendants), nor can the swarm's End.
 */
function lateRefusal(plan: Plan): string | null {
  const off = swarmRefusal(state.liveSwarm(plan.s.name), plan.s.name, plan.kind !== 'child')
  if (off) return off
  for (const b of [plan.parent, plan.of]) {
    if (b === null) continue
    if (state.binding(b.agentId) === null) return `${labelOf(b)} isn't bound any more, so it starts nothing`
    if (state.isStopped(b.agentId)) return `${labelOf(b)} was stopped; it starts nothing`
  }
  return null
}

/** `{spawns_left}`: each worker it may start, at its count now, under the swarm's cap; with the hold line for a worker. */
function spawnsLeft(plan: Plan): string {
  const list = Object.entries(plan.node.spawns ?? {})
  if (list.length === 0) return SPAWNS_LEFT_NONE
  const cap = plan.s.spec.limits?.maxAgentsAtOnce
  const room = cap === undefined ? Number.POSITIVE_INFINITY : Math.max(0, cap - state.countSwarm(plan.s.name))
  const items = list.map(([w, max]) => renderSlots(SPAWNS_LEFT_ITEM, { node: w, left: String(Math.min(max, room)), of: String(max) })).join(', ')
  return plan.kind === 'worker' ? `${items}. ${SPAWNS_LEFT_WORKER_HOLD}` : items
}

/**
 * `{budget}`: what a repair swarm has left, this spawn counted; null (the line
 * goes) for any other swarm. Its run's workflow picks the line, as gate.ts
 * tells the two apart: an execute run's is its plan-template swarm, whose
 * round is a rejecting verdict (phase 3, decision 1). A run.json that can't
 * be read throws, so the spawn is denied: the gates would refuse every record
 * of that run too.
 */
async function budgetText(p: Ports, s: LiveSwarm): Promise<string | null> {
  if (!budgetLeft(s)) return null
  let line = REPAIR_BUDGET_LEFT
  if (s.run) {
    const f = await readRunFacts(p, s.run.runDir, s.run.run)
    if ('ok' in f) throw new Error(f.error.replace(/^litter: /, ''))
    if (f.json.workflow === 'execute') line = REPAIR_BUDGET_LEFT_PLAN
  }
  const left = budgetLeft(s)!
  return renderSlots(line, { rounds_left: String(left.roundsLeft), rounds: String(left.rounds), agents_left: String(left.agentsLeft), agents: String(left.agents) })
}

/** The parent as the block names it. */
const parentName = (plan: Plan): string =>
  plan.parent === null ? PARENT_LEAD : plan.parent.kind === 'worker' ? `${plan.parent.node} #${plan.parent.n}` : plan.parent.node

/** 16.5 and 15.10's label on a proposal that reaches a later prompt of the same swarm. */
export const PROPOSED_LABEL = 'Proposed in this run, not accepted: '
/** 15.10: at most this many of the swarm's proposals reach a spawn. */
export const PROPOSALS_MAX = 10

const bytes = (s: string): number => new TextEncoder().encode(s).length
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/**
 * The `<rules>` block's text for a spawn of a swarm type: the node's rules
 * (AE's selectForSpawn, 16.5), then its swarm's pending proposals, labelled,
 * deduplicated by folded text, the PROPOSALS_MAX most recent (15.10), while
 * the block's 8 KiB lasts. RULES_NONE when nothing applies. Run before the
 * check and reservation, which await nothing (15.4), from the node and
 * directory planNode settles on; a spawn planNode refuses, and a child (it
 * gets no block), take RULES_NONE. A rules failure throws: the spawn is
 * denied, as a launch whose rules can't be selected is refused. A proposals
 * failure is logged, since proposals bind nobody.
 */
async function rulesBlock(p: Ports, litterDir: string, e: Spawn, parentB: NodeBinding | null, root: string): Promise<string> {
  const hit = state.swarmOfType(e.subagentType)
  const s = hit ? state.liveSwarm(hit.swarm) : null
  const node = s && hit ? nodeOf(s, hit.node) : null
  if (!s || !node) return RULES_NONE
  // An own worktree is made after the reservation; any instance's path is that worktree's top, which is all
  // selection reads from it (the node's paths are relative to the repository there). Instances count from 1.
  const dir = (node.worktree ?? 'inherit') === 'own' ? `${root}/${swarmOwnWorktreeName(s.name, node.id, 0)}` : sharedDir(s, node, parentB)
  if (dir === null) return RULES_NONE
  const entries = await deps.selectForSpawn(p, litterDir, { swarm: s, node, dir })
  let used = entries.reduce((n, x) => n + bytes(x) + 1, 0)
  const out = [...entries]
  for (const x of await swarmProposals(p, litterDir, s.name)) {
    const n = bytes(x) + 1
    if (used + n > RULES_CAP) break
    out.push(x)
    used += n
  }
  return out.length > 0 ? out.join('\n') : RULES_NONE
}

/** The swarm's pending proposals as entries: newest first to pick the PROPOSALS_MAX, given back oldest first. */
async function swarmProposals(p: Ports, litterDir: string, swarm: string): Promise<string[]> {
  let list: Awaited<ReturnType<typeof proposalsOf>>
  try {
    list = await deps.proposalsOf(p, litterDir, { swarm, status: ['proposed'] })
  } catch (err) {
    p.log(`swarm ${swarm}: its critics' proposals couldn't be read, so this spawn's rules block has none: ${errText(err)}`)
    return []
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (let i = list.length - 1; i >= 0 && out.length < PROPOSALS_MAX; i--) {
    const x = list[i]!
    if (x.status !== 'proposed') continue
    const text = oneLine(x.body.doc?.body.rule ?? x.body.rule ?? '')
    const folded = text.toLowerCase()
    if (text === '' || seen.has(folded)) continue
    seen.add(folded)
    out.push(`${PROPOSED_LABEL}${text}`)
  }
  return out.reverse()
}

/**
 * The prompt a node spawns with: its `<instance>` block, its `<rules>` block,
 * then the task (litter-prompts.md). `nonce` is the instance's own, made now,
 * after the parent wrote the task: the swarm's would be in every node's own
 * blocks, so a parent could close its child's or forge whole new ones.
 */
function promptFor(plan: Plan, dir: string, branch: string | null, token: string, nonce: string, task: string, rules: string, budget: string | null): string {
  const instance = renderSlots(SWARM_INSTANCE, {
    nonce,
    node: plan.node.id,
    n: String(plan.n),
    swarm: plan.s.name,
    parent_node: parentName(plan),
    parent_route: plan.kind === 'orchestrator' ? PARENT_ROUTE_ORCHESTRATOR : PARENT_ROUTE_WORKER,
    cwd: dir,
    branch: branch === null ? null : branch.replace(/^refs\/heads\//, ''),
    spawns_left: spawnsLeft(plan),
    budget,
    token,
  })
  const block = renderSlots(SWARM_RULES, { nonce, rules: rules === '' ? RULES_NONE : rules })
  return `${instance}\n\n${block}\n\n${task}`
}

/** The branch checked out in `dir`, as a full ref; null on a detached HEAD. */
async function branchIn(p: Ports, dir: string): Promise<string | null> {
  const r = await git(p, dir, ['symbolic-ref', '-q', 'HEAD'])
  const ref = r.stdout.trim()
  return r.code === 0 && ref.startsWith('refs/heads/') ? ref : null
}

/** A fresh `own` worktree this spawn made. */
type Made = { path: string; branch: string; from: string; ignored: string[]; repo: string }

/** Removes a fresh `own` worktree a failed spawn made, only while nothing changed in it; else P's cleanup decides. */
async function removeFresh(p: Ports, dir: string, s: LiveSwarm, made: Made): Promise<void> {
  try {
    const f = await inspectWorktree(p, made.repo, made.path, made.branch, made.from, made.ignored)
    const unchanged = f.listed === true && f.commitsPast === 0 && f.changes?.length === 0 && f.newIgnored?.length === 0
    if (!unchanged) {
      p.log(`swarm ${s.name}: the worktree ${made.path} of a failed spawn has changes or commits; it stays for the swarm's cleanup`)
      return
    }
    // --force: the ignored files its setup left are its own, and nothing else is in it (checked above).
    const rm = await git(p, made.repo, ['worktree', 'remove', '--force', '--', made.path])
    if (rm.code !== 0) {
      p.log(`swarm ${s.name}: the worktree ${made.path} of a failed spawn wasn't removed: ${rm.stderr.trim()}`)
      return
    }
    const del = await git(p, made.repo, ['update-ref', '-d', `refs/heads/${made.branch}`, made.from])
    await appendLaunchRecord(p, dir, s.name, s.launch, 'swarm.worktree.removed', { path: made.path, branch: made.branch, branchDeleted: del.code === 0 })
  } catch (err) {
    p.log(`swarm ${s.name}: the worktree ${made.path} of a failed spawn wasn't removed: ${errText(err)}`)
  }
}

/**
 * A teammate litter has no stake in (2.1.289 runs agent.spawn for teammates
 * too): from the main thread, so no node or node's child spawned it, and of
 * no litter type. Safe to pass before rebound and the gate: the role check
 * refuses only a litter type, and the spawn check takes only a swarm type or
 * a node's spawn, so whatever the state holds, both answer next(e) for it.
 * Waiting would hold an outside team's spawn (deepwork's, say) for as long as
 * the gate stays closed.
 */
export function outsideTeammate(e: Pick<Spawn, 'isTeammate' | 'parentAgentId' | 'subagentType'>): boolean {
  const t = e.subagentType
  // swarmOfType (state.ts) reads a swarm type with or without its `litter:`, so a bare one is litter's too.
  return e.isTeammate === true && e.parentAgentId === undefined && !t.startsWith('litter:') && !`litter:${t}`.startsWith(SWARM_TYPE_PREFIX)
}

/**
 * agent.spawn (15.4): the check and reservation, then the marker, an `own`
 * worktree, `swarm.instance`, the rewritten call, and the binding, all before
 * it returns, so before the parent sees the Agent result.
 */
export const swarmSpawn: PortHook<SpawnHook> = async (p, e, next) => {
  if (outsideTeammate(e)) return next(e)
  // A closed gate is waited on only for what the hook has left (admit.ts, waitBudget; FIX-U, U5).
  await state.ready(p, await (await waitBudget(p, next)).left())
  const hit = state.swarmOfType(e.subagentType)
  const parentB = e.parentAgentId !== undefined ? state.binding(e.parentAgentId) : null
  if (!hit && !parentB) return next(e)
  const dir = session().litterDir
  if (!dir) return deny('this session has no litter directory, so it runs no swarm agents')
  // A repair swarm's budget, caught up from its ledgers before this process's first check of it (gate.ts).
  const swarm = hit?.swarm ?? parentB!.swarm
  try {
    await budgetCounted(p, dir, swarm)
  } catch (err) {
    return deny(`swarm ${swarm}'s repair budget couldn't be counted, so it starts nothing: ${errText(err)}`)
  }
  const root = await litterWorktreeRoot(p, dir)
  const at = await p.now()
  // The <rules> block awaits the store, so it's selected here, before the check and reservation (15.4).
  let rules: string
  try {
    rules = await rulesBlock(p, dir, e, parentB, root)
  } catch (err) {
    return deny(`swarm ${swarm}'s accepted rules couldn't be selected, so it starts nothing: ${errText(err)}. /litter-rules shows them and their problems`)
  }

  const plan = planSpawn(e, root, at)
  if (typeof plan === 'string') return deny(plan)
  return startPlanned(p, dir, plan, e, next, at, rules)
}

async function startPlanned(p: Ports, litterDir: string, plan: Plan, e: Spawn, next: Next, at: number, rules: string): Promise<SpawnResult> {
  const { s, key } = plan
  const marker = pendingPath(litterDir, key)
  let made: Made | null = null
  /** Releases the place, the marker and a fresh worktree; denies with `reason` (the engine's own deny passes as it is). */
  const undo = async (reason: string, engine = false): Promise<SpawnResult> => {
    state.release(key)
    // A spawn that never started gives its count back (decision 7); one that started keeps it, even unbound.
    state.unnoteSpawned(s.name, key)
    await remove(p, marker).catch(err => p.log(`swarm ${s.name}: the pending marker ${marker} wasn't removed: ${errText(err)}`))
    if (made) await removeFresh(p, litterDir, s, made)
    return engine ? { deny: reason } : deny(reason)
  }

  let cwd = plan.dir
  let branch: string | null = plan.branch === 'pending' ? null : plan.branch
  const token = crypto.randomUUID().replace(/-/g, '')
  const nonce = crypto.randomUUID().replace(/-/g, '')
  let prompt = e.prompt
  try {
    const m: PendingMarker = { v: 1, swarm: s.name, node: plan.node.id, parent: e.parentAgentId ?? null, at: Math.floor(at / 1000) }
    await atomicWriteJson(p, marker, m)

    if (plan.own) {
      const repo = plan.parent!.cwd
      const from = await revParse(p, repo, 'HEAD')
      if (!from) return await undo(`${labelOf(plan.parent!)}'s directory ${repo} has no HEAD to make ${plan.node.id}'s worktree from`)
      const short = swarmOwnBranch(s.name, plan.node.id, plan.n)
      const o = getOptions()
      const r = await addSwarmWorktree(p, litterDir, o, {
        swarm: s.name,
        launch: s.launch,
        node: plan.node.id,
        n: plan.n,
        path: plan.dir,
        branch: short,
        from,
        repo,
        setup: o.setup ? [...o.setup] : null,
        linkDirs: [...o.linkDirs],
      })
      if (!r.ok) return await undo(r.reason)
      made = { path: r.path, branch: short, from: r.from, ignored: r.ignored, repo }
      cwd = r.path
    }

    if (plan.branch === 'pending') {
      branch = await branchIn(p, cwd)
      if (branch === null) return await undo(`${plan.node.id} may commit, but ${cwd} is on a detached HEAD, so it has no branch to commit to`)
    }

    if (plan.kind !== 'child') {
      // The budget line before the instance record, so a run.json it can't read records nothing.
      const budget = await budgetText(p, s)
      const body: SwarmInstanceBody = { node: plan.node.id, n: plan.n, parentAgentId: e.parentAgentId ?? null, tool_use_id: key, cwd, branch, token, nonce }
      await appendLaunchRecord(p, litterDir, s.name, s.launch, 'swarm.instance', body)
      prompt = promptFor(plan, cwd, branch, token, nonce, e.prompt, rules, budget)
    }
  } catch (err) {
    return undo(`${plan.node.id} couldn't be prepared: ${errText(err)}`)
  }

  // Judged again with nothing awaited before next(e): a stop or an End during the steps above refuses it here.
  const late = lateRefusal(plan)
  if (late) return undo(late)

  let r: SpawnResult
  try {
    const model = plan.kind !== 'child' && plan.node.model ? { model: plan.node.model } : {}
    r = await next({ ...e, cwd, background: true, ...model, prompt })
  } catch (err) {
    return undo(`the spawn failed: ${errText(err)}`)
  }
  if (r.deny !== undefined) return undo(r.deny, true)
  const agentId = r.agentId
  if (agentId === undefined) return undo('the engine started no agent')

  // Started: its place is its own now, before anything else awaits.
  state.promote(key, agentId)
  const b: NodeBinding = {
    agentId,
    swarm: s.name,
    launch: s.launch,
    node: plan.node.id,
    n: plan.n,
    kind: plan.kind,
    of: plan.of?.agentId ?? null,
    parent: e.parentAgentId ?? null,
    type: plan.of ? plan.of.type : (s.types[plan.node.id] ?? e.subagentType),
    cwd,
    branch,
    token: plan.kind === 'child' ? null : token,
    revision: s.revision,
    generation: s.owner.generation,
    boundAt: at,
    adopted: false,
  }
  state.putBinding(b)
  // Its parent stopped while next(e) ran: that stop couldn't name it, so it's stopped with its parent.
  const parentStop = b.parent === null ? undefined : state.stopped(s.name).find(x => x.agentId === b.parent)
  if (parentStop && !state.isStopped(agentId)) state.stop(s.name, [agentId], parentStop.reason)
  try {
    // The binding, then the policy file, then the record: a concurrent spawn's ledger append can't hold up
    // the file the guard waits on (15.4, "The guard closes the race"); both still land before the hook returns.
    // The write takes `stopped` from the stopped list under the file's key (guard.ts).
    await writeNodePolicy(p, litterDir, agentId, nodePolicyFor(b, s, { admitted: true, stopped: null, bind: false }))
    const body: SwarmNodeBody = {
      node: b.node,
      n: b.n,
      agentId,
      parentAgentId: b.parent,
      kind: b.kind,
      ...(b.of !== null ? { of: b.of } : {}),
      cwd,
      branch,
      model: plan.kind !== 'child' ? (plan.node.model ?? null) : null,
      revision: b.revision,
      generation: b.generation,
    }
    await appendLaunchRecord(p, litterDir, s.name, s.launch, 'swarm.node', body)
  } catch (err) {
    // Started but unbound: the guard would hold it to nothing, so it's stopped, and a policy already written admits
    // nothing more. Its worktree stays for the cleanup.
    state.dropBinding(agentId)
    await patchNodePolicy(p, litterDir, agentId, { admitted: false }).catch(() => {})
    await remove(p, marker).catch(() => {})
    await p.callTool('TaskStop', { task_id: agentId }).catch(x => p.log(`swarm ${s.name}: ${agentId} wasn't stopped: ${errText(x)}`))
    return deny(`${plan.node.id} started as ${agentId} but couldn't be bound (${errText(err)}), so litter stopped it`)
  }
  await remove(p, marker).catch(err => p.log(`swarm ${s.name}: the pending marker ${marker} wasn't removed: ${errText(err)}`))
  return r
}
