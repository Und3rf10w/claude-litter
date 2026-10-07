// WP-N: the panes' view models, plain JSON, built from state.ts, the ledgers
// and the other packages' read functions: the start screen, builder,
// proposal, browser, goal history, recovery card, unsettled report,
// read-only, and the doctor pane (plan 15.5, 15.6, 15.7).
//
// What's here:
//  - the owners: every other package's function the panes call, through one
//    table a spec can swap (setOwnersForTests), so N's tests never depend on
//    another package's body;
//  - the panes' navigation (which view, which swarm, what's selected, what's
//    typed): module memory, mirrored to $.store under one key so a hot reload
//    finds it (a /clear keeps the module, and $.state is only what's drawn);
//  - the builders, each turning the navigation and the live state into the
//    view the renderers draw. External text is cleaned and cut here, so the
//    renderers only draw; colors are 15.6's theme keys, each status with its
//    word or glyph.
//
// Contract owner: phase 2b-1, package N (C picked one builder per pane; N extends).

import type { DoctorPaneView, ListedAgent, Ports, SwarmPaneView } from '../ports'
import type {
  DoctorPaneBody,
  DoctorRowView,
  SwarmBadge,
  SwarmBriefPanel,
  SwarmBrowserView,
  SwarmBudgetPart,
  SwarmBuilderView,
  SwarmChangeRow,
  SwarmComposer,
  SwarmEventRow,
  SwarmField,
  SwarmFieldGroup,
  SwarmFlagRow,
  SwarmHistoryView,
  SwarmInspector,
  SwarmNodeRow,
  SwarmNotice,
  SwarmOption,
  SwarmProposalView,
  SwarmRecoveryInstance,
  SwarmRecoveryRow,
  SwarmRecoveryView,
  SwarmSaveAsCandidate,
  SwarmSpan,
  SwarmStartView,
  SwarmStripRow,
  SwarmTreeProps,
  SwarmTreeRow,
  SwarmUnsettledView,
  SwarmViewName,
} from '../../types/index'
import type { StoredRecord } from '../records/core'
import type { Head } from '../ledgercore'
import type { SwarmEventBody, SwarmNodeBody, SwarmSummaryBody } from '../records/swarm'
import type {
  BindingKind,
  Draft,
  HealthReport,
  LiveSwarm,
  NodeBinding,
  SpecCheck,
  SwarmNode,
  SwarmSpec,
  TemplateListing,
  WorktreeSpec,
} from './types'
import { agentLive } from '../ports'
import { session } from '../session'
import { headKey } from '../ledgercore'
import { launchDir, swarmBriefPath, swarmDir, swarmProposalDir } from '../layout'
import { repoOf } from '../lifecycle'
import { readLaunchLedger } from '../records/swarm'
import { IDENTITY, MARK, STYLE } from '../ui/style'
import {
  binding,
  bindings,
  inflight,
  isStopped,
  lastReport,
  leadBusy,
  liveSwarm,
  liveSwarms,
  openQuestions,
  queued,
  roundsUsed,
  spawnsUsed,
  status as admissionStatus,
  tokens,
} from './state'
import { validateSaved } from './spec'
import { checkHealth } from './doctor'
import {
  acceptProposal,
  clearDraft,
  listSwarms,
  readDraft,
  readProposal,
  readSaved,
  rejectProposal,
  saveRevision,
  undecidedProposals,
  writeDraft,
} from './store'
import { instantiate, listTemplates, loadTemplate, saveTemplate, templateOffers } from './templates'
import { launchSwarm } from './launch'
import { handover, readOwner } from './owner'
import { recoveryCard, requestResume, resumeTargets } from './recover'
import { cancelQueued, sendFromBrowser } from './admit'
import { endSwarm, settleProgress, stopNode } from './end'
import { ackBranchMoved } from './observe'
import { parseSummary, plainText, summaryOf } from './summary'

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// ---------------------------------------------------------------------------
// The owners: every other package's function the panes call (WP-N, "Each
// action calls its owner"). Built when called, never at import time, since
// some of these modules import each other.

export type Owners = {
  validateSaved: typeof validateSaved
  checkHealth: typeof checkHealth
  listSwarms: typeof listSwarms
  readSaved: typeof readSaved
  readDraft: typeof readDraft
  writeDraft: typeof writeDraft
  clearDraft: typeof clearDraft
  saveRevision: typeof saveRevision
  readProposal: typeof readProposal
  acceptProposal: typeof acceptProposal
  rejectProposal: typeof rejectProposal
  undecidedProposals: typeof undecidedProposals
  listTemplates: typeof listTemplates
  loadTemplate: typeof loadTemplate
  instantiate: typeof instantiate
  saveTemplate: typeof saveTemplate
  launchSwarm: typeof launchSwarm
  readOwner: typeof readOwner
  handover: typeof handover
  recoveryCard: typeof recoveryCard
  requestResume: typeof requestResume
  resumeTargets: typeof resumeTargets
  sendFromBrowser: typeof sendFromBrowser
  cancelQueued: typeof cancelQueued
  stopNode: typeof stopNode
  endSwarm: typeof endSwarm
  settleProgress: typeof settleProgress
  ackBranchMoved: typeof ackBranchMoved
  summaryOf: typeof summaryOf
}

let fakeOwners: Partial<Owners> = {}

export function owners(): Owners {
  return {
    validateSaved,
    checkHealth,
    listSwarms,
    readSaved,
    readDraft,
    writeDraft,
    clearDraft,
    saveRevision,
    readProposal,
    acceptProposal,
    rejectProposal,
    undecidedProposals,
    listTemplates,
    loadTemplate,
    instantiate,
    saveTemplate,
    launchSwarm,
    readOwner,
    handover,
    recoveryCard,
    requestResume,
    resumeTargets,
    sendFromBrowser,
    cancelQueued,
    stopNode,
    endSwarm,
    settleProgress,
    ackBranchMoved,
    summaryOf,
    ...fakeOwners,
  }
}

/** Tests: the owners to use instead of the real ones, by name (an empty object restores them). */
export function setOwnersForTests(fakes: Partial<Owners>): void {
  fakeOwners = fakes
}

// ---------------------------------------------------------------------------
// The navigation

/** Where the swarm pane is, and what you've picked and typed there. */
export type SwarmNav = {
  view: SwarmViewName
  swarm: string | null
  /** Builder and proposal: the tree row selected. Browser: the agentId selected (the composer's To). */
  selected: string | null
  /** Proposal: its number. */
  proposal: number | null
  /** Proposal: the change indexes picked for [Accept selected]. */
  picked: number[]
  /** Proposal: the briefs picked for [Accept selected], by node. */
  pickedBriefs: string[]
  /** Proposal: the brief whose diff is open. */
  diff: string | null
  /** Browser: whose transcript is open. */
  transcript: string | null
  /** What's typed in each field, by element key, so a redraw keeps it. */
  inputs: Record<string, string>
  /** Start: the template picked (`<scope>:<name>`). */
  template: string | null
  /** Start: why [Use template] made no draft, until a parameter changes. */
  templateErrors: string[]
  /** Builder: the [Save as template] form, when open; `params` are the picked offers' fields (J's templateOffers). */
  saveAs: { scope: 'user' | 'project'; params: string[] } | null
  /** Recovery: the orchestrators picked, by node id. */
  recoveryPicked: string[]
  /** Browser: the last send was refused and can be queued instead. */
  offerQueue: boolean
  /** Unsettled: when you chose [Wait longer]; the report comes back 2 minutes after. */
  waitedOn: number | null
  notice: SwarmNotice | null
}

/**
 * The doctor pane: the swarm it checks (the builder's), and the row the last
 * [Test] gave. [Test] runs its summaryModel call once per press (15.7, "on
 * its [Test] button only"); the row is drawn again until [Recheck].
 */
export type DoctorNav = { swarm: string | null; notice: SwarmNotice | null; tested: DoctorRowView | null }

/** The $.store key the navigation is mirrored under: one key, last writer wins, read back only by the same session. */
export const PANE_STORE_KEY = 'litter.swarm.pane'

type PaneStore = { v: 1; session: string; swarm: SwarmNav | null; doctor: DoctorNav | null }

let swarmNav: SwarmNav | null = null
let doctorNav: DoctorNav | null = null
let restored = false

export const blankNav = (view: SwarmViewName, swarm: string | null): SwarmNav => ({
  view,
  swarm,
  selected: null,
  proposal: null,
  picked: [],
  pickedBriefs: [],
  diff: null,
  transcript: null,
  inputs: {},
  template: null,
  templateErrors: [],
  saveAs: null,
  recoveryPicked: [],
  offerQueue: false,
  waitedOn: null,
  notice: null,
})

/** The swarm pane's navigation, or null while it isn't open. */
export const nav = (): SwarmNav | null => swarmNav
export const doctorNavigation = (): DoctorNav | null => doctorNav

let rev = 0

/** Bumped by every change of the navigation: part of the tick's change check. */
export const navRev = (): number => rev

export function setNav(next: SwarmNav | null): void {
  swarmNav = next
  restored = true
  rev++
}

export function setDoctorNav(next: DoctorNav | null): void {
  doctorNav = next
  restored = true
  rev++
}

/**
 * What's typed in a field, kept without a redraw: a redraw while you type
 * hands the field its text again, and a keystroke in flight then would be
 * lost. `null` forgets it, so the field shows the draft's value again.
 */
export function putInput(key: string, value: string | null): void {
  if (!swarmNav) return
  const inputs = { ...swarmNav.inputs }
  if (value === null) delete inputs[key]
  else inputs[key] = value
  swarmNav = { ...swarmNav, inputs }
}

/** After a hot reload module memory is empty: the navigation comes back from $.store, when this session wrote it. */
export async function restoreNav(p: Ports): Promise<void> {
  if (restored) return
  restored = true
  try {
    const raw = (await p.store.get(PANE_STORE_KEY)) as Partial<PaneStore> | undefined
    if (!raw || raw.v !== 1 || raw.session !== (await p.sessionId())) return
    if (swarmNav === null && raw.swarm) swarmNav = { ...blankNav(raw.swarm.view, raw.swarm.swarm), ...raw.swarm }
    if (doctorNav === null && raw.doctor) doctorNav = { swarm: raw.doctor.swarm ?? null, notice: raw.doctor.notice ?? null, tested: raw.doctor.tested ?? null }
  } catch (err) {
    p.log(`swarm pane: the navigation wasn't read back: ${errText(err)}`)
  }
}

export async function saveNav(p: Ports): Promise<void> {
  try {
    const value: PaneStore = { v: 1, session: await p.sessionId(), swarm: swarmNav, doctor: doctorNav }
    await p.store.set(PANE_STORE_KEY, value)
  } catch (err) {
    p.log(`swarm pane: the navigation wasn't saved: ${errText(err)}`)
  }
}

// ---------------------------------------------------------------------------
// Caches (module memory; none is a fact anyone else reads)

const drafts = new Map<string, Draft>()

/** J's check of a draft, for the builder's strip: run on the pane's tick after an edit. */
export type StripCheck = {
  check: SpecCheck | null
  health: HealthReport | null
  error: string | null
  /** An edit came after the last check. */
  due: boolean
  /** When the check ran. */
  at: number
  /** When the last edit was made, so the tick waits for a pause in typing. */
  editedAt: number
}
const strips = new Map<string, StripCheck>()

/** Staged proposals not yet decided, by swarm: state.ts hands each over once (takeProposals), and J's spec ledger seeds them (seedProposals). */
const proposals = new Map<string, number[]>()
/** The swarms whose list came from the spec ledger in this module's life. */
const seeded = new Set<string>()
/** Proposals J couldn't read, with why, by `<swarm>/<n>`: the builder offers [Reject] for each. */
const unreadable = new Map<string, string>()

/** The template a never-saved draft came from, for its first revision's note. */
const fromTemplate = new Map<string, string>()

/** A field whose typed value didn't parse: the value and why, by element key. */
const invalidInputs = new Map<string, string>()

type LedgerCache = { seq: number; records: StoredRecord[]; tampered: string | null }
const ledgers = new Map<string, LedgerCache>()

/** The composer's When and Route, kept per swarm in $.store (15.6). */
export type ComposerPrefs = { when: 'interject' | 'queue'; route: 'direct' | 'lead' | 'parent' }
const composerPrefs = new Map<string, ComposerPrefs>()
export const composerKey = (litterDir: string, swarm: string) => `litter.swarm.composer.${litterDir}.${swarm}`

/** Recovery cards you've acted on or left, by `<swarm>:<launch>:<at>`. */
const dismissedCards = new Set<string>()

let viewSeq = 0
export const nextV = (): number => ++viewSeq

export function cachedDraft(name: string): Draft | null {
  return drafts.get(name) ?? null
}

export function putDraftCache(name: string, draft: Draft | null): void {
  if (draft === null) drafts.delete(name)
  else drafts.set(name, draft)
}

export function stripOf(name: string): StripCheck | null {
  return strips.get(name) ?? null
}

export function markStripDue(name: string, editedAt: number): void {
  const cur = strips.get(name)
  strips.set(name, { check: cur?.check ?? null, health: cur?.health ?? null, error: cur?.error ?? null, due: true, at: cur?.at ?? 0, editedAt })
}

/** A check from elsewhere (a template's instantiate) stands as the strip's. */
export function putStrip(name: string, check: SpecCheck | null, at: number): void {
  strips.set(name, { check, health: null, error: null, due: true, at, editedAt: 0 })
}

export function noteProposal(name: string, n: number): void {
  const list = proposals.get(name) ?? []
  if (!list.includes(n)) proposals.set(name, [...list, n].sort((a, b) => a - b))
}

export function dropProposal(name: string, n: number): void {
  const list = (proposals.get(name) ?? []).filter(x => x !== n)
  if (list.length === 0) proposals.delete(name)
  else proposals.set(name, list)
  unreadable.delete(`${name}/${n}`)
}

/** The swarm's staged proposals this session has been told of and not decided. */
export const pendingProposals = (name: string): number[] => proposals.get(name) ?? []

/**
 * The swarm's undecided proposals from J's spec ledger, in place of what
 * module memory holds: after a reload, or a decision in another session. A
 * failed read leaves the list as it was.
 */
export async function seedProposals(p: Ports, name: string): Promise<void> {
  const litterDir = session().litterDir
  if (!litterDir) return
  seeded.add(name)
  try {
    const list = await owners().undecidedProposals(p, litterDir, name)
    if (list.length === 0) proposals.delete(name)
    else proposals.set(name, [...list])
    for (const key of [...unreadable.keys()]) if (key.startsWith(`${name}/`) && !list.includes(Number(key.slice(name.length + 1)))) unreadable.delete(key)
  } catch (err) {
    p.log(`swarm pane: the proposals of ${name} weren't read from its ledger: ${errText(err)}`)
  }
}

/** Whether this module's list for the swarm came from the ledger yet. */
export const proposalsSeeded = (name: string): boolean => seeded.has(name)

/** A proposal J's readProposal threw on (null once it reads again). */
export function noteUnreadable(name: string, n: number, error: string | null): void {
  if (error === null) unreadable.delete(`${name}/${n}`)
  else unreadable.set(`${name}/${n}`, error)
}

export function setFromTemplate(name: string, template: string | null): void {
  if (template === null) fromTemplate.delete(name)
  else fromTemplate.set(name, template)
}

export const templateOf = (name: string): string | null => fromTemplate.get(name) ?? null

export function setInvalid(key: string, why: string | null): void {
  if (why === null) invalidInputs.delete(key)
  else invalidInputs.set(key, why)
}

export function dismissCard(key: string): void {
  dismissedCards.add(key)
}

export const cardKey = (c: { swarm: string; launch: string; at: number }) => `${c.swarm}:${c.launch}:${c.at}`

