// WP-N: `/litter swarms` and `/litter doctor`, the `litter` pane's Swarms
// and Doctor sections (phase 5b, WP-DA), and their handlers: every press,
// input, pick and tree message calls the package that owns it, then
// refreshes the view (p.setView), which the hub's render draws.
//
// Keys are `swarm:<view>:<action>[:<arg>]`, the arg `<swarm>` or
// `<swarm>/<rest>` on every view but the start screen and the doctor's
// (`swarm:doctor:`, Doctor's: ui/hub.ts's key rule). A press on a view the
// section no longer shows (another view, another swarm, another proposal) is
// stale: it's ignored, with a toast, and the view is drawn again. Anything
// not keyed so passes to next(e).
//
// Contract owner: phase 2b-1, package N (C picked the signatures).

import type { Ports } from '../ports'
import type { CommandRunHook, PortHook, UiInputHook, UiMessageHook, UiPressHook, UiSelectHook } from '../hooktypes'
import type { SwarmNotice } from '../../types/index'
import type { Draft, SwarmNode, SwarmSpec, Template } from './types'
import type { SwarmNav } from './view'
import type { WaitBudget } from './admit'
import type { Loaded } from '../ui/hub'
import { litterShows, openSection } from '../ui/hub'
import { session } from '../session'
import { SWARM_NAME } from '../layout'
import { liveSwarm, takeProposals, version } from './state'
import { parameterize } from './templates'
import { waitBudget } from './admit'
import {
  LEAD_ROW,
  NODE_FIELDS,
  SUMMARY_TEST_ROW,
  UNSETTLED_AFTER_MS,
  acceptPick,
  blankNav,
  briefOf,
  cardKey,
  clean,
  composerRoute,
  composerTarget,
  defaultLiveSwarm,
  dismissCard,
  doctorNavigation,
  doctorView,
  dropProposal,
  fieldKey,
  instanceAddress,
  launchLedgerRecords,
  ledgerStamp,
  loadDraft,
  markStripDue,
  namesTheSwarm,
  nav,
  navRev,
  nodeChanges,
  noteProposal,
  oneLine,
  openFlags,
  owners,
  pendingCard,
  pendingProposals,
  prefsOf,
  proposalsSeeded,
  putDraftCache,
  putInput,
  putStrip,
  recoveryChoices,
  resolveRow,
  restoreNav,
  runCheck,
  runningOf,
  saveAsOffers,
  saveNav,
  seedProposals,
  setDoctorNav,
  setFromTemplate,
  setInvalid,
  setNav,
  setPrefs,
  setSwarmField,
  spawnKey,
  stripOf,
  swarmView,
  templateOf,
  unprefixed,
} from './view'

/** The tree Client's key: `e.element` of its ui.message. */
export const TREE_KEY = 'swarm-tree'
/** What the tree posts: `{ swarm, action, row, worker? }`. */
export const TREE_ACTIONS: readonly string[] = ['select', 'add', 'attach', 'duplicate', 'delete', 'up', 'down']

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// ---------------------------------------------------------------------------
// The commands

/** `/litter swarms [name]` (ui/hub.ts's litterCommand): shows Swarms in the `litter` pane, answering with a one-line `text`. */
export const swarmCommand: PortHook<CommandRunHook> = async (p, e, next) => ({ text: (await openSection(p, 'swarms', (e.args ?? '').trim(), { focus: true })).text })

/** `/litter doctor [swarm]`: shows Doctor, checking that swarm's spec (else the builder's, else none). */
export const doctorCommand: PortHook<CommandRunHook> = async (p, e, next) => ({ text: (await openSection(p, 'doctor', (e.args ?? '').trim(), { focus: true })).text })

/** Where `/litter swarms` lands for a live swarm: its recovery card while one waits, else the browser. */
const liveNav = (name: string): SwarmNav => blankNav(pendingCard(name) ? 'recovery' : 'browser', name)

/** A swarm name an argument names, or the refusal's line. */
function swarmNamed(arg: string): { name: string } | { refused: string } {
  const name = arg.trim().split(/\s+/)[0] ?? ''
  if (name !== '' && !SWARM_NAME.test(name)) return { refused: `"${oneLine(name, 40)}" isn't a swarm name (a-z, 0-9 and -, up to 24, not starting with -)` }
  return { name }
}

/** Swarms' load (openSection): `/litter swarms [name]`'s work, and the band's [Browser]; answers the command's line. */
export async function loadSwarm(p: Ports, arg: string): Promise<Loaded> {
  await restoreNav(p)
  const named = swarmNamed(arg)
  if ('refused' in named) return { text: named.refused, refused: true }
  const name = named.name
  let n: SwarmNav
  // The swarm's undecided proposals, from J's spec ledger: module memory is empty after a reload.
  const opened = name !== '' ? name : defaultLiveSwarm()
  if (opened) await seedProposals(p, opened)
  if (name === '') {
    const live = defaultLiveSwarm()
    n = live ? liveNav(live) : blankNav('start', null)
  } else if (liveSwarm(name)) {
    n = liveNav(name)
  } else {
    const staged = pendingProposals(name)
    n = staged.length > 0 ? await proposalNav(p, name, staged[0]!) : blankNav('builder', name)
  }
  setNav(n)
  await drawSwarm(p)
  const shows = nav()
  const what = shows ? describeNav(shows) : 'nothing'
  return { text: `Swarms shows ${what}` }
}

/** Swarms from the strip or Home: the view it showed, drawn again, else what `/litter swarms` opens. */
export async function resumeSwarm(p: Ports): Promise<void> {
  await restoreNav(p)
  if (nav()) await drawSwarm(p)
  else await loadSwarm(p, '')
}

const describeNav = (n: SwarmNav): string => {
  const s = n.swarm ?? ''
  switch (n.view) {
    case 'start':
      return 'the start screen'
    case 'builder':
      return `the builder for ${s}`
    case 'proposal':
      return `the lead's proposal ${n.proposal ?? ''} for ${s}`
    case 'browser':
      return `${s}, live`
    case 'history':
      return `${s}'s goal history`
    case 'recovery':
      return `${s}'s recovery card`
    case 'unsettled':
      return `what ${s} is still waiting on`
  }
}

/**
 * Doctor's load (openSection): `/litter doctor [swarm]`, and the builder's
 * [Doctor] with its swarm's name. With no name, the swarm the builder or a
 * proposal shows, else this session alone. Answers the command's line.
 */
export async function loadDoctor(p: Ports, arg: string): Promise<Loaded> {
  await restoreNav(p)
  const named = swarmNamed(arg)
  if ('refused' in named) return { text: named.refused, refused: true }
  const n = nav()
  const which = named.name !== '' ? named.name : n && (n.view === 'builder' || n.view === 'proposal') ? n.swarm : null
  setDoctorNav({ swarm: which, notice: null, tested: null })
  const view = await drawDoctor(p)
  const body = view?.body
  const counts = body ? `: ${body.errors} error${body.errors === 1 ? '' : 's'}, ${body.warnings} warning${body.warnings === 1 ? '' : 's'}` : ''
  return { text: `Doctor checks ${which ? which : 'this session, with no swarm spec'}${counts}` }
}

/** Doctor from the strip or Home: the checks it showed, run again, else what `/litter doctor` opens. */
export async function resumeDoctor(p: Ports): Promise<void> {
  await restoreNav(p)
  if (doctorNavigation()) await drawDoctor(p)
  else await loadDoctor(p, '')
}

// ---------------------------------------------------------------------------
// Drawing

let lastStamp = ''
let savedRev = -1

async function stampOf(p: Ports): Promise<string> {
  const n = nav()
  const live = n !== null && (n.view === 'browser' || n.view === 'unsettled')
  // The browser's ages and the unsettled report's run times move on their own.
  const bucket = live ? Math.floor((await p.now()) / 10_000) : 0
  return `${version()}|${navRev()}|${await ledgerStamp(p)}|${bucket}`
}

/**
 * Builds the swarm pane's view and writes it. The navigation follows what was
 * drawn: the view a fallback drew, and the browser's selection, which a
 * default may have filled (the composer's To), so [Send] and ⏎ act on what
 * the pane shows.
 */
async function drawSwarm(p: Ports): Promise<void> {
  const view = await swarmView(p)
  const n = nav()
  if (view && n) {
    const patch: Partial<SwarmNav> = {}
    if (view.view !== n.view) patch.view = view.view
    if (view.view === 'browser' && view.selected !== n.selected) patch.selected = view.selected
    if (Object.keys(patch).length > 0) setNav({ ...n, ...patch })
  }
  await p.setView('swarm', view)
  lastStamp = await stampOf(p)
  if (savedRev !== navRev()) {
    savedRev = navRev()
    await saveNav(p)
  }
}

