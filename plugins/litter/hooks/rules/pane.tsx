// The rules pane, the `litter` pane's Rules section (plan 16.3, 16.8; phase
// 5b, WP-DA): the only place a rule is
// accepted, dismissed or retired. Its buttons are the only path to store.ts's
// acceptRule, dismissRule and retireRule (COMMON, "Only you accept"). Keys
// are `rules:<action>[:<arg>]`. Owner: phase 3, package AF.
//
// Only `ui.press` reaches those three, through pressRules: a field (ui.input),
// a pick (ui.select), a message, a timer, the record tool and the spool never
// do. A project rule's [Accept] shows the exact file first (AD's
// previewAccept), and [Confirm accept] writes it; [Retire] asks for
// [Confirm retire]. Every call into the store is logged before it's made.
//
// Phase 6 (16.7): after an accept or a retire, the Claude Code rule files are
// brought in line (export.ts's syncExports). A rule in force whose rule file
// was edited by hand has [Adopt edit], which proposes the edit, and [Restore
// file], which asks for [Confirm restore] before litter's copy replaces it;
// these two, too, are reached only from ui.press.
//
// Phase 5b (WP-DE): the rows are the chrome's in-pane lists, each row's
// actions its right-click menu (the list's Client, whose clicks and picks the
// hub presses here as the Buttons would be), and the picked row's
// description and actions beside or under the lists, as Buttons on every
// surface; [next] and [previous] (j, k) move the pick from the keyboard,
// since a Client's rows are no Tab stop.

import type { RenderElement } from 'claude-code'
import type { Ports } from '../ports'
import type { CommandRunHook, PaneElements, PaneUiHandlers, PortHook, UiScrollHook } from '../hooktypes'
import type { Action, BodyContext, Cell, KeyHint, SectionMeta } from '../ui/chrome'
import type { ListAction, ListItem, ListPlace, ListSpec, ListWindow } from '../ui/list'
import type { Loaded } from '../ui/hub'
import type { ProposalRef, RuleScope, RuleType } from '../records/rules'
import type { RulesBatch, RulesBody, RulesPaneView, RulesRow, RulesTab, SwarmNotice, SwarmSpan } from '../../types/index'
import type { AcceptOpts, AcceptWhat } from './store'
import type { RulesNav, ShownRow } from './paneview'
import { session } from '../session'
import { serial } from '../fsx'
import { headKey } from '../ledgercore'
import { repoRulesLedgerDir, userRulesLedgerDir } from '../layout'
import { primaryOf } from '../lifecycle'
import { interactive } from '../swarm/state'
import { tableFor } from '../swarm/builder'
import { clean, oneLine } from '../swarm/view'
import { cells, fitSpans } from '../band/view'
import { MARK, NOTICE_STYLE, SELECTED_MARK, STYLE } from '../ui/style'
import { WIDE_COLUMNS, action, actions, empty, field, fieldRows, heading, itemWidth, notice, packWidths, textRows } from '../ui/chrome'
import { list, listPlace, listWindow, pageOf, scrolled } from '../ui/list'
import { listOffset, moveList, openSection } from '../ui/hub'
import { acceptRule, dismissRule, narrowPaths, previewAccept, retireRule } from './store'
import { adoptExport, restoreExport, syncExports } from './export'
import {
  NO_PATHS,
  batchKey,
  blankRulesNav,
  describeRow,
  deps as viewDeps,
  restoreRulesNav,
  rulesNavOf,
  rulesView,
  saveRulesNav,
  scopeChoices,
  setRulesNav,
  shownPath as relativePath,
} from './paneview'