/** Tests: a fresh module's memory. */
export function resetViewForTests(): void {
  swarmNav = null
  doctorNav = null
  restored = false
  drafts.clear()
  strips.clear()
  invalidInputs.clear()
  ledgers.clear()
  composerPrefs.clear()
  dismissedCards.clear()
  proposals.clear()
  seeded.clear()
  unreadable.clear()
  fromTemplate.clear()
  viewSeq = 0
  rev = 0
  fakeOwners = {}
}

// ---------------------------------------------------------------------------
// Text, time and color

/** U+2028 and U+2029, which end a line in JavaScript source, so they're built here, not written. */
const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, 'g')

/**
 * Text from outside (a report, a brief, a spec value, an id or a model from a
 * project template) made safe to draw, cut to `max`. One cleaner for the
 * panes and O's summary, summary.ts's plainText: no terminal sequence, no
 * control character but newline, no zero-width or bidi override (a report
 * could otherwise reorder what a row says); tabs as spaces.
 */
export function clean(text: unknown, max = 2000): string {
  const s = typeof text === 'string' ? text : text === undefined || text === null ? '' : String(text)
  return cut(plainText(s.replace(LINE_SEPARATORS, '\n')), max)
}

const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s)

/** One line: newlines folded into spaces. */
export const oneLine = (text: unknown, max = 160): string =>
  cut(
    clean(text, max * 4)
      .replace(/\s*\n\s*/g, ' ')
      .trim(),
    max,
  )

/** The first non-empty line. */
export const firstLine = (text: unknown, max = 120): string => oneLine(clean(text, 4000).split('\n').find(l => l.trim() !== '') ?? '', max)

/**
 * A line litter hands the model too (a refusal, a thrown error), as the person
 * is shown it: without its leading `litter: `. The engine already puts the
 * plugin's name before a toast, a command's reply and a log line (2.1.290,
 * JXe), while the model's copy keeps the prefix to say which plugin refused.
 */
export const unprefixed = (line: string): string => (line.startsWith('litter: ') ? line.slice('litter: '.length) : line)

/** A short JSON of a spec value, for a diff row. */
export function short(value: unknown, max = 60): string {
  if (value === undefined) return 'not set'
  const text = typeof value === 'string' ? JSON.stringify(value) : (JSON.stringify(value) ?? String(value))
  return oneLine(text, max)
}