/** The doctor view last drawn: [Copy] and [Ask lead] act on what you saw. */
let lastDoctor: Awaited<ReturnType<typeof doctorView>> = null

async function drawDoctor(p: Ports, test = false) {
  const view = await doctorView(p, { test })
  lastDoctor = view
  await p.setView('doctor', view)
  await saveNav(p)
  return view
}

/** Rebuilds both views now (O after a /clear rebind, since $.state was wiped). */
export async function refreshPanes(p: Ports): Promise<void> {
  await restoreNav(p)
  if (nav()) await drawSwarm(p)
  if (doctorNavigation()) await drawDoctor(p)
}

// ---------------------------------------------------------------------------
// The tick

let timer: { cancel(): void } | null = null
let ticking = false

/** The builder's strip waits this long after the last edit, so typing isn't checked per key. */
export const STRIP_DEBOUNCE_MS = 800

/**
 * At session.start, with the timers: every second, the proposals handed
 * over, then, while the `litter` pane is open on Swarms (ui/hub.ts,
 * litterShows), the view rebuilt when state.ts's version or a ledger head
 * changed.
 */
export function startPaneTimer(p: Ports): void {
  timer?.cancel()
  timer = p.every(1000, () => {
    if (ticking) return
    ticking = true
    paneTick(p, () => litterShows(p, 'swarms'))
      .catch((err: unknown) => p.log(`swarm pane: the tick failed: ${errText(err)}`))
      .finally(() => {
        ticking = false
      })
  })
}

/**
 * One tick: proposals handed over (always: a proposal's toast never waits on
 * the pane), then, when `shown` answers true (no `shown`: always), the
 * strip's check when due, the recovery card and unsettled report, and a
 * redraw if anything moved.
 */
export async function paneTick(p: Ports, shown?: () => Promise<boolean>): Promise<void> {
  await restoreNav(p)
  for (const staged of takeProposals()) await proposalArrived(p, staged.name, staged.n)
  const n = nav()
  if (!n) return
  if (shown && !(await shown())) return
  const now = await p.now()
  let force = false
  // A pane a reload brought back from $.store: its swarm's proposals, from the ledger, once.
  if (n.swarm && !proposalsSeeded(n.swarm)) {
    await seedProposals(p, n.swarm)
    force = true
  }
  if (n.view === 'builder' && n.swarm) {
    const strip = stripOf(n.swarm)
    if ((strip === null || strip.due) && now - (strip?.editedAt ?? 0) >= STRIP_DEBOUNCE_MS) {
      await runCheck(p, n.swarm)
      force = true
    }
  }
  if (n.view === 'browser' && n.swarm) {
    if (pendingCard(n.swarm)) setNav({ ...n, view: 'recovery', recoveryPicked: [] })
    else {
      const progress = settling(p, n.swarm)
      if (progress && now - Math.max(progress.since, n.waitedOn ?? 0) >= UNSETTLED_AFTER_MS) setNav({ ...n, view: 'unsettled' })
    }
  }
  if (n.view === 'unsettled' && n.swarm && !settling(p, n.swarm)) setNav({ ...n, view: 'browser' })
  if (!force && (await stampOf(p)) === lastStamp) return
  await drawSwarm(p)
}

function settling(p: Ports, swarm: string) {
  try {
    return owners().settleProgress(swarm)
  } catch (err) {
    p.log(`swarm pane: settleProgress: ${errText(err)}`)
    return null
  }
}

/** A proposal swarm_propose staged: the pane shows it when it's on that swarm's builder or the start screen, else a toast says where it is. */
async function proposalArrived(p: Ports, name: string, num: number): Promise<void> {
  noteProposal(name, num)
  const n = nav()
  if (n && (n.view === 'start' || (n.view === 'builder' && n.swarm === name))) {
    setNav(await proposalNav(p, name, num))
    return
  }
  p.toast(`the lead proposed changes to ${name}: /litter swarms ${name} shows them`)
}

/**
 * The proposal view's navigation, with every change and brief picked but the
 * conflicts. A new or removed node's brief has no pick of its own: it goes
 * with its node's change (15.5).
 */
async function proposalNav(p: Ports, name: string, num: number): Promise<SwarmNav> {
  const n: SwarmNav = { ...blankNav('proposal', name), proposal: num }
  const litterDir = session().litterDir
  if (!litterDir) return n
  try {
    const pv = await owners().readProposal(p, litterDir, name, num)
    if (!pv) return n
    const withNode = nodeChanges(pv)
    return {
      ...n,
      picked: pv.changes.flatMap((c, i) => (c.conflict ? [] : [i])),
      pickedBriefs: pv.briefs.filter(b => !b.conflict && !withNode.has(b.node)).map(b => b.node),
    }
  } catch (err) {
    p.log(`swarm pane: readProposal ${name} ${num}: ${errText(err)}`)
    return n
  }
}

// ---------------------------------------------------------------------------
// Keys, and the stale check

export type PaneKey = {
  view: string
  action: string
  /** Everything after the action. */
  arg: string
  /** The swarm the key was drawn for; null on the start screen and the doctor's. */
  swarm: string | null
  /** The arg after `<swarm>/`. */
  rest: string
}

export function parseKey(key: string): PaneKey | null {
  if (!key.startsWith('swarm:')) return null
  const [, view, action, ...more] = key.split(':')
  if (!view || !action) return null
  const arg = more.join(':')
  if (view === 'start' || view === 'doctor') return { view, action, arg, swarm: null, rest: arg }
  const slash = arg.indexOf('/')
  return { view, action, arg, swarm: slash < 0 ? arg : arg.slice(0, slash), rest: slash < 0 ? '' : arg.slice(slash + 1) }
}

/** Why a key no longer acts on what the pane shows, or null when it does. */
export function stalePress(n: SwarmNav | null, k: PaneKey, doctorOpen: boolean): string | null {
  if (k.view === 'doctor') return doctorOpen ? null : 'the doctor pane was closed'
  if (!n) return 'the swarm pane was closed'
  if (n.view !== k.view) return `that was on the ${k.view} view, and the pane shows the ${n.view} now`
  if (k.swarm !== null && k.swarm !== n.swarm) return `that was for ${k.swarm}, and the pane shows ${n.swarm ?? 'no swarm'} now`
  if (k.view === 'proposal' && Number(k.rest.split('/')[0]) !== n.proposal) return 'that was on another proposal'
  return null
}

type Input = {
  value?: string
  kind?: 'change' | 'submit'
  data?: Record<string, unknown>
  /** The dispatch's own (admit.ts's waitBudget over its next): a send's settle wait never runs past it (FIX-U, U5). */
  budget?: WaitBudget
}

/** ui.message from the tree's Client (`e.element === 'swarm-tree'`). */
export const onUiMessage: PortHook<UiMessageHook> = async (p, e, next) => {
  if (e.element !== TREE_KEY) return next(e)
  const data = e.data !== null && typeof e.data === 'object' && !Array.isArray(e.data) ? (e.data as Record<string, unknown>) : {}
  const swarm = typeof data.swarm === 'string' ? data.swarm : ''
  const action = typeof data.action === 'string' ? data.action : ''
  const row = typeof data.row === 'string' ? data.row : ''
  if (!TREE_ACTIONS.includes(action)) return {}
  p.log(`swarm pane: the tree's ${action} on ${oneLine(row, 80)}`)
  await handle(p, `swarm:builder:${action}:${swarm}/${row}`, { data })
  return {}
}

/** ui.press on the panes' buttons, keyed `swarm:<view>:<action>[:<arg>]`. [Send] carries the dispatch's budget. */
export const onUiPress: PortHook<UiPressHook> = async (p, e, next) => {
  if (!parseKey(e.element)) return next(e)
  await handle(p, e.element, { budget: await waitBudget(p, next) })
  return { element: e.element }
}

/** ui.input on the panes' fields; ⏎ in the composer sends, with the dispatch's budget. */
export const onUiInput: PortHook<UiInputHook> = async (p, e, next) => {
  if (!parseKey(e.element)) return next(e)
  await handle(p, e.element, { value: e.value, kind: e.kind, budget: await waitBudget(p, next) })
  return { element: e.element, value: e.value }
}

export const onUiSelect: PortHook<UiSelectHook> = async (p, e, next) => {
  if (!parseKey(e.element)) return next(e)
  await handle(p, e.element, { value: e.value })
  return { element: e.element, value: e.value }
}

