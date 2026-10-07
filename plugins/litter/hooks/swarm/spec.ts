// WP-J: what a spec is and when it's valid (plan 15.3): the schema, every
// 15.3 rule, and the tree's shape (15.7: depth, peak, and each writing
// template's instances).
//
// The schema runs first and keeps what it can read, so the rules run on the
// rest and every error comes back at once, the schema's first. Git runs only
// with argv built here, and a spec's refs and paths reach it only after the
// patterns, after `--end-of-options` where git takes one (15.8, "Specs are
// data").
//
// Owner: phase 2b-1, package J. The stub's four exports are the contract; the
// rest are J's helpers, exported for the store, propose, templates and the doctor.

import type { Ports } from '../ports'
import type { Authority, InstancePlan, PlannedDir, SpecCheck, SpecError, SwarmNode, SwarmSpec, TreeShape, ValidateCtx, WorktreeSpec } from './types'
import { NODE_ID, RUN_ID, SWARM_NAME, runDir as runDirOf, swarmNewWorktreeName, swarmOwnBranch, swarmOwnWorktreeName } from '../layout'
import { BRANCH, git, listWorktrees, litterWorktreeRoot, OID, realOf, revParse } from '../worktrees'
import { repoOf } from '../lifecycle'
import { readPolicy } from '../policy'
import { readLedger } from '../ledgercore'

/** A brief becomes part of a registered type's prompt (15.3): at most this many UTF-8 bytes. */
export const BRIEF_MAX_BYTES = 16 * 1024
/** The goal goes into every node's type prompt; a task is an orchestrator's first prompt. */
const GOAL_MAX_BYTES = 4 * 1024
const TASK_MAX_BYTES = 16 * 1024
/** A model, a tool name, a deny prefix, a ref, a `paths` entry. */
const NAME_MAX = 200
const PATH_MAX = 4096

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
/** The engine's permission modes (d.ts, PermissionMode). */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'] as const
export const REPORT_EVENTS = ['ready-to-push', 'belongs-elsewhere', 'blocked', 'done'] as const
export const PUSH_VALUES = ['none', 'own-branch', 'any'] as const
const AUTHORITY_FIELDS = ['commit', 'push', 'forcePush', 'rewriteHistory', 'worktreeOps', 'verify', 'land'] as const
/** 2b-2's grants (15.10): unset is not given, where the fields before them are unchecked when unset. */
const GRANT_FIELDS = ['verify', 'land'] as const
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const

/** The engine's defaults (15.7): depth 3 or a server-side value, 20 at once, and the lead's own agents beside the swarm. */
export const DEFAULT_SPAWN_DEPTH = 3
export const DEFAULT_CONCURRENT_SUBAGENTS = 20
export const LEAD_AGENTS = 4

const SPEC_KEYS = ['name', 'goal', 'nodes', 'limits'] as const
const NODE_KEYS = [
  'id', 'kind', 'brief', 'task', 'model', 'effort', 'tools', 'maxTurns', 'permissionMode', 'spawns',
  'spawnOther', 'serial', 'worktree', 'paths', 'authority', 'bash', 'report', 'verdicts',
] as const

type Raw = Record<string, unknown>
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const bytes = (s: string): number => new TextEncoder().encode(s).length
const oneLine = (s: string): boolean => !/[\0\r\n]/.test(s)
const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1
const kib = (n: number): string => `${(n / 1024).toFixed(1)} KiB`
const quoted = (xs: readonly string[]): string => xs.map(x => `'${x}'`).join(', ')

/** A limit as the engine reads it (`M.int({ min: 1, digitsOnly: true })`): trimmed digits, at least 1; anything else counts as unset. */
export function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const t = raw.trim()
  if (!/^[+-]?\d+$/.test(t)) return null
  const n = Number(t)
  return Number.isSafeInteger(n) && n >= 1 ? n : null
}

/** A node that may write (WP-J): its `tools.deny` doesn't cover Edit, Write and NotebookEdit together, or it may commit. */
export function isWritingNode(node: Pick<SwarmNode, 'tools' | 'authority'>): boolean {
  if (node.authority?.commit === true) return true
  const deny = node.tools?.deny ?? []
  return !WRITE_TOOLS.every(t => deny.includes(t))
}