export function span(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export const ago = (ms: number): string => `${span(ms)} ago`

/** HH:MM in the mod's local time. */
export function clockAt(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** 15.6's table, its keys from ui/style.ts. */
export const COLOR = {
  running: STYLE.running,
  done: STYLE.done,
  failed: STYLE.failed,
  waiting: STYLE.warning,
  idle: STYLE.idle,
  you: STYLE.needsYou,
  /** Secondary text: every use carries words, so `muted`, not `faint`. */
  subtle: STYLE.muted,
  added: STYLE.added,
  removed: STYLE.removed,
  changed: STYLE.changed,
  link: STYLE.link,
  sha: STYLE.sha,
  path: STYLE.path,
  draft: STYLE.draft,
} as const

/** Each orchestrator's identity color, in order, red last (it reads as an error). Its workers take it, dimmed. */
export const ORCHESTRATOR_COLORS = IDENTITY

/** Enforcement badges, strongest to weakest. */
export const BADGE_COLOR: Record<SwarmBadge, string> = {
  engine: STYLE.enforcedEngine,
  litter: STYLE.enforcedLitter,
  prompt: STYLE.enforcedPrompt,
  '—': STYLE.faint,
}

const SEVERITY: Record<'ok' | 'info' | 'warning' | 'error', { glyph: string; color: string }> = {
  ok: { glyph: '✓', color: COLOR.done },
  info: { glyph: '·', color: STYLE.muted },
  warning: { glyph: '!', color: COLOR.waiting },
  error: { glyph: '✕', color: COLOR.failed },
}

// ---------------------------------------------------------------------------
// The tree

/** The lead's row id: `@` can't start a node id, so no node takes it. */
export const LEAD_ROW = '@lead'
const UNATTACHED = '~/'
const MAX_ROWS = 200

const detailOf = (n: SwarmNode): string => [n.model, n.effort].filter((x): x is string => typeof x === 'string' && x !== '').join(' · ')

/**
 * The tree as the builder draws it (15.5): the lead, each orchestrator in
 * spec order with its identity color, and under each node the workers its
 * `spawns` names, a worker under each parent that spawns it. A worker no
 * reachable node spawns is listed at the end as unattached, and a spawn of an
 * unknown id or a cycle is marked, so validation's errors have rows to point at.
 */
export function treeRows(spec: SwarmSpec, mark?: (node: string) => { mark: string; color: string } | null): SwarmTreeRow[] {
  const byId = new Map<string, SwarmNode>()
  for (const n of Array.isArray(spec.nodes) ? spec.nodes : []) if (n && typeof n.id === 'string') byId.set(n.id, n)
  const rows: SwarmTreeRow[] = [
    { id: LEAD_ROW, node: null, kind: 'lead', depth: 0, label: 'lead (this session)', detail: '', color: null, dim: false, mark: null, markColor: null },
  ]
  const reached = new Set<string>()
  const marked = (id: string) => mark?.(id) ?? null
  const walk = (node: SwarmNode, rowId: string, depth: number, color: string, path: string[]) => {
    const spawns = node.spawns && typeof node.spawns === 'object' ? node.spawns : {}
    for (const [w, count] of Object.entries(spawns)) {
      if (rows.length >= MAX_ROWS) return
      const id = `${rowId}/${w}`
      const child = byId.get(w)
      const label = `${clean(w, 40)} ≤${clean(count, 6)}`
      if (!child) {
        rows.push({ id, node: w, kind: 'worker', depth, label, detail: 'no such node', color, dim: true, mark: '!', markColor: COLOR.failed })
        continue
      }
      reached.add(w)
      const cycle = path.includes(w)
      const m = cycle ? { mark: '!', color: COLOR.failed } : marked(w)
      rows.push({ id, node: w, kind: child.kind === 'orchestrator' ? 'orchestrator' : 'worker', depth, label, detail: cycle ? 'spawns a node above it' : clean(detailOf(child), 60), color, dim: true, mark: m?.mark ?? null, markColor: m?.color ?? null })
      if (!cycle && depth < 12) walk(child, id, depth + 1, color, [...path, w])
    }
  }
  let i = 0
  for (const n of byId.values()) {
    if (n.kind !== 'orchestrator' || rows.length >= MAX_ROWS) continue
    reached.add(n.id)
    const color = ORCHESTRATOR_COLORS[i++ % ORCHESTRATOR_COLORS.length]!
    const m = marked(n.id)
    rows.push({ id: n.id, node: n.id, kind: 'orchestrator', depth: 1, label: clean(n.id, 40), detail: clean(detailOf(n), 60), color, dim: false, mark: m?.mark ?? null, markColor: m?.color ?? null })
    walk(n, n.id, 2, color, [n.id])
  }
  for (const n of byId.values()) {
    if (reached.has(n.id) || rows.length >= MAX_ROWS) continue
    const m = marked(n.id)
    rows.push({
      id: `${UNATTACHED}${n.id}`,
      node: n.id,
      kind: n.kind === 'orchestrator' ? 'orchestrator' : 'worker',
      depth: 1,
      label: clean(n.id, 40),
      detail: 'not spawned by any node',
      color: null,
      dim: true,
      mark: m?.mark ?? '!',
      markColor: m?.color ?? COLOR.waiting,
    })
  }
  return rows
}

/** What a tree row names in a spec: the lead, or a node with the parent it sits under there (null under the lead, or unattached). */
export type RowTarget = { kind: 'lead' } | { kind: 'node'; node: SwarmNode; parent: SwarmNode | null; unattached: boolean }

export function resolveRow(spec: SwarmSpec, rowId: string): RowTarget | null {
  if (rowId === LEAD_ROW) return { kind: 'lead' }
  const nodes = Array.isArray(spec.nodes) ? spec.nodes : []
  const byId = (id: string) => nodes.find(n => n.id === id) ?? null
  if (rowId.startsWith(UNATTACHED)) {
    const node = byId(rowId.slice(UNATTACHED.length))
    return node ? { kind: 'node', node, parent: null, unattached: true } : null
  }
  const ids = rowId.split('/')
  let parent: SwarmNode | null = null
  let node: SwarmNode | null = null
  for (const [i, id] of ids.entries()) {
    const next = byId(id)
    if (!next) return null
    if (i === 0 && next.kind !== 'orchestrator') return null
    if (i > 0 && !(node?.spawns && Object.hasOwn(node.spawns, id))) return null
    parent = node
    node = next
  }
  return node ? { kind: 'node', node, parent, unattached: false } : null
}

/** Every worker id, for the tree's "add worker ▸". */
export const workerIds = (spec: SwarmSpec): string[] =>
  (Array.isArray(spec.nodes) ? spec.nodes : []).filter(n => n.kind === 'worker').map(n => n.id)

// ---------------------------------------------------------------------------
// The inspector's fields (15.3's table: what unset means, who enforces it)

/** The key of a node field's element: `swarm:builder:field:<swarm>/<node>/<path>`, `@lead` for the swarm's own. */
export const fieldKey = (swarm: string, node: string, path: string) => `swarm:builder:field:${swarm}/${node}/${path}`
export const spawnKey = (swarm: string, node: string, worker: string) => `swarm:builder:spawn:${swarm}/${node}/${worker}`
export const spawnAddKey = (swarm: string, node: string) => `swarm:builder:spawn-add:${swarm}/${node}`

type SetResult = { node: SwarmNode } | { error: string }

export type FieldDef = {
  path: string
  label: string
  kind: 'select' | 'input'
  badge: SwarmBadge
  /** What applies while it's unset (15.3's "Unset means"). */
  unset: string
  only?: 'orchestrator' | 'worker'
  options?: (node: SwarmNode, ctx: FieldCtx) => SwarmOption[]
  placeholder?: string
  shown?: (node: SwarmNode) => boolean
  get: (node: SwarmNode) => string
  set: (node: SwarmNode, value: string) => SetResult
}

export type FieldCtx = { models: string[] }

const NOT_SET: SwarmOption = { value: '', label: 'not set' }
const yesNo = (yes = 'yes', no = 'no'): SwarmOption[] => [NOT_SET, { value: 'yes', label: yes }, { value: 'no', label: no }]

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The node with `path` set to `value`, or removed when `value` is undefined; an object left empty goes too. */
export function withPath(node: SwarmNode, path: string, value: unknown): SwarmNode {
  const parts = path.split('.')
  const put = (obj: Record<string, unknown>, i: number): Record<string, unknown> => {
    const out = { ...obj }
    const k = parts[i]!
    if (i === parts.length - 1) {
      if (value === undefined) delete out[k]
      else out[k] = value
      return out
    }
    const inner = put(isObj(out[k]) ? (out[k] as Record<string, unknown>) : {}, i + 1)
    if (Object.keys(inner).length === 0) delete out[k]
    else out[k] = inner
    return out
  }
  return put(node as unknown as Record<string, unknown>, 0) as unknown as SwarmNode
}

const getPath = (node: SwarmNode, path: string): unknown =>
  path.split('.').reduce<unknown>((v, k) => (isObj(v) ? v[k] : undefined), node as unknown)

const csv = (value: string): string[] =>
  value
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '')

const listText = (v: unknown, sep = ', '): string => (Array.isArray(v) ? v.filter(x => typeof x === 'string').join(sep) : '')

/** A whole number above 0, or undefined for empty. */
function count(value: string): number | undefined | null {
  const t = value.trim()
  if (t === '') return undefined
  if (!/^[0-9]+$/.test(t)) return null
  const n = Number(t)
  return n > 0 && Number.isSafeInteger(n) ? n : null
}

const boolField = (path: string, label: string, unset: string, yes?: string, no?: string, only?: 'orchestrator' | 'worker'): FieldDef => ({
  path,
  label,
  kind: 'select',
  badge: 'litter',
  unset,
  only,
  options: () => yesNo(yes, no),
  get: n => {
    const v = getPath(n, path)
    return v === true ? 'yes' : v === false ? 'no' : ''
  },
  set: (n, v) => ({ node: withPath(n, path, v === 'yes' ? true : v === 'no' ? false : undefined) }),
})

const listField = (path: string, label: string, badge: SwarmBadge, unset: string, placeholder: string, sep: ',' | ';' = ','): FieldDef => ({
  path,
  label,
  kind: 'input',
  badge,
  unset,
  placeholder,
  get: n => listText(getPath(n, path), sep === ',' ? ', ' : '; '),
  set: (n, v) => {
    const items = sep === ',' ? csv(v) : v.split(';').map(s => s.trim()).filter(s => s !== '')
    return { node: withPath(n, path, items.length === 0 ? undefined : items) }
  },
})

const AUTHORITY_UNSET = 'not checked by litter; the classifier, your permission rules and your hooks still apply'
/** 2b-2's grants (15.10): unset is not given, and the builder's Launch refuses them set (decision 4). */
const GRANT_UNSET = 'not given; in this version only a repair swarm a failed run starts may verify or land'
const GRANT_PATHS: readonly string[] = ['authority.verify', 'authority.land']
const REPORT_EVENTS = ['ready-to-push', 'belongs-elsewhere', 'blocked', 'done']
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions', 'auto']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

const worktreeKind = (wt: WorktreeSpec | undefined): string =>
  wt === undefined ? '' : typeof wt === 'string' ? wt : isObj(wt) && 'existing' in wt ? 'existing' : isObj(wt) && 'new' in wt ? 'new' : ''

/** The node fields, in the inspector's order (15.5's mockup), each as 15.3's table has it. */
export const NODE_FIELDS: readonly FieldDef[] = [
  {
    path: 'task',
    label: 'Task',
    kind: 'input',
    badge: 'prompt',
    unset: 'the lead writes the first task from the goal and your request',
    only: 'orchestrator',
    placeholder: 'the first task',
    get: n => (typeof n.task === 'string' ? n.task : ''),
    set: (n, v) => ({ node: withPath(n, 'task', v.trim() === '' ? undefined : v) }),
  },
  {
    path: 'model',
    label: 'Model',
    kind: 'select',
    badge: 'engine',
    unset: "the parent's model",
    options: (n, ctx) => {
      const opts: SwarmOption[] = [NOT_SET, { value: 'inherit', label: 'inherit' }, ...ctx.models.map(m => ({ value: m, label: m }))]
      // The value as the field shows it (inspectorFor cleans it), so the Select finds it among its options.
      const model = typeof n.model === 'string' ? clean(n.model, 2000) : ''
      if (model !== '' && !opts.some(o => o.value === model)) opts.push({ value: model, label: clean(model, 80) })
      return opts
    },
    get: n => (typeof n.model === 'string' ? n.model : ''),
    set: (n, v) => ({ node: withPath(n, 'model', v === '' ? undefined : v) }),
  },
  {
    path: 'model.id',
    label: 'Model id',
    kind: 'input',
    badge: 'engine',
    unset: "the parent's model",
    placeholder: 'any id or alias',
    get: n => (typeof n.model === 'string' ? n.model : ''),
    set: (n, v) => ({ node: withPath(n, 'model', v.trim() === '' ? undefined : v.trim()) }),
  },
  {
    path: 'effort',
    label: 'Effort',
    kind: 'select',
    badge: 'engine',
    unset: "the session's",
    options: () => [NOT_SET, ...EFFORTS.map(e => ({ value: e, label: e }))],
    get: n => (typeof n.effort === 'string' ? n.effort : ''),
    set: (n, v) => (v === '' || EFFORTS.includes(v) ? { node: withPath(n, 'effort', v === '' ? undefined : v) } : { error: `effort is one of ${EFFORTS.join(', ')}` }),
  },
  {
    path: 'worktree',
    label: 'Worktree',
    kind: 'select',
    badge: 'litter',
    unset: "inherit: the parent's directory",
    options: n => [
      NOT_SET,
      { value: 'inherit', label: 'inherit' },
      ...(n.kind === 'worker' ? [{ value: 'own', label: 'own (one per instance)' }] : []),
      { value: 'none', label: "none (the session's directory)" },
      { value: 'existing', label: 'existing worktree' },
      { value: 'new', label: 'new worktree' },
    ],
    get: n => worktreeKind(n.worktree),
    set: (n, v) => {
      const cur = n.worktree
      if (v === '') return { node: withPath(n, 'worktree', undefined) }
      if (v === 'inherit' || v === 'none' || (v === 'own' && n.kind === 'worker')) return { node: withPath(n, 'worktree', v) }
      if (v === 'existing') return { node: withPath(n, 'worktree', { existing: isObj(cur) && 'existing' in cur ? cur.existing : '' }) }
      if (v === 'new') return { node: withPath(n, 'worktree', isObj(cur) && 'new' in cur ? cur : { new: { from: 'HEAD', branch: '' } }) }
      return { error: `worktree is inherit, ${n.kind === 'worker' ? 'own, ' : ''}none, existing or new` }
    },
  },
  {
    path: 'worktree.existing',
    label: '  path',
    kind: 'input',
    badge: 'litter',
    unset: 'a registered worktree of this repository',
    placeholder: '.claude/worktrees/<name>',
    shown: n => worktreeKind(n.worktree) === 'existing',
    get: n => (isObj(n.worktree) && 'existing' in n.worktree ? String(n.worktree.existing) : ''),
    set: (n, v) => ({ node: { ...n, worktree: { existing: v.trim() } } }),
  },
  {
    path: 'worktree.new.from',
    label: '  from',
    kind: 'input',
    badge: 'litter',
    unset: 'the ref the worktree starts at',
    placeholder: 'a ref',
    shown: n => worktreeKind(n.worktree) === 'new',
    get: n => (isObj(n.worktree) && 'new' in n.worktree ? String(n.worktree.new.from) : ''),
    set: (n, v) => ({ node: { ...n, worktree: { new: { from: v.trim(), branch: isObj(n.worktree) && 'new' in n.worktree ? n.worktree.new.branch : '' } } } }),
  },
  {
    path: 'worktree.new.branch',
    label: '  branch',
    kind: 'input',
    badge: 'litter',
    unset: 'the branch Launch creates',
    placeholder: 'a new branch name',
    shown: n => worktreeKind(n.worktree) === 'new',
    get: n => (isObj(n.worktree) && 'new' in n.worktree ? String(n.worktree.new.branch) : ''),
    set: (n, v) => ({ node: { ...n, worktree: { new: { from: isObj(n.worktree) && 'new' in n.worktree ? n.worktree.new.from : 'HEAD', branch: v.trim() } } } }),
  },
  boolField('spawnOther', 'Spawn other', 'it may spawn other agent types, held to its own scope'),
  boolField('serial', 'Serial', 'instances run at once only where validation finds their directories distinct', undefined, undefined, 'worker'),
  listField('paths', 'Paths', 'litter', 'anywhere the session may write', 'src/, docs/README.md'),
  boolField('authority.commit', 'Commit', AUTHORITY_UNSET, 'allowed', 'not allowed'),
  {
    path: 'authority.push',
    label: 'Push',
    kind: 'select',
    badge: 'litter',
    unset: AUTHORITY_UNSET,
    options: () => [NOT_SET, { value: 'none', label: 'none' }, { value: 'own-branch', label: 'own branch' }, { value: 'any', label: 'any' }],
    get: n => (typeof n.authority?.push === 'string' ? n.authority.push : ''),
    set: (n, v) =>
      v === '' || v === 'none' || v === 'own-branch' || v === 'any'
        ? { node: withPath(n, 'authority.push', v === '' ? undefined : v) }
        : { error: 'push is none, own-branch or any' },
  },
  boolField('authority.forcePush', 'Force-push', AUTHORITY_UNSET),
  boolField('authority.rewriteHistory', 'Rewrite history', AUTHORITY_UNSET),
  boolField('authority.worktreeOps', 'Worktree ops', AUTHORITY_UNSET),
  boolField('authority.verify', 'Verify', GRANT_UNSET, 'given', 'not given'),
  boolField('authority.land', 'Land', GRANT_UNSET, 'given', 'not given'),
  boolField('verdicts', 'Verdicts', "its verdicts aren't the critic's veto a land needs; one that is writes nothing"),
  listField('tools.allow', 'Tools allow', 'engine', "whatever tools the parent's spawn would give", 'Read, Grep, Bash'),
  listField('tools.deny', 'Tools deny', 'engine', "whatever tools the parent's spawn would give", 'Edit, Write, NotebookEdit'),
  listField('bash.deny', 'Bash deny', 'litter', 'nothing extra', 'git reset --hard; rm -rf', ';'),
  {
    path: 'maxTurns',
    label: 'Max turns',
    kind: 'input',
    badge: 'engine',
    unset: "the engine's default",
    placeholder: 'a whole number',
    get: n => (typeof n.maxTurns === 'number' ? String(n.maxTurns) : ''),
    set: (n, v) => {
      const c = count(v)
      return c === null ? { error: 'max turns is a whole number above 0' } : { node: withPath(n, 'maxTurns', c) }
    },
  },
  {
    path: 'permissionMode',
    label: 'Permission mode',
    kind: 'select',
    badge: 'engine',
    unset: "the parent's",
    options: () => [NOT_SET, ...PERMISSION_MODES.map(m => ({ value: m, label: m }))],
    get: n => (typeof n.permissionMode === 'string' ? n.permissionMode : ''),
    set: (n, v) => ({ node: withPath(n, 'permissionMode', v === '' ? undefined : v) }),
  },
  {
    path: 'report',
    label: 'Reports',
    kind: 'input',
    badge: 'prompt',
    unset: 'report only when blocked',
    placeholder: REPORT_EVENTS.join(', '),
    get: n => listText(n.report),
    set: (n, v) => {
      const items = csv(v)
      const bad = items.filter(x => !REPORT_EVENTS.includes(x))
      if (bad.length > 0) return { error: `reports are ${REPORT_EVENTS.join(', ')}; not ${bad.join(', ')}` }
      return { node: withPath(n, 'report', items.length === 0 ? undefined : items) }
    },
  },
]

/** The swarm's own fields, on the lead's row. */
export const SWARM_FIELDS = [
  { path: 'goal', label: 'Goal', badge: 'prompt' as SwarmBadge, unset: 'no goal: every node prompt carries it, so set one', placeholder: 'what the swarm is for' },
  {
    path: 'limits.maxAgentsAtOnce',
    label: 'Max agents at once',
    badge: 'litter' as SwarmBadge,
    unset: "only the engine's cap, which two cases skip (15.2)",
    placeholder: 'a whole number',
  },
] as const

/** Applies one swarm-level field to a spec, or why the value doesn't parse. */
export function setSwarmField(spec: SwarmSpec, path: string, value: string): { spec: SwarmSpec } | { error: string } {
  if (path === 'goal') return { spec: { ...spec, goal: value } }
  if (path === 'limits.maxAgentsAtOnce') {
    const c = count(value)
    if (c === null) return { error: 'max agents at once is a whole number above 0' }
    const limits = { ...(spec.limits ?? {}) }
    if (c === undefined) delete limits.maxAgentsAtOnce
    else limits.maxAgentsAtOnce = c
    const out: SwarmSpec = { ...spec, limits }
    if (Object.keys(limits).length === 0) delete out.limits
    return { spec: out }
  }
  return { error: `no swarm field ${path}` }
}

const noteFor = (unset: boolean, def: { unset: string }, invalid: string | undefined): { note: string | null; noteColor: string | null } =>
  invalid !== undefined
    ? { note: invalid, noteColor: COLOR.failed }
    : unset
      ? { note: `not set: ${def.unset}`, noteColor: COLOR.idle }
      : { note: null, noteColor: null }

/**
 * Each node field's heading in the inspector (WP-DD; the review's "group
 * execution, limits, tools, paths, and authority"): what it runs as, how
 * much of it runs, its tools, where it works, and what it may do to the repo.
 */
const GROUP_OF: Readonly<Record<string, SwarmFieldGroup>> = {
  kind: 'execution',
  task: 'execution',
  model: 'execution',
  'model.id': 'execution',
  effort: 'execution',
  permissionMode: 'execution',
  report: 'execution',
  maxTurns: 'limits',
  spawns: 'limits',
  serial: 'limits',
  spawnOther: 'limits',
  'tools.allow': 'tools',
  'tools.deny': 'tools',
  'bash.deny': 'tools',
  worktree: 'paths',
  'worktree.existing': 'paths',
  'worktree.new.from': 'paths',
  'worktree.new.branch': 'paths',
  paths: 'paths',
  verdicts: 'authority',
}
const groupOf = (path: string): SwarmFieldGroup => (path.startsWith('authority.') ? 'authority' : (GROUP_OF[path] ?? 'execution'))

function inspectorFor(swarm: string, spec: SwarmSpec, target: RowTarget, inputs: Record<string, string>, ctx: FieldCtx): SwarmInspector {
  if (target.kind === 'lead') {
    const fields: SwarmField[] = [
      { key: fieldKey(swarm, LEAD_ROW, 'name'), label: 'Name', kind: 'text', value: clean(spec.name, 40), options: [], placeholder: '', badge: null, note: null, noteColor: null, group: 'swarm' },
    ]
    for (const f of SWARM_FIELDS) {
      const key = fieldKey(swarm, LEAD_ROW, f.path)
      const raw = f.path === 'goal' ? spec.goal : spec.limits?.maxAgentsAtOnce
      const value = inputs[key] ?? (raw === undefined || raw === null ? '' : String(raw))
      const unset = raw === undefined || raw === ''
      fields.push({
        key,
        label: f.label,
        kind: 'input',
        value: clean(value, 2000),
        options: [],
        placeholder: f.placeholder,
        badge: f.badge,
        ...noteFor(unset, f, invalidInputs.get(key)),
        group: f.path === 'goal' ? 'swarm' : 'limits',
      })
    }
    return { title: 'the swarm (the lead is this session)', fields }
  }
  const node = target.node
  const id = node.id
  const fields: SwarmField[] = [
    {
      key: fieldKey(swarm, id, 'kind'),
      label: 'Kind',
      kind: 'text',
      value: node.kind === 'orchestrator' ? 'orchestrator (its parent is the lead)' : `worker${target.parent ? ` under ${target.parent.id}` : ''}`,
      options: [],
      placeholder: '',
      badge: null,
      note: null,
      noteColor: null,
      group: 'execution',
    },
  ]
  for (const f of NODE_FIELDS) {
    if (f.only && f.only !== node.kind) continue
    if (f.shown && !f.shown(node)) continue
    const key = fieldKey(swarm, id, f.path)
    const current = f.get(node)
    const value = f.kind === 'input' ? (inputs[key] ?? current) : current
    const unset = current === ''
    // `—` is an unset field nothing checks; an unset grant is checked: it's not given.
    const badge: SwarmBadge = f.path.startsWith('authority.') && !GRANT_PATHS.includes(f.path) && unset ? '—' : f.badge
    fields.push({
      key,
      label: f.label,
      kind: f.kind,
      value: clean(value, 2000),
      options: f.kind === 'select' ? (f.options?.(node, ctx) ?? [NOT_SET]) : [],
      placeholder: f.placeholder ?? '',
      badge,
      ...noteFor(unset && f.path !== 'model.id', f, invalidInputs.get(key)),
      group: groupOf(f.path),
    })
    if (f.path === 'worktree') fields.push(...spawnFields(swarm, spec, node, inputs))
  }
  return { title: `${clean(id, 40)} · ${node.kind}`, fields }
}

/** Spawns (15.5's "reviewer [3] fixer [2] [+]"): a count per worker, and an "add" pick. */
function spawnFields(swarm: string, spec: SwarmSpec, node: SwarmNode, inputs: Record<string, string>): SwarmField[] {
  const spawns = node.spawns && isObj(node.spawns) ? node.spawns : {}
  const out: SwarmField[] = []
  for (const [w, c] of Object.entries(spawns)) {
    const key = spawnKey(swarm, node.id, w)
    const invalid = invalidInputs.get(key)
    out.push({
      key,
      label: `Spawns ${clean(w, 32)}`,
      kind: 'input',
      value: clean(inputs[key] ?? String(c), 8),
      options: [],
      placeholder: 'at once; empty removes',
      badge: 'litter',
      note: invalid ?? null,
      noteColor: invalid ? COLOR.failed : null,
      group: 'limits',
    })
  }
  const others = workerIds(spec).filter(w => w !== node.id && !Object.hasOwn(spawns, w))
  out.push({
    key: spawnAddKey(swarm, node.id),
    label: Object.keys(spawns).length === 0 ? 'Spawns' : '',
    kind: 'select',
    value: '',
    options: [{ value: '', label: 'add a worker' }, ...others.map(w => ({ value: w, label: clean(w, 40) })), { value: '+new', label: 'a new worker' }],
    placeholder: '',
    badge: 'litter',
    note: Object.keys(spawns).length === 0 ? 'not set: it may spawn no swarm types' : null,
    noteColor: Object.keys(spawns).length === 0 ? COLOR.idle : null,
    group: 'limits',
  })
  return out
}

// ---------------------------------------------------------------------------
// Reading what the views draw

const sessionDir = (): string | null => session().litterDir

async function readTextOrNull(p: Ports, path: string): Promise<string | null> {
  try {
    return (await p.fs.exists(path)) ? await p.fs.read(path) : null
  } catch {
    return null
  }
}

/** A swarm's draft: the one in hand, J's in $.store, the saved revision as a draft, or a new one. */
export async function loadDraft(p: Ports, litterDir: string, name: string): Promise<Draft> {
  const cached = drafts.get(name)
  if (cached) return cached
  const o = owners()
  const draft = await o.readDraft(p, litterDir, name)
  if (draft) {
    drafts.set(name, draft)
    return draft
  }
  // No draft: the saved revision as one, read again each time (a save or an
  // accept elsewhere moves it), held only once an edit writes it.
  const saved = await o.readSaved(p, litterDir, name)
  return saved
    ? { base: saved.revision, edits: [], spec: saved.spec, briefs: { ...saved.briefs }, updatedAt: await p.now() }
    : { base: 0, edits: [], spec: { name, goal: '', nodes: [] }, briefs: {}, updatedAt: await p.now() }
}

/** A node's brief as validation and the builder use it: the draft's, else the saved file. */
export async function briefOf(p: Ports, litterDir: string, name: string, draft: Draft, node: string): Promise<string | null> {
  const t = draft.briefs[node]
  if (typeof t === 'string') return t
  return readTextOrNull(p, swarmBriefPath(litterDir, name, node))
}

/**
 * J's validation and health check over the draft, into the strip (the pane's
 * tick, after an edit, or [Validate]). Validation is J's validateSaved over
 * the draft's spec and briefs, what [Save] hands saveRevision, so the strip
 * and [Save] agree (a brief only on disk passes neither).
 */
export async function runCheck(p: Ports, name: string): Promise<StripCheck> {
  const litterDir = sessionDir()
  const at = await p.now()
  const editedAt = strips.get(name)?.editedAt ?? 0
  // An edit made while the check ran leaves the strip due again.
  const settle = (s: Omit<StripCheck, 'due' | 'editedAt'>): StripCheck => {
    const latest = strips.get(name)?.editedAt ?? 0
    const out: StripCheck = { ...s, due: latest > editedAt, editedAt: latest }
    strips.set(name, out)
    return out
  }
  if (!litterDir) return settle({ check: null, health: null, error: 'no litter directory', at })
  let check: SpecCheck | null = null
  let health: HealthReport | null = null
  const errors: string[] = []
  try {
    const draft = await loadDraft(p, litterDir, name)
    const o = owners()
    try {
      check = await o.validateSaved(p, litterDir, name, { spec: draft.spec, briefs: draft.briefs })
    } catch (err) {
      errors.push(`validation didn't run: ${errText(err)}`)
    }
    try {
      health = await o.checkHealth(p, { spec: draft.spec, litterDir })
    } catch (err) {
      errors.push(`the health check didn't run: ${errText(err)}`)
    }
  } catch (err) {
    errors.push(`the draft can't be read: ${errText(err)}`)
  }
  return settle({ check, health, error: errors.length > 0 ? errors.join('; ') : null, at })
}

const STRIP_ROWS = 8

export function stripRows(s: StripCheck | null): SwarmStripRow[] {
  if (!s) return []
  const rows: SwarmStripRow[] = []
  if (s.error) rows.push({ ...SEVERITY.error, text: oneLine(s.error, 200) })
  for (const e of s.check?.errors ?? []) rows.push({ ...SEVERITY.error, text: oneLine(`${e.field}: ${e.error}`, 200) })
  for (const w of s.check?.warnings ?? []) rows.push({ ...SEVERITY.warning, text: oneLine(`${w.field}: ${w.error}`, 200) })
  const health = s.health?.rows ?? []
  const order = { error: 0, warning: 1, ok: 2, info: 3 } as const
  for (const r of [...health].sort((a, b) => order[a.severity] - order[b.severity])) {
    rows.push({ ...SEVERITY[r.severity], text: oneLine(r.severity === 'ok' || r.detail === '' ? r.title : `${r.title}: ${r.detail}`, 200) })
  }
  if (s.check?.ok && s.check.errors.length === 0 && !rows.some(r => r.glyph === '✕')) rows.unshift({ ...SEVERITY.ok, text: 'the spec validates' })
  if (rows.length <= STRIP_ROWS) return rows
  const shown = rows.slice(0, STRIP_ROWS - 1)
  shown.push({ glyph: '…', color: COLOR.subtle, text: `${rows.length - shown.length} more: [Doctor] lists every check` })
  return shown
}

/** One launch ledger's records, read again only when its head moved. */
async function launchRecords(p: Ports, litterDir: string, name: string, launch: string): Promise<LedgerCache> {
  const dir = launchDir(litterDir, name, launch)
  const head = (await p.store.get(headKey(dir))) as Head | undefined
  const cached = ledgers.get(dir)
  if (cached && head && cached.seq === head.seq) return cached
  const read = await readLaunchLedger(p, litterDir, name, launch)
  const out: LedgerCache = {
    seq: read.head?.seq ?? 0,
    // The kinds the views draw; the last 400, so a long launch stays light.
    records: read.records.filter(r => r.kind !== 'swarm.instance').slice(-400),
    tampered: read.tampered ? `the launch ledger is broken at record ${read.tampered.seq} (${read.tampered.reason}); the log stops there` : null,
  }
  ledgers.set(dir, out)
  return out
}

/** The head seq of a ledger folder, from $.store: the pane's change check. */
export async function headSeq(p: Ports, dir: string): Promise<number> {
  const head = (await p.store.get(headKey(dir))) as Head | undefined
  return head?.seq ?? 0
}

export async function ledgerStamp(p: Ports): Promise<string> {
  const n = swarmNav
  const litterDir = sessionDir()
  if (!n?.swarm || !litterDir) return ''
  const s = liveSwarm(n.swarm)
  const spec = await headSeq(p, swarmDir(litterDir, n.swarm))
  const launch = s ? await headSeq(p, launchDir(litterDir, n.swarm, s.launch)) : 0
  return `${spec}:${launch}`
}

// ---------------------------------------------------------------------------
// The start screen

/**
 * A view's first line (WP-DD): the swarm's name bold in the name color, then
 * what the view shows, muted unless a part names its own color (a state's,
 * beside its word). No `litter · `: the hub's header says it.
 */
function title(name: string | null, ...parts: SwarmSpan[]): SwarmSpan[] {
  return [...(name ? [{ text: clean(name, 24), color: STYLE.name, bold: true }] : []), ...parts.map(s => (s.color ? s : { ...s, color: STYLE.muted }))]
}

export const templateId = (t: { scope: string; name: string }) => `${t.scope}:${t.name}`

/** What the start screen's list says of a template (WP-DA2): its own description, else its goal's first line. */
export const listedAs = (t: { description: string; goal?: string }): string =>
  t.description.trim() !== '' ? t.description : ((t.goal ?? '').split('\n').find(l => l.trim() !== '') ?? '')

/** A template's `name` parameter, the swarm's name (every built-in has one): the start screen's Name fills it. */
export const namesTheSwarm = (param: { name: string; type: string }): boolean => param.name === 'name' && param.type === 'string'

/** The branches and worktrees offered for a list parameter (15.5, "Parameters"). */
async function suggestions(p: Ports, litterDir: string): Promise<string[]> {
  const repo = repoOf(litterDir)
  const out: string[] = []
  try {
    const b = await p.run(['git', '-C', repo, 'branch', '--format=%(refname:short)'], { timeoutMs: 5_000 })
    if (b.code === 0) out.push(...b.stdout.split('\n').map(s => s.trim()).filter(s => s !== ''))
    const w = await p.run(['git', '-C', repo, 'worktree', 'list', '--porcelain'], { timeoutMs: 5_000 })
    if (w.code === 0) {
      for (const l of w.stdout.split('\n')) if (l.startsWith('worktree ')) out.push(l.slice('worktree '.length).trim())
    }
  } catch {
    // Suggestions only.
  }
  return [...new Set(out)].slice(0, 20).map(s => clean(s, 120))
}

async function buildStart(p: Ports, n: SwarmNav): Promise<SwarmStartView> {
  const litterDir = sessionDir()
  const base = {
    view: 'start' as const,
    v: nextV(),
    // Not drawn: the start screen's headings say what it is.
    title: title(null, { text: 'new swarm' }),
    notice: n.notice,
    name: clean(n.inputs['swarm:start:name'] ?? '', 24),
    ask: clean(n.inputs['swarm:start:ask'] ?? '', 2000),
  }
  if (!litterDir) {
    return { ...base, blocked: `no litter directory: ${session().litterDirError ?? 'session.start found none'}`, templates: [], template: null, swarms: [] }
  }
  const o = owners()
  const problems: string[] = []
  let listings: TemplateListing[] = []
  try {
    listings = await o.listTemplates(p, litterDir)
  } catch (err) {
    problems.push(`templates: ${errText(err)}`)
  }
  let swarms: SwarmStartView['swarms'] = []
  try {
    swarms = (await o.listSwarms(p, litterDir)).map(s => ({ name: clean(s.name, 24), goal: oneLine(s.goal, 80), revision: s.revision, nodes: s.nodes, live: s.live }))
  } catch (err) {
    problems.push(`saved swarms: ${errText(err)}`)
  }
  let template: SwarmStartView['template'] = null
  const picked = n.template ? listings.find(t => templateId(t) === n.template) : undefined
  if (picked) {
    const hasList = picked.params.some(x => x.type === 'list')
    const sugg = hasList ? await suggestions(p, litterDir) : []
    template = {
      id: templateId(picked),
      name: clean(picked.name, 60),
      description: oneLine(picked.description, 200),
      // The Name above fills a `name` parameter (useTemplate), so it has no field of its own.
      params: picked.params.filter(x => !namesTheSwarm(x)).map(x => {
        const key = `swarm:start:param:${x.name}`
        const dflt = Array.isArray(x.default) ? x.default.join(', ') : (x.default ?? '')
        return {
          name: clean(x.name, 40),
          list: x.type === 'list',
          description: oneLine(x.description ?? '', 160),
          value: clean(n.inputs[key] ?? dflt, 2000),
          suggestions: x.type === 'list' ? sugg : [],
        }
      }),
      errors: n.templateErrors.slice(0, 12).map(e => oneLine(e, 200)),
    }
  }
  const notice = n.notice ?? (problems.length > 0 ? { text: oneLine(problems.join('; '), 300), level: 'warning' as const } : null)
  return {
    ...base,
    notice,
    blocked: null,
    templates: listings.map(t => ({ id: templateId(t), name: clean(t.name, 60), description: oneLine(listedAs(t), 120), scope: t.scope })),
    template,
    swarms,
  }
}

// ---------------------------------------------------------------------------
// The builder

async function buildBuilder(p: Ports, n: SwarmNav): Promise<SwarmBuilderView> {
  const name = n.swarm ?? ''
  const litterDir = sessionDir()
  const live = liveSwarm(name)
  const empty: SwarmTreeProps = { swarm: name, rows: [], selected: null, editable: false, workers: [] }
  const blocked = (why: string): SwarmBuilderView => ({
    view: 'builder',
    v: nextV(),
    title: title(name, { text: ' · builder' }),
    notice: n.notice,
    swarm: name,
    base: 0,
    unsaved: false,
    live: live !== null && !live.readOnly,
    blocked: why,
    goal: '',
    tree: empty,
    inspector: { title: '', fields: [] },
    brief: null,
    strip: [],
    checking: false,
    askLead: '',
    saveAs: null,
    proposals: [],
    unreadable: [],
  })
  if (!litterDir) return blocked(`no litter directory: ${session().litterDirError ?? 'session.start found none'}`)
  let draft: Draft
  try {
    draft = await loadDraft(p, litterDir, name)
  } catch (err) {
    return blocked(`the swarm store can't be read: ${errText(err)}`)
  }
  const spec = draft.spec
  const strip = strips.get(name) ?? null
  const errorNodes = new Set(
    (strip?.check?.errors ?? []).map(e => e.node ?? /^nodes\.([^.]+)/.exec(e.field)?.[1]).filter((x): x is string => typeof x === 'string'),
  )
  const rows = treeRows(spec, id => (errorNodes.has(id) ? { mark: '✕', color: COLOR.failed } : null))
  const selected = n.selected && rows.some(r => r.id === n.selected) ? n.selected : LEAD_ROW
  const target = resolveRow(spec, selected) ?? { kind: 'lead' as const }
  const models = await availableModels(p)
  const unsaved = draft.base === 0 || draft.edits.length > 0
  return {
    view: 'builder',
    v: nextV(),
    title: title(
      name,
      { text: ' · builder' },
      unsaved ? { text: draft.base > 0 ? ` (unsaved) · over rev ${draft.base}` : ' (unsaved)', color: COLOR.draft } : { text: ` · rev ${draft.base}` },
      ...(live && !live.readOnly ? [{ text: ` · ${MARK.running.glyph} live`, color: COLOR.running }] : []),
    ),
    notice: n.notice,
    swarm: name,
    base: draft.base,
    unsaved,
    live: live !== null && !live.readOnly,
    blocked: null,
    goal: clean(typeof spec.goal === 'string' ? spec.goal : '', 2000),
    // The Client draws each worker id as a menu label: cleaned, as every label is.
    tree: { swarm: name, rows, selected, editable: true, workers: workerIds(spec).map(w => clean(w, 40)) },
    inspector: inspectorFor(name, spec, target, n.inputs, { models }),
    brief: target.kind === 'node' ? await briefPanel(p, litterDir, name, draft, target.node) : null,
    strip: stripRows(strip),
    checking: strip === null || strip.due,
    askLead: clean(n.inputs[`swarm:builder:ask:${name}`] ?? '', 2000),
    saveAs: n.saveAs ? saveAsForm(name, spec, n) : null,
    proposals: pendingProposals(name).filter(x => !unreadable.has(`${name}/${x}`)),
    unreadable: pendingProposals(name).flatMap(x => {
      const error = unreadable.get(`${name}/${x}`)
      return error === undefined ? [] : [{ n: x, error: oneLine(error, 300) }]
    }),
  }
}

async function availableModels(p: Ports): Promise<string[]> {
  try {
    const v = (await p.settings()).availableModels
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '').slice(0, 40).map(x => clean(x, 80)) : []
  } catch {
    return []
  }
}