/** One press, field or pick: the stale check, the action, then the redraw. */
export async function handle(p: Ports, key: string, input: Input): Promise<void> {
  const k = parseKey(key)
  if (!k) return
  await restoreNav(p)
  const why = stalePress(nav(), k, doctorNavigation() !== null)
  if (why) {
    p.toast(`${why}, so it was ignored`)
    p.log(`swarm pane: stale ${key}: ${why}`)
    await refreshPanes(p)
    return
  }
  if (k.view === 'doctor') {
    try {
      await doctorAction(p, k)
    } catch (err) {
      p.log(`swarm pane: ${key} failed: ${errText(err)}`)
      p.toast(`that failed: ${oneLine(unprefixed(errText(err)), 100)}`)
    }
    return
  }
  const typing = input.kind === 'change'
  const n = nav()!
  // A new action's outcome replaces the last one's; typing leaves it.
  if (!typing && n.notice) setNav({ ...n, notice: null })
  let redraw = true
  try {
    redraw = await swarmAction(p, k, input)
  } catch (err) {
    // An owner's read that threw (the draft, a ledger): said on the pane, never swallowed.
    p.log(`swarm pane: ${key} failed: ${errText(err)}`)
    failed(p, 'that', errText(err))
  }
  if (redraw) await drawSwarm(p)
}

// ---------------------------------------------------------------------------
// Owners, notices

type Called<T> = { ok: true; value: T } | { ok: false; error: string }

/** Calls an owner, logging the call (`swarm pane: <what>`) and its failure. */
async function call<T>(p: Ports, what: string, fn: () => Promise<T> | T): Promise<Called<T>> {
  p.log(`swarm pane: ${what}`)
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    const error = errText(err)
    p.log(`swarm pane: ${what} failed: ${error}`)
    return { ok: false, error }
  }
}

function notice(level: SwarmNotice['level'], text: string): void {
  const n = nav()
  if (n) setNav({ ...n, notice: { level, text: oneLine(text, 300) } })
}

/** An owner's failure: on the pane, and as a toast in case the pane isn't drawn. */
function failed(p: Ports, what: string, error: string): void {
  notice('error', `${what} failed: ${error}`)
  p.toast(`${what} failed: ${oneLine(unprefixed(error), 100)}`)
}

function go(view: SwarmNav['view'], swarm: string | null, patch: Partial<SwarmNav> = {}): void {
  setNav({ ...blankNav(view, swarm), ...patch })
}

/** A request for the lead, as its own turn once the session is idle: scheduled, never awaited in the hook. */
function submitLater(p: Ports, text: string, what: string): void {
  p.after(0, () => {
    p.submitPrompt(text).then(
      () => p.log(`swarm pane: ${what} reached the lead`),
      (err: unknown) => {
        p.log(`swarm pane: ${what} wasn't submitted: ${errText(err)}`)
        p.toast(`${what} didn't reach the lead: ${oneLine(unprefixed(errText(err)), 100)}`)
      },
    )
  })
}

const litterDirOr = (): string | null => session().litterDir

// ---------------------------------------------------------------------------
// The swarm pane's actions; each answers whether to redraw

async function swarmAction(p: Ports, k: PaneKey, input: Input): Promise<boolean> {
  switch (k.view) {
    case 'start':
      return startAction(p, k, input)
    case 'builder':
      return builderAction(p, k, input)
    case 'proposal':
      return proposalAction(p, k)
    case 'browser':
      return browserAction(p, k, input)
    case 'history':
      if (k.action === 'back') go('browser', k.swarm)
      return true
    case 'recovery':
      return recoveryAction(p, k)
    case 'unsettled':
      return unsettledAction(p, k)
    default:
      return true
  }
}

// The start screen

const START_NAME = 'swarm:start:name'
const START_ASK = 'swarm:start:ask'

async function startAction(p: Ports, k: PaneKey, input: Input): Promise<boolean> {
  const n = nav()!
  const litterDir = litterDirOr()
  switch (k.action) {
    case 'name':
    case 'ask':
    case 'param': {
      const key = k.action === 'param' ? `swarm:start:param:${k.arg}` : k.action === 'name' ? START_NAME : START_ASK
      putInput(key, input.value ?? '')
      if (k.action === 'ask' && input.kind === 'submit') return askNew(p)
      // A template's errors stay until you change its parameters (the Name fills its `name`): then they go, drawn once.
      if (k.action !== 'ask' && n.templateErrors.length > 0) {
        setNav({ ...nav()!, templateErrors: [] })
        return true
      }
      return false
    }
    case 'ask-send':
      return askNew(p)
    case 'template':
      setNav({ ...n, template: input.value ? input.value : null, templateErrors: [] })
      return true
    case 'cancel-template':
      setNav({ ...n, template: null, templateErrors: [] })
      return true
    case 'use-template':
      return useTemplate(p)
    case 'blank': {
      const name = await newName(p)
      if (!name || !litterDir) return true
      const at = await p.now()
      const draft: Draft = { base: 0, edits: [{ path: 'nodes', at }], spec: { name, goal: '', nodes: [] }, briefs: {}, updatedAt: at }
      if (!(await keepDraft(p, litterDir, name, draft))) return true
      setFromTemplate(name, null)
      go('builder', name, { notice: { level: 'info', text: `a new swarm, ${name}: nothing is saved until [Save]` } })
      return true
    }
    case 'open': {
      const name = k.arg
      if (!SWARM_NAME.test(name)) return true
      await seedProposals(p, name)
      if (liveSwarm(name)) setNav(liveNav(name))
      else go('builder', name)
      return true
    }
    default:
      return true
  }
}

/** The start screen's name, checked: a valid name no saved swarm has. */
async function newName(p: Ports): Promise<string | null> {
  const n = nav()!
  const litterDir = litterDirOr()
  const name = (n.inputs[START_NAME] ?? '').trim()
  if (!litterDir) {
    notice('error', 'no litter directory, so nothing can be saved')
    return null
  }
  if (!SWARM_NAME.test(name)) {
    notice('warning', 'name the swarm first: a-z, 0-9 and -, up to 24, not starting with -')
    return null
  }
  const listed = await call(p, `listSwarms`, () => owners().listSwarms(p, litterDir))
  if (listed.ok && listed.value.some(s => s.name === name)) {
    notice('warning', `there's a swarm named ${name} already: open it below, or pick another name`)
    return null
  }
  return name
}

async function askNew(p: Ports): Promise<boolean> {
  const n = nav()!
  const ask = clean(n.inputs[START_ASK] ?? '', 4000).trim()
  if (ask === '') {
    notice('warning', 'say what the swarm is for first')
    return true
  }
  const name = (n.inputs[START_NAME] ?? '').trim()
  const named = SWARM_NAME.test(name) ? ` named "${name}"` : ''
  submitLater(
    p,
    `Please design a new litter swarm${named} for this: ${ask}\n\nUse the proposal section of the litter swarm skill: stage it with swarm_propose, so I can review it in the swarm builder.`,
    'the request for a new swarm',
  )
  putInput(START_ASK, null)
  notice('ok', 'asked the lead: its proposal opens here once staged')
  return true
}

/** A template by its id (`<scope>:<name>`), whole, through J's loadTemplate. */
async function readTemplate(p: Ports, litterDir: string, id: string): Promise<Template | string> {
  const at = id.indexOf(':')
  const scope = id.slice(0, at)
  if (at < 0 || (scope !== 'builtin' && scope !== 'user' && scope !== 'project')) return 'that template is gone'
  const r = await call(p, `loadTemplate ${id}`, () => owners().loadTemplate(p, litterDir, scope, id.slice(at + 1)))
  if (!r.ok) return r.error
  return r.value ?? 'that template is gone'
}

/**
 * [Use template]: J's instantiate with the parameters typed, the Name filling
 * a `name` parameter. A check that fails makes no draft: its errors stay on
 * the start screen until a parameter changes.
 */