// AD's acting functions, through one table so tier 2 can stand in for them
// (COMMON, "Another package's module"). The mod never changes it.
export const deps = {
  acceptRule: (...a: Parameters<typeof acceptRule>) => acceptRule(...a),
  dismissRule: (...a: Parameters<typeof dismissRule>) => dismissRule(...a),
  retireRule: (...a: Parameters<typeof retireRule>) => retireRule(...a),
  previewAccept: (...a: Parameters<typeof previewAccept>) => previewAccept(...a),
  narrowPaths: (...a: Parameters<typeof narrowPaths>) => narrowPaths(...a),
  syncExports: (...a: Parameters<typeof syncExports>) => syncExports(...a),
  adoptExport: (...a: Parameters<typeof adoptExport>) => adoptExport(...a),
  restoreExport: (...a: Parameters<typeof restoreExport>) => restoreExport(...a),
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const TABS: readonly RulesTab[] = ['proposed', 'in-force']
const SCOPES: readonly RuleScope[] = ['user', 'project', 'local']
const TYPES: readonly RuleType[] = ['rule', 'ban']
/** A rule id as the skill takes it: what fills the prompt is built from a checked id only. */
const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
/** Under the engine's 10000-character bound for Code. */
const PREVIEW_MAX = 9000

// ---------------------------------------------------------------------------
// One step at a time

/**
 * Rules' steps run one at a time, each once the one before it has finished
 * and written its view: a press, a field, a pick, the tick, an open, a
 * resume, a refresh. The engine dispatches a list's post (a click on a row, a
 * menu pick) and a Button's press as separate events, so a press could
 * otherwise run while a click's pick is still being drawn: each step reads
 * the navigation at its start and writes it back after its awaits, so the
 * later one would overwrite the earlier one's change, and the slower build
 * would land its view over the newer one. No step starts another (a nested
 * one would wait on itself); each calls drawRules or loadNow directly.
 */
const STEPS = 'rules-pane:steps'
const inTurn = <T,>(work: () => Promise<T>): Promise<T> => serial(STEPS, work)

// ---------------------------------------------------------------------------
// Drawing

let lastStamp = ''

/** The two rules ledgers' heads: what moves when a proposal arrives or a step is recorded. */
async function rulesStamp(p: Ports, litterDir: string): Promise<string> {
  const head = async (dir: string) => {
    const stored = (await p.store.get(headKey(dir))) as { seq?: unknown } | undefined
    return typeof stored?.seq === 'number' ? String(stored.seq) : '0'
  }
  const user = await p.configDir().then(
    dir => head(userRulesLedgerDir(dir)),
    () => '-',
  )
  return `${await head(repoRulesLedgerDir(litterDir))}|${user}`
}

/** Builds the pane's view from the store and the navigation, keeps what it drew for the presses, and writes it. */
async function drawRules(p: Ports): Promise<RulesPaneView | null> {
  const n = rulesNavOf()
  if (!n) return null
  const litterDir = session().litterDir
  if (!litterDir) {
    const why = session().litterDirError
    const view: RulesPaneView = {
      view: 'rules',
      v: 0,
      tab: n.tab,
      body: {
        notice: { level: 'error', text: `this session has no litter directory${why ? `: ${oneLine(why, 240)}` : ''}, so the rules can't be read` },
        counts: { proposed: 0, inForce: 0 },
        rows: [],
        batch: null,
        focus: null,
        more: null,
        problems: [],
        pending: null,
        editing: null,
      },
    }
    await p.setView('rules', view)
    return view
  }
  const built = await rulesView(p, litterDir, n)
  // What the build drew is what a press acts on; a pending step or a field whose row is gone goes with it.
  n.shown = built.shown
  n.batch = built.batch
  n.seeded = built.seeded
  n.checked = built.checked
  n.pending = built.view.body?.pending ?? null
  n.editing = built.view.body?.editing ?? null
  await p.setView('rules', built.view)
  lastCounts = built.view.body?.counts ?? null
  lastStamp = await rulesStamp(p, litterDir)
  await saveRulesNav(p)
  return built.view
}

/** The last build's counts, for the hub's strip and Home (WP-DA); null before one. */
let lastCounts: { proposed: number; inForce: number } | null = null
export const rulesCounts = (): { proposed: number; inForce: number } | null => (lastCounts ? { ...lastCounts } : null)

/** `/litter rules` (ui/hub.ts's litterCommand): shows Rules on the Proposed tab in the `litter` pane. */
export const rulesCommand: PortHook<CommandRunHook> = async (p, e, next) => ({ text: (await openSection(p, 'rules', '', { focus: true })).text })

const validFocus = (focus: { id?: unknown; proposal?: unknown } | null): RulesNav['focus'] => {
  if (!focus) return null
  const out: NonNullable<RulesNav['focus']> = {}
  if (typeof focus.id === 'string' && RULE_ID.test(focus.id)) out.id = focus.id
  const ref = focus.proposal as Partial<ProposalRef> | undefined
  if (ref && (ref.store === 'repo' || ref.store === 'user') && Number.isInteger(ref.seq) && (ref.seq as number) > 0) out.proposal = { store: ref.store, seq: ref.seq as number }
  return out.id || out.proposal ? out : null
}

/**
 * Rules' load (openSection): focused on a rule id or a proposal, or for null
 * the Proposed tab (`/litter rules`, the board's [Rules]); AD's rule.open and
 * rule.import pass the focus. A proposal that is, or is in, an import batch
 * focuses the batch. Answers the reply's line. A step (inTurn).
 */
export function loadRules(p: Ports, focus: { id?: string; proposal?: ProposalRef } | null): Promise<Loaded> {
  return inTurn(() => loadNow(p, focus))
}

async function loadNow(p: Ports, focus: { id?: string; proposal?: ProposalRef } | null): Promise<Loaded> {
  await restoreRulesNav(p)
  const f = validFocus(focus)
  const litterDir = session().litterDir
  let tab: RulesTab = 'proposed'
  if (f?.id && litterDir) {
    // A rule in force opens on its own tab; an unverified file on the Proposed one.
    try {
      const found = (await viewDeps.loadRules(p, litterDir)).rules.find(r => r.doc.id === f.id)
      if (found && found.standing !== 'unverified' && found.delivered) tab = 'in-force'
    } catch (err) {
      p.log(`rules pane: the rules couldn't be loaded to place ${f.id}: ${errText(err)}`)
    }
  }
  setRulesNav({ ...blankRulesNav(tab, f), held: rulesNavOf()?.held ?? {} })
  const view = await drawRules(p)
  const c = view?.body?.counts
  return { text: litterDir && c ? `Rules shows ${c.proposed} proposed or unverified, ${c.inForce} in force` : 'Rules has no litter directory to read' }
}

/** Rules from the strip or Home: the tab it showed, drawn again, else the Proposed tab. A step. */
export function resumeRules(p: Ports): Promise<void> {
  return inTurn(async () => {
    await restoreRulesNav(p)
    if (rulesNavOf()) await drawRules(p)
    else await loadNow(p, null)
  })
}

/** Rules' tick (ui/hub.ts's litterTick, while Rules is shown): the view again when a rules ledger moved (a critic's proposal, a step taken elsewhere). A step. */
export function rulesTick(p: Ports): Promise<void> {
  return inTurn(async () => {
    await restoreRulesNav(p)
    const litterDir = session().litterDir
    if (!rulesNavOf() || !litterDir) return
    if ((await rulesStamp(p, litterDir)) === lastStamp) return
    await drawRules(p)
  })
}

/** After a /clear ($.state wiped): the pane's view again, if it was open. A step. */
export function refreshRulesPane(p: Ports): Promise<void> {
  return inTurn(async () => {
    await restoreRulesNav(p)
    if (rulesNavOf()) await drawRules(p)
  })
}

export function resetRulesPaneForTests(): void {
  lastStamp = ''
  lastCounts = null
}

// ---------------------------------------------------------------------------
// The render (phase 5b, WP-DE)
//
// What takes the body, first match: a preview waiting on [Confirm accept]
// (the file as Code, windowed, with [Confirm accept] and [Cancel] above it,
// so always in view); every problem ([More] on "N more problems"); one row's
// whole description ([More] under its cut one); else the lists and the picked
// row's detail, beside them from WIDE_COLUMNS, under them below it.
// rulesLayout is the row budget for all of it, so the body keeps to ctx.rows
// (`fits`); the render notes what it laid out (drawnRules) for the presses
// and the wheel that move a window, as ui/drawn.ts notes the pane.

/** The rules' list, or with an import batch shown the proposals outside it. */
export const MAIN_LIST = 'rules:list:main'
/** An import batch's instance's list: `instances[i]`'s rows (one past the last: rows whose instance isn't listed). */
export const instanceList = (i: number): string => `rules:list:i${i}`
/** The windows of a view that takes the body: the file a preview shows, one row's whole description, the problems. */
export const PREVIEW_WINDOW = 'rules:window:preview'
export const DETAIL_WINDOW = 'rules:window:detail'
export const PROBLEMS_WINDOW = 'rules:window:problems'
/** A row in its list: a press (a click, Enter) picks it, so its description and actions are drawn. */
export const rowKey = (key: string): string => `rules:row:${key}`
/** The rows the inline form keeps to: `placement: 'inline'` has no bound of its own, and shows the compact form. */
export const INLINE_ROWS = 18
/** Problems drawn above the list, each on one line; past this many, the first ones and "N more". */
const PROBLEM_ROWS = 3
/** A row's first line keeps at least this many cells before its columns drop. */
const LABEL_MIN = 20
/** The fewest lines a cut description keeps beside its [More], when the lists can spare them. */
const DESCRIPTION_KEEP = 3
/** Of the body's columns from WIDE_COLUMNS, the lists' share; the detail has the rest, two cells between. */
const LIST_SHARE = 0.55
const ACTION_LABEL: Record<string, string> = { accept: 'Accept', edit: 'Edit…', dismiss: 'Dismiss', retire: 'Retire', adopt: 'Adopt edit', restore: 'Restore file' }
const noop = (): void => {}

/** Rules to the hub (chrome.tsx's SectionMeta): the body keeps to ctx.rows; its keys are the lists'. */
export const rulesSection: SectionMeta<RulesPaneView> = {
  fits: true,
  keys: view => {
    const n = view?.body?.rows?.length ?? 0
    return [...(n > 1 ? [{ key: 'j/k', word: 'next/previous rule' }] : []), ...(n > 0 ? [{ key: 'right-click', word: "a rule's actions" }] : [])] satisfies KeyHint[]
  },
}

// --- Text in lines

const finite = (n: number): boolean => Number.isFinite(n)
/** `text` cut to `n` cells with `…`; whole when `n` is infinite. */
const cut = (text: string, n: number): string => (finite(n) ? (fitSpans([{ text }], Math.max(1, Math.floor(n)))[0]?.text ?? '') : text)
/** `text` padded with spaces to `n` cells. */
const padTo = (text: string, n: number): string => text + ' '.repeat(Math.max(0, Math.floor(n) - cells(text)))
const firstLine = (text: string): string => text.split('\n').find(l => l.trim() !== '')?.trim() ?? ''
const sameStyle = (a: SwarmSpan, b: SwarmSpan): boolean => a.color === b.color && a.bold === b.bold && a.dim === b.dim

/**
 * Spans as lines of at most `width` cells (a local helper; chrome.tsx's
 * spansLine cuts to one): broken at spaces, a word wider than a line
 * hard-broken, the first span's leading spaces kept as an indent, each line's
 * runs merged by style. Drawn one Text per run, so a line is exactly one row.
 * Pure.
 */
export function wrapSpans(spans: readonly SwarmSpan[], width: number): SwarmSpan[][] {
  const parts = spans.filter(s => s.text !== '').map(s => ({ ...s }))
  if (!finite(width)) return [parts]
  const w = Math.max(1, Math.floor(width))
  const lines: SwarmSpan[][] = [[]]
  let used = 0
  const put = (s: SwarmSpan): void => {
    const line = lines[lines.length - 1]!
    const last = line[line.length - 1]
    if (last && sameStyle(last, s)) last.text += s.text
    else line.push({ ...s })
    used += cells(s.text)
  }
  const first = parts[0]
  const indent = first ? /^ +/.exec(first.text)?.[0] : undefined
  if (first && indent) {
    put({ ...first, text: ' '.repeat(Math.min(indent.length, w - 1)) })
    first.text = first.text.slice(indent.length)
  }
  type Word = { segs: SwarmSpan[]; cells: number; gap: SwarmSpan | null }
  const words: Word[] = []
  let gap = null as SwarmSpan | null
  let word = null as Word | null
  for (const s of parts) {
    for (const piece of s.text.split(/( +)/)) {
      if (piece === '') continue
      if (piece.startsWith(' ')) {
        if (word) words.push(word)
        word = null
        gap = gap === null ? { ...s, text: piece } : { ...gap, text: gap.text + piece }
        continue
      }
      if (!word) {
        word = { segs: [], cells: 0, gap }
        gap = null
      }
      word.segs.push({ ...s, text: piece })
      word.cells += cells(piece)
    }
  }
  if (word) words.push(word)
  for (const x of words) {
    const g = x.gap && used > 0 ? cells(x.gap.text) : 0
    if (used > 0 && used + g + x.cells > w) {
      lines.push([])
      used = 0
    } else if (g > 0) put(x.gap!)
    for (const seg of x.segs) {
      let rest = seg.text
      while (rest !== '') {
        if (used >= w) {
          lines.push([])
          used = 0
        }
        let head = ''
        let n = 0
        for (const ch of rest) {
          const c = cells(ch)
          if (used + n + c > w && (head !== '' || used > 0)) break
          head += ch
          n += c
        }
        if (head === '') {
          lines.push([])
          used = 0
          continue
        }
        put({ ...seg, text: head })
        rest = rest.slice(head.length)
      }
    }
  }
  return lines
}

/** A file's lines hard-broken at `width` cells, so each is one row of the Code. Pure. */
export function codeLines(text: string, width: number): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (!finite(width) || cells(line) <= width) {
      out.push(line)
      continue
    }
    let row = ''
    let n = 0
    for (const ch of line) {
      const c = cells(ch)
      if (n + c > width && row !== '') {
        out.push(row)
        row = ''
        n = 0
      }
      row += ch
      n += c
    }
    out.push(row)
  }
  return out
}

/** The rows a row of Buttons takes at `width` (the terminal's `[ label ]`, one cell between). */
const buttonRows = (labels: readonly string[], width: number): number => (labels.length === 0 ? 0 : packWidths(labels.map(l => cells(l) + 4), width).length)
/** The rows an engine Select takes, at most: its label's, one per option up to 7, and "… N more" (WP-DA2). */
const selectRows = (options: number): number => 1 + Math.min(7, options) + (options > 7 ? 1 : 0)

// --- The tabs

type TabSpec = { tab: RulesTab; mark: (typeof MARK)['needsYou' | 'done']; label: string; count: number }

/** Proposed in the needs-you mark, In force in the done one: a proposal never wears the in-force color. */
const tabsOf = (body: RulesBody): TabSpec[] => [
  { tab: 'proposed', mark: MARK.needsYou, label: 'Proposed', count: body.counts?.proposed ?? 0 },
  { tab: 'in-force', mark: MARK.done, label: 'In force', count: body.counts?.inForce ?? 0 },
]
const tabText = (t: TabSpec): string => `${t.mark.glyph} ${t.label} ${t.count}`
/** Between the two tabs. */
const TAB_GAP = 3
const tabsRowsAt = (view: RulesPaneView, body: RulesBody, columns: number): number =>
  packWidths(
    tabsOf(body).map(t => cells(tabText(t)) + (t.tab === view.tab ? 2 : 0) + TAB_GAP - 1),
    finite(columns) ? columns + TAB_GAP - 1 : columns,
  ).length

// --- The rows as list items

/** A row's columns after its first line: the status (never dropped), the scope, the type, `id@version` (the first to drop). */
const COLUMN_DROP = [0, 1, 2, 3] as const
const nameOf = (r: RulesRow): string => (r.id ? `${r.id}@${r.version ?? '?'}` : r.edits ? `edit of ${r.edits}` : 'new rule')
const labelOf = (r: RulesRow): string => `${r.checked === undefined ? '' : r.checked ? '[x] ' : '[ ] '}${firstLine(r.rule)}`

function rowCells(r: RulesRow): Cell[] {
  return [
    { text: `${r.status.glyph} ${r.status.text}`, color: r.status.color },
    r.scope ? { text: r.scope, dim: true } : { text: '! no scope yet', color: STYLE.warning },
    { text: r.type },
    { text: nameOf(r), color: STYLE.name },
  ]
}

/**
 * Which cells the rows keep at `columns`, and the cells their first line
 * gets: the line keeps LABEL_MIN (or its own width) while a cell can drop,
 * the name first, then the type, then the scope. Every list of a view is
 * planned over all its rows, so an import batch's lists align. Pure.
 */
