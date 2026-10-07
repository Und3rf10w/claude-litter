// WP-J: how revisions, briefs, drafts and proposals are stored (15.8's
// layout, the mod the only writer): swarm.json and revisions/, the drafts in
// $.store, staged proposals, accept and reject.
//
// The spec ledger counts: revision n is the n-th swarm.revision, proposal n
// the n-th swarm.proposal, and each proposal gets one swarm.proposal.decided.
// Files are written before their record, so a crash between the two leaves
// files the next write replaces. Every write to one swarm runs under one
// serial key, and a write never waits on that key from inside it.
//
// Owner: phase 2b-1, package J. The stub's signatures are the contract.

import type { Ports } from '../ports'
import type { ProposedChange, SwarmProposalBody, SwarmProposalDecidedBody, SwarmRevisionBody } from '../records/swarm'
import type {
  BriefDiff,
  DiffCounts,
  Draft,
  DraftEdit,
  ProposalChange,
  ProposalView,
  RevisionFrom,
  SavedSwarm,
  SpecError,
  SwarmListing,
  SwarmNode,
  SwarmSpec,
} from './types'
import { appendSpecRecord, readSpecLedger } from '../records/swarm'
import { NODE_ID, revisionBriefPath, revisionPath, SWARM_NAME, swarmBriefPath, swarmDir, swarmJsonPath, swarmProposalDir, swarmsDir } from '../layout'
import { atomicWrite, atomicWriteJson, readJson, remove, serial, sha256 } from '../fsx'
import { liveSwarm, liveSwarms } from './state'
import { validateSaved } from './spec'

/** How a revision came to be, for its `swarm.revision` record. */
export type RevisionNote = {
  from: RevisionFrom
  /** `from: 'proposal'`. */
  proposal?: number
  /** `from: 'template'`. */
  template?: string
  changes: string[]
}

/** A save's answer: the new revision, or every validation error (nothing written). */
export type SaveResult = { ok: true; revision: number } | { ok: false; errors: SpecError[] }

/** `$.store` key for a swarm's draft (a /clear wipes `$.state`, not the store). */
export const draftKey = (litterDir: string, name: string) => `litter.swarm.draft.${litterDir}.${name}`
const lockKey = (litterDir: string, name: string) => `swarm-spec:${litterDir}:${name}`

/** A draft is kept in a store all of litter shares (4 MiB): at most this much JSON. */
const DRAFT_MAX_BYTES = 1024 * 1024
const EDITS_MAX = 500
const CHANGES_MAX = 200
const CHANGE_MAX_CHARS = 300

type Raw = Record<string, unknown>
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const bytes = (s: string): number => new TextEncoder().encode(s).length
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const badName = (name: string): SpecError => ({
  field: 'name',
  error: `'${name}' isn't a swarm name: lowercase letters, digits and dashes, starting with a letter or digit, at most 24 characters`,
})

/** The nodes that name a brief, with ids the layout can join. */
const briefNodes = (spec: SwarmSpec): SwarmNode[] =>
  (Array.isArray(spec?.nodes) ? spec.nodes : []).filter(n => isObj(n) && typeof n.id === 'string' && NODE_ID.test(n.id) && n.brief !== undefined)

async function readBriefs(p: Ports, spec: SwarmSpec, path: (node: string) => string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const n of briefNodes(spec)) {
    const file = path(n.id)
    if (await p.fs.exists(file)) out[n.id] = await p.fs.read(file)
  }
  return out
}

// ---------------------------------------------------------------------------
// The spec ledger

type SpecLedger = {
  revisions: SwarmRevisionBody[]
  proposals: Map<number, SwarmProposalBody>
  decided: Map<number, SwarmProposalDecidedBody>
  tampered: { seq: number; reason: string } | null
}

async function specLedger(p: Ports, litterDir: string, name: string): Promise<SpecLedger> {
  const r = await readSpecLedger(p, litterDir, name)
  const out: SpecLedger = { revisions: [], proposals: new Map(), decided: new Map(), tampered: r.tampered }
  for (const rec of r.records) {
    if (rec.by.source !== 'mod') continue
    const body = rec.body as Raw
    if (rec.kind === 'swarm.revision' && typeof body.n === 'number') out.revisions.push(body as unknown as SwarmRevisionBody)
    if (rec.kind === 'swarm.proposal' && typeof body.n === 'number') out.proposals.set(body.n, body as unknown as SwarmProposalBody)
    if (rec.kind === 'swarm.proposal.decided' && typeof body.proposal === 'number' && !out.decided.has(body.proposal)) {
      out.decided.set(body.proposal, body as unknown as SwarmProposalDecidedBody)
    }
  }
  return out
}

