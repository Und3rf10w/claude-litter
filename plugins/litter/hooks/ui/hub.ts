// The `litter` pane's hub (phase 5b, WP-DA): the one pane, its seven
// sections, `/litter [section] [arg]`, the one opener, the router, and the
// tick. The pane shows one section at a time; each keeps its own view, atom
// and handlers as before, and the hub holds only which is shown and what its
// strip counts (the `hub` atom).
//
// The key rule. Every element key in the pane belongs to one section, by
// prefix, and the prefixes are disjoint:
//   litter:section:<id>      the hub's strip
//   home:                    Home
//   board:, board-gates      Runs (the board, and its gate table's posts)
//   swarm:, swarm-tree       Swarms (every swarm view, and the tree's posts), less
//   swarm:doctor:            Doctor
//   rules:                   Rules
//   tasks:                   Tasks
//   agents:                  Agents
// The hub answers its own keys. A key of the shown section goes to that
// section's handler; a key of another section is stale (drawn before a
// switch): it's ignored with a toast and answered in its event's shape; a key
// no section owns goes to the shown section's handler, which passes it on. A
// new section takes a prefix no other has, and its Buttons use letters for
// hotkeys: the strip holds 1–7.
//
// The one opener. openSection(p, id, arg?) is how anything shows a section:
// `/litter`, the band's and the card's buttons, the board's [Rules], the
// builder's [Doctor], the rules records' open. With an `arg` (a string, ''
// for none, or the rules focus) it loads the section as its command did;
// without one it shows what the section kept (the strip, Home). It sets the
// section and opens `litter`, asking for the keyboard when the person asked.
//
// Refreshing. The ui tick's litterTick does nothing while `litter` isn't
// open; while it is, it refreshes the shown section alone, then the strip's
// counts. The swarm pane's own 1 s timer is gated the same way
// (litterShows), all but its proposals' hand-over.
//
// The ring and the lists (WP-DA2). ui.focus and ui.scroll go to the shown
// section as the other events do: a focus by its element's key (one of
// another section's moves the ring and nothing else), a scroll always to the
// shown section, which takes a tick over its own list (ui/list.tsx) and
// passes the rest on, so the pane scrolls. The hub keeps, in its atom, the
// element the ring is on (every body's ctx.focused) and each list's window
// offset (ctx.lists), so a render reads them and never keeps them. An
// in-pane list's Client posts `{ list, press }` (a row's click, a menu
// pick), pressed on the list's section as its Button would be, or
// `{ list, offset, max }` (its keys past the window's edge).

import type { Ports } from '../ports'
import type { CommandRunHook, PaneUiHandlers, PortHook, UiPressHook } from '../hooktypes'
import type { HubSection, HubTab, HubView, SwarmSpan } from '../../types/index'
import type { ProposalRef } from '../records/rules'
import { agentLive } from '../ports'
import { MARK, STYLE } from './style'
import { STRIP_PREFIX } from './chrome'
import { GATES_KEY, boardCommand, boardTick, loadBoard, onBoardUi, resumeBoard } from '../board/pane'
import { loadRules, onRulesUi, resumeRules, rulesCommand, rulesCounts, rulesTick } from '../rules/pane'
import { TREE_KEY, doctorCommand, loadDoctor, loadSwarm, onUiInput, onUiMessage, onUiPress, onUiScroll, onUiSelect, resumeDoctor, resumeSwarm, swarmCommand } from '../swarm/panes'
import { loadTasks, onTasksUi, resumeTasks, tasksCommand, tasksTick } from '../tasks/pane'
import { agentsCommand, agentsTick, loadAgents, onAgentsUi, resumeAgents } from '../agents/pane'
import { bandCounts } from '../band/view'
import { liveSwarms, openQuestions } from '../swarm/state'
import { pendingProposals } from '../swarm/view'
import { shownOf as tasksShown } from '../tasks/view'

export const LITTER_PANE = 'litter'
export const LITTER_TITLE = 'litter'