function rowColumns(rows: readonly RulesRow[], columns: number): { kept: number[]; label: number } {
  if (!finite(columns)) return { kept: [...COLUMN_DROP], label: Number.POSITIVE_INFINITY }
  const all = rows.map(rowCells)
  const natural = COLUMN_DROP.map(i => Math.max(0, ...all.map(c => cells(c[i]!.text))))
  const labelNatural = Math.max(1, ...rows.map(r => cells(labelOf(r))))
  const kept: number[] = [...COLUMN_DROP]
  // The mark, its gap, and each kept cell with its gap (list.tsx's listPlace).
  const room = () => Math.floor(columns) - 2 - kept.reduce((n, i) => n + natural[i]! + 1, 0)
  while (room() < Math.min(LABEL_MIN, labelNatural) && kept.length > 1) kept.pop()
  return { kept, label: Math.max(1, Math.min(labelNatural, room())) }
}

/** A row's right-click menu: its actions, and a batch row's check. */
const menuOf = (r: RulesRow): ListAction[] => [
  ...r.actions.map(a => ({ key: `rules:${a}:${r.key}`, label: ACTION_LABEL[a] ?? a })),
  ...(r.checked !== undefined ? [{ key: `rules:check:${r.key}`, label: r.checked ? 'Uncheck' : 'Check' }] : []),
]

/**
 * The rows as items. Where a Client is drawn each has its menu; elsewhere
 * none, since the picked row's actions are the detail's Buttons on every
 * surface (a list's own Buttons on its focused row would repeat their keys).
 */
const itemsOf = (rows: readonly RulesRow[], cols: { kept: number[]; label: number }, current: string | null, menu: boolean): ListItem[] =>
  rows.map(r => ({
    key: rowKey(r.key),
    // Cut, then padded to the view's widest, so a batch's lists line up.
    label: finite(cols.label) ? padTo(cut(labelOf(r), cols.label), cols.label) : labelOf(r),
    cells: cols.kept.map(i => rowCells(r)[i]!),
    selected: r.key === current,
    ...(menu ? { actions: menuOf(r) } : {}),
  }))

type Group = { id: string; rows: RulesRow[]; instance: RulesBatch['instances'][number] | null }

/** An import batch's rows by instance, in the batch's order, and the rows outside it. */
function groupsOf(view: RulesPaneView, body: RulesBody): { batch: RulesBatch | null; groups: Group[]; others: RulesRow[] } {
  const batch = view.tab === 'proposed' ? (body.batch ?? null) : null
  if (!batch) return { batch: null, groups: [], others: body.rows }
  const inBatch = body.rows.filter(r => r.checked !== undefined)
  const groups: Group[] = batch.instances.map((instance, i) => ({ id: instanceList(i), rows: inBatch.filter(r => r.instance === instance.id), instance })).filter(g => g.rows.length > 0)
  const placed = new Set(groups.flatMap(g => g.rows.map(r => r.key)))
  const stray = inBatch.filter(r => !placed.has(r.key))
  if (stray.length > 0) groups.push({ id: instanceList(batch.instances.length), rows: stray, instance: null })
  return { batch, groups, others: body.rows.filter(r => r.checked === undefined) }
}

/**
 * Each list's window rows within `room`: one row each first, then a row at a
 * time to each list in turn while it fits. A list's height is its window and
 * its footer (the Client's status line always; else [↑]/[↓] when windowed).
 * Infinite room: every row. Pure.
 */
function allot(counts: readonly number[], client: readonly boolean[], room: number): number[] {
  if (!finite(room)) return [...counts]
  const height = (i: number, w: number): number => w + (client[i] || w < counts[i]! ? 1 : 0)
  const w = counts.map(c => Math.min(c, 1))
  let used = w.reduce((n, x, i) => n + height(i, x), 0)
  for (let grew = true; grew; ) {
    grew = false
    for (let i = 0; i < counts.length; i++) {
      if (w[i]! >= counts[i]!) continue
      const more = height(i, w[i]! + 1) - height(i, w[i]!)
      if (used + more > room) continue
      w[i]! += 1
      used += more
      grew = true
    }
  }
  return w
}

// --- The picked row's detail

/** What the picked row's detail draws at `width`, and the rows each part takes. */
export type RulesDetail = {
  row: RulesRow
  width: number
  name: string
  /** Its description (describeRow), wrapped at `width`. */
  lines: SwarmSpan[][]
  /** The scopes it can be accepted into, when the pick is drawn. */
  scopes: string[] | null
  scopeRows: number
  /** What [Accept] writes, wrapped; empty where there's no [Accept]. */
  consequence: SwarmSpan[][]
  editing: RulesBody['editing']
  editorRows: number
  actions: Action[]
  actionRows: number
  /** The retire confirm's question, while it waits. */
  retire: string | null
  retireRows: number
  /** The restore confirm's question, while it waits: a hand-edited export about to get litter's copy back. */
  restore: string | null
  restoreRows: number
  /** The rows of all but the description, its heading's included. */
  fixed: number
}

/** Before the scope pick: what it is, or that one is wanted. */
const scopeWord = (r: RulesRow): string => (r.scope ? 'scope' : 'pick a scope')
const pathsCaption = (type: string): string => (type === 'ban' ? 'globs it protects; a ban reaches every gate' : 'globs, comma-separated; empty: every gate')

function detailOf(body: RulesBody, r: RulesRow, width: number, ctx: BodyContext, batchShown: boolean): RulesDetail {
  const pending = body.pending?.key === r.key ? body.pending : null
  const editing = body.editing?.key === r.key ? body.editing : null
  const name = nameOf(r)
  const retire = pending?.kind === 'retire' ? `retire ${name}? Its file moves to .history, and no later run gets it` : null
  const restore = pending?.kind === 'restore' ? `put litter's copy of ${name}'s Claude Code rule file back? Your edit is kept beside the rules ledger` : null
  // An edit keeps its rule's scope, so only a new rule has a scope to pick.
  const scopes = r.kind === 'proposal' && !r.edits && r.actions.includes('accept') ? scopeChoices({ source: r.source }) : null
  const scopeRows = scopes ? packWidths([cells(scopeWord(r)), ...scopes.map(s => cells(s) + (s === r.scope ? 2 : 0))], width).length : 0
  const consequence = r.consequence && r.actions.includes('accept') && !retire && !restore ? wrapSpans(r.consequence, width) : []
  const typeRows = ctx.surface === 'mobile' ? 1 : Math.max(1, selectRows(TYPES.length))
  const editorRows = editing ? fieldRows(ctx.surface, true) + typeRows + (editing.error ? textRows(`✕ ${editing.error}`, width) : 0) : 0
  // Accept is a proposal's primary, unless a batch's [Accept selected] is; Retire never is.
  const acts: Action[] = retire || restore
    ? []
    : [
        ...r.actions.map(a => ({ key: `rules:${a}:${r.key}`, label: ACTION_LABEL[a] ?? a, ...(a === 'accept' && !batchShown ? { primary: true } : {}) })),
        ...(r.checked !== undefined ? [{ key: `rules:check:${r.key}`, label: r.checked ? 'Uncheck' : 'Check' }] : []),
      ]
  const actionRows = buttonRows(acts.map(a => a.label), width)
  const retireRows = retire ? textRows(`! ${retire}`, width) + buttonRows(['Confirm retire', 'Cancel'], width) : 0
  const restoreRows = restore ? textRows(`! ${restore}`, width) + buttonRows(['Confirm restore', 'Cancel'], width) : 0
  const lines = describeRow(r).flatMap(l => wrapSpans(l, width))
  return {
    row: r,
    width,
    name,
    lines,
    scopes,
    scopeRows,
    consequence,
    editing,
    editorRows,
    actions: acts,
    actionRows,
    retire,
    retireRows,
    restore,
    restoreRows,
    fixed: 1 + scopeRows + consequence.length + editorRows + actionRows + retireRows + restoreRows,
  }
}

// --- The layout

/** One list as laid out: its spec (the window's rows set) and where it draws. */
export type RulesList = { spec: ListSpec; place: ListPlace; group: Group | null }
/** A window over lines that takes the body. */
export type RulesWindow = { id: string; count: number; budget: number; window: ListWindow; rows: number }

export type RulesLayout = {
  mode: 'empty' | 'lists' | 'preview' | 'problems' | 'more'
  /** The rows the body keeps to: ctx.rows in the dock, INLINE_ROWS at most inline. */
  budget: number
  columns: number
  wide: boolean
  listColumns: number
  detailColumns: number
  /** Problems drawn above the lists, each cut to a line, and how many more fold under [More]. */
  problems: { shown: string[]; more: number }
  batch: RulesBatch | null
  /** [Accept selected]'s consequence, wrapped at the lists' width. */
  batchLines: SwarmSpan[][]
  lists: RulesList[]
  /** The picked row, its place in the view's rows, and its detail. */
  current: RulesRow | null
  index: number
  detail: RulesDetail | null
  /** The description's lines drawn in the lists' form; fewer than its lines: [More] under them. */
  shown: number
  /** A preview's consequence, wrapped. */
  confirmLines: SwarmSpan[][]
  /** The lines a window draws from: the file, the description, the problems. */
  lines: SwarmSpan[][]
  window: RulesWindow | null
  /** The rows the body takes, at most `budget` once the budget has room for the least of it. */
  height: number
}

/** A window of `count` lines in `room` rows: all of them, else what fits less a footer of [↑]/[↓]. */
function windowOf(id: string, count: number, room: number, ctx: BodyContext): RulesWindow {
  const n = Math.max(1, count)
  const budget = !finite(room) || n <= room ? n : Math.max(1, Math.floor(room) - 1)
  const window = listWindow(n, ctx.lists?.[id] ?? 0, budget)
  return { id, count: n, budget, window, rows: window.end - window.start + (window.above > 0 || window.below > 0 ? 1 : 0) }
}

/**
 * The row budget for everything the body draws (the render follows it, and
 * the presses that move a window read it back from drawnRules). From the top:
 * the notice, the tabs, a gap; then the mode's parts. In the lists' form the
 * detail's fixed parts are reserved first, then the lists and the description
 * share the rest: each list a row at least, the lists up to half when the
 * description wants more, the description what's left, cut with [More]. Pure.
 */