const lastRevision = (l: SpecLedger): number => Math.max(0, ...l.revisions.map(r => r.n))
const tamperedError = (t: { seq: number; reason: string }): SpecError => ({
  field: 'swarm',
  error: `the swarm's spec ledger is tampered at record ${t.seq} (${t.reason}); nothing more is written to it`,
})

// ---------------------------------------------------------------------------
// Saved swarms and revisions

/** Every swarm under `<litterDir>/swarms/`, for the start screen, and any live one not saved here. */
export async function listSwarms(p: Ports, litterDir: string): Promise<SwarmListing[]> {
  const dir = swarmsDir(litterDir)
  const names = (await p.fs.exists(dir))
    ? (await p.fs.list(dir)).filter(e => e.kind === 'dir' && !e.isLink && SWARM_NAME.test(e.name)).map(e => e.name)
    : []
  const out: SwarmListing[] = []
  for (const name of names) {
    try {
      const saved = await readSaved(p, litterDir, name)
      if (!saved) continue
      out.push({
        name,
        goal: typeof saved.spec.goal === 'string' ? saved.spec.goal : '',
        revision: saved.revision,
        nodes: Array.isArray(saved.spec.nodes) ? saved.spec.nodes.length : 0,
        live: liveSwarm(name) !== null,
      })
    } catch (err) {
      p.log(`swarm ${name} isn't listed: ${errText(err)}`)
    }
  }
  for (const s of liveSwarms()) {
    if (!out.some(x => x.name === s.name)) out.push({ name: s.name, goal: s.spec.goal, revision: s.revision, nodes: s.spec.nodes.length, live: true })
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** The latest saved revision (swarm.json and briefs/), or null when the swarm was never saved. Its revision number is the ledger's. */
export async function readSaved(p: Ports, litterDir: string, name: string): Promise<SavedSwarm | null> {
  if (!SWARM_NAME.test(name)) return null
  const spec = await readJson<SwarmSpec>(p, swarmJsonPath(litterDir, name))
  if (spec === undefined) return null
  const revision = lastRevision(await specLedger(p, litterDir, name))
  return { spec, revision, briefs: await readBriefs(p, spec, node => swarmBriefPath(litterDir, name, node)) }
}

/** Revision `n` (revisions/<n>.json and its briefs), or null. */
export async function readRevision(p: Ports, litterDir: string, name: string, n: number): Promise<SavedSwarm | null> {
  if (!SWARM_NAME.test(name) || !Number.isSafeInteger(n) || n < 1) return null
  const spec = await readJson<SwarmSpec>(p, revisionPath(litterDir, name, n))
  if (spec === undefined) return null
  return { spec, revision: n, briefs: await readBriefs(p, spec, node => revisionBriefPath(litterDir, name, n, node)) }
}

/** A node's brief text at a revision (revisions/<n>/briefs/<node>.md), or null when it has none. */
export async function briefTextFor(p: Ports, litterDir: string, name: string, revision: number, node: string): Promise<string | null> {
  if (!SWARM_NAME.test(name) || !NODE_ID.test(node) || !Number.isSafeInteger(revision) || revision < 1) return null
  const file = revisionBriefPath(litterDir, name, revision, node)
  return (await p.fs.exists(file)) ? p.fs.read(file) : null
}

/** Under the swarm's key: validates, then revisions/<n>, then swarm.json and briefs/, then the record, then the draft. */
async function writeRevision(
  p: Ports,
  litterDir: string,
  name: string,
  saved: { spec: SwarmSpec; briefs: Record<string, string> },
  note: RevisionNote,
): Promise<SaveResult> {
  if (!SWARM_NAME.test(name)) return { ok: false, errors: [badName(name)] }
  const check = await validateSaved(p, litterDir, name, saved)
  if (!check.ok) return { ok: false, errors: check.errors }
  const l = await specLedger(p, litterDir, name)
  if (l.tampered) return { ok: false, errors: [tamperedError(l.tampered)] }
  const n = lastRevision(l) + 1
  const { spec } = saved
  const briefs: Record<string, string> = {}
  for (const node of briefNodes(spec)) briefs[node.id] = saved.briefs[node.id]!

  // A revision folder a crash left before its record is replaced whole.
  await remove(p, `${swarmDir(litterDir, name)}/revisions/${n}`)
  await atomicWriteJson(p, revisionPath(litterDir, name, n), spec)
  for (const [node, text] of Object.entries(briefs)) await atomicWrite(p, revisionBriefPath(litterDir, name, n, node), text)
  await atomicWriteJson(p, swarmJsonPath(litterDir, name), spec)
  for (const [node, text] of Object.entries(briefs)) await atomicWrite(p, swarmBriefPath(litterDir, name, node), text)
  const briefsDir = `${swarmDir(litterDir, name)}/briefs`
  if (await p.fs.exists(briefsDir)) {
    for (const e of await p.fs.list(briefsDir)) {
      const m = /^(.+)\.md$/.exec(e.name)
      if (e.kind === 'file' && m && !Object.hasOwn(briefs, m[1]!)) await remove(p, `${briefsDir}/${e.name}`)
    }
  }
  const body: SwarmRevisionBody = {
    n,
    from: note.from,
    ...(note.proposal !== undefined ? { proposal: note.proposal } : {}),
    ...(note.template !== undefined ? { template: note.template } : {}),
    changes: note.changes.slice(0, CHANGES_MAX).map(c => c.slice(0, CHANGE_MAX_CHARS)),
  }
  await appendSpecRecord(p, litterDir, name, 'swarm.revision', body)
  // The draft, if there is one, now starts from this revision: what it held is saved.
  if (await readDraft(p, litterDir, name)) {
    await writeDraft(p, litterDir, name, { base: n, edits: [], spec, briefs, updatedAt: await p.now() })
  }
  return { ok: true, revision: n }
}

/**
 * Validates, then writes the next revision, then swarm.json and briefs/, and
 * records `swarm.revision`. C's choice: the spec and briefs as one argument,
 * and the record's fields as `note`; J builds the ValidateCtx itself. Only the
 * briefs of nodes that name one are written. A draft of the swarm is reset to
 * the new revision, with no edits.
 */
export async function saveRevision(
  p: Ports,
  litterDir: string,
  name: string,
  saved: { spec: SwarmSpec; briefs: Record<string, string> },
  note: RevisionNote,
): Promise<SaveResult> {
  return serial(lockKey(litterDir, name), () => writeRevision(p, litterDir, name, saved, note))
}

// ---------------------------------------------------------------------------
// Drafts

function isDraft(v: unknown): v is Draft {
  return (
    isObj(v) &&
    Number.isSafeInteger(v.base) &&
    (v.base as number) >= 0 &&
    Array.isArray(v.edits) &&
    v.edits.every(x => isObj(x) && typeof x.path === 'string' && typeof x.at === 'number') &&
    isObj(v.spec) &&
    isObj(v.briefs) &&
    Object.values(v.briefs).every(x => typeof x === 'string') &&
    typeof v.updatedAt === 'number'
  )
}

/** One edit per path, the latest, in the order of the latest; the last EDITS_MAX. */
function compactEdits(edits: readonly DraftEdit[]): DraftEdit[] {
  const last = new Map<string, DraftEdit>()
  for (const e of edits) {
    last.delete(e.path)
    last.set(e.path, { path: e.path, at: e.at })
  }
  return [...last.values()].slice(-EDITS_MAX)
}

/** The builder's draft from `$.store` (`litter.swarm.draft.<litterDir>.<name>`), or null. */
export async function readDraft(p: Ports, litterDir: string, name: string): Promise<Draft | null> {
  if (!SWARM_NAME.test(name)) return null
  const v = await p.store.get(draftKey(litterDir, name))
  return isDraft(v) ? v : null
}

/** Keeps the draft, its edits one per path; rejects a draft over 1 MiB of JSON, which the shared store can't spare. */
export async function writeDraft(p: Ports, litterDir: string, name: string, draft: Draft): Promise<void> {
  if (!SWARM_NAME.test(name)) throw new Error(`litter: ${badName(name).error}`)
  const kept: Draft = { ...draft, edits: compactEdits(draft.edits) }
  const size = bytes(JSON.stringify(kept))
  if (size > DRAFT_MAX_BYTES) throw new Error(`litter: the draft of ${name} is ${Math.ceil(size / 1024)} KiB, over 1 MiB, so it isn't kept; save it, or shorten its briefs`)
  await p.store.set(draftKey(litterDir, name), kept)
}

export async function clearDraft(p: Ports, litterDir: string, name: string): Promise<void> {
  if (!SWARM_NAME.test(name)) return
  await p.store.delete(draftKey(litterDir, name))
}

// ---------------------------------------------------------------------------
// The diff (15.5): the proposal against its base, your draft against the same base

type Side = { spec: SwarmSpec; briefs: Record<string, string> }

const emptySide = (name: string): Side => ({ spec: { name, goal: '', nodes: [] }, briefs: {} })

/** JSON with sorted keys, so two equal values compare equal. */
const canon = (v: unknown): string =>
  JSON.stringify(v ?? null, (_k, x: unknown) => (isObj(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x))
const same = (a: unknown, b: unknown): boolean => (a === undefined) === (b === undefined) && canon(a) === canon(b)

/** Each field's value by its path: plain objects are walked into, a worktree, a list and a value are leaves. */
function flatten(v: unknown, path: string, out: Map<string, unknown>): void {
  if (isObj(v) && !path.endsWith('.worktree')) for (const [k, x] of Object.entries(v)) flatten(x, `${path}.${k}`, out)
  else if (v !== undefined) out.set(path, v)
}

type Leaves = { top: Map<string, unknown>; nodes: Map<string, { node: SwarmNode; fields: Map<string, unknown> }> }

function leavesOf(spec: SwarmSpec): Leaves {
  const top = new Map<string, unknown>()
  if (spec.goal !== undefined) top.set('goal', spec.goal)
  if (spec.limits !== undefined) flatten(spec.limits, 'limits', top)
  const nodes = new Map<string, { node: SwarmNode; fields: Map<string, unknown> }>()
  for (const n of Array.isArray(spec.nodes) ? spec.nodes : []) {
    if (!isObj(n) || typeof n.id !== 'string' || nodes.has(n.id)) continue
    const fields = new Map<string, unknown>()
    for (const [k, x] of Object.entries(n)) if (k !== 'id') flatten(x, `nodes.${n.id}.${k}`, fields)
    nodes.set(n.id, { node: n, fields })
  }
  return { top, nodes }
}

/** A side's value at a change's path: a whole node, a node's field, or a field of the spec. */
function valueAt(l: Leaves, path: string, node: string | undefined): unknown {
  if (node === undefined) return l.top.get(path)
  const n = l.nodes.get(node)
  if (path === `nodes.${node}`) return n?.node
  return n?.fields.get(path)
}

const holds = (outer: string, inner: string): boolean => inner.startsWith(`${outer}.`)

/** The lead's reason for a path: its change for that path, else the closest change above or below it. */
function reasonFor(changes: readonly ProposedChange[], paths: readonly string[]): string | null {
  for (const path of paths) {
    const exact = changes.find(c => c.path === path)
    if (exact) return exact.reason
  }
  const near = changes
    .filter(c => paths.some(path => holds(c.path, path) || holds(path, c.path)))
    .sort((a, b) => b.path.length - a.path.length)
  return near[0]?.reason ?? null
}

/** A line diff by longest common subsequence; past 4M cells, the differing middle as removed then added. */
export function lineDiff(before: string, after: string): BriefDiff['lines'] {
  const split = (s: string): string[] => (s === '' ? [] : s.replace(/\n$/, '').split('\n'))
  const a = split(before)
  const b = split(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const x = a.slice(head, a.length - tail)
  const y = b.slice(head, b.length - tail)
  const out: BriefDiff['lines'] = a.slice(0, head).map(text => ({ op: ' ', text }))
  if (x.length * y.length > 4_000_000) {
    out.push(...x.map(text => ({ op: '-' as const, text })), ...y.map(text => ({ op: '+' as const, text })))
  } else {
    const w = y.length + 1
    const lcs = new Uint32Array((x.length + 1) * w)
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        out.push({ op: ' ', text: x[i]! })
        i++
        j++
      } else if (j < y.length && (i === x.length || lcs[i * w + j + 1]! >= lcs[(i + 1) * w + j]!)) out.push({ op: '+', text: y[j++]! })
      else out.push({ op: '-', text: x[i++]! })
    }
  }
  out.push(...a.slice(a.length - tail).map(text => ({ op: ' ' as const, text })))
  return out
}

/** A side's brief for a node that names one. */
const briefOf = (side: Side, l: Leaves, node: string): string | undefined =>
  l.nodes.get(node)?.node.brief !== undefined && Object.hasOwn(side.briefs, node) ? side.briefs[node] : undefined

/**
 * The proposal `prop` against its base, each change and brief marked
 * conflicting where your draft changed it from the base too, to something else.
 *
 * `fromNothing`, a proposal over revision 0: nothing saved is there for the
 * lead to read, so the draft (swarm_read, draft: true) is what it proposed
 * over. A draft node its whole spec leaves out is one it removes, so it's
 * `removed` from the draft's node, with its brief: the lead's one way to drop
 * a node that's only in the draft. Over a saved revision, a node you added
 * since may be one the lead never read, so it stays yours.
 */
function diffSides(base: Side, prop: Side, draft: Side, reasons: readonly ProposedChange[], fromNothing = false): { changes: ProposalChange[]; briefs: BriefDiff[] } {
  const lb = leavesOf(base.spec)
  const lp = leavesOf(prop.spec)
  const ld = leavesOf(draft.spec)
  const dropped = fromNothing ? [...ld.nodes.keys()].filter(id => !lb.nodes.has(id) && !lp.nodes.has(id)) : []
  const changes: ProposalChange[] = []
  const entry = (path: string, node: string | undefined, before: unknown, after: unknown): void => {
    if (same(before, after)) return
    const kind: ProposalChange['kind'] = before === undefined ? 'added' : after === undefined ? 'removed' : 'changed'
    const yours = valueAt(ld, path, node)
    const conflict = !same(yours, before) && !same(yours, after)
    changes.push({
      path,
      ...(node !== undefined ? { node } : {}),
      kind,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
      reason: reasonFor(reasons, [path]),
      conflict,
      ...(conflict ? { yours } : {}),
    })
  }
  for (const path of new Set([...lb.top.keys(), ...lp.top.keys()])) entry(path, undefined, lb.top.get(path), lp.top.get(path))
  for (const [id, pn] of lp.nodes) {
    const bn = lb.nodes.get(id)
    if (!bn) entry(`nodes.${id}`, id, undefined, pn.node)
    else for (const path of new Set([...bn.fields.keys(), ...pn.fields.keys()])) entry(path, id, bn.fields.get(path), pn.fields.get(path))
  }
  for (const [id, bn] of lb.nodes) if (!lp.nodes.has(id)) entry(`nodes.${id}`, id, bn.node, undefined)
  for (const id of dropped) entry(`nodes.${id}`, id, ld.nodes.get(id)!.node, undefined)

  const briefs: BriefDiff[] = []
  for (const id of new Set([...lp.nodes.keys(), ...lb.nodes.keys(), ...dropped])) {
    const before = dropped.includes(id) ? briefOf(draft, ld, id) : briefOf(base, lb, id)
    const after = briefOf(prop, lp, id)
    if (before === after) continue
    const yours = briefOf(draft, ld, id)
    const conflict = yours !== before && yours !== after
    briefs.push({
      node: id,
      kind: before === undefined ? 'added' : after === undefined ? 'removed' : 'changed',
      lines: lineDiff(before ?? '', after ?? ''),
      reason: reasonFor(reasons, [`brief:${id}`, `briefs.${id}`, `nodes.${id}.brief`, `nodes.${id}`]),
      conflict,
      // A conflict is two diffs over the same base: the lead's, and yours.
      ...(conflict ? { yoursLines: lineDiff(before ?? '', yours ?? '') } : {}),
    })
  }
  return { changes, briefs }
}

function countsOf(changes: readonly ProposalChange[], briefs: readonly BriefDiff[]): DiffCounts {
  return {
    added: changes.filter(c => c.kind === 'added').length,
    removed: changes.filter(c => c.kind === 'removed').length,
    changed: changes.filter(c => c.kind === 'changed').length,
    briefs: briefs.length,
    conflicts: changes.filter(c => c.conflict).length + briefs.filter(b => b.conflict).length,
  }
}

// ---------------------------------------------------------------------------
// Proposals

type Loaded = { n: number; body: SwarmProposalBody; staged: Record<string, string>; decided: SwarmProposalDecidedBody | null }

/** Proposal `n` from its record, with its staged briefs, each checked against the record's sha256. */
async function loadProposal(p: Ports, litterDir: string, name: string, l: SpecLedger, n: number): Promise<Loaded | null> {
  const body = l.proposals.get(n)
  if (!body) return null
  const staged: Record<string, string> = {}
  for (const [node, hash] of Object.entries(isObj(body.briefs) ? body.briefs : {})) {
    if (!NODE_ID.test(node)) continue
    const file = `${swarmProposalDir(litterDir, name, n)}/briefs/${node}.md`
    const text = (await p.fs.exists(file)) ? await p.fs.read(file) : null
    if (text === null || (await sha256(text)) !== hash) {
      throw new Error(`litter: proposal ${n}'s staged brief for ${node} isn't the one the lead proposed (${text === null ? 'it is gone' : 'its sha256 differs'}); reject the proposal and ask the lead again`)
    }
    staged[node] = text
  }
  return { n, body, staged, decided: l.decided.get(n) ?? null }
}

async function baseSide(p: Ports, litterDir: string, name: string, revision: number): Promise<Side> {
  if (revision === 0) return emptySide(name)
  const r = await readRevision(p, litterDir, name, revision)
  if (!r) throw new Error(`litter: revision ${revision} of ${name} is missing (revisions/${revision}.json)`)
  return { spec: r.spec, briefs: r.briefs }
}

/** What a proposal is over: your draft, else the saved swarm, else nothing yet. */
async function currentSide(p: Ports, litterDir: string, name: string): Promise<Side> {
  const draft = await readDraft(p, litterDir, name)
  if (draft) return { spec: draft.spec, briefs: draft.briefs }
  const saved = await readSaved(p, litterDir, name)
  return saved ? { spec: saved.spec, briefs: saved.briefs } : emptySide(name)
}

/** The proposal whole: its spec, and each brief it names, staged or else its base revision's. */
function proposedSide(loaded: Loaded, base: Side): Side {
  const briefs: Record<string, string> = {}
  for (const n of briefNodes(loaded.body.spec)) {
    const text = Object.hasOwn(loaded.staged, n.id) ? loaded.staged[n.id] : Object.hasOwn(base.briefs, n.id) ? base.briefs[n.id] : undefined
    if (text !== undefined) briefs[n.id] = text
  }
  return { spec: loaded.body.spec, briefs }
}

async function diffOf(p: Ports, litterDir: string, name: string, loaded: Loaded) {
  const base = await baseSide(p, litterDir, name, loaded.body.baseRevision)
  const prop = proposedSide(loaded, base)
  const draft = await currentSide(p, litterDir, name)
  return { base, prop, draft, ...diffSides(base, prop, draft, loaded.body.changes, loaded.body.baseRevision === 0) }
}

/**
 * Stages a proposal that passed the checks under `proposals/<n>/` and records
 * `swarm.proposal`. C's choice: the decoded tool input with its spec typed;
 * it answers the proposal's number and the diff's counts.
 */
export async function stageProposal(
  p: Ports,
  litterDir: string,
  name: string,
  proposal: { baseRevision: number; spec: SwarmSpec; briefs: Record<string, string>; changes: ProposedChange[] },
): Promise<{ n: number; diff: DiffCounts }> {
  return serial(lockKey(litterDir, name), async () => {
    if (!SWARM_NAME.test(name)) throw new Error(`litter: ${badName(name).error}`)
    const l = await specLedger(p, litterDir, name)
    if (l.tampered) throw new Error(`litter: ${tamperedError(l.tampered).error}`)
    const n = Math.max(0, ...l.proposals.keys()) + 1
    const dir = swarmProposalDir(litterDir, name, n)
    // A stage a crash left before its record is replaced whole.
    await remove(p, dir)
    const briefs = Object.fromEntries(Object.entries(proposal.briefs).filter(([node]) => NODE_ID.test(node)))
    const hashes: Record<string, string> = {}
    for (const [node, text] of Object.entries(briefs)) hashes[node] = await sha256(text)
    const body: SwarmProposalBody = { n, baseRevision: proposal.baseRevision, spec: proposal.spec, briefs: hashes, changes: proposal.changes }
    try {
      await atomicWriteJson(p, `${dir}/spec.json`, proposal.spec)
      for (const [node, text] of Object.entries(briefs)) await atomicWrite(p, `${dir}/briefs/${node}.md`, text)
      await appendSpecRecord(p, litterDir, name, 'swarm.proposal', body)
    } catch (err) {
      await remove(p, dir).catch(() => {})
      throw err
    }
    const d = await diffOf(p, litterDir, name, { n, body, staged: briefs, decided: null })
    return { n, diff: countsOf(d.changes, d.briefs) }
  })
}

/** A staged proposal's diff over the current draft, conflicts marked, or null when there's no proposal `n`. */
export async function readProposal(p: Ports, litterDir: string, name: string, n: number): Promise<ProposalView | null> {
  if (!SWARM_NAME.test(name)) return null
  const loaded = await loadProposal(p, litterDir, name, await specLedger(p, litterDir, name), n)
  if (!loaded) return null
  const d = await diffOf(p, litterDir, name, loaded)
  return {
    swarm: name,
    n,
    baseRevision: loaded.body.baseRevision,
    changes: d.changes,
    briefs: d.briefs,
    counts: countsOf(d.changes, d.briefs),
    decided: loaded.decided?.accepted ?? null,
  }
}

/** Sets or, with `undefined`, removes a dotted field, dropping objects the removal left empty. */
function setField(target: Raw, dotted: string, value: unknown): void {
  const keys = dotted.split('.')
  const trail: Raw[] = [target]
  let at = target
  for (const k of keys.slice(0, -1)) {
    if (!isObj(at[k])) {
      if (value === undefined) return
      at[k] = {}
    }
    at = at[k] as Raw
    trail.push(at)
  }
  const last = keys[keys.length - 1]!
  if (value !== undefined) {
    at[last] = structuredClone(value)
    return
  }
  delete at[last]
  for (let i = trail.length - 1; i > 0; i--) {
    if (Object.keys(trail[i]!).length > 0) break
    delete trail[i - 1]![keys[i - 1]!]
  }
}

/**
 * Applies all of proposal `n`, or only the change paths `pick` names, over the
 * draft, validates, writes the next revision, and records the decision.
 * C's choice: `pick` is `'all'` or the list of change paths.
 *
 * J's: `'all'` takes every change that doesn't conflict, so your edits since
 * the base win; a list takes exactly what it names, conflicts included. A
 * change path is a ProposalChange's `path`; a brief of a node both sides have
 * is `brief:<node>`, and a new or removed node's brief goes with `nodes.<id>`.
 * The decision is `all` when every change was taken, else `some` with them.
 */
export async function acceptProposal(p: Ports, litterDir: string, name: string, n: number, pick: 'all' | readonly string[]): Promise<SaveResult> {
  return serial(lockKey(litterDir, name), async (): Promise<SaveResult> => {
    if (!SWARM_NAME.test(name)) return { ok: false, errors: [badName(name)] }
    const l = await specLedger(p, litterDir, name)
    if (l.tampered) return { ok: false, errors: [tamperedError(l.tampered)] }
    const loaded = await loadProposal(p, litterDir, name, l, n)
    if (!loaded) return { ok: false, errors: [{ field: 'proposal', error: `there's no proposal ${n} for ${name}` }] }
    if (loaded.decided) return { ok: false, errors: [{ field: 'proposal', error: `proposal ${n} was already decided (${loaded.decided.accepted})` }] }
    const d = await diffOf(p, litterDir, name, loaded)
    const nodeChange = new Map(d.changes.filter(c => c.node !== undefined && c.path === `nodes.${c.node}`).map(c => [c.node!, c]))
    const briefPath = (b: BriefDiff): string => (nodeChange.has(b.node) ? `nodes.${b.node}` : `brief:${b.node}`)
    const total = d.changes.length + d.briefs.filter(b => !nodeChange.has(b.node)).length

    // A revision a crash left before its decision: only the decision is left to record.
    const done = l.revisions.find(r => r.from === 'proposal' && r.proposal === n)
    if (done) {
      const all = done.changes.length >= total
      await appendSpecRecord(p, litterDir, name, 'swarm.proposal.decided', {
        proposal: n,
        accepted: all ? 'all' : 'some',
        ...(all ? {} : { picked: done.changes }),
        revision: done.n,
      })
      return { ok: true, revision: done.n }
    }

    let chosen: Set<string>
    if (pick === 'all') {
      chosen = new Set([...d.changes.filter(c => !c.conflict).map(c => c.path), ...d.briefs.filter(b => !b.conflict && !nodeChange.has(b.node)).map(briefPath)])
    } else {
      const known = new Set([...d.changes.map(c => c.path), ...d.briefs.map(briefPath)])
      const unknown = pick.filter(x => !known.has(x) && !(x.startsWith('brief:') && nodeChange.has(x.slice(6))))
      if (unknown.length > 0) {
        return { ok: false, errors: unknown.map(x => ({ field: 'pick', error: `proposal ${n} has no change at '${x}'` })) }
      }
      if (pick.length === 0) return { ok: false, errors: [{ field: 'pick', error: 'pick at least one change, or reject the proposal' }] }
      // A new or removed node's brief goes with its node.
      chosen = new Set(pick.map(x => (x.startsWith('brief:') && nodeChange.has(x.slice(6)) ? `nodes.${x.slice(6)}` : x)))
    }

    const spec = structuredClone(d.draft.spec)
    if (!Array.isArray(spec.nodes)) spec.nodes = []
    const briefs: Record<string, string> = { ...d.draft.briefs }
    const propNode = (id: string): SwarmNode | undefined => d.prop.spec.nodes.find(x => x.id === id)
    const setBrief = (id: string): void => {
      if (Object.hasOwn(d.prop.briefs, id)) briefs[id] = d.prop.briefs[id]!
      else delete briefs[id]
    }
    const placeNode = (node: SwarmNode): void => {
      const i = spec.nodes.findIndex(x => x.id === node.id)
      if (i >= 0) {
        spec.nodes[i] = structuredClone(node)
        return
      }
      // After the node that comes before it in the proposal, else at the end.
      const order = d.prop.spec.nodes.map(x => x.id)
      const before = order.slice(0, order.indexOf(node.id)).reverse().find(id => spec.nodes.some(x => x.id === id))
      const at = before === undefined ? spec.nodes.length : spec.nodes.findIndex(x => x.id === before) + 1
      spec.nodes.splice(at, 0, structuredClone(node))
    }
    const applied: string[] = []
    for (const c of d.changes) {
      if (!chosen.has(c.path)) continue
      applied.push(c.path)
      if (c.node !== undefined && c.path === `nodes.${c.node}`) {
        if (c.kind === 'removed') spec.nodes = spec.nodes.filter(x => x.id !== c.node)
        else placeNode(propNode(c.node)!)
        setBrief(c.node)
      } else if (c.node !== undefined) {
        const target = spec.nodes.find(x => x.id === c.node)
        // A node you removed since the base comes back as the lead has it.
        if (!target) placeNode(propNode(c.node) ?? (c.after as SwarmNode))
        else setField(target as unknown as Raw, c.path.slice(`nodes.${c.node}.`.length), c.after)
      } else setField(spec as unknown as Raw, c.path, c.after)
    }
    for (const b of d.briefs) {
      if (nodeChange.has(b.node) || !chosen.has(`brief:${b.node}`)) continue
      applied.push(`brief:${b.node}`)
      setBrief(b.node)
    }
    spec.name = name

    const saved = await writeRevision(p, litterDir, name, { spec, briefs }, { from: 'proposal', proposal: n, changes: applied })
    if (!saved.ok) return saved
    const all = applied.length >= total
    await appendSpecRecord(p, litterDir, name, 'swarm.proposal.decided', {
      proposal: n,
      accepted: all ? 'all' : 'some',
      ...(all ? {} : { picked: applied }),
      revision: saved.revision,
    })
    return saved
  })
}

/**
 * The staged proposals with no `swarm.proposal.decided`, oldest first: what
 * the builder offers after a reload, since the pane's own list is module memory.
 */
export async function undecidedProposals(p: Ports, litterDir: string, name: string): Promise<number[]> {
  if (!SWARM_NAME.test(name)) return []
  const l = await specLedger(p, litterDir, name)
  return [...l.proposals.keys()].filter(n => !l.decided.has(n)).sort((a, b) => a - b)
}

/**
 * The undecided proposals that still need you, and those that don't (WP-DD):
 * an undecided proposal is superseded once a later proposal of the swarm was
 * decided (accepted or rejected), or once a revision was saved after it was
 * staged. A revision its own accept wrote, before a crash kept its decision
 * from being recorded, doesn't supersede it. Each list oldest first, from the
 * spec ledger's order alone; the hub's count and the browser's banner take
 * `current`, the builder lists `superseded` as older proposals.
 */
export async function proposalStanding(p: Ports, litterDir: string, name: string): Promise<{ current: number[]; superseded: number[] }> {
  if (!SWARM_NAME.test(name)) return { current: [], superseded: [] }
  const r = await readSpecLedger(p, litterDir, name)
  const staged: number[] = []
  const decided = new Set<number>()
  const over = new Set<number>()
  const open = (): number[] => staged.filter(n => !decided.has(n) && !over.has(n))
  for (const rec of r.records) {
    if (rec.by.source !== 'mod') continue
    const body = rec.body as Raw
    if (rec.kind === 'swarm.proposal' && typeof body.n === 'number') {
      if (!staged.includes(body.n)) staged.push(body.n)
    } else if (rec.kind === 'swarm.revision' && typeof body.n === 'number') {
      const own = body.from === 'proposal' && typeof body.proposal === 'number' ? body.proposal : null
      for (const n of open()) if (n !== own) over.add(n)
    } else if (rec.kind === 'swarm.proposal.decided' && typeof body.proposal === 'number' && staged.includes(body.proposal) && !decided.has(body.proposal)) {
      const k = body.proposal
      decided.add(k)
      for (const n of open()) if (n < k) over.add(n)
    }
  }
  const undecided = staged.filter(n => !decided.has(n)).sort((a, b) => a - b)
  return { current: undecided.filter(n => !over.has(n)), superseded: undecided.filter(n => over.has(n)) }
}

/**
 * Records only the decision, `accepted: 'none'`; nothing reaches briefs/.
 * Rejects when there's no such proposal, or it was decided. It reads only the
 * ledger, never the staged files, so a proposal readProposal can't read (a
 * staged brief changed, its base revision gone) can still be rejected.
 */
export async function rejectProposal(p: Ports, litterDir: string, name: string, n: number): Promise<void> {
  return serial(lockKey(litterDir, name), async () => {
    if (!SWARM_NAME.test(name)) throw new Error(`litter: ${badName(name).error}`)
    const l = await specLedger(p, litterDir, name)
    if (!l.proposals.has(n)) throw new Error(`litter: there's no proposal ${n} for ${name}`)
    const decided = l.decided.get(n)
    if (decided) throw new Error(`litter: proposal ${n} was already decided (${decided.accepted})`)
    await appendSpecRecord(p, litterDir, name, 'swarm.proposal.decided', { proposal: n, accepted: 'none' })
  })
}

/** The latest saved revision, the draft's base revision (null with no draft), and whether the spec ledger is tampered: swarm_propose's checks. */
export async function specState(
  p: Ports,
  litterDir: string,
  name: string,
): Promise<{ latest: number; draftBase: number | null; tampered: { seq: number; reason: string } | null }> {
  const l = await specLedger(p, litterDir, name)
  const draft = await readDraft(p, litterDir, name)
  return { latest: lastRevision(l), draftBase: draft ? draft.base : null, tampered: l.tampered }
}