/** `<base>/<rel>` with `.` and `..` folded; an absolute `rel` is taken as it is. */
export function joinPath(base: string, rel: string): string {
  const parts = rel.startsWith('/') ? [] : base.split('/').filter(Boolean)
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`)

// ---------------------------------------------------------------------------
// The schema

type Push = (field: string, error: string) => void

/** A list of non-empty single-line strings; bad entries are reported and dropped. */
function stringList(v: unknown, field: string, err: Push, what: string): string[] | undefined {
  if (!Array.isArray(v)) {
    err(field, `${field.split('.').pop()} must be a list of ${what}`)
    return undefined
  }
  const out: string[] = []
  v.forEach((x, j) => {
    if (typeof x === 'string' && x.trim() !== '' && oneLine(x) && x.length <= NAME_MAX) out.push(x)
    else err(`${field}[${j}]`, `each entry must be ${what}: a non-empty single line of at most ${NAME_MAX} characters`)
  })
  return out
}

function unknownKeys(o: Raw, known: readonly string[], at: (k: string) => string, err: Push, what: string): void {
  for (const k of Object.keys(o)) {
    if (!known.includes(k)) err(at(k), `unknown field '${k}'; ${what} has ${quoted(known)}`)
  }
}

function parseWorktree(v: unknown, err: Push): WorktreeSpec | undefined {
  if (v === 'inherit' || v === 'own' || v === 'none') return v
  if (isObj(v) && Object.keys(v).length === 1 && 'existing' in v) {
    const path = v.existing
    if (typeof path === 'string' && path.trim() !== '' && oneLine(path) && path.length <= PATH_MAX) return { existing: path }
    err('worktree.existing', 'existing must be the path of a worktree of this repository: absolute, or relative to the main checkout')
    return undefined
  }
  if (isObj(v) && Object.keys(v).length === 1 && 'new' in v) {
    const n = v.new
    if (!isObj(n)) {
      err('worktree.new', 'new must be { from: <commit or ref>, branch: <new branch name> }')
      return undefined
    }
    unknownKeys(n, ['from', 'branch'], k => `worktree.new.${k}`, err, 'a new worktree')
    const ok = (x: unknown): x is string => typeof x === 'string' && x.trim() !== '' && oneLine(x) && x.length <= NAME_MAX
    if (!ok(n.from)) err('worktree.new.from', 'from is required: the commit or ref the new worktree starts at')
    if (!ok(n.branch)) err('worktree.new.branch', 'branch is required: the branch the new worktree is made on')
    return ok(n.from) && ok(n.branch) ? { new: { from: n.from, branch: n.branch } } : undefined
  }
  err('worktree', "worktree must be 'inherit', 'own', 'none', { existing: <path> } or { new: { from: <ref>, branch: <name> } }")
  return undefined
}

function parseAuthority(v: unknown, err: Push): Authority | undefined {
  if (!isObj(v)) {
    err('authority', 'authority must be an object of commit, push, forcePush, rewriteHistory, worktreeOps, verify and land')
    return undefined
  }
  unknownKeys(v, AUTHORITY_FIELDS, k => `authority.${k}`, err, 'authority')
  const out: Authority = {}
  for (const f of ['commit', 'forcePush', 'rewriteHistory', 'worktreeOps'] as const) {
    if (v[f] === undefined) continue
    if (typeof v[f] === 'boolean') out[f] = v[f]
    else err(`authority.${f}`, `${f} must be true or false, or left unset (not checked by litter)`)
  }
  for (const f of GRANT_FIELDS) {
    if (v[f] === undefined) continue
    if (typeof v[f] === 'boolean') out[f] = v[f]
    else err(`authority.${f}`, `${f} must be true or false, or left unset (not given)`)
  }
  if (v.push !== undefined) {
    if ((PUSH_VALUES as readonly unknown[]).includes(v.push)) out.push = v.push as Authority['push']
    else err('authority.push', `push must be one of ${quoted(PUSH_VALUES)}, or left unset (not checked by litter)`)
  }
  return out
}

/** One node, as far as it reads: null when its id or kind doesn't (the rules can't place it). */
function parseNode(raw: unknown, i: number, seen: Set<string>, errors: SpecError[]): SwarmNode | null {
  if (!isObj(raw)) {
    errors.push({ field: `nodes[${i}]`, error: 'each node must be an object with an id and a kind' })
    return null
  }
  const id = raw.id
  const idOk = typeof id === 'string' && NODE_ID.test(id)
  const dup = idOk && seen.has(id)
  const base = idOk && !dup ? `nodes.${id}` : `nodes[${i}]`
  const err: Push = (field, error) => errors.push({ field: field ? `${base}.${field}` : base, ...(idOk ? { node: id } : {}), error })

  if (!idOk) {
    err(
      'id',
      typeof id === 'string'
        ? `'${id}' isn't a node id: lowercase letters, digits and dashes, starting with a letter or digit, at most 32 characters`
        : 'id is required: lowercase letters, digits and dashes, at most 32 characters',
    )
  } else if (dup) err('id', `the id '${id}' is used twice; each node's id is its own`)
  else seen.add(id)

  const kind = raw.kind
  const kindOk = kind === 'orchestrator' || kind === 'worker'
  if (!kindOk) err('kind', "kind is required: 'orchestrator' (the lead spawns it) or 'worker' (a node that lists it in spawns does)")
  unknownKeys(raw, NODE_KEYS, k => k, err, 'a node')
  if (!idOk || dup || !kindOk) return null

  const node: SwarmNode = { id, kind }
  if (raw.brief !== undefined) {
    if (raw.brief === `briefs/${id}.md`) node.brief = raw.brief
    else err('brief', `brief must be 'briefs/${id}.md', the node's own brief file, or left unset`)
  }
  if (raw.task !== undefined) {
    if (typeof raw.task === 'string' && raw.task.trim() !== '' && bytes(raw.task) <= TASK_MAX_BYTES) node.task = raw.task
    else err('task', `task must be the orchestrator's first task as text, at most ${TASK_MAX_BYTES / 1024} KiB`)
  }
  if (raw.model !== undefined) {
    if (typeof raw.model === 'string' && raw.model.trim() !== '' && oneLine(raw.model) && raw.model.length <= NAME_MAX) node.model = raw.model
    else err('model', "model must be a model alias or id on one line, or left unset (the parent's applies)")
  }
  if (raw.effort !== undefined) {
    if ((EFFORTS as readonly unknown[]).includes(raw.effort)) node.effort = raw.effort as SwarmNode['effort']
    else err('effort', `effort must be one of ${quoted(EFFORTS)}, or left unset (the session's applies)`)
  }
  if (raw.tools !== undefined) {
    if (!isObj(raw.tools)) err('tools', 'tools must be { allow?: [tool names], deny?: [tool names] }')
    else {
      unknownKeys(raw.tools, ['allow', 'deny'], k => `tools.${k}`, err, 'tools')
      const tools: NonNullable<SwarmNode['tools']> = {}
      if (raw.tools.allow !== undefined) {
        const allow = stringList(raw.tools.allow, 'tools.allow', err, 'tool names')
        if (allow) tools.allow = allow
      }
      if (raw.tools.deny !== undefined) {
        const deny = stringList(raw.tools.deny, 'tools.deny', err, 'tool names')
        if (deny) tools.deny = deny
      }
      node.tools = tools
    }
  }
  if (raw.maxTurns !== undefined) {
    if (posInt(raw.maxTurns)) node.maxTurns = raw.maxTurns
    else err('maxTurns', "maxTurns must be a whole number, at least 1, or left unset (the engine's default)")
  }
  if (raw.permissionMode !== undefined) {
    if ((PERMISSION_MODES as readonly unknown[]).includes(raw.permissionMode)) node.permissionMode = raw.permissionMode as string
    else err('permissionMode', `permissionMode must be one of ${quoted(PERMISSION_MODES)}, or left unset (the parent's applies)`)
  }
  if (raw.spawns !== undefined) {
    if (!isObj(raw.spawns)) err('spawns', 'spawns must map worker ids to how many may run at once under one instance of this node')
    else {
      const spawns: Record<string, number> = {}
      for (const [k, v] of Object.entries(raw.spawns)) {
        if (!NODE_ID.test(k)) err(`spawns.${k}`, `'${k}' isn't a node id`)
        else if (!posInt(v)) err(`spawns.${k}`, `how many ${k} may run at once under one instance of ${id}: a whole number, at least 1`)
        else spawns[k] = v
      }
      node.spawns = spawns
    }
  }
  for (const f of ['spawnOther', 'serial', 'verdicts'] as const) {
    if (raw[f] === undefined) continue
    if (typeof raw[f] === 'boolean') node[f] = raw[f]
    else err(f, `${f} must be true or false, or left unset`)
  }
  if (raw.worktree !== undefined) {
    const wt = parseWorktree(raw.worktree, err)
    if (wt !== undefined) node.worktree = wt
  }
  if (raw.paths !== undefined) {
    const paths = stringList(raw.paths, 'paths', err, 'paths relative to the node\'s directory')
    if (paths) node.paths = paths
  }
  if (raw.authority !== undefined) {
    const a = parseAuthority(raw.authority, err)
    if (a) node.authority = a
  }
  if (raw.bash !== undefined) {
    if (!isObj(raw.bash)) err('bash', 'bash must be { deny: [command prefixes] }')
    else {
      unknownKeys(raw.bash, ['deny'], k => `bash.${k}`, err, 'bash')
      if (raw.bash.deny !== undefined) {
        const deny = stringList(raw.bash.deny, 'bash.deny', err, 'command prefixes')
        if (deny) node.bash = { deny }
      } else node.bash = {}
    }
  }
  if (raw.report !== undefined) {
    if (!Array.isArray(raw.report)) err('report', `report must be a list of ${quoted(REPORT_EVENTS)}`)
    else {
      const report: SwarmNode['report'] = []
      raw.report.forEach((x, j) => {
        if ((REPORT_EVENTS as readonly unknown[]).includes(x)) report.push(x as NonNullable<SwarmNode['report']>[number])
        else err(`report[${j}]`, `each entry must be one of ${quoted(REPORT_EVENTS)}`)
      })
      node.report = report
    }
  }
  return node
}