export function rulesLayout(view: RulesPaneView, ctx: BodyContext): RulesLayout {
  const body = view.body!
  const columns = ctx.bodyColumns
  const budget = ctx.placement === 'inline' ? Math.min(ctx.rows, INLINE_ROWS) : ctx.rows
  const wide = finite(columns) && columns >= WIDE_COLUMNS
  const listColumns = wide ? Math.floor((columns - 2) * LIST_SHARE) : columns
  const detailColumns = wide ? columns - 2 - listColumns : columns
  const noticeRows = body.notice ? textRows(`${NOTICE_STYLE[body.notice.level].glyph} ${body.notice.text}`, columns) : 0
  const head = noticeRows + tabsRowsAt(view, body, columns) + 1
  const rows = body.rows
  const current = rows.find(r => r.key === body.focus) ?? rows[0] ?? null
  const index = current ? rows.indexOf(current) : -1
  const { batch, groups, others } = groupsOf(view, body)
  const none = { problems: { shown: [], more: 0 }, batch, batchLines: [], lists: [], current, index, detail: null, shown: 0, confirmLines: [], lines: [], window: null }
  const base = { budget, columns, wide, listColumns, detailColumns }

  const pending = body.pending
  if (pending?.kind === 'preview') {
    const conseq = pending.key.startsWith('batch:') ? batch?.consequence : rows.find(r => r.key === pending.key)?.consequence
    const confirmLines = conseq ? wrapSpans(conseq, columns) : []
    const lines = codeLines(pending.text, columns).map(text => [{ text }])
    const fixed = head + 1 + confirmLines.length + buttonRows(['Confirm accept', 'Cancel'], columns)
    const window = windowOf(PREVIEW_WINDOW, lines.length, budget - fixed, ctx)
    return { ...base, ...none, mode: 'preview', confirmLines, lines, window, height: fixed + window.rows }
  }
  if (body.more === 'problems' && body.problems.length > 0) {
    const lines = body.problems.flatMap(x => wrapSpans([{ text: `${NOTICE_STYLE.warning.glyph} ${x}`, color: NOTICE_STYLE.warning.color }], columns))
    const window = windowOf(PROBLEMS_WINDOW, lines.length, budget - head - 1, ctx)
    return { ...base, ...none, mode: 'problems', lines, window, height: head + 1 + window.rows }
  }
  if (current && body.more === current.key) {
    const detail = detailOf(body, current, columns, ctx, batch !== null)
    const window = windowOf(DETAIL_WINDOW, detail.lines.length, budget - head - detail.fixed, ctx)
    return { ...base, ...none, mode: 'more', detail, lines: detail.lines, window, height: head + detail.fixed + window.rows }
  }

  const all = body.problems
  const shownProblems = all.length <= PROBLEM_ROWS ? all : all.slice(0, PROBLEM_ROWS - 1)
  const problems = { shown: shownProblems.map(x => cut(x, columns - 2)), more: all.length - shownProblems.length }
  const top = head + problems.shown.length + (problems.more > 0 ? 1 : 0)
  if (rows.length === 0) {
    const emptyRows = view.tab === 'proposed' ? 1 : 1 + textRows('nothing in force yet: /litter:rules add drafts a proposal', columns)
    return { ...base, ...none, mode: 'empty', problems, height: top + emptyRows }
  }

  const menu = ctx.surface === 'terminal' || ctx.surface === 'desktop'
  const cols = rowColumns(rows, listColumns)
  const parts: { group: Group | null; rows: RulesRow[] }[] = [...groups.map(g => ({ group: g, rows: g.rows })), ...(others.length > 0 ? [{ group: null, rows: others }] : [])]
  const batchLines = batch?.consequence ? wrapSpans(batch.consequence, listColumns) : []
  // The batch's heading, each instance's heading and goal, [Accept selected] and its line, and "Other proposals".
  const batchRows = batch
    ? 1 + groups.reduce((n, g) => n + 1 + (g.instance?.goal ? 1 : 0), 0) + batchLines.length + 1 + (others.length > 0 ? 1 : 0)
    : 0
  const detail = current ? detailOf(body, current, detailColumns, ctx, batch !== null) : null
  const want = detail?.lines.length ?? 0
  const counts = parts.map(x => x.rows.length)
  const client = parts.map(x => menu && x.rows.some(r => menuOf(r).length > 0))
  const full = counts.reduce((n, c, i) => n + c + (client[i] ? 1 : 0), 0)
  let windows: number[]
  let room: number
  if (wide) {
    windows = allot(counts, client, budget - top - batchRows)
    room = budget - top - (detail?.fixed ?? 0)
  } else {
    // The gap between the lists and the detail.
    const rest = budget - top - batchRows - 1 - (detail?.fixed ?? 0)
    if (full + want <= rest) windows = [...counts]
    else {
      const keep = Math.min(want, DESCRIPTION_KEEP) + (want > DESCRIPTION_KEEP ? 1 : 0)
      windows = allot(counts, client, Math.min(full, Math.max(rest - want, Math.ceil(rest / 2)), Math.max(0, rest - keep)))
    }
    const used = windows.reduce((n, w, i) => n + w + (client[i] || w < counts[i]! ? 1 : 0), 0)
    room = rest - used
  }
  const shown = !finite(room) || want <= room ? want : Math.max(0, Math.floor(room) - 1)
  const listCtx = { ...ctx, bodyColumns: listColumns }
  const lists: RulesList[] = parts.map((x, i) => {
    const spec: ListSpec = {
      id: x.group?.id ?? MAIN_LIST,
      items: itemsOf(x.rows, cols, current?.key ?? null, menu),
      rows: Math.max(1, windows[i]!),
      columns: cols.kept.map(k => ({ drop: COLUMN_DROP[k]! })),
    }
    return { spec, place: listPlace(spec, listCtx), group: x.group }
  })
  const listsHeight = batchRows + lists.reduce((n, l) => n + l.place.height, 0)
  const detailHeight = detail ? detail.fixed + shown + (shown < want ? 1 : 0) : 0
  const height = top + (wide ? Math.max(listsHeight, detailHeight) : listsHeight + 1 + detailHeight)
  return { ...base, ...none, mode: 'lists', problems, batchLines, lists, detail, shown, height }
}

// --- What the render drew, for the presses and the wheel

/** A list or a window as last drawn: what a footer's press, [next]/[previous] and a wheel tick move. */
type Scroller = { id: string; keys: string[]; count: number; budget: number; max: number }
type RulesDrawn = { rows: string[]; current: string | null; scrollers: Scroller[]; wheel: string | null }

let drawnRules: RulesDrawn | null = null

/** The last drawing's lists and windows, or null before one (tier 1 reads it too). */
export const lastRulesDrawn = (): RulesDrawn | null => drawnRules

export function resetRulesDrawnForTests(): void {
  drawnRules = null
}

/** Notes what the layout drew. Changes nothing drawn: a drawing stays a function of the view and the context. */
function noteRules(view: RulesPaneView, layout: RulesLayout): void {
  const scrollers: Scroller[] = layout.lists.map(l => ({ id: l.spec.id, keys: l.spec.items.map(i => i.key), count: l.place.count, budget: l.place.budget, max: l.place.window.max }))
  if (layout.window) scrollers.push({ id: layout.window.id, keys: [], count: layout.window.count, budget: layout.window.budget, max: layout.window.window.max })
  const holding = layout.current ? layout.lists.find(l => l.spec.items.some(i => i.key === rowKey(layout.current!.key))) : undefined
  drawnRules = {
    rows: (view.body?.rows ?? []).map(r => r.key),
    current: layout.current?.key ?? null,
    scrollers,
    // The wheel moves the window that takes the body, else the list holding the picked row, else the first.
    wheel: layout.window?.id ?? holding?.spec.id ?? layout.lists[0]?.spec.id ?? null,
  }
}

// --- Drawing

/** Rules' body renderer (ui/pane.tsx calls it with the rulesPane atom under the hub's chrome). Pure but for its note (drawnRules). */
export function renderRulesPane(view: RulesPaneView | null, resolved: PaneElements, ctx: BodyContext): RenderElement {
  const el = tableFor(resolved, ctx.surface)
  const { Box } = el
  const body = view?.body
  if (!view || !body) return <Box flexDirection="column">{empty(el, 'nothing to show yet', { command: '/litter rules', does: 'opens the rules' })}</Box>
  // A view that isn't one: the pane's catch passes the render on.
  if (!Array.isArray(body.rows)) throw new Error("the rules view's body has no rows")
  const layout = rulesLayout(view, ctx)
  noteRules(view, layout)
  return (
    <Box flexDirection="column">
      {body.notice ? notice(el, body.notice.level, body.notice.text) : null}
      {tabsPart(el, view, body, ctx.bodyColumns)}
      <Box flexDirection="column" marginTop={1}>
        {layout.mode === 'preview'
          ? previewPart(el, body, layout)
          : layout.mode === 'problems'
            ? problemsWindow(el, body, layout)
            : layout.mode === 'more'
              ? detailPart(el, body, layout, ctx)
              : layout.mode === 'empty'
                ? [problemsPart(el, layout), emptyPart(el, view)]
                : [problemsPart(el, layout), listsAndDetail(el, view, body, layout, ctx)]}
      </Box>
    </Box>
  )
}

function spanLine(el: PaneElements, line: readonly SwarmSpan[]): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexDirection="row">
      {line.map(s => (
        <Text color={s.color ?? (s.dim ? STYLE.muted : undefined)} bold={s.bold} wrap="truncate-end">
          {s.text}
        </Text>
      ))}
    </Box>
  )
}

/** The tabs, a strip of their own (the hub's strip style): the shown one bold with `›` in its mark's color, the other a plain Button, each with its count; a faint rule to the end. */
function tabsPart(el: PaneElements, view: RulesPaneView, body: RulesBody, columns: number): RenderElement {
  const { Box, Button, Text } = el
  const tabs = tabsOf(body)
  const used = tabs.reduce((n, t) => n + cells(tabText(t)) + (t.tab === view.tab ? 2 : 0), 0) + TAB_GAP * tabs.length
  const rule = finite(columns) ? Math.floor(columns) - used : 0
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={TAB_GAP}>
      {tabs.map(t =>
        t.tab === view.tab ? (
          <Text bold color={t.mark.color}>{`${SELECTED_MARK} ${tabText(t)}`}</Text>
        ) : (
          <Button key={`rules:tab:${t.tab}`} label={tabText(t)} plain onPress={noop} />
        ),
      )}
      {rule >= 3 ? <Text color={STYLE.faint}>{'─'.repeat(rule)}</Text> : null}
    </Box>
  )
}