async function useTemplate(p: Ports): Promise<boolean> {
  const n = nav()!
  const litterDir = litterDirOr()
  if (!n.template || !litterDir) return true
  const name = await newName(p)
  if (!name) return true
  const template = await readTemplate(p, litterDir, n.template)
  if (typeof template === 'string') {
    notice('error', `the template can't be used: ${template}`)
    return true
  }
  const values: Record<string, string | string[]> = {}
  for (const param of template.params) {
    if (namesTheSwarm(param)) {
      values[param.name] = name
      continue
    }
    const dflt = Array.isArray(param.default) ? param.default.join(', ') : (param.default ?? '')
    const text = n.inputs[`swarm:start:param:${param.name}`] ?? dflt
    values[param.name] =
      param.type === 'list'
        ? text
            .split(/[,\n]/)
            .map(s => s.trim())
            .filter(s => s !== '')
        : text
  }
  const r = await call(p, `instantiate ${template.scope}:${template.name}`, () => owners().instantiate(p, litterDir, template, values))
  if (!r.ok) {
    failed(p, 'the template', r.error)
    return true
  }
  const check = r.value.check
  if (!check.ok) {
    const errors = check.errors.map(e => `${e.field}: ${e.error}`)
    setNav({ ...nav()!, templateErrors: errors })
    notice('error', `no draft made: ${errors.length} error${errors.length === 1 ? '' : 's'} with these parameters; change them and [Use template] again`)
    return true
  }
  const at = await p.now()
  const spec: SwarmSpec = { ...r.value.spec, name }
  const draft: Draft = { base: 0, edits: [{ path: 'nodes', at }], spec, briefs: { ...r.value.briefs }, updatedAt: at }
  if (!(await keepDraft(p, litterDir, name, draft))) return true
  setFromTemplate(name, template.name)
  go('builder', name, { notice: { level: 'info', text: `${name}, from the ${template.name} template: nothing is saved until [Save]` } })
  return true
}

/** Puts a draft in hand and in J's store. */
async function keepDraft(p: Ports, litterDir: string, name: string, draft: Draft): Promise<boolean> {
  const r = await call(p, `writeDraft ${name}`, () => owners().writeDraft(p, litterDir, name, draft))
  if (!r.ok) {
    failed(p, 'keeping the draft', r.error)
    return false
  }
  putDraftCache(name, draft)
  markStripDue(name, draft.updatedAt)
  return true
}

// ---------------------------------------------------------------------------
// The builder: the spec edits, pure, so the spec tests drive them directly

export type SpecEdit = {
  spec: SwarmSpec
  /** The paths edited, for the draft's `edits`. */
  paths: string[]
  /** The tree row to select after. */
  select: string
  /** Briefs to set (text) or drop (null), by node. */
  briefs?: Record<string, string | null>
}

const NODE_MAX = 32

/** `base`, or `base-2`, `base-3`, … the first no node has, cut to a node id's length. */
export function freshId(spec: SwarmSpec, base: string): string {
  const taken = new Set(spec.nodes.map(x => x.id))
  const stem = base.slice(0, NODE_MAX).replace(/-+$/, '') || 'node'
  if (!taken.has(stem)) return stem
  for (let i = 2; ; i++) {
    const tail = `-${i}`
    const id = `${stem.slice(0, NODE_MAX - tail.length).replace(/-+$/, '')}${tail}`
    if (!taken.has(id)) return id
  }
}

const parentRow = (row: string): string => {
  const at = row.lastIndexOf('/')
  return at <= 0 || row.startsWith('~/') ? LEAD_ROW : row.slice(0, at)
}

const withNodes = (spec: SwarmSpec, nodes: SwarmNode[]): SwarmSpec => ({ ...spec, nodes })
const replaceNode = (spec: SwarmSpec, node: SwarmNode): SwarmSpec => withNodes(spec, spec.nodes.map(x => (x.id === node.id ? node : x)))

/** Adds a child under a row: an orchestrator under the lead, a new worker under a node (in its spawns). */
export function addChild(spec: SwarmSpec, row: string): SpecEdit | { error: string } {
  const target = resolveRow(spec, row)
  if (!target) return { error: 'that row is gone' }
  if (target.kind === 'lead') {
    const id = freshId(spec, 'orchestrator')
    return { spec: withNodes(spec, [...spec.nodes, { id, kind: 'orchestrator' }]), paths: [`nodes.${id}`], select: id }
  }
  const id = freshId(spec, 'worker')
  const parent: SwarmNode = { ...target.node, spawns: { ...(target.node.spawns ?? {}), [id]: 1 } }
  const nodes = [...replaceNode(spec, parent).nodes, { id, kind: 'worker' as const }]
  return { spec: withNodes(spec, nodes), paths: [`nodes.${id}`, `nodes.${parent.id}.spawns`], select: target.unattached ? row : `${row}/${id}` }
}

/** Puts an existing worker under a node, one at a time ("add worker ▸"). */
export function attachWorker(spec: SwarmSpec, row: string, worker: string): SpecEdit | { error: string } {
  const target = resolveRow(spec, row)
  if (!target || target.kind === 'lead') return { error: 'workers go under a node' }
  const w = spec.nodes.find(x => x.id === worker)
  if (!w || w.kind !== 'worker') return { error: `there's no worker ${worker}` }
  if (worker === target.node.id) return { error: "a node can't spawn itself" }
  if (target.node.spawns && Object.hasOwn(target.node.spawns, worker)) return { spec, paths: [], select: target.unattached ? row : `${row}/${worker}` }
  const parent: SwarmNode = { ...target.node, spawns: { ...(target.node.spawns ?? {}), [worker]: 1 } }
  return { spec: replaceNode(spec, parent), paths: [`nodes.${parent.id}.spawns`], select: target.unattached ? row : `${row}/${worker}` }
}

/** A copy of a row's node, `<id>-copy`, beside it, with its brief and its place in its parent's spawns. */
export function duplicateRow(spec: SwarmSpec, row: string, brief: string | null): SpecEdit | { error: string } {
  const target = resolveRow(spec, row)
  if (!target || target.kind === 'lead') return { error: 'pick a node to duplicate' }
  const src = target.node
  const id = freshId(spec, `${src.id}-copy`)
  const copy: SwarmNode = { ...structuredClone(src), id }
  if (copy.brief !== undefined) copy.brief = `briefs/${id}.md`
  const at = spec.nodes.findIndex(x => x.id === src.id)
  let nodes = [...spec.nodes.slice(0, at + 1), copy, ...spec.nodes.slice(at + 1)]
  const paths = [`nodes.${id}`]
  let select = target.unattached ? `~/${id}` : id
  if (target.parent && !target.unattached) {
    const count = target.parent.spawns?.[src.id] ?? 1
    const parent: SwarmNode = { ...target.parent, spawns: { ...(target.parent.spawns ?? {}), [id]: count } }
    nodes = nodes.map(x => (x.id === parent.id ? parent : x))
    paths.push(`nodes.${parent.id}.spawns`)
    select = `${parentRow(row)}/${id}`
  }
  if (brief !== null) paths.push(`brief:${id}`)
  return { spec: withNodes(spec, nodes), paths, select, ...(brief !== null ? { briefs: { [id]: brief } } : {}) }
}

/**
 * Deletes a row: a worker under a parent leaves that parent's spawns, and goes
 * when nothing else spawns it; an orchestrator, or a node nothing spawns, goes,
 * and leaves every spawns it was in.
 */
export function deleteRow(spec: SwarmSpec, row: string): SpecEdit | { error: string } {
  const target = resolveRow(spec, row)
  if (!target) return { error: 'that row is gone' }
  if (target.kind === 'lead') return { error: "the lead is this session: it can't be deleted" }
  const id = target.node.id
  const paths: string[] = []
  let nodes = spec.nodes
  if (target.parent && !target.unattached) {
    const spawns = { ...(target.parent.spawns ?? {}) }
    delete spawns[id]
    const parent: SwarmNode = { ...target.parent, spawns }
    if (Object.keys(spawns).length === 0) delete parent.spawns
    nodes = nodes.map(x => (x.id === parent.id ? parent : x))
    paths.push(`nodes.${parent.id}.spawns`)
    const stillSpawned = nodes.some(x => x.spawns && Object.hasOwn(x.spawns, id))
    if (stillSpawned) return { spec: withNodes(spec, nodes), paths, select: parentRow(row) }
  }
  nodes = nodes
    .filter(x => x.id !== id)
    .map(x => {
      if (!x.spawns || !Object.hasOwn(x.spawns, id)) return x
      const spawns = { ...x.spawns }
      delete spawns[id]
      paths.push(`nodes.${x.id}.spawns`)
      const out: SwarmNode = { ...x, spawns }
      if (Object.keys(spawns).length === 0) delete out.spawns
      return out
    })
  paths.unshift(`nodes.${id}`)
  return { spec: withNodes(spec, nodes), paths, select: parentRow(row), briefs: { [id]: null } }
}