/**
 * The schema over a spec, and what of it reads: the nodes whose id and kind
 * read, each with the fields that do. Null when it isn't an object with a
 * list of nodes.
 */
export function parseSpec(raw: unknown): { spec: SwarmSpec | null; errors: SpecError[] } {
  const errors: SpecError[] = []
  if (!isObj(raw)) return { spec: null, errors: [{ field: 'spec', error: 'the spec must be a JSON object with name, goal and nodes' }] }
  const err: Push = (field, error) => errors.push({ field, error })
  unknownKeys(raw, SPEC_KEYS, k => k, err, 'a spec')
  const name = typeof raw.name === 'string' ? raw.name : ''
  if (!SWARM_NAME.test(name)) {
    err(
      'name',
      typeof raw.name === 'string'
        ? `'${raw.name}' isn't a swarm name: lowercase letters, digits and dashes, starting with a letter or digit, at most 24 characters`
        : 'name is required: lowercase letters, digits and dashes, at most 24 characters',
    )
  }
  const goal = typeof raw.goal === 'string' ? raw.goal : ''
  if (typeof raw.goal !== 'string') err('goal', 'goal is required: one or two sentences on what the swarm is for')
  else if (bytes(goal) > GOAL_MAX_BYTES) err('goal', `the goal is ${kib(bytes(goal))}; at most ${GOAL_MAX_BYTES / 1024} KiB, since every node's prompt carries it`)
  const spec: SwarmSpec = { name, goal, nodes: [] }
  if (raw.limits !== undefined) {
    if (!isObj(raw.limits)) err('limits', 'limits must be { maxAgentsAtOnce?: <number> }')
    else {
      unknownKeys(raw.limits, ['maxAgentsAtOnce'], k => `limits.${k}`, err, 'limits')
      const m = raw.limits.maxAgentsAtOnce
      if (m !== undefined && !posInt(m)) err('limits.maxAgentsAtOnce', 'maxAgentsAtOnce must be a whole number, at least 1, or left unset')
      spec.limits = posInt(m) ? { maxAgentsAtOnce: m } : {}
    }
  }
  if (!Array.isArray(raw.nodes)) {
    err('nodes', 'nodes is required: the list of orchestrators and workers')
    return { spec: null, errors }
  }
  const seen = new Set<string>()
  raw.nodes.forEach((n, i) => {
    const node = parseNode(n, i, seen, errors)
    if (node) spec.nodes.push(node)
  })
  return { spec, errors }
}

/** The schema alone: types, required fields, known keys only, the patterns and the value sets. */
export function specSchemaErrors(spec: unknown): SpecError[] {
  return parseSpec(spec).errors
}

// ---------------------------------------------------------------------------
// The tree

type Graph = {
  byId: Map<string, SwarmNode>
  /** Each node's parents by edges that close no cycle: [parent, count]. Reachable parents only. */
  parents: Map<string, [string, number][]>
  /** Every node that lists it in spawns, whether or not it's reachable. */
  listedBy: Map<string, string[]>
  /** Reachable from the lead: the orchestrators, and every worker they spawn, directly or through workers. */
  reach: Set<string>
  /** Each cycle as found: the path, ending with the node it closes on. */
  cycles: string[][]
  depthOf(id: string): number
  instancesOf(id: string): number
}

/** The tree over whatever the spec holds: unknown names, orchestrators in `spawns` and cycles are skipped, for the rules to report. */
function graphOf(spec: SwarmSpec): Graph {
  const byId = new Map<string, SwarmNode>()
  for (const n of Array.isArray(spec.nodes) ? spec.nodes : []) {
    if (isObj(n) && typeof n.id === 'string' && !byId.has(n.id)) byId.set(n.id, n)
  }
  const children = (id: string): [string, number][] =>
    Object.entries(isObj(byId.get(id)?.spawns) ? byId.get(id)!.spawns! : {}).filter(
      (e): e is [string, number] => byId.get(e[0])?.kind === 'worker' && posInt(e[1]),
    )
  const listedBy = new Map<string, string[]>()
  for (const id of byId.keys()) {
    for (const [c] of children(id)) listedBy.set(c, [...(listedBy.get(c) ?? []), id])
  }

  const parents = new Map<string, [string, number][]>()
  const reach = new Set<string>()
  const cycles: string[][] = []
  const color = new Map<string, 1 | 2>()
  const stack: string[] = []
  const visit = (u: string, reached: boolean): void => {
    color.set(u, 1)
    stack.push(u)
    if (reached) reach.add(u)
    for (const [v, k] of children(u)) {
      const c = color.get(v)
      if (c === 1) {
        cycles.push([...stack.slice(stack.indexOf(v)), v])
        continue
      }
      if (reached) parents.set(v, [...(parents.get(v) ?? []), [u, k]])
      if (c === undefined) visit(v, reached)
    }
    stack.pop()
    color.set(u, 2)
  }
  for (const [id, n] of byId) if (n.kind === 'orchestrator') visit(id, true)
  // The rest only for their cycles: nothing reaches them.
  for (const id of byId.keys()) if (!color.has(id)) visit(id, false)

  const depth = new Map<string, number>()
  const depthOf = (id: string): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    const d = byId.get(id)?.kind === 'orchestrator' ? 1 : Math.max(0, ...(parents.get(id) ?? []).map(([p]) => depthOf(p) + 1))
    depth.set(id, d)
    return d
  }
  const count = new Map<string, number>()
  const instancesOf = (id: string): number => {
    const known = count.get(id)
    if (known !== undefined) return known
    const n = byId.get(id)?.kind === 'orchestrator' ? 1 : (parents.get(id) ?? []).reduce((sum, [p, k]) => sum + instancesOf(p) * k, 0)
    const capped = Math.min(n, 1e9)
    count.set(id, capped)
    return capped
  }
  return { byId, parents, listedBy, reach, cycles, depthOf, instancesOf }
}

