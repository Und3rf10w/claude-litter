// The `litter` pane's Home (phase 5b, WP-DB): what `/litter` opens on, the
// one screen that answers, in this order (the UI review's recommendation):
//  1. what needs you: each open question of a swarm's node, each lead
//     proposal waiting, the rules proposed or unverified, a run that ended
//     wanting a decision (halted, or back for you), each one row with ⚑ and
//     the word, which thing waits, and an [Open] that lands on it;
//  2. what runs: the band's open runs and live swarms, in the band's own
//     marks and words (band/view.ts's BandLine), each with [Open];
//  3. what ended inside the band's window (bandEndedMinutes), with its mark;
//  4. one line for each other section with something to say (Tasks' open
//     tasks, Agents' running ones, Doctor); a section with nothing is left
//     out rather than shown as 0.
//
// Pure: hub.ts's writeHub gathers the facts from module memory, as the
// strip's counts are (no file is read for Home), and homeOf words them into
// the hub's view; home.tsx draws them through homePlan, the row budget
// (`fits`: needs you and running are kept whole, ended and the others fold
// into "N more" lines first). Every text is cleaned and cut here.

import type { HomeLine, HomeRow, HomeView, HubSection, SwarmSpan } from '../../types/index'
import { RUN_ID, SWARM_NAME } from '../layout'
import { firstLine, oneLine } from '../swarm/view'
import { cells, lineSpans, type BandLine } from '../band/view'
import { MARK, NOTICE_STYLE, STYLE } from './style'
import { textRows } from './chrome'

const SEP: SwarmSpan = { text: ' · ' }
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

// ---------------------------------------------------------------------------
// The facts, and Home's rows from them

/**
 * An open question of a live swarm's node, oldest first: the agent that asked
 * (its [Open] picks it in the browser) and where it went (`lead`, or the
 * parent node's id; absent when not recorded), as swarm/state.ts keeps them.
 */
export type HomeQuestion = { swarm: string; node: string; text: string; agentId?: string; to?: string | null }
/** A live swarm's lead proposal waiting for your review: its number, as swarm/view.ts's pendingProposals lists it. */
export type HomeProposal = { swarm: string; n: number }

/** What Home is built from: module memory and the agent list, as hub.ts's countsNow reads them. */
export type HomeFacts = {
  /** The band's last build (band/view.ts, bandLines). */
  lines: readonly BandLine[]
  questions: readonly HomeQuestion[]
  /** Each live swarm's proposals waiting for your review, one each, as pendingProposals counts them (only the current ones: WP-DD). */
  proposals: readonly HomeProposal[]
  /** The rules section's last build; null before one. */
  rules: { proposed: number; inForce: number } | null
  /** The tasks section's list: its open tasks and how it's named; null before it's read. */
  tasks: { open: number; list: string } | null
  /** This session's agents still alive; null when the list couldn't be read. */
  agents: number | null
  /** The bandEndedMinutes option. */
  endedMinutes: number
}

/** An [Open]'s key: `home:open:<section>[:<arg>]`; a proposal's is `home:open:swarms:<swarm>/<n>`, a question's `home:open:swarms:<swarm> <agentId>`. */
const openKey = (section: HubSection, arg?: string): string => `home:open:${section}${arg !== undefined ? `:${arg}` : ''}`

/** An agent id a key can carry after its swarm's name: what `$.agent.list()` and teammates' `name@team` ids are made of. */
const AGENT_ID = /^[A-Za-z0-9@._-]{1,128}$/

/** Who a question went to, in its row: `asks the lead:`, `asks part-a:`, or `asks:` when not recorded (as the browser's asksWhom says it). */
const asksWords = (to: string | null | undefined): string => (to === 'lead' ? ' asks the lead:' : to ? ` asks ${oneLine(to, 40)}:` : ' asks:')

/** Where a band line's [Open] goes: its run's board, or its swarm's browser. */
const lineOpen = (l: BandLine): string => openKey(l.kind === 'swarm' ? 'swarms' : 'runs', l.name)

const needsMark = { glyph: MARK.needsYou.glyph, word: MARK.needsYou.word, color: MARK.needsYou.color }
const nameSpan = (name: string): SwarmSpan => ({ text: oneLine(name, 24), color: STYLE.name })
/** The proposals with a number a key can carry (a whole number from 1), the only ones Home lists or counts. */
const numbered = (list: readonly HomeProposal[]): HomeProposal[] => list.filter(pr => Number.isSafeInteger(pr.n) && pr.n > 0)