const BRIEF_LINES = 8

// A brief's links, drawn as text (15.5's briefs can come from a project
// template, which is repository content): placeholders hold what's made, so
// a later step never reads its own output. clean() has removed every control
// character, so these two can't be in the text.
const HOLD_OPEN = String.fromCharCode(1)
const HOLD_CLOSE = String.fromCharCode(2)
const HELD = new RegExp(`${HOLD_OPEN}(\\d+)${HOLD_CLOSE}`, 'g')
const LINK = /!?\[((?:[^[\]]|\[[^[\]]*\])*)\]\(\s*<?([^)\s>]*)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g
const AUTOLINK = /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>@]+)>/g
const BARE_URL = new RegExp(`\\b(?:(?:https?|file|ftp):\\/\\/|www\\.)[^\\s<>${HOLD_OPEN}${HOLD_CLOSE}]+`, 'gi')
const DEFINITION = /^ {0,3}\[((?:[^[\]]|\\.)+)\]:(\s*)(\S+)(.*)$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const CODE_SPAN = /(`+)[^`](?:[\s\S]*?[^`])?\1(?!`)/g

/** A target as text no renderer links: a code span (a backtick in it would end the span). */
const asCode = (target: string): string => `\`${target.replace(/`/g, '%60')}\``

function unlinkText(text: string): string {
  const held: string[] = []
  const hold = (s: string): string => `${HOLD_OPEN}${held.push(s) - 1}${HOLD_CLOSE}`
  // A link's label can hold another (an image in a link): again, a few times.
  let out = text
  for (let i = 0, prev = ''; i < 4 && out !== prev; i++) {
    prev = out
    out = out.replace(LINK, (_m, label: string, target: string) => `${label}${target === '' ? '' : ` (${hold(asCode(target))})`}`)
  }
  out = out
    .replace(AUTOLINK, (_m, target: string) => hold(asCode(target)))
    .replace(BARE_URL, url => {
      // As GFM does, trailing punctuation isn't part of the address.
      const tail = /[.,:;!?'")\]*_~]+$/.exec(url)?.[0] ?? ''
      return `${hold(asCode(url.slice(0, url.length - tail.length)))}${tail}`
    })
  return out.replace(HELD, (_m, i: string) => held[Number(i)] ?? '')
}

/**
 * A brief's Markdown with no link the pane would make clickable: a link or an
 * image is its text with its target after it as code, an autolink and a bare
 * address are code, and a reference definition is text, so `[x][ref]` stays
 * text too. Code spans and fenced blocks are left as written: nothing in them
 * is a link.
 */
export function unlinked(markdown: string): string {
  let fence: string | null = null
  return markdown
    .split('\n')
    .map(line => {
      const f = FENCE.exec(line)?.[1] ?? null
      if (fence !== null) {
        if (f !== null && f[0] === fence[0] && f.length >= fence.length) fence = null
        return line
      }
      if (f !== null) {
        fence = f
        return line
      }
      const def = DEFINITION.exec(line)
      if (def) return `\\[${def[1]}\\]:${def[2]}${asCode(def[3]!)}${unlinkText(def[4]!)}`
      // Only the text between code spans.
      let out = ''
      let at = 0
      for (const m of line.matchAll(CODE_SPAN)) {
        out += unlinkText(line.slice(at, m.index)) + m[0]
        at = m.index + m[0].length
      }
      return out + unlinkText(line.slice(at))
    })
    .join('\n')
}

async function briefPanel(p: Ports, litterDir: string, name: string, draft: Draft, node: SwarmNode): Promise<SwarmBriefPanel> {
  const path = swarmBriefPath(litterDir, name, node.id)
  const saved = await readTextOrNull(p, path)
  const text = typeof draft.briefs[node.id] === 'string' ? draft.briefs[node.id]! : saved
  const lines = clean(text ?? '', 8000).split('\n')
  return {
    node: node.id,
    markdown: text === null ? '' : unlinked(clean(lines.slice(0, BRIEF_LINES).join('\n'), 1500)),
    more: lines.length > BRIEF_LINES,
    // A Markdown link target: parentheses would end it early.
    href: saved === null ? null : `file://${encodeURI(path).replace(/\(/g, '%28').replace(/\)/g, '%29')}`,
    differs: saved !== null && text !== saved,
  }
}

/** What an offer's field is, in words: `nodes.<id>.task` is "<id>'s task". */
function offerLabel(field: string): string {
  if (field === 'name') return "the swarm's name"
  if (field === 'goal') return 'the goal'
  const m = /^nodes\.([^.]+)\.(.+)$/.exec(field)
  if (!m) return field
  const what: Record<string, string> = { task: 'task', 'worktree.existing': 'worktree', 'worktree.new.from': 'worktree base', 'worktree.new.branch': 'branch' }
  return `${m[1]}'s ${what[m[2]!] ?? m[2]}`
}

/**
 * The values tied to this repository or this job that saving offers as
 * parameters (15.5, "Parameters"): J's templateOffers, each picked by its
 * field. An offer with no value has nothing to make a parameter of.
 */
export function saveAsOffers(spec: SwarmSpec): ReturnType<typeof templateOffers> {
  try {
    return templateOffers(spec).filter(o => typeof o.value === 'string' && o.value !== '')
  } catch {
    // A draft too broken to walk offers nothing; validation says why.
    return []
  }
}

function saveAsForm(name: string, spec: SwarmSpec, n: SwarmNav): SwarmBuilderView['saveAs'] {
  const params = new Set(n.saveAs?.params ?? [])
  const candidates: SwarmSaveAsCandidate[] = saveAsOffers(spec).map(o => ({ id: o.field, label: clean(offerLabel(o.field), 60), value: oneLine(o.value, 80), param: params.has(o.field) }))
  return {
    name: clean(n.inputs[`swarm:builder:saveas-name:${name}`] ?? name, 24),
    description: clean(n.inputs[`swarm:builder:saveas-description:${name}`] ?? '', 400),
    scope: n.saveAs?.scope ?? 'user',
    candidates,
  }
}

// ---------------------------------------------------------------------------
// A proposal

async function proposedSpec(p: Ports, litterDir: string, name: string, n: number): Promise<SwarmSpec | null> {
  const text = await readTextOrNull(p, `${swarmProposalDir(litterDir, name, n)}/spec.json`)
  if (text === null) return null
  try {
    const v = JSON.parse(text) as unknown
    return isObj(v) && Array.isArray(v.nodes) ? (v as unknown as SwarmSpec) : null
  } catch {
    return null
  }
}

async function buildProposal(p: Ports, n: SwarmNav): Promise<SwarmProposalView | SwarmBuilderView> {
  const name = n.swarm ?? ''
  const litterDir = sessionDir()
  const back = async (why: string) => buildBuilder(p, { ...n, view: 'builder', notice: { text: why, level: 'warning' } })
  if (!litterDir || n.proposal === null) return back('no proposal to show')
  const o = owners()
  let pv
  try {
    pv = await o.readProposal(p, litterDir, name, n.proposal)
  } catch (err) {
    // J can't read it (a staged brief changed, its base revision gone): the builder says why, with [Reject].
    noteUnreadable(name, n.proposal, errText(err))
    return back(`proposal ${n.proposal} can't be read: ${errText(err)}`)
  }
  noteUnreadable(name, n.proposal, null)
  let draft: Draft
  try {
    draft = await loadDraft(p, litterDir, name)
  } catch (err) {
    return back(`the draft of ${name} can't be read: ${errText(err)}`)
  }
  if (!pv) {
    dropProposal(name, n.proposal)
    return back(`there's no proposal ${n.proposal} for ${name}`)
  }
  const spec = (await proposedSpec(p, litterDir, name, pv.n)) ?? draft.spec
  const changed = new Map<string, 'added' | 'removed' | 'changed' | 'conflict'>()
  for (const c of pv.changes) {
    const id = c.node ?? /^nodes\.([^.]+)/.exec(c.path)?.[1]
    if (!id) continue
    const nodeLevel = c.path === `nodes.${id}`
    changed.set(id, c.conflict ? 'conflict' : nodeLevel && c.kind !== 'changed' ? c.kind : (changed.get(id) ?? 'changed'))
  }
  const markOf = (id: string) => {
    const k = changed.get(id)
    if (k === 'added') return { mark: '+', color: COLOR.added }
    if (k === 'removed') return { mark: '−', color: COLOR.removed }
    if (k === 'conflict') return { mark: '!', color: COLOR.waiting }
    if (k === 'changed') return { mark: '~', color: COLOR.changed }
    return null
  }
  const rows = treeRows(spec, markOf)
  const inProposal = new Set((Array.isArray(spec.nodes) ? spec.nodes : []).map(x => x.id))
  for (const gone of draft.spec.nodes ?? []) {
    if (inProposal.has(gone.id) || changed.get(gone.id) !== 'removed' || rows.length >= MAX_ROWS) continue
    rows.push({ id: `−/${gone.id}`, node: gone.id, kind: gone.kind === 'orchestrator' ? 'orchestrator' : 'worker', depth: 1, label: clean(gone.id, 40), detail: 'removed', color: null, dim: true, mark: '−', markColor: COLOR.removed })
  }
  const picked = new Set(n.picked)
  const changes: SwarmChangeRow[] = pv.changes.map((c, index) => {
    const glyph = c.kind === 'added' ? '+' : c.kind === 'removed' ? '−' : '~'
    const color = c.kind === 'added' ? COLOR.added : c.kind === 'removed' ? COLOR.removed : COLOR.changed
    const text = c.kind === 'added' ? short(c.after, 80) : c.kind === 'removed' ? `was ${short(c.before, 80)}` : `${short(c.before, 40)} → ${short(c.after, 40)}`
    return {
      index,
      glyph,
      color,
      words: changeWords(c),
      path: oneLine(c.path, 80),
      text,
      reason: c.reason === null ? null : oneLine(c.reason, 200),
      conflict: c.conflict,
      yours: c.conflict ? short(c.yours, 60) : null,
      yoursWords: c.conflict ? valueWords(fieldOf(c), c.yours) : null,
      picked: picked.has(index),
    }
  })
  const diffLines = (lines: readonly { op: ' ' | '+' | '-'; text: string }[]): SwarmSpan[] =>
    lines.slice(0, 120).map(l => ({
      text: `${l.op === ' ' ? ' ' : l.op === '+' ? '+' : '−'} ${clean(l.text, 300)}`,
      ...(l.op === '+' ? { color: COLOR.added } : l.op === '-' ? { color: COLOR.removed } : { dim: true }),
    }))
  const withNode = nodeChanges(pv)
  const briefs = pv.briefs.map(b => {
    // A new or removed node's brief is accepted or rejected with its node (15.5): its node's pick is its own.
    const nodeAt = withNode.get(b.node)
    const open = n.diff === b.node
    return {
      node: clean(b.node, 40),
      glyph: b.kind === 'added' ? '+' : b.kind === 'removed' ? '−' : '~',
      color: b.kind === 'added' ? COLOR.added : b.kind === 'removed' ? COLOR.removed : COLOR.changed,
      reason: b.reason === null ? null : oneLine(b.reason, 200),
      conflict: b.conflict,
      withNode: nodeAt !== undefined,
      open,
      lines: open ? diffLines(b.lines) : [],
      yoursLines: open && b.conflict ? diffLines(b.yoursLines ?? []) : [],
      picked: nodeAt !== undefined ? picked.has(nodeAt) : n.pickedBriefs.includes(b.node),
    }
  })
  const c = pv.counts
  const counts = [
    `${c.added} added`,
    `${c.removed} removed`,
    `${c.changed} changed`,
    `${c.briefs} brief${c.briefs === 1 ? '' : 's'}`,
    ...(c.conflicts > 0 ? [`${c.conflicts} conflict${c.conflicts === 1 ? '' : 's'}`] : []),
  ].join(', ')
  let savedRev = draft.base
  try {
    savedRev = (await o.readSaved(p, litterDir, name))?.revision ?? draft.base
  } catch {
    // The draft's base stands in.
  }
  return {
    view: 'proposal',
    v: nextV(),
    title: title(name, { text: ` · the lead's proposal ${pv.n}` }, { text: ` · rev ${pv.baseRevision} → ${savedRev + 1}` }),
    notice: n.notice,
    swarm: name,
    n: pv.n,
    from: pv.baseRevision,
    to: savedRev + 1,
    tree: { swarm: name, rows, selected: null, editable: false, workers: [] },
    changes,
    briefs,
    counts,
    decided: pv.decided === null ? null : pv.decided === 'all' ? 'accepted all' : pv.decided === 'some' ? 'accepted some' : 'rejected',
    picked: changes.filter(x => x.picked).length + briefs.filter(x => x.picked && !x.withNode).length,
    technical: n.diff === TECHNICAL_DIFF,
  }
}

/**
 * [Technical diff]'s arg to the proposal's `diff` press (WP-DD): it opens in
 * the navigation's `diff`, as a brief's diff does, so one of them is open at a
 * time. No node id starts with `#` (NODE_ID), so no brief takes it.
 */
export const TECHNICAL_DIFF = '#technical'

/** A change's field under its node (`model`, `authority.commit`, `spawns.reviewer`), or a spec field's path (`goal`). */
const fieldOf = (c: { path: string; node?: string }): string =>
  c.node !== undefined && c.path.startsWith(`nodes.${c.node}.`) ? c.path.slice(`nodes.${c.node}.`.length) : c.path

/** A field's name in a change line: the inspector's label, lower-cased. */
function fieldWords(field: string): string {
  if (field === 'goal') return 'the goal'
  if (field === 'limits.maxAgentsAtOnce') return 'max agents at once'
  if (field === 'brief') return 'brief file'
  const def = NODE_FIELDS.find(f => f.path === field)
  return def ? def.label.trim().toLowerCase() : oneLine(field, 60)
}

/**
 * A spec value in words, for a change line: a Select field's value by its
 * option's label (`allowed`, `own branch`), a worktree by what it is, a list
 * joined, text as written. Model and agent text, so cleaned and cut.
 */
export function valueWords(field: string, value: unknown): string {
  if (value === undefined) return 'not set'
  if (field === 'worktree' && isObj(value)) {
    if ('existing' in value) return `existing ${oneLine(value.existing, 60)}`
    const fresh: Record<string, unknown> = isObj(value.new) ? value.new : {}
    return `new from ${oneLine(fresh.from, 30) || 'HEAD'} on ${oneLine(fresh.branch, 40) || 'a branch not named yet'}`
  }
  const def = NODE_FIELDS.find(f => f.path === field)
  if (def?.kind === 'select' && def.options) {
    try {
      const probe = withPath({ id: 'x', kind: 'worker' }, field, value)
      const v = def.get(probe)
      const label = def.options(probe, { models: [] }).find(o => o.value === v && v !== '')?.label
      if (label) return oneLine(label, 60)
    } catch {
      // As written, then.
    }
  }
  if (typeof value === 'string') return value.trim() === '' ? 'empty' : oneLine(value, 80)
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (Array.isArray(value) && value.every(x => typeof x === 'string')) return value.length === 0 ? 'none' : oneLine(value.join(', '), 80)
  return short(value, 80)
}

/**
 * A proposal's change in words (WP-DD; the review's "Add surveyor /
 * orchestrator / delegates to reader ≤2"): a node added with its kind, what
 * it delegates to and its model; a node removed; a delegation; else
 * `Set|Change|Unset <node> · <field> · <value>`. The raw path and value
 * stay on the row for [Technical diff].
 */
export function changeWords(c: { path: string; node?: string; kind: 'added' | 'removed' | 'changed'; before?: unknown; after?: unknown }): string {
  const node = c.node === undefined ? undefined : oneLine(c.node, 40)
  if (node !== undefined && c.path === `nodes.${c.node}`) {
    const n = c.kind === 'removed' ? c.before : c.after
    const kind = isObj(n) && (n.kind === 'orchestrator' || n.kind === 'worker') ? n.kind : 'node'
    if (c.kind === 'removed') return `Remove ${node} · ${kind}`
    const parts = [`Add ${node}`, kind]
    const spawns = isObj(n) && isObj(n.spawns) ? Object.entries(n.spawns) : []
    if (spawns.length > 0) {
      const named = spawns.slice(0, 4).map(([w, k]) => `${oneLine(w, 32)} ≤${oneLine(k, 6)}`)
      parts.push(`delegates to ${named.join(', ')}${spawns.length > 4 ? ` and ${spawns.length - 4} more` : ''}`)
    }
    if (isObj(n) && typeof n.model === 'string' && n.model !== '') parts.push(oneLine(n.model, 40))
    return parts.join(' · ')
  }
  const field = fieldOf(c)
  const delegate = /^spawns\.(.+)$/.exec(field)
  if (node !== undefined && delegate) {
    const w = oneLine(delegate[1], 32)
    if (c.kind === 'removed') return `${node} no longer delegates to ${w}`
    return `${node} delegates to ${w} ≤${oneLine(c.after, 6)}${c.kind === 'changed' ? ` (was ≤${oneLine(c.before, 6)})` : ''}`
  }
  const what = node !== undefined ? `${node} · ${fieldWords(field)}` : fieldWords(field)
  if (c.kind === 'added') return `Set ${what} · ${valueWords(field, c.after)}`
  if (c.kind === 'removed') return `Unset ${what} · was ${valueWords(field, c.before)}`
  return `Change ${what} · ${valueWords(field, c.before)} → ${valueWords(field, c.after)}`
}

/** The proposal's node-level changes (`nodes.<id>`, a node added or removed), by node: each one's change index. */
export function nodeChanges(pv: { changes: readonly { path: string; node?: string }[] }): Map<string, number> {
  const out = new Map<string, number>()
  pv.changes.forEach((c, i) => {
    if (c.node !== undefined && c.path === `nodes.${c.node}`) out.set(c.node, i)
  })
  return out
}

/**
 * What [Accept selected] or [Accept all] hands J's acceptProposal, from what's
 * picked (C's contract: `'all'`, or change paths). A brief of a new or removed
 * node is never named: it goes with its node's path. [Accept all] is `'all'`,
 * which takes every change that doesn't conflict, unless you took the lead's
 * side of a conflict: then it's every non-conflicting change and brief, and
 * the conflicts taken.
 */
export function acceptPick(
  pv: { changes: readonly { path: string; node?: string; conflict: boolean }[]; briefs: readonly { node: string; conflict: boolean }[] },
  picked: readonly number[],
  pickedBriefs: readonly string[],
  all: boolean,
): 'all' | string[] {
  const withNode = nodeChanges(pv)
  const own = pv.briefs.filter(b => !withNode.has(b.node))
  if (all) {
    const taken = pv.changes.some((c, i) => c.conflict && picked.includes(i)) || own.some(b => b.conflict && pickedBriefs.includes(b.node))
    if (!taken) return 'all'
    return [
      ...pv.changes.flatMap((c, i) => (!c.conflict || picked.includes(i) ? [c.path] : [])),
      ...own.filter(b => !b.conflict || pickedBriefs.includes(b.node)).map(b => `brief:${b.node}`),
    ]
  }
  return [
    ...[...new Set(picked)].sort((a, b) => a - b).flatMap(i => (pv.changes[i] ? [pv.changes[i]!.path] : [])),
    ...own.filter(b => pickedBriefs.includes(b.node)).map(b => `brief:${b.node}`),
  ]
}

// ---------------------------------------------------------------------------
// The browser

type Statusish = { word: string; glyph: string; color: string; running: boolean }

/**
 * A node's status, from the stopped list, the admission table and `$.agent.list()` (15.6, "Facts come from what the mod observes").
 * `running` is whether it's alive (agentLive), so a held or starting node can still be flagged and stopped.
 */
export function statusOf(agentId: string, listed: ListedAgent | undefined, question: boolean): Statusish {
  const adm = admissionStatus(agentId)
  const alive = listed !== undefined && agentLive(listed.status)
  if (isStopped(agentId)) return { word: 'stopped', glyph: '−', color: COLOR.idle, running: alive }
  // The engine's `waiting` (2.1.289) isn't litter's ⚑ waiting, a question: the node is mid-turn on child agents alone, or
  // its turn ended but a shell, monitor, child or workflow it holds will wake it. Shown over settling, since it says why.
  if (listed?.status === 'waiting' && !question) return { word: 'held', glyph: '‖', color: COLOR.running, running: true }
  if (adm === 'settling') return { word: 'settling', glyph: '~', color: COLOR.running, running: true }
  if (alive || adm === 'running') {
    if (question) return { word: 'waiting', glyph: '⚑', color: COLOR.waiting, running: true }
    if (listed?.status === 'pending') return { word: 'starting', glyph: '', color: COLOR.running, running: true }
    return { word: 'running', glyph: '', color: COLOR.running, running: true }
  }
  if (question) return { word: 'waiting', glyph: '⚑', color: COLOR.waiting, running: false }
  if (!listed) return { word: 'gone', glyph: '−', color: COLOR.idle, running: false }
  if (listed.status === 'completed') return { word: 'done', glyph: '✓', color: COLOR.done, running: false }
  if (listed.status === 'failed') return { word: 'failed', glyph: '✕', color: COLOR.failed, running: false }
  if (listed.status === 'killed') return { word: 'killed', glyph: '✕', color: COLOR.failed, running: false }
  // A teammate's, or an ended named agent's; a litter node is never named, so this is rare.
  if (listed.status === 'idle') return { word: 'between turns', glyph: '', color: COLOR.idle, running: false }
  return { word: oneLine(listed.status, 16), glyph: '', color: COLOR.idle, running: false }
}

const sumTokens = (t: { input: number; output: number; cacheRead: number; cacheCreation: number }) => t.input + t.output + t.cacheRead + t.cacheCreation

/** An instance's name: its node, with `#n` when the node has run more than once, or a child's description. */
function instanceName(b: NodeBinding, all: readonly NodeBinding[], listed: ListedAgent | undefined): string {
  if (b.kind === 'child') return `${oneLine(listed?.description || listed?.type || 'agent', 24)} (child)`
  const several = all.filter(x => x.node === b.node && x.kind !== 'child').length > 1
  return several ? `${b.node} #${b.n}` : b.node
}

const KIND_ORDER: Record<BindingKind, number> = { orchestrator: 0, worker: 1, child: 2 }

/** The tree rows of a live swarm: the lead, then each orchestrator instance and what it spawned, in spec order. */
function liveRows(name: string, listed: Map<string, ListedAgent>, flaggedNodes: Set<string>): SwarmNodeRow[] {
  const s = liveSwarm(name)
  const all = bindings(name)
  const order = new Map((s?.spec.nodes ?? []).map((x, i) => [x.id, i]))
  const sorted = [...all].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (order.get(a.node) ?? 99) - (order.get(b.node) ?? 99) || a.n - b.n || a.boundAt - b.boundAt,
  )
  const questions = openQuestions(name)
  const calls = inflight()
  const colorOf = new Map<string, string>()
  let i = 0
  for (const b of sorted) if (b.kind === 'orchestrator' && !colorOf.has(b.node)) colorOf.set(b.node, ORCHESTRATOR_COLORS[i++ % ORCHESTRATOR_COLORS.length]!)
  const rows: SwarmNodeRow[] = [
    {
      key: 'lead',
      agentId: null,
      depth: 0,
      name: 'lead',
      role: 'lead',
      color: null,
      dim: false,
      ...(leadBusy() ? { status: 'running', statusGlyph: '', statusColor: COLOR.running } : { status: 'idle', statusGlyph: '', statusColor: COLOR.idle }),
      running: leadBusy(),
      tool: '',
      turns: null,
      tokens: '',
      report: '',
      queued: [],
      question: null,
      flagged: false,
    },
  ]
  const seen = new Set<string>()
  const add = (b: NodeBinding, depth: number, color: string | null) => {
    if (seen.has(b.agentId) || rows.length >= MAX_ROWS) return
    seen.add(b.agentId)
    const listedAgent = listed.get(b.agentId)
    const q = questions.find(x => x.agentId === b.agentId) ?? null
    const st = statusOf(b.agentId, listedAgent, q !== null)
    const call = calls.filter(c => c.agentId === b.agentId).sort((x, y) => y.at - x.at)[0]
    const t = tokens(b.agentId)
    const report = lastReport(b.agentId)
    const myColor = b.kind === 'orchestrator' ? (colorOf.get(b.node) ?? null) : color
    rows.push({
      key: b.agentId,
      agentId: b.agentId,
      depth,
      name: clean(instanceName(b, all, listedAgent), 40),
      role: b.kind,
      color: myColor,
      dim: b.kind !== 'orchestrator',
      status: st.word,
      // A glyph beside every color (WP-DD): running and starting are ▸, between turns and the like ·.
      statusGlyph: st.glyph || (st.color === COLOR.running ? MARK.running.glyph : MARK.idle.glyph),
      statusColor: st.color,
      running: st.running,
      tool: call ? oneLine(call.tool, 40) : '',
      turns: t.turns,
      tokens: fmtTokens(sumTokens(t)),
      report: report ? firstLine(report.text, 120) : '',
      queued: queued(name, b.agentId).map(m => ({ id: m.id, text: firstLine(m.text, 80) })),
      question: q ? firstLine(q.text, 120) : null,
      flagged: flaggedNodes.has(b.node) && st.running,
    })
    for (const c of sorted.filter(x => x.parent === b.agentId)) add(c, depth + 1, myColor)
  }
  for (const b of sorted.filter(x => x.parent === null)) add(b, 1, null)
  // Anything whose parent isn't bound (a reload, a binding pruned) still gets a row.
  for (const b of sorted) add(b, 1, null)
  return rows
}