/** The problems above the lists, warnings each on one line, then "N more problems" with its [More]. */
function problemsPart(el: PaneElements, layout: RulesLayout): RenderElement | null {
  const { Box } = el
  const p = layout.problems
  if (p.shown.length === 0 && p.more === 0) return null
  return (
    <Box flexDirection="column">
      {p.shown.map(x => notice(el, 'warning', x))}
      {p.more > 0 ? (
        <Box flexDirection="row" columnGap={1}>
          {notice(el, 'warning', `${p.more} more problem${p.more === 1 ? '' : 's'}`)}
          {action(el, { key: 'rules:more:problems', label: 'More' })}
        </Box>
      ) : null}
    </Box>
  )
}

function emptyPart(el: PaneElements, view: RulesPaneView): RenderElement {
  const { Box, Text } = el
  if (view.tab === 'proposed') return empty(el, 'nothing proposed', { command: '/litter:rules add', does: 'drafts a rule' })
  return (
    <Box flexDirection="column">
      <Text color={STYLE.muted} wrap="truncate-end">
        a rule is in force once you accept its proposal under Proposed
      </Text>
      {empty(el, 'nothing in force yet', { command: '/litter:rules add', does: 'drafts a proposal' })}
    </Box>
  )
}

/** [↑ n above] [↓ n more] under a window: plain Buttons keyed `<id>:up` and `<id>:down`, as a list's footer. */
function windowFooter(el: PaneElements, w: RulesWindow): RenderElement | null {
  const { Box, Button } = el
  const { above, below } = w.window
  if (above === 0 && below === 0) return null
  return (
    <Box flexDirection="row" columnGap={2} paddingLeft={2}>
      {above > 0 ? <Button key={`${w.id}:up`} label={`↑ ${above} above`} plain dimColor onPress={noop} /> : null}
      {below > 0 ? <Button key={`${w.id}:down`} label={`↓ ${below} more`} plain dimColor onPress={noop} /> : null}
    </Box>
  )
}

const windowed = (layout: RulesLayout): SwarmSpan[][] => (layout.window ? layout.lines.slice(layout.window.window.start, layout.window.window.end) : layout.lines)

/** The file [Confirm accept] writes, taking the body: its heading and path, what it does, [Confirm accept] and [Cancel], then the file, windowed. */
function previewPart(el: PaneElements, body: RulesBody, layout: RulesLayout): RenderElement {
  const { Box, Code, Text } = el
  const p = body.pending as Extract<RulesBody['pending'], { kind: 'preview' }>
  const many = p.key.startsWith('batch:')
  return (
    <Box flexDirection="column">
      {heading(el, many ? 'The files [Confirm accept] writes' : 'The file [Confirm accept] writes', layout.columns, { text: p.path, color: STYLE.path })}
      {layout.confirmLines.map(l => spanLine(el, l))}
      {actions(el, [
        { key: `rules:confirm:${p.key}`, label: 'Confirm accept', primary: true },
        { key: `rules:cancel:${p.key}`, label: 'Cancel' },
      ])}
      {p.text === '' ? (
        <Text color={STYLE.muted}>(empty)</Text>
      ) : (
        <Code source={windowed(layout).map(l => l.map(s => s.text).join('')).join('\n')} language="markdown" />
      )}
      {layout.window ? windowFooter(el, layout.window) : null}
    </Box>
  )
}

/** Every problem, taking the body, windowed; [Back] returns to the lists. */
function problemsWindow(el: PaneElements, body: RulesBody, layout: RulesLayout): RenderElement {
  const { Box } = el
  const back = 'Back'
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        {heading(el, 'Problems', finite(layout.columns) ? layout.columns - cells(back) - 5 : layout.columns, `${body.problems.length}`)}
        {action(el, { key: 'rules:less', label: back })}
      </Box>
      {windowed(layout).map(l => spanLine(el, l))}
      {layout.window ? windowFooter(el, layout.window) : null}
    </Box>
  )
}

/** The lists (an import batch's by instance, then the rest) and the picked row's detail: side by side when wide, else stacked. */
function listsAndDetail(el: PaneElements, view: RulesPaneView, body: RulesBody, layout: RulesLayout, ctx: BodyContext): RenderElement {
  const { Box } = el
  const listCtx: BodyContext = { ...ctx, bodyColumns: layout.listColumns }
  const main = layout.lists.find(l => l.group === null)
  const left = layout.batch ? (
    <Box flexDirection="column">
      {batchPart(el, body, layout, listCtx)}
      {main ? heading(el, 'Other proposals', layout.listColumns) : null}
      {main ? list(el, main.spec, listCtx) : null}
    </Box>
  ) : main ? (
    list(el, main.spec, listCtx)
  ) : null
  const detail = layout.detail ? detailPart(el, body, layout, ctx) : null
  if (layout.wide) {
    return (
      <Box flexDirection="row" columnGap={2}>
        <Box flexDirection="column" width={layout.listColumns}>
          {left}
        </Box>
        <Box flexDirection="column" width={layout.detailColumns}>
          {detail}
        </Box>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {left}
      {detail ? (
        <Box flexDirection="column" marginTop={1}>
          {detail}
        </Box>
      ) : null}
    </Box>
  )
}

/** An import batch: its heading and how many are checked; each instance a heading (`✓ live` or `− archived`, its id, its date) with its goal muted and its rows; [Accept selected] and what it writes. */
function batchPart(el: PaneElements, body: RulesBody, layout: RulesLayout, listCtx: BodyContext): RenderElement {
  const { Box, Text } = el
  const b = layout.batch!
  const inBatch = body.rows.filter(r => r.checked !== undefined)
  const checked = inBatch.filter(r => r.checked).length
  const columns = layout.listColumns
  return (
    <Box flexDirection="column">
      {heading(el, 'Import from deepwork', columns, `${checked} of ${inBatch.length} checked`)}
      {layout.lists
        .filter(l => l.group !== null)
        .map(l => {
          const i = l.group!.instance
          return (
            <Box flexDirection="column">
              {heading(el, i ? `${i.archived ? `${MARK.stopped.glyph} archived` : `${MARK.done.glyph} live`} ${i.id}` : 'from no listed instance', columns, i?.date ?? null)}
              {i?.goal ? (
                <Text color={STYLE.muted} wrap="truncate-end">
                  {i.goal}
                </Text>
              ) : null}
              {list(el, l.spec, listCtx)}
            </Box>
          )
        })}
      {layout.batchLines.map(l => spanLine(el, l))}
      {actions(el, [{ key: `rules:accept-selected:${b.seq}`, label: 'Accept selected', primary: true }])}
    </Box>
  )
}

/**
 * The picked row's detail: its heading (`id@version`, which of how many,
 * [previous] [next]); its description, cut to its rows (or whole, windowed,
 * with [Less]); the scope pick; what [Accept] writes; the editor; its
 * actions, or the retire confirm; and, when the description was cut, how
 * much and [More].
 */
function detailPart(el: PaneElements, body: RulesBody, layout: RulesLayout, ctx: BodyContext): RenderElement {
  const { Box, Text } = el
  const d = layout.detail!
  const r = d.row
  const whole = layout.mode === 'more'
  const total = body.rows.length
  const pager: Action[] = whole || total < 2 ? [] : [
    { key: 'rules:prev', label: 'previous', ...(ctx.isFocused ? { hotkey: 'k' } : {}) },
    { key: 'rules:next', label: 'next', ...(ctx.isFocused ? { hotkey: 'j' } : {}) },
  ]
  const side = whole
    ? cells('Less') + 4
    : pager.reduce((n, a) => n + itemWidth({ kind: 'plain', label: a.label, ...(a.hotkey ? { hotkey: a.hotkey } : {}) }) + 1, 0)
  const headColumns = finite(d.width) ? Math.max(1, d.width - side - (side > 0 ? 1 : 0)) : d.width
  const cutAt = d.lines.length - layout.shown
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        {heading(el, d.name, headColumns, whole ? 'all of it' : `${layout.index + 1} of ${total}`)}
        {whole ? action(el, { key: 'rules:less', label: 'Less' }) : pagerPart(el, pager)}
      </Box>
      {whole ? windowed(layout).map(l => spanLine(el, l)) : d.lines.slice(0, layout.shown).map(l => spanLine(el, l))}
      {whole && layout.window ? windowFooter(el, layout.window) : null}
      {d.scopes ? scopePart(el, r, d.scopes) : null}
      {d.consequence.map(l => spanLine(el, l))}
      {d.editing ? editorPart(el, r, d.editing, ctx) : null}
      {d.retire ? (
        <Box flexDirection="column">
          {notice(el, 'warning', d.retire)}
          {actions(el, [
            { key: `rules:confirm-retire:${r.key}`, label: 'Confirm retire' },
            { key: `rules:cancel:${r.key}`, label: 'Cancel' },
          ])}
        </Box>
      ) : d.restore ? (
        <Box flexDirection="column">
          {notice(el, 'warning', d.restore)}
          {actions(el, [
            { key: `rules:confirm-restore:${r.key}`, label: 'Confirm restore' },
            { key: `rules:cancel:${r.key}`, label: 'Cancel' },
          ])}
        </Box>
      ) : d.actions.length > 0 ? (
        actions(el, d.actions)
      ) : null}
      {/* After the actions, so how tall the pane is never moves their places in the ring (rules.sh counts them). */}
      {!whole && cutAt > 0 ? (
        <Box flexDirection="row" columnGap={1}>
          <Text color={STYLE.muted} wrap="truncate-end">{`… ${cutAt} more line${cutAt === 1 ? '' : 's'} of its description`}</Text>
          {action(el, { key: `rules:more:${r.key}`, label: 'More' })}
        </Box>
      ) : null}
    </Box>
  )
}