/** A run that ended wanting a decision, under needs you: its words, its status's word (halted) before the outcome, as the band says it. */
function decisionSpans(l: BandLine): SwarmSpan[] {
  const spans = lineSpans({ ...l, detail: [] })
  const said = l.mark.word === MARK.needsYou.word ? [] : [{ text: l.mark.word, color: l.mark.color }]
  const detail = [...said, ...(said.length > 0 && l.detail.length > 0 ? [{ text: ' ' }] : []), ...l.detail]
  if (detail.length === 0) return spans
  // Before the time, which lineSpans put last.
  const time = l.time !== null ? spans.splice(-2) : []
  return [...spans, SEP, ...detail, ...time]
}

/**
 * Home's view from its facts. Two rows that open the same place get `#<n>`
 * after the second's key, so every key is one element's.
 *
 * Each needs-you row says which thing waits and opens on it (the user's live
 * look, 2026-10-07: every ⚑ is explained by the first thing where its [Open]
 * lands): a question, `port asks the lead: <its first line>`, on its swarm's
 * browser with the asker picked (WP-DG's `<swarm> <node>`);
 * a proposal, `the lead's proposal 6 for <swarm>`, on the proposal view
 * (hub.ts steps Swarms there); the rules, on Rules; a run, on its board. A
 * question names its swarm (`port in review asks: …`) only when more than one
 * swarm has something waiting.
 */
export function homeOf(f: HomeFacts): HomeView {
  const used = new Map<string, number>()
  const unique = (key: string): string => {
    const n = (used.get(key) ?? 0) + 1
    used.set(key, n)
    return n === 1 ? key : `${key}#${n}`
  }
  const row = (open: string, mark: HomeRow['mark'], spans: SwarmSpan[]): HomeRow => ({ open: unique(open), mark, spans })

  const needsYou: HomeRow[] = []
  const proposals = numbered(f.proposals)
  const waiting = new Set([...f.questions.map(q => q.swarm), ...proposals.map(pr => pr.swarm)])
  for (const q of f.questions) {
    const where = waiting.size > 1 ? [{ text: ' in ' }, nameSpan(q.swarm)] : []
    const asker = q.agentId !== undefined && AGENT_ID.test(q.agentId) ? `${q.swarm} ${q.agentId}` : q.swarm
    needsYou.push(row(openKey('swarms', asker), needsMark, [{ text: oneLine(q.node, 40), color: STYLE.name }, ...where, { text: `${asksWords(q.to)} ${firstLine(q.text, 200)}` }]))
  }
  for (const pr of proposals) {
    needsYou.push(row(openKey('swarms', `${pr.swarm}/${pr.n}`), needsMark, [{ text: `the lead's proposal ${pr.n} for ` }, nameSpan(pr.swarm)]))
  }
  if (f.rules !== null && f.rules.proposed > 0) {
    needsYou.push(row(openKey('rules'), needsMark, [{ text: `${plural(f.rules.proposed, 'rule')} proposed or unverified, for you to accept or dismiss` }]))
  }
  for (const l of f.lines) if (l.kind === 'ended' && l.needsYou) needsYou.push(row(lineOpen(l), needsMark, decisionSpans(l)))

  const running = f.lines.filter(l => l.kind === 'run' || l.kind === 'swarm').map(l => row(lineOpen(l), l.mark, lineSpans(l)))
  const ended = f.lines.filter(l => l.kind === 'ended' && !l.needsYou).map(l => row(lineOpen(l), l.mark, lineSpans(l)))

  const others: HomeLine[] = []
  // Nothing needs you and nothing runs: the quiet line names /litter:execute, and Swarms is one step from it.
  if (needsYou.length === 0 && running.length === 0) others.push({ open: unique(openKey('swarms')), label: 'Swarms', text: 'none live: build one from a template, or ask the lead' })
  if (f.tasks !== null && f.tasks.open > 0) others.push({ open: unique(openKey('tasks')), label: 'Tasks', text: `${plural(f.tasks.open, 'open task')} in ${oneLine(f.tasks.list, 60)}` })
  if (f.agents !== null && f.agents > 0) others.push({ open: unique(openKey('agents')), label: 'Agents', text: `${f.agents} running in this session` })
  others.push({ open: unique(openKey('doctor')), label: 'Doctor', text: "what a swarm needs of this session's settings and limits" })

  return { needsYou, running, ended, endedMinutes: f.endedMinutes, others }
}