const whoOf = (id: string | undefined, all: readonly NodeBinding[]): string => {
  if (id === undefined || id === '') return ''
  if (id === 'user') return 'you'
  if (id === 'lead' || id === 'main') return 'lead'
  const b = all.find(x => x.agentId === id)
  return b ? b.node : oneLine(id, 16)
}

/** One launch ledger record as an event-log row, or null for one the log doesn't show. */
export function eventRow(r: StoredRecord, all: readonly NodeBinding[]): SwarmEventRow | null {
  const at = clockAt(r.at)
  const body = r.body as Record<string, unknown>
  const node = typeof body.node === 'string' ? body.node : ''
  switch (r.kind) {
    case 'swarm.start':
      return { at, who: 'litter', text: `launched revision ${String(body.revision)}`, color: COLOR.done }
    case 'swarm.node': {
      const b = body as unknown as SwarmNodeBody
      return { at, who: b.node, text: `${b.kind === 'child' ? 'a child started' : `#${b.n} started`}${b.adopted ? ' (adopted after a reload)' : ''}`, color: COLOR.running }
    }
    case 'swarm.stop':
      return { at, who: 'you', text: `stopped ${Array.isArray(body.nodes) ? body.nodes.length : 0} agent(s) (${String(body.how)})`, color: COLOR.idle }
    case 'swarm.stopping':
      return { at, who: body.by === 'lead' ? 'lead' : 'you', text: 'ending the swarm: stopping', color: COLOR.waiting }
    case 'swarm.handover':
      return { at, who: 'litter', text: `handed over at generation ${String(body.generation)}`, color: COLOR.waiting }
    case 'swarm.end':
      return { at, who: 'litter', text: body.settled === false ? 'ended without settling' : 'ended', color: COLOR.idle }
    case 'session.rebind':
      return { at, who: 'litter', text: 'the session was cleared and rebound', color: COLOR.subtle }
    case 'swarm.summary':
      return { at, who: 'summary', text: `goal: ${oneLine((body as unknown as SwarmSummaryBody).goal, 100)}`, color: COLOR.subtle }
    case 'swarm.worktree':
      return { at, who: node || 'litter', text: `worktree made: ${oneLine(body.path, 80)}`, color: COLOR.path }
    case 'swarm.worktree.failed':
      return { at, who: node || 'litter', text: `worktree failed (${String(body.step)}): ${oneLine(body.reason, 80)}`, color: COLOR.failed }
    case 'swarm.worktree.kept':
      return { at, who: 'litter', text: `worktree kept: ${oneLine(body.path, 60)}: ${oneLine(body.reason, 60)}`, color: COLOR.waiting }
    case 'swarm.worktree.removed':
      return { at, who: 'litter', text: `worktree removed: ${oneLine(body.path, 80)}`, color: COLOR.idle }
    case 'swarm.event':
      return swarmEventRow(at, r.body as unknown as SwarmEventBody, all)
    default:
      return null
  }
}

function swarmEventRow(at: string, e: SwarmEventBody, all: readonly NodeBinding[]): SwarmEventRow | null {
  const who = e.node ?? whoOf(e.agentId, all)
  switch (e.kind) {
    case 'message':
      return { at, who: `${whoOf(e.from, all)} → ${whoOf(e.to, all)}`, text: `${e.route === 'lead' ? 'via lead' : e.route}, ${e.delivery}: "${oneLine(e.text, 80)}"`, color: null }
    case 'readdressed':
      return { at, who: `${whoOf(e.from, all)} → ${whoOf(e.to, all)}`, text: `sent via its parent ${whoOf(e.parent, all)}: ${oneLine(e.why, 60)}`, color: COLOR.subtle }
    case 'queued':
      return { at, who, text: `queued a message from ${whoOf(e.from, all)}`, color: COLOR.waiting }
    case 'queue-sent':
      return { at, who, text: 'queued message sent', color: null }
    case 'queue-cancelled':
      return { at, who, text: 'queued message cancelled', color: COLOR.idle }
    case 'send-refused':
      return { at, who: `${whoOf(e.from, all)} → ${whoOf(e.to, all)}`, text: `refused: ${oneLine(e.reason, 80)}`, color: COLOR.failed }
    case 'resume-refused':
      return { at, who, text: `resume refused: ${oneLine(e.reason, 80)}`, color: COLOR.failed }
    case 'wake-refused':
      return { at, who, text: `wake refused: ${oneLine(e.reason, 80)}`, color: COLOR.failed }
    case 'denied':
      return { at, who: 'guard', text: `denied ${who}: ${oneLine(e.tool, 20)}: ${oneLine(e.reason, 80)}`, color: COLOR.failed }
    case 'report':
      return { at, who, text: `reported: "${firstLine(e.text, 90)}"`, color: COLOR.done }
    case 'report-to-lead':
      return { at, who, text: 'its report went to the lead, not its parent', color: COLOR.waiting }
    case 'question':
      return { at, who, text: `⚑ asked: ${oneLine(e.text, 90)}`, color: COLOR.waiting }
    case 'worker-ended-early':
      return { at, who, text: `ended its turn with ${e.children.length} child(ren) still running`, color: COLOR.waiting }
    case 'held':
      return { at, who, text: `held for ${e.children.length} child(ren)`, color: COLOR.subtle }
    case 'isolation-lost':
      return { at, who, text: `ran outside its directory (${oneLine(e.tool, 20)})`, color: COLOR.failed }
    case 'branch-moved':
      return { at, who: 'litter', text: `! ${oneLine(e.ref, 50)} moved ${shortSha(e.from)} → ${shortSha(e.to)}`, color: COLOR.waiting }
    case 'branch-moved-ack':
      return { at, who: 'you', text: 'that was me', color: COLOR.subtle }
    case 'rule-commit':
      return { at, who, text: `! committed to the rule folders: ${e.files.slice(0, 3).map(f => oneLine(f, 40)).join(', ')}`, color: COLOR.waiting }
    case 'head-moved':
      return { at, who, text: `HEAD is ${oneLine(e.actual ?? 'detached', 40)}, not its bound branch`, color: COLOR.waiting }
    case 'type-missing':
      return { at, who, text: `its type ${oneLine(e.type, 40)} wasn't registered`, color: COLOR.failed }
    case 'ready-to-push':
      return { at, who, text: `ready to push ${oneLine(e.branch, 40)} at ${shortSha(e.commit)}`, color: COLOR.done }
    case 'pushed':
      return { at, who: 'lead', text: `pushed ${shortSha(e.commit)} to ${oneLine(e.branch, 40)}`, color: COLOR.done }
    case 'clear-killed':
      return { at, who, text: `/clear cut short ${oneLine(e.tool, 20)} (${oneLine(e.detail, 60)})`, color: COLOR.waiting }
    case 'gate':
      return gateRow(at, who, e)
    case 'budget':
      return budgetRow(at, e)
    default:
      return null
  }
}

/** A repair swarm's verify, verdict or land (2b-2, Y's mirror of the run's ledger): its round, its result with a glyph. */
function gateRow(at: string, who: string, e: Extract<SwarmEventBody, { kind: 'gate' }>): SwarmEventRow {
  const ok = e.result === 'green' || e.result === 'approved' || e.result === 'landed'
  const id = oneLine(e.verify_id, 24)
  const what =
    e.record === 'verify'
      ? `verify ${id}`
      : e.record === 'verdict'
        ? `verdict${typeof e.round === 'number' ? `, round ${e.round},` : ''} on ${id}`
        : `land of ${id}`
  return { at, who: who || 'litter', text: `${what}: ${ok ? '✓' : '✕'} ${oneLine(String(e.result).replace('-', ' '), 16)}`, color: ok ? COLOR.done : COLOR.failed }
}

/** The lead's `repair.budget` ask and your answer (2b-2, X's), with the budget as it stands after. */
function budgetRow(at: string, e: Extract<SwarmEventBody, { kind: 'budget' }>): SwarmEventRow {
  const req: Record<string, unknown> = isObj(e.requested) ? e.requested : {}
  const asked = [typeof req.rounds === 'number' && `rounds ${req.rounds}`, typeof req.agents === 'number' && `agents ${req.agents}`]
    .filter((x): x is string => typeof x === 'string')
    .join(', ')
  const b: Record<string, unknown> = isObj(e.budget) ? e.budget : {}
  const now = `${typeof b.rounds === 'number' ? b.rounds : '?'} rounds, ${typeof b.agents === 'number' ? b.agents : '?'} agents`
  return {
    at,
    who: 'lead',
    text: `asked for more budget (${asked || 'nothing named'}): ${e.granted === true ? `✓ granted, now ${now}` : `✕ not granted, still ${now}`}`,
    color: e.granted === true ? COLOR.done : COLOR.idle,
  }
}

/** A part of a repair swarm's budget: `rounds 1 of 3`, or `! rounds 3 of 3, all used` in warning. */
function budgetPart(what: string, used: number, of: number): SwarmBudgetPart {
  return used >= of
    ? { used, of, text: `${what} ${used} of ${of}, all used`, glyph: '!', color: COLOR.waiting }
    : { used, of, text: `${what} ${used} of ${of}`, glyph: '', color: null }
}

/** The browser's budget row for a repair swarm (15.11): the state's counters, which the spawn check and the gates keep. */
export function budgetOf(s: LiveSwarm): SwarmBrowserView['budget'] {
  if (!s.run || !s.budget) return null
  const rounds = budgetPart('rounds', roundsUsed(s.name), s.budget.rounds)
  const agents = budgetPart('agents', spawnsUsed(s.name), s.budget.agents)
  const spent = [rounds.glyph && 'no verdict past its last round is taken', agents.glyph && 'it spawns no more agents'].filter((x): x is string => typeof x === 'string' && x !== '')
  return {
    run: oneLine(s.run.run, 40),
    generation: s.run.generation,
    rounds,
    agents,
    note: spent.length > 0 ? `${spent.join(', and ')}, until you grant more when the lead asks (repair.budget)` : null,
  }
}

const shortSha = (sha: string | null | undefined): string => (typeof sha === 'string' && sha !== '' ? oneLine(sha.slice(0, 7), 7) : 'none')

const EVENTS_SHOWN = 8

/** The branch-moved and rule-commit events with no `branch-moved-ack` for their seq (15.4, "checked again afterwards"). */
export function openFlags(records: readonly StoredRecord[], all: readonly NodeBinding[]): SwarmFlagRow[] {
  const acked = new Set<number>()
  for (const r of records) {
    const b = r.body as Partial<SwarmEventBody>
    if (r.kind === 'swarm.event' && b.kind === 'branch-moved-ack' && typeof (b as { seq?: unknown }).seq === 'number') acked.add((b as { seq: number }).seq)
  }
  const out: SwarmFlagRow[] = []
  for (const r of records) {
    if (r.kind !== 'swarm.event' || acked.has(r.seq)) continue
    const e = r.body as unknown as SwarmEventBody
    if (e.kind === 'branch-moved') {
      const running = e.running.filter(x => typeof x === 'string')
      out.push({
        seq: r.seq,
        kind: 'branch-moved',
        text: oneLine(`${e.ref} moved ${shortSha(e.from)} → ${shortSha(e.to)}${running.length > 0 ? ` while ${running.join(', ')} ran` : ''}`, 160),
        running,
      })
    } else if (e.kind === 'rule-commit') {
      const by = e.node ?? whoOf(e.agentId, all)
      out.push({ seq: r.seq, kind: 'rule-commit', text: oneLine(`${by} committed to the rule folders: ${e.files.join(', ')}`, 160), running: by ? [by] : [] })
    }
  }
  return out.slice(-6)
}

/** The messages read for the transcript: the last ones. */
const TRANSCRIPT_ROWS = 120
/** The transcript's lines the view holds at most, the last ones; the browser draws a window over them (browser.tsx's transcriptWindow). */
export const TRANSCRIPT_LINES = 200
/** A message's tool calls drawn at most, one line each; the last says how many more. */
const TOOLS_SHOWN = 6

/** An engine-wrapped message (`<teammate-message teammate_id="…" …>…</teammate-message>`, a task notification, …): its tag, attributes and body. */
const WRAPPED = /^<([a-z][a-z0-9-]*)((?:\s+[a-z_][a-z0-9_-]*="[^"]*")*)\s*>([\s\S]*?)<\/\1>/i
const ATTR = /([a-z_][a-z0-9_-]*)="([^"]*)"/gi