/** The sections, in the strip's order: hotkeys 1–7. */
export const SECTIONS: readonly HubSection[] = ['home', 'runs', 'swarms', 'rules', 'tasks', 'agents', 'doctor']
export const LABEL: Record<HubSection, string> = {
  home: 'Home',
  runs: 'Runs',
  swarms: 'Swarms',
  rules: 'Rules',
  tasks: 'Tasks',
  agents: 'Agents',
  doctor: 'Doctor',
}

/** What opens a section: the command's argument ('' for none), or the rules focus (a rule id or a proposal). */
export type SectionArg = string | { id?: string; proposal?: ProposalRef }
/** A load's reply line; `refused` when the argument wasn't one, so nothing was switched or opened. */
export type Loaded = { text: string; refused?: boolean }

/** One section, as the hub calls it. Each entry reads its module when called, never at import time (the modules import the hub). */
export type Section = {
  /** Whether an element key (or a Client's key) is this section's. */
  owns: (key: string) => boolean
  /** Loads the section's view for `arg`, as its command did, and answers the reply's line. */
  load: (p: Ports, arg: SectionArg) => Promise<Loaded>
  /** Draws the section from what it kept, else loads it with no argument. */
  resume: (p: Ports) => Promise<void>
  ui: PaneUiHandlers
  /** litterTick's step while the section is shown. */
  tick: (p: Ports) => Promise<void>
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const asText = (arg: SectionArg): string => (typeof arg === 'string' ? arg : '')
const noop = async (): Promise<void> => {}

/** The swarm panes' handlers, shared by Swarms and Doctor: their keys tell the two apart. */
const swarmUi: PaneUiHandlers = {
  message: (p, e, next) => onUiMessage(p, e, next),
  press: (p, e, next) => onUiPress(p, e, next),
  input: (p, e, next) => onUiInput(p, e, next),
  select: (p, e, next) => onUiSelect(p, e, next),
}

/** Home's: `home:open:<section>` shows that section; Home has no fields. */
const homeUi: PaneUiHandlers = {
  message: async (p, e, next) => next(e),
  press: async (p, e, next) => {
    if (!e.element.startsWith('home:')) return next(e)
    const id = sectionNamed(e.element.slice('home:open:'.length))
    if (e.element.startsWith('home:open:') && id !== null && id !== 'home') await showSection(p, id)
    return { element: e.element }
  },
  input: async (p, e, next) => (e.element.startsWith('home:') ? { element: e.element, value: e.value } : next(e)),
  select: async (p, e, next) => (e.element.startsWith('home:') ? { element: e.element, value: e.value } : next(e)),
}

/** The sections, through one table so tier 2 can stand in for them. The mod never changes it. */
export const sections: Record<HubSection, Section> = {
  home: {
    owns: key => key.startsWith('home:'),
    load: async p => ({ text: `Home shows ${liveWords(await countsNow(p))}` }),
    resume: noop,
    ui: homeUi,
    tick: noop,
  },
  runs: {
    owns: key => key.startsWith('board:') || key === GATES_KEY,
    load: (p, arg) => loadBoard(p, asText(arg)),
    resume: p => resumeBoard(p),
    ui: {
      message: (p, e, next) => onBoardUi.message(p, e, next),
      press: (p, e, next) => onBoardUi.press(p, e, next),
      input: (p, e, next) => onBoardUi.input(p, e, next),
      select: (p, e, next) => onBoardUi.select(p, e, next),
    },
    tick: p => boardTick(p),
  },
  swarms: {
    owns: key => (key.startsWith('swarm:') && !key.startsWith('swarm:doctor:')) || key === TREE_KEY,
    load: (p, arg) => loadSwarm(p, asText(arg)),
    resume: p => resumeSwarm(p),
    // The start screen's template list scrolls under the wheel (WP-DA2).
    ui: { ...swarmUi, scroll: (p, e, next) => onUiScroll(p, e, next) },
    // The swarm pane's own 1 s timer refreshes it, gated by litterShows.
    tick: noop,
  },
  rules: {
    owns: key => key.startsWith('rules:'),
    load: (p, arg) => loadRules(p, typeof arg === 'string' ? null : arg),
    resume: p => resumeRules(p),
    ui: {
      message: (p, e, next) => onRulesUi.message(p, e, next),
      press: (p, e, next) => onRulesUi.press(p, e, next),
      input: (p, e, next) => onRulesUi.input(p, e, next),
      select: (p, e, next) => onRulesUi.select(p, e, next),
    },
    tick: p => rulesTick(p),
  },
  tasks: {
    owns: key => key.startsWith('tasks:'),
    load: (p, arg) => loadTasks(p, asText(arg)),
    resume: p => resumeTasks(p),
    ui: {
      message: (p, e, next) => onTasksUi.message(p, e, next),
      press: (p, e, next) => onTasksUi.press(p, e, next),
      input: (p, e, next) => onTasksUi.input(p, e, next),
      select: (p, e, next) => onTasksUi.select(p, e, next),
    },
    tick: p => tasksTick(p),
  },
  agents: {
    owns: key => key.startsWith('agents:'),
    load: (p, arg) => loadAgents(p, asText(arg)),
    resume: p => resumeAgents(p),
    ui: {
      message: (p, e, next) => onAgentsUi.message(p, e, next),
      press: (p, e, next) => onAgentsUi.press(p, e, next),
      input: (p, e, next) => onAgentsUi.input(p, e, next),
      select: (p, e, next) => onAgentsUi.select(p, e, next),
    },
    tick: p => agentsTick(p),
  },
  doctor: {
    owns: key => key.startsWith('swarm:doctor:'),
    load: (p, arg) => loadDoctor(p, asText(arg)),
    resume: p => resumeDoctor(p),
    ui: swarmUi,
    // The doctor's checks run when it opens and at [Recheck], never on a timer.
    tick: noop,
  },
}

/** What the hub reads beside the sections, through one table for tier 2. */
export const deps = {
  bandCounts: () => bandCounts(),
  liveSwarms: () => liveSwarms(),
  openQuestions: (name: string) => openQuestions(name),
  pendingProposals: (name: string) => pendingProposals(name),
  rulesCounts: () => rulesCounts(),
  tasksShown: () => tasksShown(),
  /** `/litter <section> …`: each section's own command, which calls openSection. */
  command: {
    home: (async (p, e) => ({ text: (await openSection(p, 'home', '', { focus: true })).text })) as PortHook<CommandRunHook>,
    runs: ((p, e, next) => boardCommand(p, e, next)) as PortHook<CommandRunHook>,
    swarms: ((p, e, next) => swarmCommand(p, e, next)) as PortHook<CommandRunHook>,
    rules: ((p, e, next) => rulesCommand(p, e, next)) as PortHook<CommandRunHook>,
    tasks: ((p, e, next) => tasksCommand(p, e, next)) as PortHook<CommandRunHook>,
    agents: ((p, e, next) => agentsCommand(p, e, next)) as PortHook<CommandRunHook>,
    doctor: ((p, e, next) => doctorCommand(p, e, next)) as PortHook<CommandRunHook>,
  } satisfies Record<HubSection, PortHook<CommandRunHook>>,
}
const defaults = { sections: { ...sections }, deps: { ...deps, command: { ...deps.command } } }

export const sectionNamed = (word: string): HubSection | null => ((SECTIONS as readonly string[]).includes(word) ? (word as HubSection) : null)

// ---------------------------------------------------------------------------
// Module memory: the section shown, kept in $.store for a reload

export const HUB_STORE_KEY = 'litter.hub'
type HubStore = { v: 1; session: string; section: HubSection }

let shown: HubSection = 'home'
let restored = false
let viewSeq = 0
let lastJson = ''
let panesFailed = false
/** The element the pane's ring is on (ui.focus), or null. */
let focus: string | null = null
/** Each in-pane list's window offset, by the list's id. */
let lists: Record<string, number> = {}

/** The section shown now. */
export const shownSection = (): HubSection => shown

/** After a hot reload module memory is empty: the section comes back from $.store, when this session wrote it. */
export async function restoreHub(p: Ports): Promise<void> {
  if (restored) return
  restored = true
  try {
    const raw = (await p.store.get(HUB_STORE_KEY)) as Partial<HubStore> | undefined
    if (!raw || raw.v !== 1 || raw.session !== (await p.sessionId())) return
    const id = typeof raw.section === 'string' ? sectionNamed(raw.section) : null
    if (id !== null) shown = id
  } catch (err) {
    p.log(`litter pane: the section shown wasn't read back: ${errText(err)}`)
  }
}

async function saveHub(p: Ports): Promise<void> {
  try {
    const value: HubStore = { v: 1, session: await p.sessionId(), section: shown }
    await p.store.set(HUB_STORE_KEY, value)
  } catch (err) {
    p.log(`litter pane: the section shown wasn't saved: ${errText(err)}`)
  }
}

/** A fresh module's memory, for tests: Home shown, nothing written, the real sections and reads back. */
export function resetHubForTests(): void {
  shown = 'home'
  restored = false
  viewSeq = 0
  lastJson = ''
  panesFailed = false
  focus = null
  lists = {}
  counted = null
  Object.assign(sections, defaults.sections)
  Object.assign(deps, { ...defaults.deps, command: { ...defaults.deps.command } })
}

// ---------------------------------------------------------------------------
// The counts and the hub's view

/** What the strip and Home count, from module memory and the agent list: no file is read. */
export type HubCounts = {
  /** The band's active runs. */
  runs: number
  swarms: number
  /** A live swarm has an open question or a proposal waiting. */
  swarmsNeedYou: boolean
  /** The rules section's last build; null before one. */
  rules: { proposed: number; inForce: number } | null
  /** The tasks section's list's open tasks (pending or in progress); null before it's read. */
  tasks: number | null
  /** This session's agents still alive; null when the list couldn't be read. */
  agents: number | null
}

/** The counts now. Each read that fails counts nothing, logged. */
export async function countsNow(p: Ports): Promise<HubCounts> {
  const safe = <T>(what: string, fn: () => T, none: T): T => {
    try {
      return fn()
    } catch (err) {
      p.log(`litter pane: ${what} couldn't be counted: ${errText(err)}`)
      return none
    }
  }
  const swarms = safe('the live swarms', () => deps.liveSwarms(), [])
  const shownTasks = safe('the tasks', () => deps.tasksShown(), null)
  let agents: number | null = null
  try {
    agents = (await p.listAgents()).filter(a => agentLive(a.status)).length
  } catch (err) {
    p.log(`litter pane: the agents couldn't be counted: ${errText(err)}`)
  }
  return {
    runs: safe('the runs', () => deps.bandCounts().runs, 0),
    swarms: swarms.length,
    swarmsNeedYou: safe('the swarms that need you', () => swarms.some(s => deps.openQuestions(s.name).length > 0 || deps.pendingProposals(s.name).length > 0), false),
    rules: safe('the rules', () => deps.rulesCounts(), null),
    tasks: shownTasks ? shownTasks.tasks.filter(t => t.status !== 'completed').length : null,
    agents,
  }
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** The strip's tabs, with Home's line for each. Pure. */
export function tabsOf(c: HubCounts): HubTab[] {
  const tab = (section: HubSection, count: number | null, needsYou: boolean, summary: string): HubTab => ({ section, label: LABEL[section], count, needsYou, summary })
  return [
    tab('home', null, false, 'what needs you, and what runs'),
    tab('runs', c.runs, false, c.runs > 0 ? `${plural(c.runs, 'active run')}` : 'no active run: the board shows the newest'),
    tab('swarms', c.swarms, c.swarmsNeedYou, c.swarms > 0 ? `${plural(c.swarms, 'live swarm')}${c.swarmsNeedYou ? `, ${MARK.needsYou.glyph} one waits on you` : ''}` : 'no live swarm: build one here'),
    tab('rules', c.rules?.proposed ?? null, (c.rules?.proposed ?? 0) > 0, c.rules ? `${c.rules.proposed} proposed or unverified, ${c.rules.inForce} in force` : 'proposals to accept, and the rules in force'),
    tab('tasks', c.tasks, false, c.tasks !== null ? plural(c.tasks, 'open task') : "this session's task list, and the teams'"),
    tab('agents', c.agents, false, c.agents !== null ? `${c.agents} running` : 'agents, their inboxes and transcripts'),
    tab('doctor', null, false, "what a swarm needs of this session's settings and limits"),
  ]
}

/** The header's live line: what runs, then what needs you, each with its glyph and word. Pure. */
export function liveOf(c: HubCounts, tabs: readonly HubTab[]): SwarmSpan[] {
  const out: SwarmSpan[] = []
  const running = [c.runs > 0 ? plural(c.runs, 'run') : null, c.swarms > 0 ? `${plural(c.swarms, 'swarm')} live` : null].filter((x): x is string => x !== null)
  if (running.length > 0) out.push({ text: `${MARK.running.glyph} `, color: STYLE.running }, { text: running.join(' · ') })
  else out.push({ text: 'nothing running', color: STYLE.muted })
  const waiting = tabs.filter(t => t.needsYou).map(t => t.label)
  if (waiting.length > 0) out.push({ text: ' · ', color: STYLE.faint }, { text: `${MARK.needsYou.glyph} ${MARK.needsYou.word}: ${waiting.join(', ')}`, color: STYLE.needsYou })
  return out
}

/** The live line in words, for a reply. */
const liveWords = (c: HubCounts): string => {
  const parts = [c.runs > 0 ? plural(c.runs, 'active run') : null, c.swarms > 0 ? plural(c.swarms, 'live swarm') : null].filter((x): x is string => x !== null)
  return parts.length > 0 ? parts.join(', ') : 'nothing running'
}

/** The strip and the live line as last counted, so a ring or a list that moves writes the hub without counting again. */
let counted: { live: SwarmSpan[]; tabs: HubTab[] } | null = null

/** Builds the hub's view and writes it when it changed (or always, with `force`: $.state was wiped). */
export async function writeHub(p: Ports, force = false): Promise<HubView> {
  const c = await countsNow(p)
  const tabs = tabsOf(c)
  counted = { live: liveOf(c, tabs), tabs }
  return putHub(p, counted, force)
}

async function putHub(p: Ports, strip: { live: SwarmSpan[]; tabs: HubTab[] }, force: boolean): Promise<HubView> {
  const { live, tabs } = strip
  const json = JSON.stringify({ section: shown, live, tabs, focus, lists })
  const view: HubView = { view: 'hub', v: viewSeq, section: shown, live, tabs, focus, lists: { ...lists } }
  if (!force && json === lastJson) return view
  view.v = ++viewSeq
  await p.setView('hub', view)
  lastJson = json
  return view
}

/** The hub's view again after the ring or a list moved: the strip as last counted (a wheel tick reads no count). */
const writeMoved = async (p: Ports): Promise<void> => {
  if (counted === null) await writeHub(p)
  else await putHub(p, counted, false)
}

/** The element the pane's ring is on, as the hub keeps it. */
export const focusedElement = (): string | null => focus

/** A list's window offset, as the hub keeps it (0 before any move). */
export const listOffset = (id: string): number => lists[id] ?? 0

/**
 * Moves a list's window to `offset`, clamped to [0, max], and writes the
 * hub's view when it moved; answers whether it did (false: the window was at
 * that edge already, so the caller passes the tick on).
 */
export async function moveList(p: Ports, id: string, offset: number, max: number): Promise<boolean> {
  const to = Math.min(Math.max(0, Math.floor(max)), Math.max(0, Math.floor(offset)))
  if (!Number.isFinite(to) || to === listOffset(id)) return false
  lists = { ...lists, [id]: to }
  await writeMoved(p)
  return true
}

/** The ring moved onto `element` (null: one of the engine's stops): kept, and the hub written, so bodies draw it. */
async function noteFocus(p: Ports, element: string | null): Promise<void> {
  if (element === focus) return
  focus = element
  await writeMoved(p)
}

/** Shows `id` and writes the hub: the render draws its body next. */
async function setShown(p: Ports, id: HubSection): Promise<void> {
  const moved = id !== shown
  shown = id
  if (moved) await saveHub(p)
  await writeHub(p, moved)
}

// ---------------------------------------------------------------------------
// The one opener

/**
 * Shows section `id` in the `litter` pane and opens it. With `arg` the
 * section loads as its command did; without, it shows what it kept. `focus`
 * asks for the keyboard (the command, a button the person pressed). Answers
 * whether the pane was placed and the reply's line; a refused argument
 * switches and opens nothing.
 */
export async function openSection(p: Ports, id: HubSection, arg?: SectionArg, opts: { focus?: boolean } = {}): Promise<{ placed: boolean; text: string }> {
  await restoreHub(p)
  const s = sections[id]
  let text = `${LABEL[id]} is shown`
  if (arg === undefined) await s.resume(p)
  else {
    const loaded = await s.load(p, arg)
    if (loaded.refused) return { placed: false, text: loaded.text }
    text = loaded.text
  }
  await setShown(p, id)
  const placed = await p.openPane(LITTER_PANE, LITTER_TITLE, opts.focus === true)
  return { placed, text: placed ? text : `${text} (open, but this screen can't draw it now)` }
}

/** The strip's and Home's switch: the section from what it kept, in the pane that's open. */
export async function showSection(p: Ports, id: HubSection): Promise<void> {
  await restoreHub(p)
  await sections[id].resume(p)
  await setShown(p, id)
}

// ---------------------------------------------------------------------------
// `/litter [section] [arg]`

export const USAGE = 'usage: /litter [home | runs [run | execute | design] | swarms [name] | rules | tasks [list] | agents [team] | doctor [swarm]]'
export const ARGUMENT_HINT = '[home | runs | swarms | rules | tasks | agents | doctor] [arg]'
/** How many words after the section each takes (tasks and agents take a name that may have spaces). */
const MAX_WORDS: Record<HubSection, number> = { home: 0, runs: 1, swarms: 1, rules: 0, tasks: Number.POSITIVE_INFINITY, agents: Number.POSITIVE_INFINITY, doctor: 1 }

/**
 * command.run on `litter`. Bare, Home: what needs you first, and every
 * section one key away (not the last shown, so `/litter` always lands in the
 * same place). `/litter <section> [arg]` hands the argument to that
 * section's command; anything else is the usage line.
 */
export const litterCommand: PortHook<CommandRunHook> = async (p, e, next) => {
  const words = (e.args ?? '').trim().split(/\s+/).filter(w => w !== '')
  const [first, ...rest] = words
  if (first === undefined) return deps.command.home(p, { ...e, args: '' }, next)
  const id = sectionNamed(first.toLowerCase())
  if (id === null || rest.length > MAX_WORDS[id]) return { text: USAGE }
  return deps.command[id](p, { ...e, args: rest.join(' ') }, next)
}

// ---------------------------------------------------------------------------
// The router

/** The section that owns a key, or null. */
export function ownerOf(key: string): HubSection | null {
  for (const id of SECTIONS) if (sections[id].owns(key)) return id
  return null
}

/** A key of a section that isn't shown: said, and answered in its event's shape by the caller. */
function stale(p: Ports, owner: HubSection): void {
  p.toast(`that was on ${LABEL[owner]}, and litter shows ${LABEL[shown]} now, so it was ignored`)
  p.log(`litter pane: a ${LABEL[owner]} key while ${LABEL[shown]} is shown, ignored`)
}

type PressArg = Parameters<PortHook<UiPressHook>>[1]

/** What an in-pane list's Client posted (ui/listmenu.tsx), checked: data from code, so only these two shapes, of this list's own section. */
type ListPost = { press: string } | { offset: number; max: number }

function listPost(element: string, data: unknown): ListPost | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const d = data as Record<string, unknown>
  if (d.list !== element) return null
  if (typeof d.press === 'string' && d.press !== '' && d.press.length <= 300 && ownerOf(d.press) === ownerOf(element)) return { press: d.press }
  const whole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100_000
  if (whole(d.offset) && whole(d.max)) return { offset: d.offset, max: d.max }
  return null
}

/** The pane's ui.message (a Client's posts), ui.press, ui.input, ui.select, ui.focus and ui.scroll, by the key rule above. */
export const onLitterUi: Required<PaneUiHandlers> = {
  message: async (p, e, next) => {
    await restoreHub(p)
    const owner = ownerOf(e.element)
    if (owner === null) return sections[shown].ui.message(p, e, next)
    if (owner !== shown) {
      stale(p, owner)
      return {}
    }
    const post = listPost(e.element, e.data)
    if (post !== null && 'press' in post) {
      // A row's click or a menu pick: the press its Button would have made, on the same section.
      const press: PressArg = { plugin: 'litter', element: post.press, component: e.component, requestId: e.requestId, surface: e.surface } as PressArg
      await sections[owner].ui.press(p, press, (async (pe: PressArg) => ({ element: pe.element })) as Parameters<PortHook<UiPressHook>>[2])
      return {}
    }
    if (post !== null) {
      await moveList(p, e.element, post.offset, post.max)
      return {}
    }
    return sections[owner].ui.message(p, e, next)
  },
  press: async (p, e, next) => {
    await restoreHub(p)
    if (e.element.startsWith(STRIP_PREFIX)) {
      const id = sectionNamed(e.element.slice(STRIP_PREFIX.length))
      if (id !== null && id !== shown) await showSection(p, id)
      return { element: e.element }
    }
    const owner = ownerOf(e.element)
    if (owner === null) return sections[shown].ui.press(p, e, next)
    if (owner !== shown) {
      stale(p, owner)
      return { element: e.element }
    }
    return sections[owner].ui.press(p, e, next)
  },
  input: async (p, e, next) => {
    await restoreHub(p)
    const owner = ownerOf(e.element)
    if (owner === null) return sections[shown].ui.input(p, e, next)
    if (owner !== shown) {
      stale(p, owner)
      return { element: e.element, value: e.value }
    }
    return sections[owner].ui.input(p, e, next)
  },
  select: async (p, e, next) => {
    await restoreHub(p)
    const owner = ownerOf(e.element)
    if (owner === null) return sections[shown].ui.select(p, e, next)
    if (owner !== shown) {
      stale(p, owner)
      return { element: e.element, value: e.value }
    }
    return sections[owner].ui.select(p, e, next)
  },
  /**
   * The ring moving: kept as ctx.focused, then the shown section's to answer
   * (it passes on, and the ring lands). The strip's, an engine stop's and
   * another section's (a stale drawing's) move the ring and nothing else: a
   * focus is no action, so no toast.
   */
  focus: async (p, e, next) => {
    await restoreHub(p)
    const owner = e.element === undefined || e.element.startsWith(STRIP_PREFIX) ? undefined : ownerOf(e.element)
    const handler = owner === undefined || (owner !== null && owner !== shown) ? undefined : sections[shown].ui.focus
    const r = handler ? await handler(p, e, next) : await next(e)
    // Kept once the ring landed (a deny: it stayed where it was).
    if (r.deny === undefined) await noteFocus(p, e.element ?? null)
    return r
  },
  /** A wheel tick or a scroll key: no element, so the shown section's, which takes one over its own list and passes the rest on (the pane scrolls). */
  scroll: async (p, e, next) => {
    await restoreHub(p)
    const handler = sections[shown].ui.scroll
    return handler ? handler(p, e, next) : next(e)
  },
}

// ---------------------------------------------------------------------------
// The tick

/** Whether `litter` is open: a `$.ui.panes()` that fails counts as open (logged once), so the pane never freezes. */
async function litterOpen(p: Ports): Promise<boolean> {
  try {
    const open = await p.paneOpen(LITTER_PANE)
    panesFailed = false
    return open
  } catch (err) {
    if (!panesFailed) p.log(`litter pane: $.ui.panes() failed, so the pane is refreshed as if open: ${errText(err)}`)
    panesFailed = true
    return true
  }
}

/** Whether `litter` is open on section `id` (the swarm pane's timer asks). */
export async function litterShows(p: Ports, id: HubSection): Promise<boolean> {
  await restoreHub(p)
  return shown === id && (await litterOpen(p))
}

/** The ui tick's step (uitick.ts): nothing while `litter` is closed; else the shown section, then the strip's counts. */
export async function litterTick(p: Ports): Promise<void> {
  await restoreHub(p)
  if (!(await litterOpen(p))) return
  try {
    await sections[shown].tick(p)
  } catch (err) {
    p.log(`litter pane: the ${LABEL[shown]} tick failed: ${errText(err)}`)
  }
  await writeHub(p)
}

/** After a /clear wiped $.state (clear.ts): the hub's view again, written even when unchanged. */
export async function refreshHub(p: Ports): Promise<void> {
  await restoreHub(p)
  await writeHub(p, true)
}