/** Moves a row up or down among its siblings: orchestrators in the spec's order, workers in their parent's spawns. */
export function moveRow(spec: SwarmSpec, row: string, by: -1 | 1): SpecEdit | { error: string } {
  const target = resolveRow(spec, row)
  if (!target || target.kind === 'lead') return { error: 'pick a node to move' }
  const id = target.node.id
  if (target.parent && !target.unattached) {
    const entries = Object.entries(target.parent.spawns ?? {})
    const at = entries.findIndex(([w]) => w === id)
    const to = at + by
    if (at < 0 || to < 0 || to >= entries.length) return { spec, paths: [], select: row }
    const moved = [...entries]
    ;[moved[at], moved[to]] = [moved[to]!, moved[at]!]
    const parent: SwarmNode = { ...target.parent, spawns: Object.fromEntries(moved) }
    return { spec: replaceNode(spec, parent), paths: [`nodes.${parent.id}.spawns`], select: row }
  }
  // Among the nodes drawn at the same level: the orchestrators, or the unattached.
  const peers = spec.nodes.map((x, i) => ({ x, i })).filter(({ x }) => target.unattached || x.kind === 'orchestrator')
  const at = peers.findIndex(({ x }) => x.id === id)
  const other = peers[at + by]
  if (at < 0 || !other) return { spec, paths: [], select: row }
  const nodes = [...spec.nodes]
  const from = peers[at]!.i
  ;[nodes[from], nodes[other.i]] = [nodes[other.i]!, nodes[from]!]
  return { spec: withNodes(spec, nodes), paths: ['nodes'], select: row }
}

/** Applies a spec edit to the draft: the edits list (a repeat of the last path only moves its time), J's writeDraft, the strip due. */
async function applyEdit(p: Ports, name: string, edit: SpecEdit): Promise<void> {
  const litterDir = litterDirOr()
  if (!litterDir) {
    notice('error', "no litter directory, so the draft can't be kept")
    return
  }
  const draft = await loadDraft(p, litterDir, name)
  const at = await p.now()
  const edits = [...draft.edits]
  for (const path of edit.paths) {
    const last = edits[edits.length - 1]
    if (last && last.path === path) edits[edits.length - 1] = { path, at }
    else edits.push({ path, at })
  }
  const briefs = { ...draft.briefs }
  for (const [node, text] of Object.entries(edit.briefs ?? {})) {
    if (text === null) delete briefs[node]
    else briefs[node] = text
  }
  const next: Draft = { ...draft, spec: edit.spec, briefs, edits, updatedAt: at }
  putDraftCache(name, next)
  markStripDue(name, at)
  const r = await call(p, `writeDraft ${name}`, () => owners().writeDraft(p, litterDir, name, next))
  if (!r.ok) failed(p, 'keeping the draft', r.error)
}

async function treeEdit(p: Ports, name: string, make: (spec: SwarmSpec) => SpecEdit | { error: string } | Promise<SpecEdit | { error: string }>): Promise<boolean> {
  const litterDir = litterDirOr()
  if (!litterDir) return true
  const draft = await loadDraft(p, litterDir, name)
  const edit = await make(draft.spec)
  if ('error' in edit) {
    notice('warning', edit.error)
    return true
  }
  if (edit.paths.length > 0) await applyEdit(p, name, edit)
  const n = nav()!
  setNav({ ...n, selected: edit.select })
  return true
}

/** The draft's unsaved state: what [Save] would write. */
const unsavedOf = (d: Draft): boolean => d.base === 0 || d.edits.length > 0

const ASK_BUILDER = (name: string) => `swarm:builder:ask:${name}`
const SAVEAS_NAME = (name: string) => `swarm:builder:saveas-name:${name}`
const SAVEAS_DESCRIPTION = (name: string) => `swarm:builder:saveas-description:${name}`

async function builderAction(p: Ports, k: PaneKey, input: Input): Promise<boolean> {
  const name = k.swarm ?? ''
  const n = nav()!
  const litterDir = litterDirOr()
  const o = owners()
  const row = k.rest
  switch (k.action) {
    case 'select': {
      // A row picked, or ⏎ on it: the inspector shows it; what's typed elsewhere is forgotten.
      setNav({ ...n, selected: row || LEAD_ROW, inputs: {} })
      return true
    }
    case 'add':
      return treeEdit(p, name, spec => addChild(spec, row || LEAD_ROW))
    case 'add-orchestrator':
      return treeEdit(p, name, spec => addChild(spec, LEAD_ROW))
    case 'attach': {
      const worker = typeof input.data?.worker === 'string' ? input.data.worker : (input.value ?? '')
      return treeEdit(p, name, spec => attachWorker(spec, row, worker))
    }
    case 'duplicate':
      return treeEdit(p, name, async spec => {
        const target = resolveRow(spec, row)
        if (!target || target.kind === 'lead' || !litterDir) return duplicateRow(spec, row, null)
        const draft = await loadDraft(p, litterDir, name)
        return duplicateRow(spec, row, await briefOf(p, litterDir, name, draft, target.node.id))
      })
    case 'delete':
      return treeEdit(p, name, spec => deleteRow(spec, row))
    case 'up':
    case 'down':
      return treeEdit(p, name, spec => moveRow(spec, row, k.action === 'up' ? -1 : 1))
    case 'field':
      return fieldEdit(p, name, row, input)
    case 'spawn':
      return spawnEdit(p, name, row, input)
    case 'spawn-add': {
      const value = input.value ?? ''
      if (value === '') return false
      const nodeRow = n.selected ?? row
      if (value === '+new') return treeEdit(p, name, spec => addChild(spec, rowFor(spec, nodeRow, row)))
      return treeEdit(p, name, spec => attachWorker(spec, rowFor(spec, nodeRow, row), value))
    }
    case 'ask-brief': {
      const filled = await p.fillPrompt(`/litter:swarm revise ${name} ${row}: `)
      notice(filled ? 'ok' : 'warning', filled ? 'the prompt box asks the lead: finish the request there' : "the prompt box can't take text now (a dialog is up?)")
      return true
    }
    case 'ask':
      putInput(ASK_BUILDER(name), input.value ?? '')
      return input.kind === 'submit' ? askLead(p, name) : false
    case 'ask-send':
      return askLead(p, name)
    case 'validate':
      await runCheck(p, name)
      return true
    case 'save':
      return save(p, name)
    case 'discard': {
      if (!litterDir) return true
      const r = await call(p, `clearDraft ${name}`, () => o.clearDraft(p, litterDir, name))
      if (!r.ok) failed(p, 'discarding the draft', r.error)
      else {
        putDraftCache(name, null)
        markStripDue(name, await p.now())
        setNav({ ...nav()!, inputs: {}, notice: { level: 'info', text: 'the draft is gone: this is the saved revision' } })
      }
      return true
    }
    case 'save-as':
      setNav({ ...n, saveAs: { scope: 'user', params: [] } })
      return true
    case 'saveas-name':
      putInput(SAVEAS_NAME(name), input.value ?? '')
      return false
    case 'saveas-description':
      putInput(SAVEAS_DESCRIPTION(name), input.value ?? '')
      return false
    case 'saveas-scope':
      if (n.saveAs) setNav({ ...n, saveAs: { ...n.saveAs, scope: input.value === 'project' ? 'project' : 'user' } })
      return true
    case 'saveas-param': {
      if (!n.saveAs) return true
      const params = n.saveAs.params.includes(row) ? n.saveAs.params.filter(x => x !== row) : [...n.saveAs.params, row]
      setNav({ ...n, saveAs: { ...n.saveAs, params } })
      return true
    }
    case 'saveas-cancel':
      setNav({ ...n, saveAs: null })
      return true
    case 'saveas-save':
      return saveAsTemplate(p, name)
    case 'launch':
      return launch(p, name)
    case 'doctor':
      // Doctor is a section of its own: the builder's view stays kept for the strip's way back.
      await openSection(p, 'doctor', name, { focus: true })
      return true
    case 'browser':
      if (liveSwarm(name)) setNav(liveNav(name))
      return true
    case 'proposal': {
      const num = Number(row)
      if (Number.isSafeInteger(num) && pendingProposals(name).includes(num)) setNav(await proposalNav(p, name, num))
      return true
    }
    case 'reject': {
      // A proposal J can't read: rejecting it needs only its record.
      const num = Number(row)
      if (!litterDir || !Number.isSafeInteger(num)) return true
      const r = await call(p, `rejectProposal ${name} ${num}`, () => o.rejectProposal(p, litterDir, name, num))
      if (!r.ok) {
        failed(p, 'rejecting', r.error)
        // Decided elsewhere, say: the ledger's list stands.
        await seedProposals(p, name)
      } else {
        dropProposal(name, num)
        notice('info', `rejected the lead's proposal ${num}`)
      }
      return true
    }
    case 'back':
      go('start', null)
      return true
    default:
      return true
  }
}

/** The selected row when it names a node, else the row the key was drawn for. */
function rowFor(spec: SwarmSpec, selected: string, drawn: string): string {
  const t = resolveRow(spec, selected)
  return t && t.kind === 'node' ? selected : drawn
}