/** [previous] [next]: plain Buttons, with k and j while the pane has the keys (a Client's rows are no Tab stop). */
function pagerPart(el: PaneElements, pager: readonly Action[]): RenderElement | null {
  const { Box, Button } = el
  if (pager.length === 0) return null
  return (
    <Box flexDirection="row" columnGap={1}>
      {pager.map(a => (
        <Button key={a.key} label={a.label} plain {...(a.hotkey ? { hotkey: a.hotkey } : {})} onPress={noop} />
      ))}
    </Box>
  )
}

/** The scope a new rule is accepted into, picked explicitly: the picked one bold with `›`, each other a plain Button (every surface). */
function scopePart(el: PaneElements, r: RulesRow, scopes: readonly string[]): RenderElement {
  const { Box, Button, Text } = el
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      <Text color={STYLE.muted}>{scopeWord(r)}</Text>
      {scopes.map(s =>
        s === r.scope ? (
          <Text bold>{`${SELECTED_MARK} ${s}`}</Text>
        ) : (
          <Button key={`rules:scope-${s}:${r.key}`} label={s} plain onPress={noop} />
        ),
      )}
    </Box>
  )
}

/** [Edit…]'s editor: Paths a field whose caption says what an empty one means (what a ban protects); Type a short Select (Buttons where there's none); [Done]. */
function editorPart(el: PaneElements, r: RulesRow, editing: NonNullable<RulesBody['editing']>, ctx: BodyContext): RenderElement {
  const { Box, Button, Text } = el
  const at = { surface: ctx.surface, isFocused: ctx.isFocused, focused: ctx.focused, columns: ctx.bodyColumns }
  const type =
    'Select' in el ? (
      <el.Select key={`rules:type:${r.key}`} label="Type" options={TYPES.map(t => ({ value: t, label: t }))} value={editing.type} onSelect={noop} />
    ) : (
      <Box flexDirection="row" columnGap={1}>
        <Text color={STYLE.muted}>type</Text>
        {TYPES.map(t => (t === editing.type ? <Text bold>{`${SELECTED_MARK} ${t}`}</Text> : <Button key={`rules:type-${t}:${r.key}`} label={t} plain onPress={noop} />))}
      </Box>
    )
  return (
    <Box flexDirection="column">
      {field(el, { key: `rules:paths:${r.key}`, label: 'Paths', value: editing.paths, placeholder: 'src/**, docs/*.md', submitLabel: 'Set' }, pathsCaption(editing.type), at)}
      <Box flexDirection="row" columnGap={1}>
        {type}
        {action(el, { key: `rules:edit-done:${r.key}`, label: 'Done' })}
      </Box>
      {editing.error ? (
        <Text color={STYLE.failed} wrap="wrap">
          {`✕ ${editing.error}`}
        </Text>
      ) : null}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// The events

type RulesKey = { action: string; arg: string }

const parseKey = (key: string): RulesKey | null => {
  if (!key.startsWith('rules:')) return null
  const [, action, ...rest] = key.split(':')
  return action ? { action, arg: rest.join(':') } : null
}

type Called<T> = { ok: true; value: T } | { ok: false; error: string }

/** Calls the store, logging the call (`rules pane: <what>`) before it's made, and its failure. */
async function call<T>(p: Ports, what: string, fn: () => Promise<T> | T): Promise<Called<T>> {
  p.log(`rules pane: ${what}`)
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    const error = errText(err)
    p.log(`rules pane: ${what} failed: ${error}`)
    return { ok: false, error }
  }
}

const say = (n: RulesNav, level: SwarmNotice['level'], text: string): void => setRulesNav({ ...n, notice: { level, text: oneLine(text, 400) } })

/** A row a press acts on: shown by the last build, with that action. Otherwise the press is stale, and says so. */
function rowFor(p: Ports, n: RulesNav, key: string, action: string): ShownRow | null {
  const row = n.shown[key]
  if (row && row.actions.includes(action)) return row
  p.toast("that rule isn't shown any more, so it was ignored")
  say(n, 'warning', "that rule isn't shown any more, so the press was ignored")
  return null
}

const whatOf = (row: ShownRow): AcceptWhat => (row.kind === 'proposal' ? { proposal: row.ref! } : { file: row.file! })

function optsOf(n: RulesNav, key: string, row: ShownRow, scope: RuleScope): AcceptOpts {
  const held = row.kind === 'proposal' ? (n.held[key] ?? {}) : {}
  return { scope, ...(held.paths ? { paths: held.paths } : {}), ...(held.type ? { type: held.type } : {}) }
}

/** The scope a row is accepted into: what you picked, else its own; null when there's none yet. */
const scopeOf = (n: RulesNav, key: string, row: ShownRow): RuleScope | null => (row.kind === 'proposal' ? (n.held[key]?.scope ?? row.scope) : row.scope)

/** What's left of a row's pane state once it's accepted or dismissed. */
function forget(n: RulesNav, key: string): RulesNav {
  const held = { ...n.held }
  delete held[key]
  return {
    ...n,
    held,
    checked: n.checked.filter(k => k !== key),
    pending: n.pending?.key === key ? null : n.pending,
    editing: n.editing?.key === key ? null : n.editing,
    selected: n.selected === key ? null : n.selected,
    more: n.more === key ? null : n.more,
  }
}

/** Where a written file is, as you'd commit it: relative to the primary checkout. */
const shownPath = (path: string | undefined, litterDir: string): string => relativePath(path, litterDir)

const nonInteractive = (n: RulesNav): boolean => {
  if (interactive() !== false) return false
  say(n, 'warning', "this session isn't interactive, so nothing can be accepted here (16.3)")
  return true
}

/**
 * After a step that changed what's in force: the Claude Code rule files
 * brought in line (16.7), as a phrase the step's notice ends with, '' when
 * nothing changed. Its failure never undoes the step.
 */
async function exportAfter(p: Ports, litterDir: string): Promise<string> {
  const r = await call(p, 'syncExports', () => deps.syncExports(p, litterDir))
  if (!r.ok) return `; the Claude Code rule files weren't brought in line (${oneLine(r.error, 160)})`
  const { written, removed, problems } = r.value
  const parts: string[] = []
  if (written.length > 0) parts.push(`wrote ${written.map(x => shownPath(x, litterDir)).join(', ')}`)
  if (removed.length > 0) parts.push(`removed ${removed.map(x => shownPath(x, litterDir)).join(', ')}`)
  if (problems.length > 0) parts.push(`${problems.length === 1 ? 'a problem' : `${problems.length} problems`}: ${oneLine(problems[0], 160)}`)
  return parts.length > 0 ? `; Claude Code rule files: ${parts.join('; ')}` : ''
}

/** One acceptance, after its scope is known (and, for project scope, its file seen). */
async function acceptOne(p: Ports, litterDir: string, key: string, row: ShownRow, scope: RuleScope): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const n = rulesNavOf()!
  const r = await call(p, `acceptRule ${key} ${scope}`, () => deps.acceptRule(p, litterDir, whatOf(row), optsOf(n, key, row, scope)))
  if (!r.ok) return { ok: false, reason: r.error }
  if (!r.value.ok) return { ok: false, reason: r.value.reason }
  const where = shownPath(r.value.path, litterDir)
  return { ok: true, text: scope === 'project' ? `commit ${where || 'the rule file'} yourself` : `written to ${where || `the ${scope} rules`}` }
}

async function accept(p: Ports, litterDir: string, n: RulesNav, key: string): Promise<void> {
  const row = rowFor(p, n, key, 'accept')
  if (!row || nonInteractive(n)) return
  const scope = scopeOf(n, key, row)
  if (!scope) {
    p.log(`rules pane: asks the scope for ${key}`)
    setRulesNav({
      ...n,
      pending: { kind: 'scope', key },
      notice: { level: 'info', text: 'pick the scope to accept it into: user (every project, for you), project (this repository, which you commit) or local (this repository, for you)' },
    })
    return
  }
  if (scope === 'project') {
    const r = await call(p, `previewAccept ${key} project`, () => deps.previewAccept(p, litterDir, whatOf(row), optsOf(n, key, row, scope)))
    if (!r.ok) return say(n, 'error', `the file couldn't be previewed: ${r.error}`)
    if (!r.value.ok) return say(n, 'error', r.value.reason)
    setRulesNav({
      ...n,
      pending: { kind: 'preview', key, path: r.value.path, text: clean(r.value.text, PREVIEW_MAX) },
      notice: { level: 'info', text: 'this is the exact file [Confirm accept] writes, for you to commit' },
    })
    return
  }
  const done = await acceptOne(p, litterDir, key, row, scope)
  if (!done.ok) return say(n, 'error', `not accepted: ${done.reason}`)
  setRulesNav({ ...forget(n, key), notice: { level: 'ok', text: `accepted into ${scope} scope: ${done.text}${await exportAfter(p, litterDir)}` } })
}

async function confirmAccept(p: Ports, litterDir: string, n: RulesNav, key: string): Promise<void> {
  if (n.pending?.kind !== 'preview' || n.pending.key !== key) {
    p.toast('there was no file waiting to be confirmed, so that was ignored')
    return say(n, 'warning', 'there was no file waiting to be confirmed, so the press was ignored')
  }
  if (nonInteractive(n)) return
  if (key.startsWith('batch:')) return acceptBatch(p, litterDir, n, Number(key.slice('batch:'.length)), true)
  const row = rowFor(p, n, key, 'accept')
  if (!row) return
  const scope = scopeOf(n, key, row)
  if (scope !== 'project') return say(n, 'warning', 'its scope changed since the preview, so nothing was written: press [Accept] again')
  const done = await acceptOne(p, litterDir, key, row, scope)
  if (!done.ok) return say(n, 'error', `not accepted: ${done.reason}`)
  setRulesNav({ ...forget(n, key), notice: { level: 'ok', text: `accepted: ${done.text}${await exportAfter(p, litterDir)}` } })
}

/** The checked rows of a batch, in the order shown; an import's scope is project unless you picked another (16.8). */
function checkedOf(n: RulesNav, seq: number): { key: string; row: ShownRow; scope: RuleScope }[] {
  return n.checked.flatMap(key => {
    const row = n.shown[key]
    if (!row || row.kind !== 'proposal' || row.batch !== seq || !row.actions.includes('accept')) return []
    return [{ key, row, scope: scopeOf(n, key, row) ?? 'project' }]
  })
}