/**
 * A message's text as the person reads it (WP-DD, as WP-DF's Agents section
 * reads one): a message the engine wrapped in a tag is `from <name>: <first
 * line>` (the sender from `teammate_id`, `from` or `name`), or `<tag>: <first
 * line>` when the tag names no one; the body's own tags are dropped. Any
 * other text is its first line. Model and agent text, so cleaned and cut.
 */
export function messageText(text: unknown): string {
  const s = clean(text, 4000).trim()
  const m = WRAPPED.exec(s)
  if (!m) return firstLine(s, 200)
  const attrs = new Map([...m[2]!.matchAll(ATTR)].map(a => [a[1]!.toLowerCase(), a[2]!]))
  const who = attrs.get('teammate_id') ?? attrs.get('from') ?? attrs.get('name') ?? null
  const body = firstLine(m[3]!.replace(/<[^>]*>/g, ' '), 160) || '(empty)'
  const more = s.slice(m[0].length).trim() !== '' ? ' (+ more)' : ''
  return who ? `from ${oneLine(who, 40)}: ${body}${more}` : `${oneLine(m[1], 40)}: ${body}${more}`
}

/**
 * What a tool call worked on, its first argument where its input names one:
 * a path (in the path color), else a command, pattern or address (muted),
 * else its first text field's; null for none.
 */