/** One inspector field: `<node>/<path>`, the node `@lead` for the swarm's own. */
async function fieldEdit(p: Ports, name: string, rest: string, input: Input): Promise<boolean> {
  const litterDir = litterDirOr()
  if (!litterDir) return true
  const slash = rest.indexOf('/')
  const node = rest.slice(0, slash)
  const path = rest.slice(slash + 1)
  const key = fieldKey(name, node, path)
  const value = input.value ?? ''
  const typing = input.kind === 'change'
  const draft = await loadDraft(p, litterDir, name)
  let spec: SwarmSpec
  let editPath: string
  let wasUnset: boolean
  let nowUnset = value.trim() === ''
  if (node === LEAD_ROW) {
    const r = setSwarmField(draft.spec, path, value)
    wasUnset = path === 'goal' ? !draft.spec.goal : draft.spec.limits?.maxAgentsAtOnce === undefined
    if ('error' in r) return invalid(key, value, r.error, input)
    spec = r.spec
    editPath = path
  } else {
    const def = NODE_FIELDS.find(f => f.path === path)
    const target = draft.spec.nodes.find(x => x.id === node)
    if (!def || !target) {
      notice('warning', 'that field is gone')
      return true
    }
    wasUnset = def.get(target) === ''
    const r = def.set(target, value)
    if ('error' in r) return invalid(key, value, r.error, input)
    nowUnset = def.get(r.node) === ''
    spec = replaceNode(draft.spec, r.node)
    const top = path.split('.')[0]!
    editPath = `nodes.${node}.${top === 'model' ? 'model' : top === 'worktree' ? 'worktree' : path}`
  }
  const wasInvalid = invalidNow.has(key)
  setInvalid(key, null)
  invalidNow.delete(key)
  await applyEdit(p, name, { spec, paths: [editPath], select: nav()!.selected ?? LEAD_ROW })
  if (typing) {
    putInput(key, value)
    // A redraw while typing hands the field its text again: only when its note changes.
    return wasInvalid || wasUnset !== nowUnset
  }
  putInput(key, null)
  return true
}

/** The fields whose typed value doesn't parse (mirrors view.ts's notes, so a change of state redraws). */
const invalidNow = new Set<string>()

function invalid(key: string, value: string, why: string, input: Input): boolean {
  const was = invalidNow.has(key)
  setInvalid(key, why)
  invalidNow.add(key)
  putInput(key, value)
  return input.kind !== 'change' || !was
}

/** A spawn count: `<node>/<worker>`; empty removes it. */
async function spawnEdit(p: Ports, name: string, rest: string, input: Input): Promise<boolean> {
  const litterDir = litterDirOr()
  if (!litterDir) return true
  const [node = '', worker = ''] = rest.split('/')
  const key = spawnKey(name, node, worker)
  const value = (input.value ?? '').trim()
  const draft = await loadDraft(p, litterDir, name)
  const target = draft.spec.nodes.find(x => x.id === node)
  if (!target) return true
  const spawns = { ...(target.spawns ?? {}) }
  if (value === '') delete spawns[worker]
  else if (/^[0-9]+$/.test(value) && Number(value) > 0 && Number(value) <= 1000) spawns[worker] = Number(value)
  else return invalid(key, input.value ?? '', 'how many at once: a whole number above 0, or empty to remove it', input)
  const wasInvalid = invalidNow.has(key)
  setInvalid(key, null)
  invalidNow.delete(key)
  const out: SwarmNode = { ...target, spawns }
  if (Object.keys(spawns).length === 0) delete out.spawns
  await applyEdit(p, name, { spec: replaceNode(draft.spec, out), paths: [`nodes.${node}.spawns`], select: nav()!.selected ?? LEAD_ROW })
  if (input.kind === 'change') {
    putInput(key, input.value ?? '')
    return wasInvalid || value === ''
  }
  putInput(key, null)
  return true
}

async function askLead(p: Ports, name: string): Promise<boolean> {
  const n = nav()!
  const litterDir = litterDirOr()
  const request = clean(n.inputs[ASK_BUILDER(name)] ?? '', 4000).trim()
  if (request === '' || !litterDir) {
    notice('warning', 'say what to change first')
    return true
  }
  const draft = await loadDraft(p, litterDir, name)
  const over = draft.base === 0 ? 'a draft never saved' : `my draft over revision ${draft.base}${draft.edits.length > 0 ? ', with unsaved edits' : ''}`
  submitLater(
    p,
    `Please propose changes to the litter swarm "${name}" (${over}): ${request}\n\nUse the proposal section of the litter swarm skill: stage them with swarm_propose, so I can review the diff in the swarm builder.`,
    `the request about ${name}`,
  )
  putInput(ASK_BUILDER(name), null)
  notice('ok', 'asked the lead: its proposal opens here once staged')
  return true
}

async function save(p: Ports, name: string): Promise<boolean> {
  const litterDir = litterDirOr()
  if (!litterDir) return true
  const o = owners()
  const draft = await loadDraft(p, litterDir, name)
  if (!unsavedOf(draft)) {
    notice('info', `nothing to save: this is revision ${draft.base}`)
    return true
  }
  const changes = [...new Set(draft.edits.map(e => e.path))]
  const template = draft.base === 0 ? templateOf(name) : null
  const note = template ? { from: 'template' as const, template, changes } : { from: 'save' as const, changes }
  const r = await call(p, `saveRevision ${name}`, () => o.saveRevision(p, litterDir, name, { spec: draft.spec, briefs: draft.briefs }, note))
  if (!r.ok) {
    failed(p, 'saving', r.error)
    return true
  }
  if (!r.value.ok) {
    const errors = r.value.errors
    putStrip(name, { ok: false, errors, warnings: [] }, await p.now())
    const first = errors[0]
    notice('error', `not saved: ${errors.length} error${errors.length === 1 ? '' : 's'}${first ? `, first ${first.field}: ${first.error}` : ''}`)
    return true
  }
  const cleared = await call(p, `clearDraft ${name}`, () => o.clearDraft(p, litterDir, name))
  if (!cleared.ok) p.log(`swarm pane: the saved draft stays in the store: ${cleared.error}`)
  putDraftCache(name, null)
  setFromTemplate(name, null)
  markStripDue(name, await p.now())
  notice('ok', `saved revision ${r.value.revision}`)
  return true
}

async function launch(p: Ports, name: string): Promise<boolean> {
  const litterDir = litterDirOr()
  if (!litterDir) return true
  // Launch runs the saved revision (K). The draft only decides whether to
  // stop you first; when it can't be read, K's own checks still stand.
  let unread: string | null = null
  try {
    if (unsavedOf(await loadDraft(p, litterDir, name))) {
      notice('warning', "Save first: Launch runs the saved revision, and this draft has edits it doesn't")
      return true
    }
  } catch (err) {
    unread = errText(err)
    p.log(`swarm pane: the draft of ${name} can't be read, so Launch runs the saved revision as it is: ${unread}`)
  }
  const r = await call(p, `launchSwarm ${name}`, () => owners().launchSwarm(p, name))
  if (!r.ok) {
    failed(p, 'Launch', r.error)
    return true
  }
  if (!r.value.ok) {
    notice('error', `not launched: ${r.value.reason}`)
    return true
  }
  const caveat = unread === null ? '' : `; the draft couldn't be read, so any edits in it aren't in this launch`
  go('browser', name, { notice: { level: unread === null ? 'ok' : 'warning', text: `launched (${r.value.launch})${caveat}` } })
  return true
}

/**
 * [Save as template]: J's parameterize over the draft, each offer you picked
 * (J's templateOffers, by field) a parameter with today's value as its
 * default, then J's saveTemplate.
 */
async function saveAsTemplate(p: Ports, name: string): Promise<boolean> {
  const n = nav()!
  const litterDir = litterDirOr()
  if (!n.saveAs || !litterDir) return true
  const tname = (n.inputs[SAVEAS_NAME(name)] ?? name).trim()
  if (!SWARM_NAME.test(tname)) {
    notice('warning', 'a template name is a-z, 0-9 and -, up to 24, not starting with -')
    return true
  }
  const draft = await loadDraft(p, litterDir, name)
  const picked = saveAsOffers(draft.spec).filter(o => n.saveAs!.params.includes(o.field))
  const briefs: Record<string, string> = {}
  for (const node of draft.spec.nodes) {
    const text = await briefOf(p, litterDir, name, draft, node.id)
    if (text !== null) briefs[node.id] = text
  }
  const description = clean(n.inputs[SAVEAS_DESCRIPTION(name)] ?? '', 400).trim() || `from the ${name} swarm`
  const template: Template = parameterize({ name: tname, description, scope: n.saveAs.scope }, draft.spec, briefs, picked)
  const r = await call(p, `saveTemplate ${n.saveAs.scope}:${tname}`, () => owners().saveTemplate(p, litterDir, template))
  if (!r.ok) {
    failed(p, 'saving the template', r.error)
    return true
  }
  setNav({ ...nav()!, saveAs: null, notice: { level: 'ok', text: `saved the ${tname} template: ${r.value}` } })
  return true
}