/**
 * [Accept selected]: the checked ones, one by one, each failure reported. A
 * project one's file is shown first (all of them in one preview), and
 * [Confirm accept] writes them.
 */
async function acceptBatch(p: Ports, litterDir: string, n: RulesNav, seq: number, confirmed: boolean): Promise<void> {
  if (n.batch !== seq) {
    p.toast("that import batch isn't shown any more, so it was ignored")
    return say(n, 'warning', "that import batch isn't shown any more, so the press was ignored")
  }
  if (nonInteractive(n)) return
  const picked = checkedOf(n, seq)
  if (picked.length === 0) return say(n, 'info', 'nothing is checked')
  const project = picked.filter(x => x.scope === 'project')
  if (project.length > 0 && !confirmed) {
    const files: string[] = []
    const failed: string[] = []
    for (const x of project) {
      const r = await call(p, `previewAccept ${x.key} project`, () => deps.previewAccept(p, litterDir, whatOf(x.row), optsOf(n, x.key, x.row, 'project')))
      if (!r.ok) failed.push(`${x.key}: ${r.error}`)
      else if (!r.value.ok) failed.push(`${x.key}: ${r.value.reason}`)
      else files.push(`--- ${shownPath(r.value.path, litterDir)}\n${r.value.text}`)
    }
    if (failed.length > 0) return say(n, 'error', `nothing was accepted; these couldn't be previewed: ${failed.join('; ')}`)
    const primary = primaryOf(litterDir)
    setRulesNav({
      ...n,
      pending: { kind: 'preview', key: batchKey(seq), path: primary ? `${primary}/.litter/rules/` : 'the project rules', text: clean(files.join('\n\n'), PREVIEW_MAX) },
      notice: { level: 'info', text: `${project.length} project file${project.length === 1 ? '' : 's'} for you to commit: [Confirm accept] writes them and accepts the ${picked.length} checked` },
    })
    return
  }
  let next = n
  const done: string[] = []
  const failed: string[] = []
  for (const x of picked) {
    const r = await acceptOne(p, litterDir, x.key, x.row, x.scope)
    if (r.ok) {
      done.push(x.key)
      next = forget(next, x.key)
    } else failed.push(`${x.key}: ${r.reason}`)
  }
  next = { ...next, pending: null }
  const commit = project.length > 0 && done.some(k => project.some(x => x.key === k)) ? '; commit the new .litter/rules/ files yourself' : ''
  const exported = done.length > 0 ? await exportAfter(p, litterDir) : ''
  const text =
    failed.length === 0 ? `accepted ${done.length} of ${picked.length}${commit}${exported}` : `accepted ${done.length} of ${picked.length}${commit}; not accepted: ${failed.join('; ')}${exported}`
  setRulesNav({ ...next, notice: { level: failed.length === 0 ? 'ok' : done.length === 0 ? 'error' : 'warning', text: oneLine(text, 400) } })
}

async function dismiss(p: Ports, litterDir: string, n: RulesNav, key: string): Promise<void> {
  const row = rowFor(p, n, key, 'dismiss')
  if (!row || !row.ref) return
  const r = await call(p, `dismissRule ${key}`, () => deps.dismissRule(p, litterDir, row.ref!))
  if (!r.ok) return say(n, 'error', `not dismissed: ${r.error}`)
  if (!r.value.ok) return say(n, 'error', `not dismissed: ${r.value.reason}`)
  setRulesNav({ ...forget(n, key), notice: { level: 'ok', text: 'dismissed: the same text, proposed again, comes back dismissed' } })
}

async function retire(p: Ports, litterDir: string, n: RulesNav, key: string, confirmed: boolean): Promise<void> {
  const row = rowFor(p, n, key, 'retire')
  if (!row || row.id === null || row.version === null) return
  if (!confirmed) {
    setRulesNav({ ...n, pending: { kind: 'retire', key }, notice: { level: 'info', text: `press [Confirm retire] to retire ${row.id}@${row.version}` } })
    return
  }
  if (n.pending?.kind !== 'retire' || n.pending.key !== key) {
    p.toast('there was no retire waiting to be confirmed, so that was ignored')
    return say(n, 'warning', 'there was no retire waiting to be confirmed, so the press was ignored')
  }
  const r = await call(p, `retireRule ${row.id}@${row.version}`, () => deps.retireRule(p, litterDir, { id: row.id!, version: row.version! }))
  if (!r.ok) return say(n, 'error', `not retired: ${r.error}`)
  if (!r.value.ok) return say(n, 'error', `not retired: ${r.value.reason}`)
  const where = row.scope === 'project' ? '; commit the removal yourself' : ''
  setRulesNav({ ...forget(n, key), notice: { level: 'ok', text: `retired ${row.id}@${row.version}${where}${await exportAfter(p, litterDir)}` } })
}

/**
 * [Adopt edit]: a hand edit of a rule's Claude Code rule file, proposed as
 * the rule's next version (export.ts's adoptExport). It accepts nothing: the
 * Proposed tab opens on the proposal, with its diff, for you to accept.
 */
async function adopt(p: Ports, litterDir: string, n: RulesNav, key: string): Promise<void> {
  const row = rowFor(p, n, key, 'adopt')
  if (!row || row.id === null || row.version === null) return
  const r = await call(p, `adoptExport ${row.id}@${row.version}`, () => deps.adoptExport(p, litterDir, { id: row.id!, version: row.version! }))
  if (!r.ok) return say(n, 'error', `not adopted: ${r.error}`)
  if (!r.value.ok) return say(n, 'error', `not adopted: ${r.value.reason}`)
  const ref = r.value.proposal
  setRulesNav({
    ...n,
    tab: 'proposed',
    focus: { proposal: ref },
    selected: `${ref.store}:${ref.seq}`,
    pending: null,
    editing: null,
    more: null,
    notice: { level: 'ok', text: `the edit is proposed as ${row.id}@${row.version + 1}: accept it here, and the rule file becomes litter's copy of that version` },
  })
  for (const s of drawnRules?.scrollers ?? []) await moveList(p, s.id, 0, 0)
}

/**
 * [Restore file]: litter's copy of a rule's Claude Code rule file written
 * again (export.ts's restoreExport). Over a hand edit it asks for [Confirm
 * restore] first, and the edit is kept; a deleted file is written at once.
 */
async function restore(p: Ports, litterDir: string, n: RulesNav, key: string, confirmed: boolean): Promise<void> {
  const row = rowFor(p, n, key, 'restore')
  if (!row || row.id === null || row.version === null) return
  if (row.export === 'edited' && !confirmed) {
    setRulesNav({ ...n, pending: { kind: 'restore', key }, notice: { level: 'info', text: `press [Confirm restore] to put litter's copy of ${row.id}@${row.version}'s rule file back` } })
    return
  }
  if (confirmed && (n.pending?.kind !== 'restore' || n.pending.key !== key)) {
    p.toast('there was no restore waiting to be confirmed, so that was ignored')
    return say(n, 'warning', 'there was no restore waiting to be confirmed, so the press was ignored')
  }
  const r = await call(p, `restoreExport ${row.id}@${row.version}`, () => deps.restoreExport(p, litterDir, { id: row.id!, version: row.version! }))
  if (!r.ok) return say(n, 'error', `not restored: ${r.error}`)
  if (!r.value.ok) return say(n, 'error', `not restored: ${r.value.reason}`)
  const commit = row.scope === 'project' ? ', for you to commit' : ''
  const kept = r.value.kept ? `; your edit is kept at ${shownPath(r.value.kept, litterDir)}` : ''
  setRulesNav({ ...n, pending: null, notice: { level: 'ok', text: `restored ${shownPath(r.value.path, litterDir)}${commit}${kept}` } })
}

/** [Edit…]: a proposal's paths and type in the pane; an accepted rule's text through the skill, which drafts the edit as a proposal. */
async function edit(p: Ports, n: RulesNav, key: string): Promise<void> {
  const row = rowFor(p, n, key, 'edit')
  if (!row) return
  if (row.kind === 'proposal') {
    const held = n.held[key] ?? {}
    setRulesNav({
      ...n,
      editing: { key, paths: (held.paths ?? row.paths).join(', '), type: held.type ?? row.type, error: null },
      pending: n.pending?.key === key ? null : n.pending,
      notice: null,
    })
    return
  }
  if (row.id === null || !RULE_ID.test(row.id)) return say(n, 'warning', "that rule's id can't be put in a command")
  const text = `/litter:rules show ${row.id}`
  const r = await call(p, `fills the prompt with ${text}`, () => p.fillPrompt(text))
  if (r.ok && r.value) return say(n, 'ok', `the prompt holds ${text}: send it, and the skill drafts your edit as a proposal to accept here`)
  say(n, 'warning', `the prompt couldn't take it now (a dialog is open, or nobody is at the prompt): type ${text}`)
}

/** A scope picked for a proposal (a Select, or a button where there's none). Never accepts: [Accept] does. */
function pickScope(p: Ports, n: RulesNav, key: string, value: string): void {
  const row = n.shown[key]
  if (!row || row.kind !== 'proposal' || !(SCOPES as readonly string[]).includes(value)) return
  const scope = value as RuleScope
  setRulesNav({
    ...n,
    held: { ...n.held, [key]: { ...(n.held[key] ?? {}), scope } },
    pending: n.pending?.key === key ? null : n.pending,
    notice: { level: 'info', text: scope === 'project' ? 'scope project: [Accept] shows the file first' : `scope ${scope}: press [Accept]` },
  })
}

/** A type picked in [Edit…]'s editor (the Select, or a button where there's none), held until [Accept]. */
function pickType(n: RulesNav, key: string, value: string): boolean {
  const row = n.shown[key]
  if (!row || row.kind !== 'proposal' || !(TYPES as readonly string[]).includes(value)) return false
  const type = value as RuleType
  setRulesNav({
    ...n,
    held: { ...n.held, [key]: { ...(n.held[key] ?? {}), type } },
    editing: n.editing?.key === key ? { ...n.editing, type } : n.editing,
    pending: n.pending?.key === key ? null : n.pending,
  })
  return true
}

/** The last drawing's list or window `id` moved by `by` rows, clamped (the hub keeps the offset); false when there's none or it didn't move. */
async function moveBy(p: Ports, id: string, by: number): Promise<boolean> {
  const s = drawnRules?.scrollers.find(x => x.id === id)
  if (!s) return false
  return moveList(p, id, scrolled(s.count, listOffset(id), s.budget, by), s.max)
}