/** The live line's words for what needs you (hub.ts, liveOf): `1 question, 2 rules`. Pure. */
export function needsWords(f: Pick<HomeFacts, 'questions' | 'proposals' | 'rules' | 'lines'>): string[] {
  const proposals = numbered(f.proposals).length
  const decisions = f.lines.filter(l => l.kind === 'ended' && l.needsYou).length
  return [
    f.questions.length > 0 ? plural(f.questions.length, 'question') : null,
    proposals > 0 ? plural(proposals, 'proposal') : null,
    (f.rules?.proposed ?? 0) > 0 ? plural(f.rules!.proposed, 'rule') : null,
    decisions > 0 ? plural(decisions, 'run') : null,
  ].filter((x): x is string => x !== null)
}

// ---------------------------------------------------------------------------
// [Open]'s key

const SECTION_WORDS: readonly HubSection[] = ['runs', 'swarms', 'rules', 'tasks', 'agents', 'doctor']

/**
 * Where a Home key opens: the section, and the item for Runs (a run id) and
 * Swarms (a swarm's name, then a lead proposal's number after `/` or the
 * asking agent's id after a space), each checked as layout.ts checks them.
 * Null for a key that isn't an [Open], names no section, or carries an
 * argument that isn't one. A drawn key is data from the engine, so nothing
 * else is trusted.
 */