export function toolTarget(input: unknown): SwarmSpan | null {
  if (!isObj(input)) return null
  for (const k of ['file_path', 'notebook_path', 'path']) if (typeof input[k] === 'string' && input[k] !== '') return { text: oneLine(input[k], 80), color: STYLE.path }
  for (const k of ['command', 'pattern', 'url', 'query', 'description', 'prompt']) if (typeof input[k] === 'string' && input[k] !== '') return { text: firstLine(input[k], 60), color: STYLE.muted }
  const first = Object.values(input).find((v): v is string => typeof v === 'string' && v.trim() !== '')
  return first === undefined ? null : { text: firstLine(first, 60), color: STYLE.muted }
}

/**
 * One tool call's line, in spans (the user's ask, 2026-10-07, as WP-DF's
 * Agents transcript draws it): `↳` faint, the tool's name bold in the label
 * color (as the engine draws a tool's name), its first argument muted (a
 * path in the path color), `(+n more)` faint when the message made more
 * calls than are drawn; then its outcome as the transcript holds it (`✓
 * done`, `✕` and the error's first line), or "no outcome recorded" while it
 * has none (in flight, or a transcript that stores none): never an outcome
 * it doesn't hold.
 */
export function toolLine(t: unknown, more = 0): SwarmSpan[] {
  const u = isObj(t) ? t : {}
  const name = oneLine(u.tool ?? u.name ?? 'a tool', 40) || 'a tool'
  const target = toolTarget(u.input)
  const outcome: SwarmSpan =
    u.isError === true
      ? { text: ` ${MARK.failed.glyph} ${firstLine(u.text, 60) || 'error'}`, color: COLOR.failed }
      : typeof u.text === 'string'
        ? { text: ` ${MARK.done.glyph} done`, color: COLOR.done }
        : { text: ' · no outcome recorded', color: STYLE.muted }
  return [
    { text: '  ↳ ', color: STYLE.faint },
    { text: name, color: STYLE.label, bold: true },
    ...(target ? [{ ...target, text: ` ${target.text}` }] : []),
    ...(more > 0 ? [{ text: ` (+${more} more)`, color: STYLE.faint }] : []),
    outcome,
  ]
}

/**
 * A message's line in spans: `◆` for the agent's own, `›` muted for what it
 * was sent; a message the engine wrapped in a tag reads `from <name>: <first
 * line>`, the name in the name color (messageText's words). Null for none.
 */
export function messageSpans(role: string, text: unknown): SwarmSpan[] | null {
  const words = messageText(text)
  if (words === '') return null
  const mine = role === 'assistant'
  const lead: SwarmSpan = mine ? { text: '◆ ', color: STYLE.accent } : { text: '› ', color: STYLE.muted }
  const body = (s: string): SwarmSpan => (mine ? { text: s } : { text: s, color: STYLE.muted })
  const from = /^from (.+?): /.exec(words)
  if (from && WRAPPED.test(clean(text, 4000).trim())) {
    return [lead, body('from '), { text: from[1]!, color: STYLE.name }, body(words.slice(from[0].length - 2))]
  }
  return [lead, body(words)]
}

async function transcriptOf(p: Ports, agentId: string, name: string): Promise<SwarmBrowserView['transcript']> {
  let rows
  try {
    rows = await p.messages(agentId)
  } catch {
    rows = null
  }
  if (rows === null) return { agentId, name, readable: false, lines: [] }
  const lines: SwarmSpan[][] = []
  for (const m of rows.slice(-TRANSCRIPT_ROWS)) {
    const said = messageSpans(m.role, m.text)
    if (said) lines.push(said)
    const uses = Array.isArray(m.toolUses) ? m.toolUses : []
    const shown = uses.slice(0, TOOLS_SHOWN)
    shown.forEach((t, i) => lines.push(toolLine(t, i === shown.length - 1 ? uses.length - shown.length : 0)))
  }
  return { agentId, name, readable: true, lines: lines.slice(-TRANSCRIPT_LINES) }
}

async function buildBrowser(p: Ports, n: SwarmNav): Promise<SwarmBrowserView | SwarmBuilderView> {
  const name = n.swarm ?? ''
  const s = liveSwarm(name)
  const litterDir = sessionDir()
  if (!s || !litterDir) return buildBuilder(p, { ...n, view: 'builder', notice: n.notice ?? { text: `${name} isn't live`, level: 'info' } })
  const now = await p.now()
  let listedArr: ListedAgent[] = []
  try {
    listedArr = await p.listAgents()
  } catch (err) {
    p.log(`swarm pane: the agent list wasn't read: ${errText(err)}`)
  }
  const listed = new Map(listedArr.map(a => [a.id, a]))
  const all = bindings(name)
  let ledger: LedgerCache = { seq: 0, records: [], tampered: null }
  try {
    ledger = await launchRecords(p, litterDir, name, s.launch)
  } catch (err) {
    ledger = { seq: 0, records: [], tampered: `the launch ledger can't be read: ${errText(err)}` }
  }
  const flags = s.readOnly ? [] : openFlags(ledger.records, all)
  const flaggedNodes = new Set(flags.flatMap(f => f.running))
  const rows = liveRows(name, listed, flaggedNodes)
  const events = ledger.records
    .map(r => eventRow(r, all))
    .filter((x): x is SwarmEventRow => x !== null)
    .slice(-EVENTS_SHOWN)
    .map(e => ({ ...e, who: oneLine(e.who, 32), text: oneLine(e.text, 200) }))
  const o = owners()
  let summary: SwarmBrowserView['summary'] = null
  try {
    // O's, when this session summarised or loaded the swarm; else the last one recorded (a read-only swarm's, say).
    const sum = o.summaryOf(name) ?? recordedSummary(ledger.records)
    if (sum) {
      summary = {
        goal: oneLine(sum.goalNow, 300),
        progress: sum.progress.slice(0, 6).map(x => oneLine(x, 200)),
        waiting: sum.waitingOnYou.slice(0, 4).map(x => oneLine(x, 200)),
        age: ago(now - sum.at),
        stale: sum.stale,
      }
    }
  } catch (err) {
    p.log(`swarm pane: no summary: ${errText(err)}`)
  }
  let owner: SwarmBrowserView['owner'] = null
  if (s.readOnly || s.lost) {
    try {
      const ov = await o.readOwner(p, litterDir, name)
      owner = ov
        ? {
            text: oneLine(
              ov.blob
                ? `owned by session ${ov.blob.session} on ${ov.blob.host}${ov.leaseAgeMs === null ? '' : `, its lease beaten ${ago(ov.leaseAgeMs)}`}`
                : 'no session owns it now',
              200,
            ),
            canTakeOver: ov.canHandOver && !ov.mine,
            why: ov.why === null ? null : oneLine(ov.why, 200),
          }
        : { text: 'no owner recorded', canTakeOver: false, why: null }
    } catch (err) {
      owner = { text: `the owner can't be read: ${oneLine(errText(err), 160)}`, canTakeOver: false, why: null }
    }
  }
  const total = tokens(name)
  const selected = browserSelection(name, n.selected)
  const composer = s.readOnly || s.lost ? null : await composerFor(p, litterDir, name, n, selected, all, listed)
  const tr = n.transcript && all.some(b => b.agentId === n.transcript) ? n.transcript : null
  const trName = tr ? (rows.find(r => r.agentId === tr)?.name ?? tr) : ''
  const notice = n.notice ?? (ledger.tampered ? { text: oneLine(ledger.tampered, 300), level: 'error' as const } : null)
  return {
    view: 'browser',
    v: nextV(),
    title: title(
      name,
      s.state === 'stopping'
        ? { text: ` · ${MARK.warning.glyph} stopping ${span(now - s.startedAt)}`, color: COLOR.waiting }
        : { text: ` · ${MARK.running.glyph} live ${span(now - s.startedAt)}`, color: COLOR.running },
      { text: ` · ${all.length} agent${all.length === 1 ? '' : 's'} · ${fmtTokens(sumTokens(total))} tokens` },
      // A repair swarm says which run it repairs (2b-2).
      ...(s.run ? [{ text: ` · repairs run ${oneLine(s.run.run, 40)}` }] : []),
      ...(s.readOnly ? [{ text: ' · read-only' }] : []),
      ...(s.lost ? [{ text: ` · ${MARK.failed.glyph} lost to another session`, color: COLOR.failed }] : []),
    ),
    notice,
    swarm: name,
    launch: s.launch,
    state: s.state,
    readOnly: s.readOnly,
    lost: s.lost,
    owner,
    budget: budgetOf(s),
    summary,
    rows,
    flags,
    events,
    composer,
    transcript: tr ? await transcriptOf(p, tr, trName) : null,
    selected,
  }
}

/**
 * The last `swarm.summary` in the launch ledger, as O's summary reads: the
 * browser's summary when this session holds none (another session's swarm,
 * or one not summarised since a reload). Stale once a newer event exists.
 */
export function recordedSummary(records: readonly StoredRecord[]): ReturnType<Owners['summaryOf']> {
  let at = -1
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i]!.kind === 'swarm.summary') {
      at = i
      break
    }
  }
  if (at < 0) return null
  const r = records[at]!
  const body = r.body as Partial<SwarmSummaryBody>
  const parsed = typeof body.text === 'string' ? parseSummary(body.text) : null
  const goal = parsed?.goalNow ?? (typeof body.goal === 'string' ? body.goal : '')
  if (goal === '') return null
  return {
    goalNow: goal,
    progress: parsed?.progress ?? [],
    waitingOnYou: parsed?.waitingOnYou ?? [],
    at: r.at,
    stale: records.slice(at + 1).some(x => x.kind === 'swarm.event'),
  }
}

/**
 * The browser's selection: the agent picked, while it's bound in the swarm,
 * else the first orchestrator. The view draws it, the navigation keeps it
 * (panes.ts's drawSwarm), and [Send] reads it, so To is one thing.
 */
export function browserSelection(name: string, selected: string | null): string | null {
  const all = bindings(name)
  return selected && all.some(b => b.agentId === selected) ? selected : (all.find(b => b.kind === 'orchestrator')?.agentId ?? null)
}

/** The composer's To for a selection: a node instance, never a child. */
export function composerTarget(name: string, selected: string | null): NodeBinding | null {
  const id = browserSelection(name, selected)
  return bindings(name).find(b => b.agentId === id && b.kind !== 'child') ?? null
}

/** The Route the composer shows and [Send] sends: Via parent only to a worker, else Direct. */
export const composerRoute = (route: ComposerPrefs['route'], target: NodeBinding | null): ComposerPrefs['route'] =>
  route === 'parent' && target?.kind !== 'worker' ? 'direct' : route

/** Admitted, or alive in the list (agentLive): a held or starting node isn't idle, and [Stop them] can stop it. */
const isRunningAgent = (agentId: string, listed: Map<string, ListedAgent>): boolean => {
  const adm = admissionStatus(agentId)
  const row = listed.get(agentId)
  return adm === 'running' || adm === 'settling' || (row !== undefined && agentLive(row.status))
}

/**
 * Whether a send now reaches the node itself, for the composer's Direct label: running right now, not
 * agentLive. A worker parked after its turn (the list's `waiting`) is completed to the engine, so a send
 * resumes it, and admission readdresses that resume to its parent (admit.ts, judge).
 */
const takesDirect = (agentId: string, listed: Map<string, ListedAgent>): boolean => {
  const adm = admissionStatus(agentId)
  return adm === 'running' || adm === 'settling' || listed.get(agentId)?.status === 'running'
}

/** The composer's When and Route for a swarm: module memory, else $.store, else interject and direct. */
export async function prefsOf(p: Ports, litterDir: string, swarm: string): Promise<ComposerPrefs> {
  const cur = composerPrefs.get(swarm)
  if (cur) return cur
  let out: ComposerPrefs = { when: 'interject', route: 'direct' }
  try {
    const raw = (await p.store.get(composerKey(litterDir, swarm))) as Partial<ComposerPrefs> | undefined
    if (raw && (raw.when === 'interject' || raw.when === 'queue') && (raw.route === 'direct' || raw.route === 'lead' || raw.route === 'parent')) {
      out = { when: raw.when, route: raw.route }
    }
  } catch {
    // The defaults stand.
  }
  composerPrefs.set(swarm, out)
  return out
}