/** Each node's depth (the lead is 0), and the peak (15.7). */
export function treeShape(spec: SwarmSpec): TreeShape {
  const g = graphOf(spec)
  const depth: Record<string, number> = {}
  let maxDepth = 0
  let uncapped = 0
  for (const id of g.byId.keys()) {
    if (!g.reach.has(id)) continue
    const d = g.depthOf(id)
    depth[id] = d
    maxDepth = Math.max(maxDepth, d)
    uncapped += g.instancesOf(id)
  }
  const cap = isObj(spec.limits) ? spec.limits.maxAgentsAtOnce : undefined
  return { depth, maxDepth, peak: posInt(cap) ? Math.min(uncapped, cap) : uncapped, uncapped }
}

/** Where an instance works, before anything is resolved. */
type Dir =
  | { t: 'session' }
  | { t: 'existing'; node: string; path: string }
  | { t: 'new'; node: string }
  /** `of`'s own worktree: one per instance of `of`, inherited by what it spawns. */
  | { t: 'own'; of: string }

/**
 * One way a node's instances share a directory: under `parent`, `count`
 * instances in each directory of this class, `total` across them all (the
 * two differ only for an `own` node's own worktrees, one per instance).
 */
type DirClass = { parent: string | null; dir: Dir; count: number; total: number }

const dirKey = (d: Dir): string =>
  d.t === 'session' ? 'session' : d.t === 'existing' ? `x:${d.node}:${d.path}` : d.t === 'new' ? `n:${d.node}` : `o:${d.of}`

/** A node's own directory, or null when it inherits its parent's. */
function ownDir(n: SwarmNode): Dir | null {
  const wt = n.worktree ?? 'inherit'
  if (wt === 'inherit') return n.kind === 'orchestrator' ? { t: 'session' } : null
  if (wt === 'none') return { t: 'session' }
  if (wt === 'own') return { t: 'own', of: n.id }
  if ('existing' in wt) return { t: 'existing', node: n.id, path: wt.existing }
  return { t: 'new', node: n.id }
}

/** Each node's directory classes, merged per parent and directory so a diamond doesn't multiply them. */
function dirClasses(g: Graph): (id: string) => DirClass[] {
  const memo = new Map<string, DirClass[]>()
  const classes = (id: string): DirClass[] => {
    const known = memo.get(id)
    if (known) return known
    const n = g.byId.get(id)
    const out: DirClass[] = []
    const add = (c: DirClass): void => {
      const same = out.find(o => o.parent === c.parent && dirKey(o.dir) === dirKey(c.dir))
      if (same) {
        same.count += c.count
        same.total += c.total
      } else out.push({ ...c })
    }
    if (n?.kind === 'orchestrator') add({ parent: null, dir: ownDir(n) ?? { t: 'session' }, count: 1, total: 1 })
    else if (n) {
      const own = ownDir(n)
      for (const [p, k] of g.parents.get(id) ?? []) {
        const at = g.instancesOf(p) * k
        if (own?.t === 'own') add({ parent: p, dir: own, count: 1, total: at })
        else if (own) add({ parent: p, dir: own, count: at, total: at })
        else for (const c of classes(p)) add({ parent: p, dir: c.dir, count: c.count * k, total: c.total * k })
      }
    }
    memo.set(id, out)
    return out
  }
  return classes
}

function plannedDir(swarm: string, node: string, d: Dir): PlannedDir {
  if (d.t === 'session') return { kind: 'session' }
  if (d.t === 'existing') return { kind: 'worktree', path: d.path, node: d.node }
  if (d.t === 'new') return { kind: 'worktree', path: swarmNewWorktreeName(swarm, d.node), node: d.node }
  if (d.of === node) return { kind: 'own' }
  // Inherited from an `own` node: that node's worktree, one per instance.
  return { kind: 'worktree', path: `${swarmNewWorktreeName(swarm, d.of)}-<n>`, node: d.of }
}

/**
 * Each writing template expanded per parent, with the directory each instance
 * would get. An `existing` path is as the spec wrote it and a `new` one is its
 * folder name under the worktree root: validateSpec resolves both. A node
 * that inherits an `own` node's worktree gets `sw-<swarm>-<node>-<n>`, and
 * its `count` is per instance of that node.
 */