/** A list's window moved so its row `key` is in it (after [next] or [previous]). */
async function bringIntoView(p: Ports, key: string): Promise<void> {
  const s = drawnRules?.scrollers.find(x => x.keys.includes(rowKey(key)))
  if (!s) return
  const i = s.keys.indexOf(rowKey(key))
  const w = listWindow(s.count, listOffset(s.id), s.budget)
  if (i < w.start) await moveList(p, s.id, i, s.max)
  else if (i >= w.end) await moveList(p, s.id, i - s.budget + 1, s.max)
}

/**
 * The presses that move what's shown and act on nothing (WP-DE): a row
 * picked (its click, Enter, a menu's row), [next] and [previous], [More] and
 * [Less], and the footers of the lists and windows. They keep the last
 * action's notice. Answers whether the key was one of them.
 */
async function navigate(p: Ports, n: RulesNav, k: RulesKey): Promise<boolean> {
  const page = (id: string, dir: string) => {
    const s = drawnRules?.scrollers.find(x => x.id === id)
    return s ? moveBy(p, id, (dir === 'up' ? -1 : 1) * pageOf(s.budget)) : Promise.resolve(false)
  }
  const pick = (key: string): RulesNav => ({
    ...n,
    selected: key,
    // A step waiting on another row (a scope to pick, a retire to confirm) is dropped; its held edits stay.
    pending: n.pending && n.pending.kind !== 'preview' && n.pending.key !== key ? null : n.pending,
  })
  switch (k.action) {
    case 'list':
    case 'window': {
      const at = k.arg.lastIndexOf(':')
      if (at > 0) await page(`rules:${k.action}:${k.arg.slice(0, at)}`, k.arg.slice(at + 1))
      return true
    }
    case 'row':
      if (!n.shown[k.arg]) {
        p.toast("that rule isn't shown any more, so it was ignored")
        return true
      }
      setRulesNav(pick(k.arg))
      break
    case 'next':
    case 'prev': {
      const d = drawnRules
      if (!d || d.rows.length === 0) return true
      const at = Math.max(0, d.current ? d.rows.indexOf(d.current) : 0)
      const to = d.rows[Math.min(d.rows.length - 1, Math.max(0, at + (k.action === 'next' ? 1 : -1)))]!
      if (to === d.current) return true
      setRulesNav(pick(to))
      await bringIntoView(p, to)
      break
    }
    case 'more':
      if (k.arg === 'problems') setRulesNav({ ...n, more: 'problems' })
      else if (n.shown[k.arg]) setRulesNav({ ...pick(k.arg), more: k.arg })
      else return true
      await moveList(p, k.arg === 'problems' ? PROBLEMS_WINDOW : DETAIL_WINDOW, 0, 0)
      break
    case 'less':
      setRulesNav({ ...n, more: null })
      break
    default:
      return false
  }
  await drawRules(p)
  return true
}

/** One press: the stale check, the action, then the redraw. The only path to acceptRule, dismissRule and retireRule. A step. */
export function pressRules(p: Ports, key: string): Promise<void> {
  return inTurn(() => pressNow(p, key))
}

async function pressNow(p: Ports, key: string): Promise<void> {
  const k = parseKey(key)
  if (!k) return
  await restoreRulesNav(p)
  const cur = rulesNavOf()
  const litterDir = session().litterDir
  if (!cur || !litterDir) {
    p.toast('the rules pane was closed, so that was ignored')
    return
  }
  try {
    if (await navigate(p, cur, k)) return
  } catch (err) {
    p.log(`rules pane: ${key} failed: ${errText(err)}`)
    return
  }
  // A new action's outcome replaces the last one's; an action on a row picks it.
  const n: RulesNav = { ...cur, notice: null, ...(cur.shown[k.arg] ? { selected: k.arg } : {}) }
  setRulesNav(n)
  const waited = cur.pending
  try {
    switch (k.action) {
      case 'tab':
        if ((TABS as readonly string[]).includes(k.arg) && k.arg !== n.tab) {
          setRulesNav({ ...n, tab: k.arg as RulesTab, pending: null, editing: null, selected: null, more: null })
          for (const s of drawnRules?.scrollers ?? []) await moveList(p, s.id, 0, 0)
        }
        break
      case 'accept':
        await accept(p, litterDir, n, k.arg)
        break
      case 'confirm':
        await confirmAccept(p, litterDir, n, k.arg)
        break
      case 'cancel':
        setRulesNav({ ...n, pending: null })
        break
      case 'edit':
        await edit(p, n, k.arg)
        break
      case 'edit-done':
        setRulesNav({ ...n, editing: null })
        break
      case 'dismiss':
        await dismiss(p, litterDir, n, k.arg)
        break
      case 'retire':
        await retire(p, litterDir, n, k.arg, false)
        break
      case 'confirm-retire':
        await retire(p, litterDir, n, k.arg, true)
        break
      case 'adopt':
        await adopt(p, litterDir, n, k.arg)
        break
      case 'restore':
        await restore(p, litterDir, n, k.arg, false)
        break
      case 'confirm-restore':
        await restore(p, litterDir, n, k.arg, true)
        break
      case 'check': {
        const row = n.shown[k.arg]
        if (!row || row.batch === null) break
        const checked = n.checked.includes(k.arg) ? n.checked.filter(x => x !== k.arg) : [...n.checked, k.arg]
        // A change of what's checked drops a preview of the old set.
        setRulesNav({ ...n, checked, pending: n.pending?.key.startsWith('batch:') ? null : n.pending })
        break
      }
      case 'accept-selected':
        await acceptBatch(p, litterDir, n, Number(k.arg), false)
        break
      default:
        if (k.action.startsWith('scope-')) pickScope(p, n, k.arg, k.action.slice('scope-'.length))
        else if (k.action.startsWith('type-')) pickType(n, k.arg, k.action.slice('type-'.length))
    }
  } catch (err) {
    p.log(`rules pane: ${key} failed: ${errText(err)}`)
    say(rulesNavOf() ?? n, 'error', `that failed: ${errText(err)}`)
  }
  // A preview opened, closed or replaced starts at the file's top.
  if (rulesNavOf()?.pending !== waited) await moveList(p, PREVIEW_WINDOW, 0, 0).catch(() => false)
  await drawRules(p)
}

/** A field: the paths [Edit…] holds for a proposal, checked by AD's narrowPaths on Enter. A step. */
function inputRules(p: Ports, key: string, value: string, kind: 'change' | 'submit' | undefined): Promise<void> {
  return inTurn(() => inputNow(p, key, value, kind))
}

async function inputNow(p: Ports, key: string, value: string, kind: 'change' | 'submit' | undefined): Promise<void> {
  const k = parseKey(key)
  if (!k || k.action !== 'paths') return
  await restoreRulesNav(p)
  const n = rulesNavOf()
  if (!n || n.editing?.key !== k.arg) return
  // Typing is kept without a redraw: a redraw hands the field its text again, and a keystroke in flight would be lost.
  if (kind === 'change') {
    n.editing = { ...n.editing, paths: value }
    return
  }
  const paths = value
    .split(/[,\n]/)
    .map(s => s.trim())
    .filter(s => s !== '')
  const r = await call(p, `narrowPaths ${k.arg} (${paths.length})`, () => deps.narrowPaths(paths))
  if (!r.ok || !r.value.ok) {
    const reason = !r.ok ? r.error : !r.value.ok ? r.value.reason : ''
    setRulesNav({ ...n, editing: { ...n.editing, paths: value, error: oneLine(reason, 300) } })
  } else {
    const narrowed = r.value.paths
    setRulesNav({
      ...n,
      held: { ...n.held, [k.arg]: { ...(n.held[k.arg] ?? {}), paths: narrowed } },
      editing: { ...n.editing, paths: narrowed.join(', '), error: null },
      pending: n.pending?.key === k.arg ? null : n.pending,
      notice: { level: 'info', text: narrowed.length > 0 ? 'paths kept here until you accept it' : `${NO_PATHS}, kept until you accept it` },
    })
  }
  await drawRules(p)
}

/** A pick: a proposal's scope, or the type [Edit…] holds. Never accepts. A step. */
function selectRules(p: Ports, key: string, value: string): Promise<void> {
  return inTurn(async () => {
    const k = parseKey(key)
    if (!k) return
    await restoreRulesNav(p)
    const n = rulesNavOf()
    if (!n) return
    if (k.action === 'scope') pickScope(p, n, k.arg, value)
    else if (k.action !== 'type' || !pickType(n, k.arg, value)) return
    await drawRules(p)
  })
}

/**
 * ui.scroll while Rules is shown: the body fits, so a wheel tick moves one
 * window (the one that takes the body, else the list holding the picked row,
 * else the first list) and answers `{}`; at the window's edge, or with no
 * window drawn, it passes on (WP-DA2's rule for a body that fits: no hit
 * test). The hub routes it here once its rules entry has `scroll` (WP-DE's
 * report).
 */
const scrollRules: PortHook<UiScrollHook> = async (p, e, next) => {
  const id = drawnRules?.wheel
  if (!id || e.by === 0) return next(e)
  return (await moveBy(p, id, e.by)) ? {} : next(e)
}

/** The rules pane's ui.message, ui.press, ui.input, ui.select and ui.scroll; anything not keyed `rules:` passes on. Each action refreshes the view. */
export const onRulesUi: PaneUiHandlers = {
  // The lists' Clients post to the hub, which presses their keys here (ui/hub.ts, listPost): nothing reaches this.
  message: async (p, e, next) => next(e),
  scroll: (p, e, next) => scrollRules(p, e, next),
  press: async (p, e, next) => {
    if (!parseKey(e.element)) return next(e)
    await pressRules(p, e.element)
    return { element: e.element }
  },
  input: async (p, e, next) => {
    if (!parseKey(e.element)) return next(e)
    await inputRules(p, e.element, e.value, e.kind)
    return { element: e.element, value: e.value }
  },
  select: async (p, e, next) => {
    if (!parseKey(e.element)) return next(e)
    await selectRules(p, e.element, e.value)
    return { element: e.element, value: e.value }
  },
}