// ---------------------------------------------------------------------------
// A proposal

async function proposalAction(p: Ports, k: PaneKey): Promise<boolean> {
  const name = k.swarm ?? ''
  const n = nav()!
  const litterDir = litterDirOr()
  const [numText = '', ...more] = k.rest.split('/')
  const num = Number(numText)
  const arg = more.join('/')
  const index = Number(arg)
  const o = owners()
  switch (k.action) {
    case 'pick':
    case 'keep':
    case 'take': {
      if (!Number.isSafeInteger(index)) return true
      const has = n.picked.includes(index)
      const want = k.action === 'pick' ? !has : k.action === 'take'
      setNav({ ...n, picked: want ? [...new Set([...n.picked, index])] : n.picked.filter(x => x !== index) })
      return true
    }
    case 'pick-brief':
    case 'keep-brief':
    case 'take-brief': {
      const has = n.pickedBriefs.includes(arg)
      const want = k.action === 'pick-brief' ? !has : k.action === 'take-brief'
      setNav({ ...n, pickedBriefs: want ? [...new Set([...n.pickedBriefs, arg])] : n.pickedBriefs.filter(x => x !== arg) })
      return true
    }
    case 'diff':
      setNav({ ...n, diff: n.diff === arg ? null : arg })
      return true
    case 'accept-all':
    case 'accept-selected': {
      if (!litterDir) return true
      const pv = await call(p, `readProposal ${name} ${num}`, () => o.readProposal(p, litterDir, name, num))
      if (!pv.ok || !pv.value) {
        failed(p, 'reading the proposal', pv.ok ? 'it is gone' : pv.error)
        return true
      }
      // [Accept all] is J's 'all' unless a conflict was taken; a new or removed node's brief goes with its node.
      const pick = acceptPick(pv.value, n.picked, n.pickedBriefs, k.action === 'accept-all')
      if (pick !== 'all' && pick.length === 0) {
        notice('warning', 'nothing is picked: pick the changes to accept, or [Reject]')
        return true
      }
      const what = pick === 'all' ? 'all' : `${pick.length} change${pick.length === 1 ? '' : 's'}`
      const r = await call(p, `acceptProposal ${name} ${num} ${pick === 'all' ? 'all' : pick.join(',')}`, () => o.acceptProposal(p, litterDir, name, num, pick))
      if (!r.ok) {
        failed(p, 'accepting', r.error)
        return true
      }
      if (!r.value.ok) {
        const first = r.value.errors[0]
        notice('error', `not accepted: ${r.value.errors.length} error(s)${first ? `, first ${first.field}: ${first.error}` : ''}`)
        return true
      }
      dropProposal(name, num)
      putDraftCache(name, null)
      markStripDue(name, await p.now())
      go('builder', name, { notice: { level: 'ok', text: `accepted ${what}: revision ${r.value.revision}` } })
      return true
    }
    case 'reject': {
      if (!litterDir) return true
      const r = await call(p, `rejectProposal ${name} ${num}`, () => o.rejectProposal(p, litterDir, name, num))
      if (!r.ok) {
        failed(p, 'rejecting', r.error)
        return true
      }
      dropProposal(name, num)
      go('builder', name, { notice: { level: 'info', text: `rejected the lead's proposal ${num}` } })
      return true
    }
    case 'back':
      go('builder', name)
      return true
    default:
      return true
  }
}

// ---------------------------------------------------------------------------
// The browser

const TEXT_KEY = (name: string) => `swarm:browser:text:${name}`

async function browserAction(p: Ports, k: PaneKey, input: Input): Promise<boolean> {
  const name = k.swarm ?? ''
  const n = nav()!
  const litterDir = litterDirOr()
  const o = owners()
  const arg = k.rest
  switch (k.action) {
    case 'select':
    case 'to':
      setNav({ ...n, selected: (k.action === 'to' ? input.value : arg) || null, offerQueue: false })
      return true
    case 'text':
      putInput(TEXT_KEY(name), input.value ?? '')
      if (input.kind === 'submit') return send(p, name, null, '', input.budget)
      if (n.offerQueue) {
        setNav({ ...nav()!, offerQueue: false })
        return true
      }
      return false
    case 'when':
    case 'route': {
      if (!litterDir) return true
      const prefs = await prefsOf(p, litterDir, name)
      const v = input.value ?? ''
      const next =
        k.action === 'when'
          ? { ...prefs, when: v === 'queue' ? ('queue' as const) : ('interject' as const) }
          : { ...prefs, route: v === 'lead' ? ('lead' as const) : v === 'parent' ? ('parent' as const) : ('direct' as const) }
      try {
        await setPrefs(p, litterDir, name, next)
      } catch (err) {
        p.log(`swarm pane: the composer's choice wasn't kept: ${errText(err)}`)
      }
      return true
    }
    case 'send':
      return send(p, name, null, arg, input.budget)
    case 'queue-instead':
      return send(p, name, 'queue', arg, input.budget)
    case 'cancel': {
      const r = await call(p, `cancelQueued ${arg}`, () => o.cancelQueued(p, arg))
      if (!r.ok) failed(p, 'cancelling', r.error)
      else notice(r.value ? 'ok' : 'info', r.value ? 'cancelled the queued message' : 'that message was already sent or cancelled')
      return true
    }
    case 'stop':
    case 'hard-stop': {
      const how = k.action === 'stop' ? 'soft' : 'hard'
      const r = await call(p, `stopNode ${name} ${arg} ${how}`, () => o.stopNode(p, name, arg, how))
      if (!r.ok) failed(p, how === 'soft' ? 'Stop node' : 'Hard stop', r.error)
      else notice('ok', how === 'soft' ? 'stopping it: it ends at its next step' : 'hard-stopped it')
      return true
    }
    case 'transcript':
      setNav({ ...n, transcript: n.transcript === arg ? null : arg })
      return true
    case 'close-transcript':
      setNav({ ...n, transcript: null })
      return true
    case 'builder':
      go('builder', name)
      return true
    case 'history':
      go('history', name)
      return true
    case 'end': {
      const r = await call(p, `endSwarm ${name} request`, () => o.endSwarm(p, name, 'request'))
      if (!r.ok) failed(p, 'End swarm', r.error)
      else notice('ok', 'ending: every node is asked to stop, then litter cleans up')
      return true
    }
    case 'takeover': {
      if (!litterDir) return true
      const r = await call(p, `handover ${name}`, () => o.handover(p, litterDir, name))
      if (!r.ok) failed(p, 'Take over', r.error)
      else if (!r.value.ok) notice('error', `not taken over: ${r.value.reason}`)
      else notice('ok', 'this session owns it now')
      return true
    }
    case 'ack': {
      const seq = Number(arg)
      if (!Number.isSafeInteger(seq)) return true
      const r = await call(p, `ackBranchMoved ${name} ${seq}`, () => o.ackBranchMoved(p, name, seq))
      if (!r.ok) failed(p, 'That was me', r.error)
      return true
    }
    case 'stop-them': {
      const seq = Number(arg)
      const flag = openFlags(await launchLedgerRecords(p, name), []).find(f => f.seq === seq)
      if (!flag) {
        notice('info', 'that flag is gone')
        return true
      }
      const agents = await p.listAgents().catch(() => [])
      const running = runningOf(name, flag.running, agents)
      if (running.length === 0) {
        notice('info', 'none of them is running now')
        return true
      }
      let stoppedCount = 0
      for (const agentId of running) {
        const r = await call(p, `stopNode ${name} ${agentId} soft`, () => o.stopNode(p, name, agentId, 'soft'))
        if (r.ok) stoppedCount++
        else failed(p, 'Stop them', r.error)
      }
      if (stoppedCount > 0) notice('ok', `stopping ${stoppedCount} agent${stoppedCount === 1 ? '' : 's'}`)
      return true
    }
    default:
      return true
  }
}

/**
 * [Send] (or ⏎ in the field): L's sendFromBrowser, to the instance the
 * composer showed as `<node>#<n>` ([Send]'s key carries it; ⏎ takes the
 * selection's), by the Route it showed. The To and the Route are view.ts's
 * composerTarget and composerRoute, which the drawing uses too. L refuses an
 * address that's gone. `budget` is the press's or ⏎'s dispatch's, so L's
 * settle wait never runs past what that hook has left.
 */