export function instancesOf(spec: SwarmSpec): InstancePlan[] {
  const g = graphOf(spec)
  const classes = dirClasses(g)
  const out: InstancePlan[] = []
  for (const [id, n] of g.byId) {
    if (!g.reach.has(id) || !isWritingNode(n)) continue
    for (const c of classes(id)) {
      const selfOwn = c.dir.t === 'own' && c.dir.of === id
      out.push({
        node: id,
        parent: c.parent,
        count: selfOwn ? c.total : c.count,
        dir: plannedDir(spec.name, id, c.dir),
        commits: n.authority?.commit === true,
        serial: n.serial === true,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Resolving directories against the repository

type ListedReal = { path: string; real: string; branch: string | null }

/** What the rules and the doctor need from git and the file system, each asked once. */
export class SpecPlaces {
  private list?: Promise<ListedReal[] | null>
  private rootDir?: Promise<string>
  private top?: Promise<string | null>
  // Fields, not parameter properties: node strips this file's types, and
  // can't rewrite those.
  private readonly p: Ports
  readonly repo: string
  readonly litterDir: string
  constructor(p: Ports, repo: string, litterDir: string) {
    this.p = p
    this.repo = repo
    this.litterDir = litterDir
  }

  /** `git worktree list`, each path resolved; null when git can't list them. */
  worktrees(): Promise<ListedReal[] | null> {
    this.list ??= (async () => {
      const listed = await listWorktrees(this.p, this.repo)
      if (!listed) return null
      return Promise.all(listed.map(async w => ({ path: w.path, real: await realOf(this.p, w.path), branch: w.branch })))
    })()
    return this.list
  }

  /** Where `new` and `own` worktrees go (worktrees.ts's litterWorktreeRoot). */
  root(): Promise<string> {
    this.rootDir ??= litterWorktreeRoot(this.p, this.litterDir)
    return this.rootDir
  }

  /** The session's checkout, resolved: `none` nodes and orchestrators that inherit work there. Null outside git. */
  sessionTop(): Promise<string | null> {
    this.top ??= (async () => {
      const r = await this.p.run(['git', 'rev-parse', '--show-toplevel'], { cwd: await this.p.cwd() })
      return r.code === 0 && r.stdout.trim() !== '' ? realOf(this.p, r.stdout.trim()) : null
    })().catch(() => null)
    return this.top
  }

  /** An `existing` path: absolute, or relative to the repository's main checkout, resolved through links. */
  async existing(path: string): Promise<{ abs: string; real: string }> {
    const abs = joinPath(this.repo, path)
    return { abs, real: await realOf(this.p, abs) }
  }

  /** A `new` node's worktree, `<root>/sw-<swarm>-<node>`. */
  async newPath(swarm: string, node: string): Promise<string> {
    return `${await this.root()}/${swarmNewWorktreeName(swarm, node)}`
  }
}

/**
 * A directory class's key once resolved, so two spellings of one directory
 * meet. The session's checkout is resolved only when an `existing` path
 * could name it (`withTop`).
 */
async function resolvedKey(places: SpecPlaces, swarm: string, d: Dir, withTop: boolean): Promise<string> {
  if (d.t === 'own') return `o:${d.of}`
  if (d.t === 'session') {
    const top = withTop ? await places.sessionTop() : null
    return top ? `d:${top}` : 'session'
  }
  if (d.t === 'existing') return `d:${(await places.existing(d.path)).real}`
  return `d:${await places.newPath(swarm, d.node)}`
}

function describeDir(swarm: string, d: Dir): string {
  if (d.t === 'session') return "the session's directory"
  if (d.t === 'existing') return d.path
  if (d.t === 'new') return `the new worktree ${swarmNewWorktreeName(swarm, d.node)}`
  return `${d.of}'s own worktree`
}

/**
 * Every directory a node of the spec could work in, resolved: the session's
 * checkout (`null` when it isn't in git), an `existing` or `new` worktree's
 * path, or an `own` node's `<root>/sw-<swarm>-<node>-<n>`. For the doctor's
 * session-in-a-worktree check (15.4, Launch step 1).
 */
export async function nodeDirectories(p: Ports, spec: SwarmSpec, places: SpecPlaces): Promise<{ node: string; dir: string | null; what: string }[]> {
  const g = graphOf(spec)
  const classes = dirClasses(g)
  const out: { node: string; dir: string | null; what: string }[] = []
  for (const id of g.byId.keys()) {
    if (!g.reach.has(id)) continue
    for (const c of classes(id)) {
      const d = c.dir
      const dir =
        d.t === 'session'
          ? await places.sessionTop()
          : d.t === 'existing'
            ? (await places.existing(d.path)).real
            : d.t === 'new'
              ? await places.newPath(spec.name, d.node)
              : `${await places.root()}/${swarmNewWorktreeName(spec.name, d.of)}-<n>`
      if (!out.some(o => o.node === id && o.dir === dir)) out.push({ node: id, dir, what: describeDir(spec.name, d) })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// The rules

const BOOL_RANK = (v: boolean | undefined): number => (v === undefined ? 2 : v ? 1 : 0)
const PUSH_RANK = (v: Authority['push']): number => (v === undefined ? 3 : PUSH_VALUES.indexOf(v))
const isGrant = (f: (typeof AUTHORITY_FIELDS)[number]): f is (typeof GRANT_FIELDS)[number] => (GRANT_FIELDS as readonly string[]).includes(f)
/** A grant (verify, land) counts only when true: unset is the same as false. */
const rankOf = (a: Authority | undefined, f: (typeof AUTHORITY_FIELDS)[number]): number =>
  f === 'push' ? PUSH_RANK(a?.push) : isGrant(f) ? (a?.[f] === true ? 1 : 0) : BOOL_RANK(a?.[f])
const shown = (a: Authority | undefined, f: (typeof AUTHORITY_FIELDS)[number]): string =>
  a?.[f] === undefined ? (isGrant(f) ? 'unset (not given)' : 'unset (not checked by litter)') : f === 'push' ? `'${a.push}'` : String(a[f])

/** `paths` entries meet when they're the same, or one is a folder (`dir/`) holding the other. */
function pathsMeet(x: string, y: string): boolean {
  const bx = x.replace(/\/+$/, '')
  const by = y.replace(/\/+$/, '')
  if (bx === by) return true
  return (x.endsWith('/') && by.startsWith(`${bx}/`)) || (y.endsWith('/') && bx.startsWith(`${by}/`))
}

function pathProblem(path: string): string | null {
  if (path.startsWith('/')) return 'is absolute; paths are relative to the node\'s directory'
  const parts = path.replace(/\/$/, '').split('/')
  if (parts.some(s => s === '' || s === '.' || s === '..')) return "has an empty, '.' or '..' part; name the file, or the folder with a trailing '/'"
  return null
}

type Out = { errors: SpecError[]; warnings: SpecError[] }

async function rules(p: Ports, s: SwarmSpec, ctx: ValidateCtx): Promise<Out> {
  // Each section collects its own, so the order below is the report's whatever runs first.
  const section = (): { list: SpecError[]; add: (field: string, node: string | undefined, error: string) => void } => {
    const list: SpecError[] = []
    return { list, add: (field, node, error) => list.push({ field, ...(node !== undefined ? { node } : {}), error }) }
  }
  const tree = section()
  const limits = section()
  const sharing = section()
  const perInstance = section()
  const authority = section()
  const gates = section()
  const existing = section()
  const branches = section()
  const names = section()
  const paths = section()
  const briefs = section()
  const kinds = section()
  const warnings = section()

  const g = graphOf(s)
  const places = new SpecPlaces(p, ctx.repo, ctx.litterDir)

  // The tree: spawns name workers, no cycles, everything reachable, orchestrators only under the lead.
  if (!s.nodes.some(n => n.kind === 'orchestrator')) {
    tree.add('nodes', undefined, 'a swarm needs at least one orchestrator: the lead spawns the orchestrators, and they spawn the workers')
  }
  for (const n of s.nodes) {
    for (const k of Object.keys(n.spawns ?? {})) {
      const t = g.byId.get(k)
      if (!t) tree.add(`nodes.${n.id}.spawns.${k}`, n.id, `no node '${k}' in this spec; spawns names the ids of workers`)
      else if (t.kind === 'orchestrator') {
        tree.add(`nodes.${n.id}.spawns.${k}`, n.id, `'${k}' is an orchestrator, and only the lead spawns orchestrators; make it a worker, or take it out of spawns`)
      }
    }
  }
  for (const c of g.cycles) {
    const [a, b] = [c[c.length - 2]!, c[c.length - 1]!]
    tree.add(`nodes.${a}.spawns.${b}`, a, `a cycle: ${c.join(' → ')}; a worker can't spawn a node above it`)
  }
  for (const n of s.nodes) {
    if (n.kind === 'worker' && !g.reach.has(n.id)) {
      tree.add(`nodes.${n.id}`, n.id, "nothing spawns it: no orchestrator lists it in spawns, directly or through workers, so it never runs; add it to a parent's spawns, or remove it")
    }
  }

  // Depth and peak, graded as 15.7 grades them.
  const shape = treeShape(s)
  const rawDepth = ctx.limits.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH
  const depthLimit = parseLimit(rawDepth) ?? DEFAULT_SPAWN_DEPTH
  const depthWhy = parseLimit(rawDepth) === null ? `${depthLimit}, the default` : String(depthLimit)
  for (const [id, d] of Object.entries(shape.depth)) {
    if (d > depthLimit) {
      limits.add(
        `nodes.${id}`,
        id,
        `it sits at depth ${d}, past CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH (${depthWhy}), so the engine refuses its spawn; raise the limit (/litter doctor shows how), or move it up the tree`,
      )
    }
  }
  const rawConc = ctx.limits.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS
  const concLimit = parseLimit(rawConc) ?? DEFAULT_CONCURRENT_SUBAGENTS
  const need = shape.peak + LEAD_AGENTS
  if (shape.peak > 0 && concLimit < need) {
    warnings.add(
      'limits.maxAgentsAtOnce',
      undefined,
      `up to ${shape.peak} agents at once, plus ${LEAD_AGENTS} for the lead's own, need ${need}, but CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS is ${concLimit}${parseLimit(rawConc) === null ? ' (the default)' : ''}: spawns past it are refused; raise it (/litter doctor shows how), or set limits.maxAgentsAtOnce`,
    )
  }
  const orchestrators = s.nodes.filter(n => n.kind === 'orchestrator').length
  const cap = s.limits?.maxAgentsAtOnce
  if (cap !== undefined && cap < orchestrators) {
    warnings.add('limits.maxAgentsAtOnce', undefined, `${cap} agents at once is fewer than the ${orchestrators} orchestrators the start spawns together; the rest are refused`)
  }

  // Fields that belong to one kind.
  for (const n of s.nodes) {
    if (n.kind === 'worker' && n.task !== undefined) {
      kinds.add(`nodes.${n.id}.task`, n.id, "only an orchestrator has a task; a worker's task is the message its parent spawns it with")
    }
    if (n.kind === 'orchestrator' && n.worktree === 'own') {
      kinds.add(`nodes.${n.id}.worktree`, n.id, "own is for workers; an orchestrator works in an existing or new worktree, the session's directory (none), or inherits it")
    }
    if (n.kind === 'orchestrator' && n.serial !== undefined) {
      kinds.add(`nodes.${n.id}.serial`, n.id, 'serial is for writing workers; an orchestrator runs once at a time already')
    }
    if (n.kind === 'worker' && n.serial === true && !isWritingNode(n)) {
      warnings.add(`nodes.${n.id}.serial`, n.id, "it can't write (tools.deny covers Edit, Write and NotebookEdit, and it doesn't commit), so serial changes nothing")
    }
  }

  // Two writers in one directory, and two instances of one writer (the tenth review).
  const classes = dirClasses(g)
  type Slot = { node: SwarmNode; count: number; selfOwn: boolean; dir: Dir }
  const slots = new Map<string, Slot[]>()
  const withTop = s.nodes.some(n => typeof n.worktree === 'object' && 'existing' in n.worktree)
  for (const n of s.nodes) {
    if (!g.reach.has(n.id) || !isWritingNode(n)) continue
    for (const c of classes(n.id)) {
      const key = await resolvedKey(places, s.name, c.dir, withTop)
      slots.set(key, [...(slots.get(key) ?? []), { node: n, count: c.count, selfOwn: c.dir.t === 'own' && c.dir.of === n.id, dir: c.dir }])
    }
  }
  const pairs = new Set<string>()
  const instanceSeen = new Set<string>()
  for (const list of slots.values()) {
    const ids = [...new Set(list.map(x => x.node.id))]
    for (const id of ids) {
      const mine = list.filter(x => x.node.id === id && !x.selfOwn)
      const total = mine.reduce((sum, x) => sum + x.count, 0)
      const n = mine[0]?.node
      if (n && total >= 2 && n.serial !== true && !instanceSeen.has(id)) {
        instanceSeen.add(id)
        perInstance.add(
          `nodes.${id}.worktree`,
          id,
          `up to ${total} instances of ${id} can run at once in ${describeDir(s.name, mine[0]!.dir)}, editing the same files${n.authority?.commit === true ? ' and sharing its index and branch' : ''}; give it worktree: own, or set serial: true`,
        )
      }
    }
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = g.byId.get(ids[i]!)!
        const b = g.byId.get(ids[j]!)!
        const key = `${a.id}\0${b.id}`
        if (pairs.has(key)) continue
        const where = describeDir(s.name, list.find(x => x.node.id === b.id)!.dir)
        let why: string | null = null
        let field = `nodes.${b.id}.paths`
        if (a.authority?.commit === true || b.authority?.commit === true) {
          const committer = a.authority?.commit === true ? a.id : b.id
          why = `${committer} may commit, so its scope is the whole directory; give ${b.id} a worktree of its own (own, new or existing), or make it read-only (tools.deny Edit, Write and NotebookEdit)`
          field = `nodes.${b.id}.worktree`
        } else if (!a.paths || !b.paths) {
          why = `both can write there; set disjoint paths on both, or give one a worktree of its own`
        } else {
          const hit = a.paths.flatMap(x => b.paths!.filter(y => pathsMeet(x, y)).map(y => [x, y] as const))[0]
          if (hit) why = `its paths meet ${a.id}'s ('${hit[1]}' and '${hit[0]}'); make them disjoint, or give one a worktree of its own`
        }
        if (why) {
          pairs.add(key)
          sharing.add(field, b.id, `it writes in ${where}, as ${a.id} does: ${why}`)
        }
      }
    }
  }

  // A worker never has more authority than a parent that spawns it, field by field (verify and land too: 15.10).
  for (const w of s.nodes) {
    if (w.kind !== 'worker') continue
    for (const pid of g.listedBy.get(w.id) ?? []) {
      const par = g.byId.get(pid)!
      for (const f of AUTHORITY_FIELDS) {
        if (rankOf(w.authority, f) > rankOf(par.authority, f)) {
          const fix = isGrant(f) ? 'leave it unset, or set it to false' : `set it to ${shown(par.authority, f)} or less`
          authority.add(
            `nodes.${w.id}.authority.${f}`,
            w.id,
            `${f} is ${shown(w.authority, f)}, more than its parent ${pid}'s ${shown(par.authority, f)}: a worker never gets more authority than a parent that spawns it; ${fix}`,
          )
        }
      }
    }
  }

  // The critic's veto and the land it guards (15.10, "The guarantees a swarm gets"): a node
  // whose verdicts a land needs writes nothing, so it's never the agent that changed the tree it judges.
  for (const n of s.nodes) {
    if (n.verdicts !== true) continue
    if (n.authority?.commit !== false) {
      gates.add(
        `nodes.${n.id}.authority.commit`,
        n.id,
        `a verdicts: true node writes nothing, but commit is ${shown(n.authority, 'commit')}; set authority.commit to false, or take verdicts off`,
      )
    }
    const deny = n.tools?.deny ?? []
    const open = WRITE_TOOLS.filter(t => !deny.includes(t))
    if (open.length > 0) {
      gates.add(
        `nodes.${n.id}.tools.deny`,
        n.id,
        `a verdicts: true node writes nothing, but tools.deny leaves ${open.join(', ')}; deny Edit, Write and NotebookEdit, or take verdicts off`,
      )
    }
    if (n.authority?.verify !== true) {
      warnings.add(
        `nodes.${n.id}.authority.verify`,
        n.id,
        "a verdict cites a verify its own agent recorded, and this node can't record one, so its verdicts are refused; set authority.verify to true",
      )
    }
  }
  const critics = s.nodes.filter(n => n.verdicts === true && n.authority?.verify === true && g.reach.has(n.id)).map(n => n.id)
  for (const n of s.nodes) {
    if (n.authority?.land !== true || critics.length > 0) continue
    gates.add(
      `nodes.${n.id}.authority.land`,
      n.id,
      'a land needs an approving verdict from a verdicts: true node with authority.verify, and nothing in this tree is one; add such a node to a spawns, or take land off',
    )
  }

  // `existing` worktrees: this repository's, and never the active run's checkout, but for the run's own repair swarm (decision 10).
  const checkout = ctx.activeRunCheckout ? await realOf(p, ctx.activeRunCheckout) : null
  let ownRepair: boolean | null = null
  const runsOwn = async (): Promise<boolean> => (ownRepair ??= await activeRunsRepair(p, ctx.litterDir, ctx.activeRunCheckout, s.name))
  for (const n of s.nodes) {
    const wt = n.worktree
    if (typeof wt !== 'object' || !('existing' in wt)) continue
    const field = `nodes.${n.id}.worktree.existing`
    const { abs, real } = await places.existing(wt.existing)
    const list = await places.worktrees()
    if (!list) existing.add(field, n.id, `git worktree list failed in ${ctx.repo}, so ${wt.existing} can't be checked`)
    else if (!(await p.fs.exists(abs))) existing.add(field, n.id, `${wt.existing} doesn't exist (${abs})`)
    else if (!list.some(w => w.real === real)) {
      existing.add(field, n.id, `${wt.existing} isn't a worktree of this repository: git worktree list doesn't show it; name one it shows, or use { new: { from, branch } }`)
    } else if (checkout !== null && real === checkout && !(await runsOwn())) {
      existing.add(field, n.id, `${wt.existing} is the active litter run's checkout; a node can't work there while the run is active`)
    }
  }

  // Branches: each `new` branch and every name an `own` worker's branch gets, and each `from`.
  const newBranches = new Map<string, string>()
  for (const n of s.nodes) {
    const wt = n.worktree
    if (wt === 'own') {
      const own = swarmOwnBranch(s.name, n.id, 1)
      const r = await git(p, ctx.repo, ['check-ref-format', '--branch', own])
      if (r.code !== 0 || r.stdout.trim() !== own) branches.add(`nodes.${n.id}.worktree`, n.id, `git won't take '${own}' as a branch name for its instances`)
      continue
    }
    if (typeof wt !== 'object' || !('new' in wt)) continue
    const { from, branch } = wt.new
    const field = `nodes.${n.id}.worktree.new`
    let branchOk = false
    if (!BRANCH.test(branch)) {
      branches.add(`${field}.branch`, n.id, `'${branch}' isn't a branch name litter makes: letters, digits, '.', '_', '/' and '-', with no '..', '//', '@{', leading '-', trailing '/' or '.lock'`)
    } else {
      const r = await git(p, ctx.repo, ['check-ref-format', '--branch', branch])
      if (r.code !== 0 || r.stdout.trim() !== branch) branches.add(`${field}.branch`, n.id, `git won't take '${branch}' as a branch name`)
      else branchOk = true
    }
    let oid: string | null = null
    if (from.startsWith('-') || /[\0-\x1f]/.test(from)) branches.add(`${field}.from`, n.id, `'${from}' isn't a commit or a ref`)
    else {
      const r = await git(p, ctx.repo, ['rev-parse', '--verify', '--end-of-options', `${from}^{commit}`])
      oid = r.code === 0 && OID.test(r.stdout.trim()) ? r.stdout.trim() : null
      if (!oid) branches.add(`${field}.from`, n.id, `'${from}' doesn't name a commit in this repository`)
    }
    if (branchOk && oid) {
      // Launch makes it with `git worktree add`: an existing branch must be at `from`, and checked out nowhere else.
      const tip = await revParse(p, ctx.repo, `refs/heads/${branch}`)
      if (tip && tip !== oid) {
        branches.add(`${field}.branch`, n.id, `'${branch}' already exists at ${tip.slice(0, 12)}, not at ${from} (${oid.slice(0, 12)}); pick a new branch name, or set from to '${branch}'`)
      } else if (tip) {
        const target = await places.newPath(s.name, n.id)
        const at = (await places.worktrees())?.find(w => w.branch === `refs/heads/${branch}`)
        if (at && at.real !== target) {
          branches.add(`${field}.branch`, n.id, `'${branch}' is checked out at ${at.path}; use { existing: '${at.path}' } for it, or pick a new branch`)
        }
      }
    }
  }

  // No two worktree or branch names can meet (layout.ts's names).
  const own = s.nodes.filter(n => n.worktree === 'own').map(n => n.id)
  for (const n of s.nodes) {
    for (const o of own) {
      const m = n.id !== o && n.id.startsWith(`${o}-`) ? /^[0-9]+$/.exec(n.id.slice(o.length + 1)) : null
      if (m) {
        names.add(`nodes.${n.id}.id`, n.id, `'${n.id}' reads as instance ${m[0]} of the own worker ${o}, whose worktree would be ${swarmOwnWorktreeName(s.name, o, Number(m[0]))}; rename it`)
      }
    }
    const wt = n.worktree
    if (typeof wt === 'object' && 'new' in wt) {
      const b = wt.new.branch
      if (b.startsWith('sw/')) names.add(`nodes.${n.id}.worktree.new.branch`, n.id, `branches under sw/ are litter's own, for own workers; pick another name`)
      const first = newBranches.get(b)
      if (first !== undefined) names.add(`nodes.${n.id}.worktree.new.branch`, n.id, `'${b}' is also ${first}'s new branch; each new worktree gets a branch of its own`)
      else newBranches.set(b, n.id)
    }
  }

  // `paths`: relative to the node's directory, with no empty, `.` or `..` part.
  for (const n of s.nodes) {
    ;(n.paths ?? []).forEach((path, j) => {
      const bad = pathProblem(path)
      if (bad) paths.add(`nodes.${n.id}.paths[${j}]`, n.id, `'${path}' ${bad}`)
    })
  }

  // Every brief exists, at most 16 KiB: it becomes part of the node's type prompt.
  for (const n of s.nodes) {
    if (n.brief === undefined) continue
    let text: string | null
    try {
      text = await ctx.briefText(n.id)
    } catch (err) {
      briefs.add(`nodes.${n.id}.brief`, n.id, `its brief couldn't be read: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    if (text === null) {
      briefs.add(`nodes.${n.id}.brief`, n.id, `its brief ${n.brief} doesn't exist; write it in the builder, or send its text in briefs.${n.id} with a proposal`)
    } else if (bytes(text) > BRIEF_MAX_BYTES) {
      briefs.add(`nodes.${n.id}.brief`, n.id, `its brief is ${kib(bytes(text))}; a brief is at most 16 KiB, since it becomes part of the node's type prompt`)
    }
  }

  const errors = [tree, limits, kinds, sharing, perInstance, authority, gates, existing, branches, names, paths, briefs].flatMap(x => x.list)
  return { errors, warnings: warnings.list }
}

/** The schema first, then every 15.3 rule, each error naming the node and the field. Every error, never the first only. */
export async function validateSpec(p: Ports, spec: unknown, ctx: ValidateCtx): Promise<SpecCheck> {
  const parsed = parseSpec(spec)
  const errors = [...parsed.errors]
  const warnings: SpecError[] = []
  if (parsed.spec) {
    const r = await rules(p, parsed.spec, ctx)
    errors.push(...r.errors)
    warnings.push(...r.warnings)
  }
  return { ok: errors.length === 0, errors, warnings }
}

/**
 * Decision 10 (phase 3, AC): whether swarm `name` is the active run's own
 * repair swarm, the one swarm excepted from "no node in the active run's
 * checkout". The active run is policy.json's, its checkout the one the
 * caller's ctx names, and its ledger's open generation the `run.repair` that
 * names this swarm (the reopen wrote it before the swarm's save and launch).
 * Read from the mod's files only, never from the spec. Exported for
 * launch.ts, which also requires its caller's `forRun`.
 */
export async function activeRunsRepair(p: Ports, litterDir: string, checkout: string | null, name: string): Promise<boolean> {
  const run = (await readPolicy(p, litterDir).catch(() => undefined))?.run
  if (!run || checkout === null || run.checkout !== checkout || !RUN_ID.test(run.run) || run.runDir !== runDirOf(litterDir, run.run)) return false
  const ledger = await readLedger(p, run.runDir, run.run).catch(() => null)
  if (!ledger || ledger.tampered) return false
  for (let i = ledger.records.length - 1; i >= 0; i--) {
    const r = ledger.records[i]!
    if (r.kind === 'run.repair') return r.body.swarm === name
    if (r.kind === 'run.end' || r.kind === 'run.stopping' || r.kind === 'run.launch' || r.kind === 'run.resume') return false
  }
  return false
}

/**
 * The ValidateCtx for a litter directory: its repository, this process's
 * limits, the active run's checkout from policy.json, and the briefs as the
 * caller has them (the store, propose and templates build theirs here).
 */
export async function validateCtxFor(p: Ports, litterDir: string, briefText: (node: string) => Promise<string | null>): Promise<ValidateCtx> {
  const policy = await readPolicy(p, litterDir).catch(() => undefined)
  return { repo: repoOf(litterDir), litterDir, limits: await p.limits(), briefText, activeRunCheckout: policy?.run?.checkout ?? null }
}

/** Checks a spec against a briefs map: the spec's own name must be `name` too. */
export async function validateSaved(
  p: Ports,
  litterDir: string,
  name: string,
  saved: { spec: unknown; briefs: Readonly<Record<string, string>> },
): Promise<SpecCheck> {
  const ctx = await validateCtxFor(p, litterDir, async node => (Object.hasOwn(saved.briefs, node) ? saved.briefs[node]! : null))
  const check = await validateSpec(p, saved.spec, ctx)
  const named = isObj(saved.spec) ? saved.spec.name : undefined
  if (typeof named === 'string' && SWARM_NAME.test(named) && named !== name) {
    check.errors.unshift({ field: 'name', error: `the spec is named '${named}', but this is swarm '${name}'; a spec's name is its swarm's` })
    check.ok = false
  }
  return check
}