export async function setPrefs(p: Ports, litterDir: string, swarm: string, prefs: ComposerPrefs): Promise<void> {
  composerPrefs.set(swarm, prefs)
  await p.store.set(composerKey(litterDir, swarm), prefs)
}

/** `<node>#<n>`, the composer's address for one instance (BrowserSend.node). */
export const instanceAddress = (b: NodeBinding): string => `${b.node}#${b.n}`

async function composerFor(
  p: Ports,
  litterDir: string,
  name: string,
  n: SwarmNav,
  selected: string | null,
  all: readonly NodeBinding[],
  listed: Map<string, ListedAgent>,
): Promise<SwarmComposer> {
  const prefs = await prefsOf(p, litterDir, name)
  const targets: SwarmOption[] = all.filter(b => b.kind !== 'child').map(b => ({ value: b.agentId, label: clean(instanceName(b, all, listed.get(b.agentId)), 40) }))
  const target = composerTarget(name, selected)
  const worker = target?.kind === 'worker'
  const idleWorker = worker && target !== null && !takesDirect(target.agentId, listed)
  const routes: SwarmOption[] = [
    { value: 'direct', label: idleWorker ? "via parent (it's idle)" : 'Direct' },
    { value: 'lead', label: 'Via lead' },
    ...(worker ? [{ value: 'parent', label: 'Via parent' }] : []),
  ]
  const route = composerRoute(prefs.route, target)
  return {
    to: target?.agentId ?? null,
    address: target ? instanceAddress(target) : null,
    targets,
    text: clean(n.inputs[`swarm:browser:text:${name}`] ?? '', 4000),
    when: prefs.when,
    route,
    routes,
    offerQueue: n.offerQueue,
  }
}

// ---------------------------------------------------------------------------
// Goal history, the recovery card, the unsettled report

async function buildHistory(p: Ports, n: SwarmNav): Promise<SwarmHistoryView | SwarmBuilderView> {
  const name = n.swarm ?? ''
  const s = liveSwarm(name)
  const litterDir = sessionDir()
  if (!s || !litterDir) return buildBuilder(p, { ...n, view: 'builder', notice: { text: `${name} isn't live`, level: 'info' } })
  let records: StoredRecord[] = []
  try {
    records = (await launchRecords(p, litterDir, name, s.launch)).records
  } catch (err) {
    p.log(`swarm pane: goal history: ${errText(err)}`)
  }
  const entries = records
    .filter(r => r.kind === 'swarm.summary')
    .map(r => ({ at: clockAt(r.at), goal: clean((r.body as unknown as SwarmSummaryBody).goal, 400) }))
    .reverse()
    .slice(0, 40)
  return {
    view: 'history',
    v: nextV(),
    title: title(name, { text: ' · goal history' }),
    notice: n.notice,
    swarm: name,
    entries,
  }
}

/** The orchestrator instance a bound worker (or a worker's worker) works under, by its bindings' parents. */
function orchestratorOf(agentId: string): NodeBinding | null {
  let b = binding(agentId)
  for (let i = 0; b && b.kind !== 'orchestrator' && i < 16; i++) b = b.parent ? binding(b.parent) : null
  return b && b.kind === 'orchestrator' ? b : null
}

/**
 * K's recovery card for the swarm, unless you've acted on or left it: the
 * card stays while anything on it is left to deal with, and shows only that.
 * K drops what a resume or re-spawn dealt with; a worker comes back through
 * its orchestrator (15.4, "Recreating a swarm", step 4), so a worker whose
 * orchestrator is off the card goes with it. Alive ones alone need nothing.
 */
export function pendingCard(name: string): ReturnType<Owners['recoveryCard']> {
  try {
    const card = owners().recoveryCard(name)
    if (!card || dismissedCards.has(cardKey(card))) return null
    if (card.stopping) return card
    const onCard = new Set(card.nodes.map(x => x.agentId))
    const nodes = card.nodes.filter(x => {
      if (x.kind !== 'worker') return true
      const o = orchestratorOf(x.agentId)
      return o !== null && onCard.has(o.agentId)
    })
    return nodes.length === 0 || nodes.every(x => x.state === 'alive') ? null : { ...card, nodes }
  } catch {
    return null
  }
}

/** One orchestrator on the recovery card, as its buttons weigh it. */
export type RecoveryChoice = {
  node: string
  /** K's resumeTargets has an instance: a resume reaches it. */
  resumable: boolean
  /** Every instance on the card still runs: nothing to resume. */
  alive: boolean
  /** No instance on the card is in the agent list. */
  gone: boolean
}

/** The card's orchestrators, in its order: the only nodes [Resume …] and [Re-spawn …] name (a worker comes back through its orchestrator). */
export function recoveryChoices(name: string, card: NonNullable<ReturnType<Owners['recoveryCard']>>): RecoveryChoice[] {
  const s = liveSwarm(name)
  const o = owners()
  const out: RecoveryChoice[] = []
  for (const x of card.nodes) {
    if (x.kind !== 'orchestrator' || out.some(c => c.node === x.node)) continue
    const mine = card.nodes.filter(y => y.node === x.node && y.kind === 'orchestrator')
    let resumable = false
    try {
      resumable = s !== null && o.resumeTargets(s, x.node).length > 0
    } catch {
      // Not resumable, then: a re-spawn still is.
    }
    out.push({ node: x.node, resumable, alive: mine.every(y => y.state === 'alive'), gone: mine.every(y => y.state === 'gone') })
  }
  return out
}

async function buildRecovery(p: Ports, n: SwarmNav): Promise<SwarmRecoveryView | SwarmBrowserView | SwarmBuilderView> {
  const name = n.swarm ?? ''
  const card = pendingCard(name)
  if (!card) return buildBrowser(p, { ...n, view: 'browser' })
  const picked = new Set(n.recoveryPicked)
  const glyphs = {
    alive: { glyph: '', color: COLOR.running },
    settled: { glyph: '✓', color: COLOR.done },
    gone: { glyph: '−', color: COLOR.idle },
  } as const
  const instance = (x: (typeof card.nodes)[number]): SwarmRecoveryInstance => ({
    agentId: x.agentId,
    name: clean(`${x.node} #${x.n}`, 40),
    state: x.state,
    ...glyphs[x.state],
    report: x.lastReport ? firstLine(x.lastReport, 120) : '',
    respawnOnly: x.respawnOnly,
  })
  const choices = card.stopping ? [] : recoveryChoices(name, card)
  const rows: SwarmRecoveryRow[] = []
  for (const kind of ['orchestrator', 'worker'] as const) {
    for (const x of card.nodes) {
      if (x.kind !== kind || rows.some(r => r.node === x.node && r.kind === kind)) continue
      const mine = card.nodes.filter(y => y.node === x.node && y.kind === kind)
      const choice = choices.find(c => c.node === x.node)
      const under = [...new Set(mine.map(y => orchestratorOf(y.agentId)?.node).filter((v): v is string => v !== undefined))]
      const note =
        kind === 'worker'
          ? `comes back through ${under.length > 0 ? under.map(u => clean(u, 32)).join(', ') : 'its orchestrator'}`
          : card.stopping
            ? ''
            : !choice?.resumable
              ? 're-spawn only'
              : choice.alive
                ? 'still running'
                : ''
      rows.push({
        node: clean(x.node, 40),
        kind,
        // One still running needs neither button.
        pickable: kind === 'orchestrator' && !card.stopping && choice !== undefined && !choice.alive,
        resumable: choice?.resumable ?? false,
        picked: kind === 'orchestrator' && choice !== undefined && !choice.alive && picked.has(x.node),
        note,
        instances: mine.map(instance),
      })
    }
  }
  return {
    view: 'recovery',
    v: nextV(),
    title: title(name, { text: ` · ${MARK.warning.glyph} recreated after a restart`, color: COLOR.waiting }),
    notice: n.notice,
    swarm: name,
    launch: card.launch,
    stopping: card.stopping,
    rows,
  }
}

/** The settle wait's report, once it's been open 2 minutes (15.4, "Ending"). */
export const UNSETTLED_AFTER_MS = 2 * 60_000

async function buildUnsettled(p: Ports, n: SwarmNav): Promise<SwarmUnsettledView | SwarmBrowserView | SwarmBuilderView> {
  const name = n.swarm ?? ''
  let progress: ReturnType<Owners['settleProgress']> = null
  try {
    progress = owners().settleProgress(name)
  } catch (err) {
    p.log(`swarm pane: settle progress: ${errText(err)}`)
  }
  if (!progress) return buildBrowser(p, { ...n, view: 'browser' })
  const now = await p.now()
  const all = bindings(name)
  const nameOf = (agentId: string, node: string, nn?: number) => {
    const b = all.find(x => x.agentId === agentId)
    return clean(b ? instanceName(b, all, undefined) : nn !== undefined ? `${node} #${nn}` : node, 40)
  }
  return {
    view: 'unsettled',
    v: nextV(),
    title: title(name, { text: ` · ${MARK.warning.glyph} hasn't settled after ${span(now - progress.since)}`, color: COLOR.waiting }),
    notice: n.notice,
    swarm: name,
    since: clockAt(progress.since),
    nodes: progress.nodes.map(x => ({ agentId: x.agentId, name: nameOf(x.agentId, x.node, x.n), status: oneLine(x.status, 20) })),
    calls: progress.calls.map(c => ({ name: nameOf(c.agentId, c.node), tool: oneLine(c.tool, 30), age: span(now - c.at) })),
    shells: progress.shells.map(sh => ({ shellId: oneLine(sh.shellId, 40), name: nameOf(sh.agentId, sh.node), age: span(now - sh.at) })),
    reservations: progress.reservations,
  }
}

// ---------------------------------------------------------------------------
// The two panes

/** The swarm pane's current view, or null when it isn't open. */
export async function swarmView(p: Ports): Promise<SwarmPaneView | null> {
  await restoreNav(p)
  const n = swarmNav
  if (!n) return null
  switch (n.view) {
    case 'start':
      return buildStart(p, n)
    case 'builder':
      return buildBuilder(p, n)
    case 'proposal':
      return buildProposal(p, n)
    case 'browser':
      return buildBrowser(p, n)
    case 'history':
      return buildHistory(p, n)
    case 'recovery':
      return buildRecovery(p, n)
    case 'unsettled':
      return buildUnsettled(p, n)
  }
}

const SOURCE_LABEL: Record<string, string> = { user: 'your user settings', project: 'project settings', local: 'local settings', policy: 'managed policy' }

/** A check's severity in a word, beside its glyph (WP-DD): what it says of the check. */
const SEVERITY_WORD: Record<HealthReport['rows'][number]['severity'], string> = { error: 'fails', warning: 'warning', info: 'note', ok: 'ok' }

function doctorRow(r: HealthReport['rows'][number]): DoctorRowView {
  const values: string[] = []
  const v = r.values
  if (v?.need !== undefined) values.push(`needs ${v.need}`)
  if (v && ('process' in v || v.sources)) values.push(`this process: ${v.process === undefined ? 'not set' : oneLine(v.process, 40)}`)
  for (const [src, val] of Object.entries(v?.sources ?? {})) values.push(`${SOURCE_LABEL[src] ?? src}: ${oneLine(val, 40)}`)
  return { id: oneLine(r.id, 40), ...SEVERITY[r.severity], word: SEVERITY_WORD[r.severity] ?? 'note', title: oneLine(r.title, 120), detail: clean(r.detail, 600), values }
}

/** The doctor's rows, a failing check first (WP-DD): the errors, then the warnings, then the rest in J's order. */
export function failingFirst(rows: readonly DoctorRowView[]): DoctorRowView[] {
  const rank = (r: DoctorRowView) => (r.glyph === SEVERITY.error.glyph ? 0 : r.glyph === SEVERITY.warning.glyph ? 1 : 2)
  return [...rows].sort((a, b) => rank(a) - rank(b))
}

/** [Test]'s row in J's report. */
export const SUMMARY_TEST_ROW = 'summary-model'

/**
 * The doctor pane's current view, or null when it isn't open. It runs J's
 * health check each time it's built; the summaryModel call only with `test`
 * ([Test]'s press), and otherwise the row that press gave is drawn again.
 */
export async function doctorView(p: Ports, opts: { test?: boolean } = {}): Promise<DoctorPaneView | null> {
  await restoreNav(p)
  const d = doctorNav
  if (!d) return null
  const litterDir = sessionDir()
  let settingsPath = '~/.claude/settings.json'
  try {
    settingsPath = `${await p.configDir()}/settings.json`
  } catch {
    // The usual place.
  }
  const body: DoctorPaneBody = {
    swarm: d.swarm,
    title: d.swarm ? title(d.swarm, { text: " · its spec against this session's settings" }) : title(null, { text: "this session's settings, with no swarm's spec" }),
    notice: d.notice,
    rows: [],
    errors: 0,
    warnings: 0,
    snippet: null,
    settingsPath: clean(settingsPath, 400),
    tested: opts.test === true || d.tested !== null,
  }
  try {
    let spec: SwarmSpec | null = null
    if (d.swarm && litterDir) spec = (await loadDraft(p, litterDir, d.swarm)).spec
    const report = await owners().checkHealth(p, { spec, litterDir, ...(opts.test ? { testSummaryModel: true } : {}) })
    body.rows = report.rows.map(doctorRow)
    body.errors = report.errors
    body.warnings = report.warnings
    const kept = d.tested
    if (!opts.test && kept && !body.rows.some(r => r.id === kept.id)) {
      // A row kept from before WP-DD has no word yet.
      body.rows.push({ ...kept, word: kept.word ?? (kept.glyph === SEVERITY.error.glyph ? 'fails' : kept.glyph === SEVERITY.warning.glyph ? 'warning' : 'ok') })
      if (kept.glyph === SEVERITY.error.glyph) body.errors++
      else if (kept.glyph === SEVERITY.warning.glyph) body.warnings++
    }
    body.rows = failingFirst(body.rows)
    body.snippet = report.snippet ? clean(JSON.stringify(report.snippet, null, 2), 4000) : null
  } catch (err) {
    body.notice = { text: oneLine(`the health check didn't run: ${errText(err)}`, 300), level: 'error' }
  }
  return { view: 'doctor', v: nextV(), body }
}

// ---------------------------------------------------------------------------
// What the handlers need of a live swarm

/** The swarm a no-name `/litter swarms` opens: one this session owns, the latest started, else any live one. */
export function defaultLiveSwarm(): string | null {
  const live = liveSwarms()
  const owned = live.filter(s => !s.readOnly && !s.lost).sort((a, b) => b.startedAt - a.startedAt)
  return owned[0]?.name ?? live.sort((a, b) => b.startedAt - a.startedAt)[0]?.name ?? null
}

/** The bound agents of the given node ids still running, held or starting ([Stop them]). */
export function runningOf(swarm: string, nodes: readonly string[], listed: readonly ListedAgent[]): string[] {
  const byId = new Map(listed.map(a => [a.id, a]))
  return bindings(swarm)
    .filter(b => nodes.includes(b.node) && b.kind !== 'child' && isRunningAgent(b.agentId, byId))
    .map(b => b.agentId)
}

/** The launch ledger's records as the browser last read them (handlers check a flag's seq against them). */
export async function launchLedgerRecords(p: Ports, swarm: string): Promise<StoredRecord[]> {
  const s = liveSwarm(swarm)
  const litterDir = sessionDir()
  if (!s || !litterDir) return []
  return (await launchRecords(p, litterDir, swarm, s.launch)).records
}