export function homeTarget(key: string): { section: HubSection; arg?: string; proposal?: number } | null {
  const m = /^home:open:([a-z]+)(?::([^#/]+)(?:\/([1-9][0-9]{0,15}))?)?(?:#[0-9]+)?$/.exec(key)
  if (!m) return null
  const section = SECTION_WORDS.find(s => s === m[1])
  if (section === undefined) return null
  const arg = m[2]
  if (arg === undefined) return { section }
  if (section === 'runs' && RUN_ID.test(arg) && m[3] === undefined) return { section, arg }
  const asker = /^(\S+) (\S+)$/.exec(arg)
  if (section === 'swarms' && asker && m[3] === undefined) return SWARM_NAME.test(asker[1]!) && AGENT_ID.test(asker[2]!) ? { section, arg } : null
  if (section !== 'swarms' || !SWARM_NAME.test(arg)) return null
  if (m[3] === undefined) return { section, arg }
  const proposal = Number(m[3])
  return Number.isSafeInteger(proposal) ? { section, arg, proposal } : null
}

// ---------------------------------------------------------------------------
// The row budget (`fits`), pure so tier 2 tests it

/** Below this many body columns a row is two lines, its words then its [Open] (WP-DB). */
export const NARROW_COLUMNS = 60
/** `[ Open ]`, as the terminal draws a Button. */
export const OPEN_CELLS = 8

/** The groups, in Home's order; the first two are kept whole while anything else can fold. */
export const GROUPS = ['needsYou', 'running', 'ended', 'others'] as const
export type HomeGroup = (typeof GROUPS)[number]

export type HomePlan = {
  /** Two lines per row: below NARROW_COLUMNS. */
  narrow: boolean
  /** Each group's heading drawn (dropped only when the rows can't hold them). */
  headings: boolean
  /** Nothing needs you and nothing runs: the line that says so, and the next step. */
  quiet: boolean
  /**
   * The rows of each group drawn; the rest fold into the group's "N more"
   * line. -1: not even that line (the ended runs and the other sections, so
   * needs you and running stay whole; the strip still names the sections).
   */
  shown: Record<HomeGroup, number>
  /** The rows the plan draws in all. */
  height: number
}

/** The quiet state's words: the line that says so (a notice), and the next step as a command (chrome's `empty`); Swarms' line, under Elsewhere, is the other. */
export const QUIET = {
  line: 'Nothing needs you, and nothing runs.',
  what: 'Next',
  next: { command: '/litter:execute <plan.md | goal>', does: 'starts a run' },
} as const

/** The rows the quiet state takes at `columns`: the notice, wrapped, and the next step's three Texts wrapping as a row of them does. */
export function quietRows(columns: number): number {
  return textRows(`${NOTICE_STYLE.info.glyph} ${QUIET.line}`, columns) + flowRows([`${QUIET.what}: `, QUIET.next.command, ` ${QUIET.next.does}`], columns)
}

/** The rows a wrapping row of Texts takes: each whole on a row while it fits, one wider than the row wrapping on its own. Pure. */
export function flowRows(texts: readonly string[], columns: number): number {
  if (!Number.isFinite(columns)) return 1
  const c = Math.max(1, Math.floor(columns))
  let rows = 1
  let used = 0
  for (const t of texts) {
    const w = cells(t)
    if (used > 0 && used + w > c) {
      rows++
      used = 0
    }
    if (w > c) {
      rows += textRows(t, c) - 1
      used = c
    } else used += w
  }
  return rows
}

/**
 * What Home draws in `rows` at `columns`. Everything when it fits; else the
 * others fold into their "N more" line, then the ended runs; then the
 * headings go (and the folds start again); then the others' and the ended
 * runs' lines go too, so needs you and running stay whole while they fit at
 * all; only then does running fold, and last what needs you. A group drawn
 * whole has no "N more" line; a group with none drawn has no heading.
 * Infinite rows (an unbounded surface): all.
 */
export function homePlan(home: HomeView, columns: number, rows: number): HomePlan {
  const narrow = Number.isFinite(columns) && columns < NARROW_COLUMNS
  const per = narrow ? 2 : 1
  const count: Record<HomeGroup, number> = { needsYou: home.needsYou.length, running: home.running.length, ended: home.ended.length, others: home.others.length }
  const quiet = count.needsYou === 0 && count.running === 0
  const top = quiet ? quietRows(columns) : 0
  const part = (g: HomeGroup, shown: number, headings: boolean): number => (count[g] === 0 || shown < 0 ? 0 : (shown > 0 && headings ? 1 : 0) + shown * per + (shown < count[g] ? 1 : 0))
  const height = (shown: Record<HomeGroup, number>, headings: boolean): number => top + GROUPS.reduce((n, g) => n + part(g, shown[g], headings), 0)
  const whole = { ...count }
  if (!Number.isFinite(rows) || height(whole, true) <= rows) return { narrow, headings: true, quiet, shown: whole, height: height(whole, true) }
  const budget = Math.max(0, Math.floor(rows))
  // Each step takes a row from a group, down to `floor` (-1: its "N more" line goes too).
  type Step = readonly [HomeGroup, number]
  const fold = (headings: boolean, steps: readonly Step[]): Record<HomeGroup, number> => {
    const shown = { ...count }
    for (const [g, floor] of steps) while (height(shown, headings) > budget && shown[g] > floor) shown[g]--
    return shown
  }
  const passes: readonly (readonly [boolean, readonly Step[]])[] = [
    [true, [['others', 0], ['ended', 0]]],
    [false, [['others', 0], ['ended', 0]]],
    [false, [['others', 0], ['ended', 0], ['others', -1], ['ended', -1], ['running', 0], ['needsYou', 0]]],
  ]
  let shown = whole
  let headings = true
  for (const [h, steps] of passes) {
    shown = fold(h, steps)
    headings = h
    if (height(shown, h) <= budget) break
  }
  // The last pass's when nothing fits: the fewest rows there are; the hub clips the body at its rows.
  return { narrow, headings, quiet, shown, height: height(shown, headings) }
}

/** A folded group's line: `+2 more ended`, `+1 more: Agents`; with none of the group drawn, `2 running`, `Tasks, Doctor`. */
export function moreText(home: HomeView, group: HomeGroup, shown: number): string {
  const drawn = Math.max(0, shown)
  const left = (group === 'others' ? home.others.length : home[group].length) - drawn
  const more = drawn > 0 ? `+${left} more` : `${left}`
  switch (group) {
    case 'needsYou':
      return `${more} ${left === 1 ? 'needs' : 'need'} you`
    case 'running':
      return `${more} running`
    case 'ended':
      return drawn > 0 ? `${more} ended` : `${left} ended in the last ${home.endedMinutes === 1 ? 'minute' : `${home.endedMinutes} minutes`}`
    case 'others': {
      const labels = home.others
        .slice(drawn)
        .map(o => o.label)
        .join(', ')
      return drawn > 0 ? `${more}: ${labels}` : labels
    }
  }
}

/** The one primary action (chrome's rule): the first needs-you row's [Open], else the first running row's; null when neither is drawn. */
export function primaryOpen(home: HomeView, plan: HomePlan): string | null {
  if (plan.shown.needsYou > 0) return home.needsYou[0]!.open
  if (home.needsYou.length === 0 && plan.shown.running > 0) return home.running[0]!.open
  return null
}