async function send(p: Ports, name: string, when: 'queue' | null, shown: string, budget?: WaitBudget): Promise<boolean> {
  const n = nav()!
  const litterDir = litterDirOr()
  if (!litterDir) return true
  const text = clean(n.inputs[TEXT_KEY(name)] ?? '', 16_000).trim()
  if (text === '') {
    notice('warning', 'type the message first')
    return true
  }
  const selected = composerTarget(name, n.selected)
  if (selected && shown !== '' && instanceAddress(selected) !== shown) {
    p.toast('the To changed since that was drawn, so it was ignored')
    return true
  }
  const address = shown !== '' ? shown : selected ? instanceAddress(selected) : null
  if (!address) {
    notice('warning', 'pick a node to send to (To)')
    return true
  }
  const prefs = await prefsOf(p, litterDir, name)
  const route = composerRoute(prefs.route, selected)
  const r = await call(p, `sendFromBrowser ${name} ${address} ${when ?? prefs.when} ${route}`, () =>
    owners().sendFromBrowser(p, { swarm: name, node: address, text, when: when ?? prefs.when, route }, budget),
  )
  if (!r.ok) {
    failed(p, 'Send', r.error)
    return true
  }
  const out = r.value
  const sent = () => {
    putInput(TEXT_KEY(name), null)
    setNav({ ...nav()!, offerQueue: false })
  }
  switch (out.kind) {
    case 'delivered':
      sent()
      notice('ok', `sent to ${address}`)
      break
    case 'readdressed':
      sent()
      notice('info', `sent to ${out.parentNode}, its parent, instead: ${out.why}`)
      break
    case 'queued':
      sent()
      notice('ok', `queued for ${address}: it goes when the node settles`)
      break
    case 'refused':
      setNav({ ...nav()!, offerQueue: out.canQueue })
      notice('error', `not sent: ${out.reason}${out.canQueue ? ' ([Queue instead] sends it when the node settles)' : ''}`)
      break
  }
  return true
}

// ---------------------------------------------------------------------------
// The recovery card and the unsettled report

async function recoveryAction(p: Ports, k: PaneKey): Promise<boolean> {
  const name = k.swarm ?? ''
  const n = nav()!
  const o = owners()
  const card = pendingCard(name)
  if (!card) {
    go('browser', name)
    return true
  }
  const done = (text: string) => {
    dismissCard(cardKey(card))
    go('browser', name, { notice: { level: 'ok', text } })
  }
  // Orchestrators only, and none still running: K re-spawns no worker, and resumes a node only through an instance
  // resumeTargets names (a stopped one, or one bound under an older owner, has none). A worker comes back through its orchestrator.
  const choices = recoveryChoices(name, card).filter(c => !c.alive)
  const picked = choices.filter(c => n.recoveryPicked.includes(c.node))
  const resume = async (nodes: readonly string[], how: 'resume' | 'respawn'): Promise<boolean> => {
    if (nodes.length === 0) {
      notice('warning', how === 'resume' ? 'nothing to resume: no orchestrator here has an instance this session can resume; re-spawn it' : 'pick the orchestrators to re-spawn')
      return true
    }
    const r = await call(p, `requestResume ${name} ${nodes.join(',')} ${how}`, () => o.requestResume(p, name, nodes, how))
    if (!r.ok) {
      failed(p, how === 'resume' ? 'Resume' : 'Re-spawn', r.error)
      return true
    }
    const text = `the prompt box has the ${how === 'resume' ? 'resume' : 're-spawn'} request: send it to go on`
    // The card stays while anything on it is left, showing only that (K marks what was asked for handled).
    if (pendingCard(name)) setNav({ ...nav()!, recoveryPicked: [], notice: { level: 'ok', text } })
    else go('browser', name, { notice: { level: 'ok', text } })
    return true
  }
  switch (k.action) {
    case 'pick': {
      const id = k.rest
      if (!choices.some(c => c.node === id)) return true
      setNav({ ...n, recoveryPicked: n.recoveryPicked.includes(id) ? n.recoveryPicked.filter(x => x !== id) : [...n.recoveryPicked, id] })
      return true
    }
    case 'resume-all':
      return resume(
        choices.filter(c => c.resumable).map(c => c.node),
        'resume',
      )
    case 'resume-selected':
      if (picked.length === 0) {
        notice('warning', 'pick the orchestrators to resume')
        return true
      }
      return resume(
        picked.filter(c => c.resumable).map(c => c.node),
        'resume',
      )
    case 'respawn':
      // Unpicked: the orchestrators a resume can't reach, or whose instances are all gone.
      return resume(
        (picked.length > 0 ? picked : choices.filter(c => !c.resumable || c.gone)).map(c => c.node),
        'respawn',
      )
    case 'leave':
      done('left stopped: nothing was resumed')
      return true
    case 'finish': {
      const r = await call(p, `endSwarm ${name} request`, () => o.endSwarm(p, name, 'request'))
      if (!r.ok) failed(p, 'Finish ending', r.error)
      else done('ending it, as it was before the restart')
      return true
    }
    default:
      return true
  }
}

async function unsettledAction(p: Ports, k: PaneKey): Promise<boolean> {
  const name = k.swarm ?? ''
  const o = owners()
  switch (k.action) {
    case 'wait': {
      const r = await call(p, `endSwarm ${name} wait-longer`, () => o.endSwarm(p, name, 'wait-longer'))
      if (!r.ok) failed(p, 'Wait longer', r.error)
      else go('browser', name, { waitedOn: await p.now(), notice: { level: 'info', text: "waiting longer: this comes back in 2 minutes if it still hasn't settled" } })
      return true
    }
    case 'hard-stop': {
      const progress = settling(p, name)
      for (const node of progress?.nodes ?? []) {
        const r = await call(p, `stopNode ${name} ${node.agentId} hard`, () => o.stopNode(p, name, node.agentId, 'hard'))
        if (!r.ok) failed(p, 'Hard stop', r.error)
      }
      return true
    }
    case 'keep': {
      const r = await call(p, `endSwarm ${name} keep-everything`, () => o.endSwarm(p, name, 'keep-everything'))
      if (!r.ok) failed(p, 'End, keep everything', r.error)
      else go('browser', name, { notice: { level: 'ok', text: 'ended: every worktree and branch is kept' } })
      return true
    }
    default:
      return true
  }
}

// ---------------------------------------------------------------------------
// The doctor pane

async function doctorAction(p: Ports, k: PaneKey): Promise<void> {
  const d = doctorNavigation()!
  const set = (notice: SwarmNotice | null, tested = d.tested) => setDoctorNav({ ...d, tested, notice })
  switch (k.action) {
    case 'copy':
    case 'ask-lead': {
      const view = lastDoctor ?? (await doctorView(p))
      const snippet = view?.body?.snippet ?? null
      if (!snippet) {
        set({ level: 'info', text: 'nothing to add: no setting falls short' })
        break
      }
      if (k.action === 'copy') {
        const copied = await p.copy(snippet).catch(() => false)
        set(copied ? { level: 'ok', text: 'copied the env snippet' } : { level: 'warning', text: "the clipboard didn't take it: select the snippet instead" })
      } else {
        const path = view?.body?.settingsPath ?? '~/.claude/settings.json'
        const keys = oneLine(snippet.replace(/\s+/g, ' '), 2000)
        const filled = await p.fillPrompt(`Please merge these keys into the "env" object of my user settings, ${path}, keeping everything else in that file as it is: ${keys}`)
        set(filled ? { level: 'ok', text: 'the prompt box has the request: send it when ready' } : { level: 'warning', text: "the prompt box can't take text now" })
      }
      break
    }
    case 'recheck':
      set(null, null)
      break
    case 'test': {
      // One summaryModel call per press: later redraws (the tick, Recheck aside) show the row it gave.
      p.log('swarm pane: checkHealth with the summaryModel test')
      set(null)
      const view = await drawDoctor(p, true)
      const row = view?.body?.rows.find(r => r.id === SUMMARY_TEST_ROW) ?? null
      setDoctorNav({ ...doctorNavigation()!, tested: row })
      await saveNav(p)
      return
    }
    default:
      break
  }
  await drawDoctor(p)
}

/** Tests: a fresh module (the tick's memory). */
export function resetPanesForTests(): void {
  timer?.cancel()
  timer = null
  ticking = false
  lastStamp = ''
  savedRev = -1
  lastDoctor = null
  invalidNow.clear()
}
