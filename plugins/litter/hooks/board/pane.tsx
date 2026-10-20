// `/litter runs` and the board, the `litter` pane's Runs section (phase 3;
// plan section 11, decision 21; phase 5b, WP-DA): a run drawn from its
// ledger, rebuilt by the ui tick while Runs is shown, its keys
// `board:<action>[:<arg>]`. Owner: phase 3, package AF.
//
// The render is a pure body renderer of the view in $.state (view.ts builds
// it), drawn under the hub's chrome (ui/pane.tsx). The gate table is the
// Client module gates.tsx where the surface has one, whose ↑↓ and Enter post
// `{ run, action: 'select', gate }` (a ui.message here), and a static table
// of buttons elsewhere. [Plan] and [Diff G<n>] open a section in the board;
// [Rules] shows the Rules section. The table's right-click menu (phase 5,
// package CD; COMMON decision 9) posts `replay`, `note` or `copy` for its
// row; on a surface with no Client the selected gate's actions are buttons
// under the table. A design run gets its bar × version matrix (decision 10)
// above its records.
//
// Phase 5b (WP-DC), the body in the hub's order: an exception (a refusal, a
// tampered ledger, an unreadable run.json) above everything; the run's first
// lines (its status, workflow and run with a faint rule, then its
// generation and branch, then a muted line of its base, checkout and times);
// what needs you, and what runs on its own; the gate table, with the selected
// gate's detail beside it from WIDE_COLUMNS and under it below, its actions
// as Buttons there on every surface (the menu is a shortcut); the run's
// material ([Plan], [Diff], [Rules]) and the section it opened; then the
// evidence, muted: the records, the rules used and proposed. The table stays
// gates.tsx's Client, its rows laid out here (gateLayout) to read as the
// chrome's list does: ui/list.tsx's Client draws a row as one uncolored text,
// its label the column that absorbs the width, and posts no run, so a gate's
// colored state, its title taking what's left, and the stale-run check would
// all be lost on it.

import type { RenderElement } from 'claude-code'
import type { Ports } from '../ports'
import type { CommandRunHook, PaneElements, PaneUiHandlers, PortHook } from '../hooktypes'
import type { Action, BodyContext, Cell, Column, KeyHint, SectionMeta } from '../ui/chrome'
import type { Loaded } from '../ui/hub'
import type {
  BoardAttention,
  BoardDesign,
  BoardEmpty,
  BoardGateAction,
  BoardGateDetail,
  BoardGateLayout,
  BoardGateRow,
  BoardGatesProps,
  BoardHeader,
  BoardProposalRow,
  BoardRecordRow,
  BoardRuleRow,
  BoardSection,
  BoardView,
  SwarmNotice,
  SwarmSpan,
} from '../../types/index'
import { RUN_ID } from '../layout'
import { session } from '../session'
import { tableFor } from '../swarm/builder'
import { oneLine, unprefixed } from '../swarm/view'
import { cells, fitSpans } from '../band/view'
import { MIN_RULE, RULE, WIDE_COLUMNS, actions, empty, fitCell, heading, notice, pairs, planColumns } from '../ui/chrome'
import { MARK, SELECTED_MARK, STYLE } from '../ui/style'
import { openSection } from '../ui/hub'
import { DIM_NAME, DIM_WORD, OID, blankBoardNav, boardNavRev, buildBoard, failingWords, navOf, restoreBoardNav, saveBoardNav, setBoardNav } from './view'
import { refreshRulesPane } from '../rules/pane'

/** The gate table Client's key: `e.element` of its ui.message. */
export const GATES_KEY = 'board-gates'

const GATE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// ---------------------------------------------------------------------------
// The command, and drawing

/** The view last written to $.state, by `v`: a build that answers the same view writes nothing. */
let written = -1
let savedRev = -1

/**
 * Builds the view for the navigation's run and writes it when it's new (or
 * always, with `force`: $.state was wiped). The run the build resolved is
 * kept, so the tick rebuilds that run and not whatever is newest by then.
 */
async function drawBoard(p: Ports, litterDir: string, force = false): Promise<BoardView | null> {
  const n = navOf()
  if (!n) return null
  const view = await buildBoard(p, litterDir, n.run ?? n.arg)
  if (view.run !== null && view.run !== n.run) {
    // Not a navigation change (the view was built for this run already), but saved, so a reload keeps the run.
    n.run = view.run
    savedRev = -1
  }
  if (force || view.v !== written) {
    await p.setView('board', view)
    written = view.v
  }
  if (savedRev !== boardNavRev()) {
    savedRev = boardNavRev()
    await saveBoardNav(p)
  }
  return view
}

/**
 * `/litter runs [run | execute | design]` (ui/hub.ts's litterCommand hands
 * it the argument): shows Runs, loaded for it, in the `litter` pane.
 */
export const boardCommand: PortHook<CommandRunHook> = async (p, e, next) => ({ text: (await openSection(p, 'runs', (e.args ?? '').trim(), { focus: true })).text })

/**
 * Runs' load (openSection): builds the view (view.ts, buildBoard) for the run
 * named, else the newest `execute` or `design` run, else the active one, else
 * the newest; writes it with `p.setView('board', …)`, and answers the reply's
 * line. The band's and the card's [Board] load it with the run's id.
 */
export async function loadBoard(p: Ports, args: string): Promise<Loaded> {
  await restoreBoardNav(p)
  const arg = args.trim().split(/\s+/)[0] || null
  const litterDir = session().litterDir
  setBoardNav(blankBoardNav(arg))
  if (!litterDir) {
    await drawNoDirectory(p)
    return { text: 'Runs has no litter directory to read' }
  }
  const view = await drawBoard(p, litterDir)
  const head = view?.body?.header
  // The notice can be the record tool's refusal, as the engine worded it (`litter: $.tool.register: …`).
  const what = view?.run && head ? `run ${view.run} (${head.workflow}, ${head.status.text})` : `nothing: ${unprefixed(view?.body?.notice?.text ?? view?.body?.empty?.what ?? 'no run')}`
  return { text: `Runs shows ${what}` }
}

/** Runs from the strip or Home: the run it showed, drawn again, else what `/litter runs` opens. */
export async function resumeBoard(p: Ports): Promise<void> {
  await restoreBoardNav(p)
  const litterDir = session().litterDir
  if (!navOf()) {
    await loadBoard(p, '')
    return
  }
  if (litterDir) await drawBoard(p, litterDir)
  else await drawNoDirectory(p)
}

/** The board when this session has no litter directory: why, and nothing else. */
async function drawNoDirectory(p: Ports): Promise<void> {
  const why = session().litterDirError
  const view: BoardView = {
    view: 'board',
    v: 0,
    run: null,
    body: {
      notice: { level: 'error', text: `this session has no litter directory${why ? `: ${oneLine(why, 240)}` : ''}` },
      header: null,
      attention: [],
      gates: null,
      detail: null,
      design: null,
      records: [],
      rules: [],
      proposals: [],
      section: null,
      buttons: [],
      empty: null,
      stamp: '',
    },
  }
  await p.setView('board', view)
  written = -1
}

// ---------------------------------------------------------------------------
// The render

/** The board's keys while it shows a gate table: the table's own, once a click gave it the keyboard (gates.tsx). */
export const BOARD_KEYS: readonly KeyHint[] = [
  { key: '↑↓', word: 'gates' },
  { key: 'enter', word: 'select' },
  { key: '→', word: 'actions' },
]

/**
 * Runs to the hub (chrome.tsx's SectionMeta). `fits` stays false: an opened
 * plan, diff or critic note is a Code block of up to 8000 characters and the
 * records run to 30 rows. Clipped at ctx.rows they'd have to be windowed, and
 * a window here could be moved only by its [More] Buttons, since hub.ts
 * routes no ui.scroll to Runs; drawn whole, the pane's own scroll reads them.
 */
export const runsSection: SectionMeta<BoardView> = { fits: false, keys: view => (view?.body?.gates ? BOARD_KEYS : []) }

/** Below this many body rows the board draws its short form, as it does inline: no context line, no evidence, the dimensions on one line. */
export const SHORT_ROWS = 16
/** The cells between the gate table and the detail beside it. */
export const SPLIT_GAP = 2
/** The detail's share of a wide body, and its bounds in cells: at 100 columns the table keeps 62, room for every column but the commit. */
const DETAIL_SHARE = 0.36
const DETAIL_MIN = 36
const DETAIL_MAX = 60
/** The gaps a dimension shows before [More]. */
export const GAPS_SHOWN = 2

const noop = (): void => {}

/** The short form: inline, or a dock with few rows (COMMON-5B, "inline and short panes"). Pure. */
export const isShort = (ctx: Pick<BodyContext, 'placement' | 'rows'>): boolean => ctx.placement === 'inline' || (Number.isFinite(ctx.rows) && ctx.rows < SHORT_ROWS)

/** The table's and the detail's widths when they sit side by side (from WIDE_COLUMNS); null below it, where the detail goes under the table. Pure. */
export function splitOf(columns: number): { table: number; detail: number } | null {
  if (!Number.isFinite(columns) || columns < WIDE_COLUMNS) return null
  const detail = Math.min(DETAIL_MAX, Math.max(DETAIL_MIN, Math.floor(columns * DETAIL_SHARE)))
  return { table: Math.floor(columns) - SPLIT_GAP - detail, detail }
}

/** Runs' body renderer (ui/pane.tsx calls it with the board atom under the hub's chrome). Pure. */
export function renderBoardPane(view: BoardView | null, resolved: PaneElements, ctx: BodyContext): RenderElement {
  const el = tableFor(resolved, ctx.surface)
  const { Box } = el
  const body = view?.body
  if (!body) return <Box flexDirection="column">{empty(el, 'nothing to show yet', { command: '/litter runs', does: 'opens the newest run' })}</Box>
  const columns = ctx.bodyColumns
  const short = isShort(ctx)
  const spaced = (part: RenderElement | null): RenderElement | null =>
    part === null ? null : (
      <Box flexDirection="column" marginTop={1}>
        {part}
      </Box>
    )
  const records = body.records ?? []
  const buttons = body.buttons ?? []
  const exceptions = exceptionsPart(el, body.notice ?? null, body.header?.tampered ?? null)
  const under = exceptions === null ? (part: RenderElement | null) => part : spaced
  return (
    <Box flexDirection="column">
      {exceptions}
      {body.header ? under(runLines(el, body.header, columns, short)) : null}
      {body.empty ? under(emptyPart(el, body.empty)) : null}
      {spaced(attentionPart(el, body.attention ?? []))}
      {body.gates ? spaced(gateBlock(el, body.gates, body.detail ?? null, columns, short)) : null}
      {body.design ? spaced(designPart(el, body.design, columns)) : null}
      {buttons.length > 0 ? spaced(actions(el, buttons.map(b => ({ key: b.key, label: b.label })))) : null}
      {body.section ? spaced(sectionPart(el, body.section, columns)) : null}
      {!short && records.length > 0 ? spaced(recordsPart(el, records, columns)) : null}
      {!short && body.header ? spaced(rulesPart(el, body.rules ?? [], body.proposals ?? [], columns)) : null}
    </Box>
  )
}

// `h` and `Fragment` are the environment's JSX factory, so no name here takes them.

/** An exception above everything (COMMON-5B, "exceptions first"): the refusal or the last action's outcome, then a tampered ledger. */
function exceptionsPart(el: PaneElements, n: SwarmNotice | null, tampered: string | null): RenderElement | null {
  const { Box } = el
  if (!n && !tampered) return null
  return (
    <Box flexDirection="column">
      {n ? notice(el, n.level, n.text) : null}
      {tampered ? notice(el, 'error', `${tampered}: nothing from that record on is acted on, so the board shows what came before it`) : null}
    </Box>
  )
}

/** A status's word, plain: `needs you`, not `needs_user`. */
const STATUS_WORD: Record<string, string> = { needs_user: 'needs you', ledger_tampered: 'ledger tampered', launch_failed: 'launch failed' }
export const statusText = (status: string): string => STATUS_WORD[status] ?? status.replace(/_/g, ' ')

/** A line of spans, then a faint rule to the end of `columns`: the body's first line, as the chrome's heading draws its rule. The run's id is cut before the rule goes under MIN_RULE. */
function ruledLine(el: PaneElements, spans: readonly SwarmSpan[], columns: number): RenderElement {
  const { Box, Text } = el
  const finite = Number.isFinite(columns)
  const fitted = finite ? fitSpans(spans, Math.max(1, Math.floor(columns) - 1 - MIN_RULE)) : [...spans]
  const used = fitted.reduce((n, s) => n + cells(s.text), 0)
  return (
    <Box flexDirection="row" columnGap={1}>
      <Box flexDirection="row">
        {fitted.map(s => (
          <Text color={s.color} bold={s.bold}>
            {s.text}
          </Text>
        ))}
      </Box>
      {finite ? (
        <Text color={STYLE.faint}>{RULE.repeat(Math.max(MIN_RULE, Math.floor(columns) - used - 1))}</Text>
      ) : (
        <Box flexGrow={1} width={0} minWidth={MIN_RULE} height={1} overflow="hidden">
          <Text color={STYLE.faint} wrap="wrap">
            {RULE.repeat(400)}
          </Text>
        </Box>
      )}
    </Box>
  )
}

/**
 * The run's first lines (report.md item 1): its status (glyph, word, color),
 * workflow and run, with a faint rule; its generation and branch; then, in
 * the dock, its base, checkout and times as a muted line.
 */
function runLines(el: PaneElements, head: BoardHeader, columns: number, short: boolean): RenderElement {
  const { Box } = el
  const first: SwarmSpan[] = [
    { text: `${head.status.glyph} ${statusText(head.status.text)}`, color: head.status.color, bold: true },
    { text: ' · ', color: STYLE.faint },
    { text: `${oneLine(head.workflow, 16)} ` },
    { text: head.run, color: STYLE.name },
  ]
  const second = [
    { label: 'generation', value: String(head.generation) },
    ...(head.branch ? [{ label: 'branch', value: head.branch, color: STYLE.name }] : []),
    ...(head.repairSwarm ? [{ label: 'repair swarm', value: head.repairSwarm, color: STYLE.name }] : []),
  ]
  const context = [
    ...(head.base ? [{ label: 'base', value: head.base, color: STYLE.muted }] : []),
    ...(head.checkout ? [{ label: 'checkout', value: head.checkout, color: STYLE.muted }] : []),
    ...(head.started ? [{ label: 'started', value: head.started, color: STYLE.muted }] : []),
    ...(head.ended ? [{ label: 'ended', value: head.ended, color: STYLE.muted }] : []),
  ]
  return (
    <Box flexDirection="column">
      {ruledLine(el, first, columns)}
      {pairs(el, second)}
      {!short && context.length > 0 ? pairs(el, context) : null}
    </Box>
  )
}

/** What needs you (`⚑ needs you · …`), then what runs on its own (`↻ repairing …`, neutral): one line each, cut to the body. */
function attentionPart(el: PaneElements, list: readonly BoardAttention[]): RenderElement | null {
  const { Box, Text } = el
  if (list.length === 0) return null
  return (
    <Box flexDirection="column">
      {list.map(a =>
        a.kind === 'needs-you' ? (
          <Text color={STYLE.needsYou} wrap="truncate-end">{`${MARK.needsYou.glyph} ${MARK.needsYou.word} · ${a.text}`}</Text>
        ) : (
          <Text color={MARK.repairing.color} wrap="truncate-end">{`${MARK.repairing.glyph} ${a.text}`}</Text>
        ),
      )}
    </Box>
  )
}

/** No run to show: why and the next step as a command (the chrome's empty), another on the next line, then the newest run's [Open], the one action. */
function emptyPart(el: PaneElements, e: BoardEmpty): RenderElement {
  const { Box, Text } = el
  const [first, ...rest] = e.next
  return (
    <Box flexDirection="column">
      {empty(el, e.what, first ?? null)}
      {rest.map(n => (
        <Box flexDirection="row" flexWrap="wrap">
          <Text color={STYLE.muted}>or </Text>
          <Text color={STYLE.link}>{n.command}</Text>
          <Text color={STYLE.muted}>{` ${n.does}`}</Text>
        </Box>
      ))}
      {e.newest ? <Box marginTop={1}>{actions(el, [{ key: `board:open:${e.newest.run}`, label: `Open ${e.newest.workflow} ${e.newest.run}`, primary: true }])}</Box> : null}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// The gate table and the selected gate

/** The fewest cells the title keeps before a column drops for it. */
export const TITLE_MIN = 16
/** The table's columns: the id, the state, the try, the commit, the failing dimensions, the title. The commit drops first, then the try, then the failing words; the title takes what's left. */
export const GATE_COLUMNS: readonly Column[] = [{ drop: 0 }, { drop: 0 }, { drop: 2 }, { drop: 3 }, { drop: 1 }, { drop: 0, fill: true }]
const TITLE = 5
/** The selection mark and its gap, before a row's cells. */
const MARK_CELLS = 2
/** The line under the Client's rows: how to reach a gate's detail and its actions. */
export const GATES_HINT = 'click a gate, ↑↓ enter, → or right-click for actions'

/** A row's cells, before they're fitted: the state in its color, the try it's on muted, the commit a SHA, the failing dimensions in words. */
export function gateCells(r: BoardGateRow): Cell[] {
  const on = typeof r.attemptNow === 'number' ? r.attemptNow : r.attempt
  return [
    { text: r.id },
    { text: `${r.glyph} ${r.state}`, color: r.color },
    { text: on === 0 ? '' : `try ${on}/${r.maxAttempts}`, color: STYLE.muted },
    { text: r.commit ?? '', color: STYLE.sha },
    { text: failingWords(r.failing), color: STYLE.failed },
    { text: r.earlier ? `${r.title} (landed in ${r.earlier})` : r.title, ...(r.state === 'waiting' ? { color: STYLE.muted } : {}) },
  ]
}

/**
 * Which of the table's columns show at `width` (the mark's cells included)
 * and each one's width (planColumns). The title counts at TITLE_MIN at most,
 * so a column drops only when the title would get less; then the title takes
 * what's left. A column no row fills takes no cells and no gap. Pure.
 */
export function planGates(rows: readonly BoardGateRow[], width: number): { shown: number[]; widths: number[] } {
  const data = rows.map(gateCells)
  const natural = GATE_COLUMNS.map((_, i) => Math.max(0, ...data.map(r => cells(r[i]?.text ?? ''))))
  const room = Number.isFinite(width) ? Math.max(1, Math.floor(width) - MARK_CELLS) : Number.POSITIVE_INFINITY
  const present = GATE_COLUMNS.map((_, i) => i).filter(i => i === TITLE || natural[i]! > 0)
  const planning = data.map(r => present.map(i => (i === TITLE ? { text: 'x'.repeat(Math.min(natural[TITLE]!, TITLE_MIN)) } : r[i]!)))
  const planned = planColumns(
    present.map(i => GATE_COLUMNS[i]!),
    planning,
    room,
  )
  const shown = planned.shown.map(j => present[j]!)
  const widths = [...natural]
  if (Number.isFinite(room)) widths[TITLE] = Math.max(1, room - shown.filter(i => i !== TITLE).reduce((n, i) => n + widths[i]! + 1, 0))
  return { shown, widths }
}

/** The table as gates.tsx draws it at `width`: each row's kept cells padded to their columns, the gap after each but the last, which is trimmed. Pure. */
export function gateLayout(rows: readonly BoardGateRow[], width: number): BoardGateLayout {
  const { shown, widths } = planGates(rows, width)
  const last = shown[shown.length - 1]
  return {
    cells: rows.map(r => {
      const all = gateCells(r)
      return shown.map(i => {
        const c = all[i]!
        const text = i === last ? fitCell(c.text, widths[i]!).trimEnd() : `${fitCell(c.text, widths[i]!)} `
        return c.color ? { text, color: c.color } : { text }
      })
    }),
    hint: GATES_HINT,
  }
}

/** The table and the selected gate's detail: side by side from WIDE_COLUMNS (splitOf), the detail under the table below it. */
function gateBlock(el: PaneElements, gates: BoardGatesProps, detail: BoardGateDetail | null, columns: number, short: boolean): RenderElement {
  const { Box } = el
  const row = (gates.rows ?? []).find(r => r.id === gates.selected)
  const split = detail ? splitOf(columns) : null
  if (split && detail) {
    return (
      <Box flexDirection="row" columnGap={SPLIT_GAP}>
        <Box flexDirection="column" width={split.table}>
          {gatesPart(el, gates, split.table)}
        </Box>
        <Box flexDirection="column" width={split.detail}>
          {detailPart(el, detail, row, split.detail, short)}
        </Box>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {gatesPart(el, gates, columns)}
      {detail ? (
        <Box flexDirection="column" marginTop={1}>
          {detailPart(el, detail, row, columns, short)}
        </Box>
      ) : null}
    </Box>
  )
}

/**
 * The gate table under its heading: gates.tsx's Client where the surface has
 * one (terminal, desktop), its rows laid out here; elsewhere the same rows
 * with each gate's id a Button (11:1426), as the chrome's list draws its
 * static rows. The selected gate's actions are the detail's Buttons on every
 * surface (decision 9).
 */
function gatesPart(el: PaneElements, gates: BoardGatesProps, width: number): RenderElement {
  const { Box } = el
  const rows = gates.rows ?? []
  const landed = rows.filter(r => r.state === 'landed').length
  const head = heading(el, 'Gates', width, rows.length > 0 ? `${landed} of ${rows.length} landed` : null)
  if ('Client' in el) {
    const { Client } = el
    return (
      <Box flexDirection="column">
        {head}
        <Client key={GATES_KEY} module="./gates.tsx" props={{ ...gates, layout: gateLayout(rows, width) }} width="100%" />
      </Box>
    )
  }
  const { Button, Text } = el
  const { shown, widths } = planGates(rows, width)
  const last = shown[shown.length - 1]
  return (
    <Box flexDirection="column">
      {head}
      {rows.length === 0 ? <Text color={STYLE.muted}>no gates</Text> : null}
      {rows.map(r => {
        const all = gateCells(r)
        return (
          <Box flexDirection="row" columnGap={1}>
            <Text color={STYLE.accent}>{r.id === gates.selected ? SELECTED_MARK : ' '}</Text>
            {shown.map(i =>
              i === 0 ? (
                <Box width={widths[0]!}>
                  <Button key={`board:select:${r.id}`} label={r.id} plain onPress={noop} />
                </Box>
              ) : (
                <Text color={all[i]!.color} wrap="truncate-end">
                  {i === last ? fitCell(all[i]!.text, widths[i]!).trimEnd() : fitCell(all[i]!.text, widths[i]!)}
                </Text>
              ),
            )}
          </Box>
        )
      })}
    </Box>
  )
}

/** The detail's [More]: shown once something is cut (an evidence past its line, more than GAPS_SHOWN gaps, a gap past its line), and while it's open. Pure. */
export function detailCut(d: BoardGateDetail, columns: number): boolean {
  const line = Number.isFinite(columns) ? Math.floor(columns) - 2 : Number.POSITIVE_INFINITY
  return d.dimensions.some(x => cells(x.evidence) > line || x.gaps.length > GAPS_SHOWN || x.gaps.some(g => cells(`− ${g}`) > line))
}

/**
 * The bar × version matrix (decision 10) as a Text table sized to the pane:
 * the id, a cell per version, then the item's text cut to what's left of
 * `columns`; the legend; a line per version. No Client is needed.
 */
function designPart(el: PaneElements, d: BoardDesign, columns: number): RenderElement {
  const { Box, Text } = el
  const idW = Math.max(5, ...d.rows.map(r => r.id.length + 1))
  const cellW = Math.max(4, ...d.versions.map(v => v.length + 1))
  const textW = Math.max(12, (Number.isFinite(columns) ? columns : 80) - 2 - idW - cellW * d.versions.length)
  return (
    <Box flexDirection="column">
      {heading(el, 'Bar × versions', columns, `${d.rows.filter(r => !r.outside).length} items, ${d.versions.length + d.hidden} versions`)}
      <Box flexDirection="row">
        <Text color={STYLE.muted}>{`  ${'item'.padEnd(idW)}${d.versions.map(v => v.padEnd(cellW)).join('')}`}</Text>
        {d.hidden > 0 && <Text color={STYLE.muted}>{`${d.hidden} earlier version${d.hidden === 1 ? '' : 's'} hidden`}</Text>}
      </Box>
      {d.rows.map(r => (
        <Box flexDirection="row">
          <Text color={r.outside ? STYLE.warning : STYLE.label}>{`  ${r.id.padEnd(idW)}`}</Text>
          {r.cells.map(c => (
            <Text color={c.color}>{c.text.padEnd(cellW)}</Text>
          ))}
          <Text color={r.outside ? STYLE.warning : STYLE.muted} wrap="truncate-end">
            {fitCell(r.text, textW).trimEnd()}
          </Text>
        </Box>
      ))}
      {d.versions.length === 0 && <Text color={STYLE.muted}>no version recorded yet</Text>}
      <Text color={STYLE.muted} wrap="truncate-end">{`  ${d.legend}`}</Text>
      {d.lines.map(l => (
        <Box flexDirection="row" columnGap={1}>
          <Text bold>{`  ${l.version.padEnd(cellW)}`}</Text>
          <Text color={l.color}>{l.overall}</Text>
          <Text color={l.sha ? STYLE.sha : STYLE.muted}>{l.sha ? `sha256 ${l.sha}` : 'sha256 not recorded'}</Text>
          {l.sourceChanged && <Text color={STYLE.warning}>! source changed</Text>}
        </Box>
      ))}
    </Box>
  )
}

/**
 * The selected gate (report.md items 2 and 4): its heading, its reason in
 * its state's color, the four dimensions spelled out with ✓/✕ and their
 * evidence cut to a line (whole after [More]; the critic note holds the
 * rest), its plan gap and rule clash, its verify with the log's path, and its
 * actions as Buttons with the state's one primary. Short, the dimensions on
 * one line and no evidence.
 */
function detailPart(el: PaneElements, d: BoardGateDetail, row: BoardGateRow | undefined, columns: number, short: boolean): RenderElement {
  const { Box, Text } = el
  const more = d.more === true
  const cut = !short && detailCut(d, columns)
  const list: Action[] = [
    ...(d.actions ?? []).map(a => ({ key: a.key, label: a.label, primary: a.primary === true })),
    ...(cut || (more && !short) ? [{ key: `board:more:${d.gate}`, label: more ? 'Less' : 'More' }] : []),
  ]
  return (
    <Box flexDirection="column">
      {heading(el, row?.title ? `${d.gate} ${row.title}` : d.gate, columns)}
      <Text color={row?.color ?? STYLE.label} wrap="wrap">{`${row?.glyph ?? MARK.idle.glyph} ${d.reason ?? row?.state ?? ''}`}</Text>
      {d.dimensions.length === 0 ? <Text color={STYLE.muted}>no verdict yet</Text> : null}
      {d.dimensions.length > 0 && short ? (
        <Box flexDirection="row" columnGap={1}>
          {d.dimensions.flatMap(x => [<Text>{DIM_WORD[x.name] ?? x.name}</Text>, <Text color={x.pass ? STYLE.done : STYLE.failed}>{x.pass ? '✓' : '✕'}</Text>])}
        </Box>
      ) : null}
      {d.dimensions.length > 0 && !short ? d.dimensions.map(x => dimensionPart(el, x, more)) : null}
      {d.planGap !== '' && <Text color={STYLE.warning} wrap="wrap">{`⚑ plan gap: ${d.planGap}`}</Text>}
      {d.ruleClash !== '' && <Text color={STYLE.warning} wrap="wrap">{`⚑ rule clash: ${d.ruleClash}`}</Text>}
      {d.verify && (
        <Box flexDirection="column">
          <Text>{`verify ${d.verify.id}: ${d.verify.ended}`}</Text>
          <Text color={STYLE.path} wrap="truncate-end">{`log ${d.verify.log}`}</Text>
        </Box>
      )}
      {list.length > 0 ? <Box marginTop={1}>{actions(el, list)}</Box> : null}
    </Box>
  )
}

/** One dimension: ✓/✕ and its word, then its evidence muted and its gaps, each a line (whole once [More] is open). */
function dimensionPart(el: PaneElements, x: BoardGateDetail['dimensions'][number], more: boolean): RenderElement {
  const { Box, Text } = el
  const wrap = more ? 'wrap' : 'truncate-end'
  const gaps = more ? x.gaps : x.gaps.slice(0, GAPS_SHOWN)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Text color={x.pass ? STYLE.done : STYLE.failed}>{x.pass ? '✓' : '✕'}</Text>
        <Text>{x.word ?? DIM_NAME[x.name] ?? x.name}</Text>
      </Box>
      {x.evidence !== '' ? (
        <Box paddingLeft={2}>
          <Text color={STYLE.muted} wrap={wrap}>
            {x.evidence}
          </Text>
        </Box>
      ) : null}
      {gaps.map(g => (
        <Box paddingLeft={2}>
          <Text color={STYLE.warning} wrap={wrap}>{`− ${g}`}</Text>
        </Box>
      ))}
      {gaps.length < x.gaps.length ? (
        <Box paddingLeft={2}>
          <Text color={STYLE.muted}>{`${x.gaps.length - gaps.length} more gap${x.gaps.length - gaps.length === 1 ? '' : 's'}`}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

/** The records, evidence: under their heading with their count, muted. */
function recordsPart(el: PaneElements, records: readonly BoardRecordRow[], columns: number): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexDirection="column">
      {heading(el, 'Records', columns, `the last ${records.length}`)}
      {records.map(r => (
        // One Text, so a narrow body cuts the record's text and never squeezes its seq or kind.
        <Text color={STYLE.muted} wrap="truncate-end">{`${String(r.seq).padStart(4)} ${r.kind} ${r.text}`}</Text>
      ))}
    </Box>
  )
}

/** The rules used and the run's proposals, evidence: each under its heading with its count, muted but for each standing's word. */
function rulesPart(el: PaneElements, rules: readonly BoardRuleRow[], proposals: readonly BoardProposalRow[], columns: number): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexDirection="column">
      {heading(el, 'Rules used', columns, String(rules.length))}
      {rules.length === 0 && <Text color={STYLE.muted}>none delivered</Text>}
      {rules.map(r => (
        <Box flexDirection="row" columnGap={1}>
          <Text color={STYLE.muted}>{r.ref}</Text>
          <Text color={r.color}>{r.standing}</Text>
        </Box>
      ))}
      {proposals.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {heading(el, 'Proposed in this run', columns, String(proposals.length))}
          {proposals.map(x => (
            <Box flexDirection="column">
              <Text color={STYLE.muted} wrap="wrap">{`"${x.text}"`}</Text>
              <Box flexDirection="row" columnGap={1}>
                <Text color={STYLE.muted}>{[x.source, x.gate].filter(Boolean).join(' · ')}</Text>
                <Text color={x.waiting ? STYLE.needsYou : STYLE.muted}>{`${x.waiting ? MARK.needsYou.glyph : MARK.idle.glyph} ${x.label}`}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

/** What [Plan], [Diff G<n>] or the critic note opened: its heading, its path, its text. */
function sectionPart(el: PaneElements, s: BoardSection, columns: number): RenderElement {
  const { Box, Code, Text } = el
  return (
    <Box flexDirection="column">
      {heading(el, s.title, columns)}
      {s.path ? (
        <Text color={STYLE.path} wrap="truncate-end">
          {s.path}
        </Text>
      ) : null}
      {s.text === '' ? <Text color={STYLE.muted}>nothing to show</Text> : <Code source={s.text} {...(s.kind === 'diff' ? {} : { language: 'markdown' })} />}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// The events

type BoardKey = { action: string; arg: string }

const parseKey = (key: string): BoardKey | null => {
  if (!key.startsWith('board:')) return null
  const [, action, ...rest] = key.split(':')
  return action ? { action, arg: rest.join(':') } : null
}

/** One press or pick: the navigation, then the redraw. A pick drawn for another run is stale: ignored, with a toast. */
export async function handleBoard(p: Ports, key: string, from: { run?: string } = {}): Promise<void> {
  const k = parseKey(key)
  if (!k) return
  await restoreBoardNav(p)
  const n = navOf()
  const litterDir = session().litterDir
  if (!n || !litterDir) {
    p.toast('the board was closed, so that was ignored')
    return
  }
  if (from.run !== undefined && from.run !== n.run) {
    p.toast(`that was for run ${oneLine(from.run, 60)}, and the board shows ${n.run ?? 'no run'} now, so it was ignored`)
    await drawBoard(p, litterDir)
    return
  }
  const gate = GATE_ID.test(k.arg) ? k.arg : null
  switch (k.action) {
    case 'select':
      if (!gate) return
      // A diff or a critic note was the last gate's; the plan scrolls to the new one. [More] folds again.
      setBoardNav({ ...n, selected: gate, section: n.section?.kind === 'diff' || n.section?.kind === 'verdict' ? null : n.section, notice: null, more: false })
      break
    case 'more':
      // The detail's [More] or [Less]: its evidence and gaps whole, or cut again.
      if (!gate) return
      setBoardNav({ ...n, selected: gate, more: n.selected === gate || n.selected === null ? !n.more : true, notice: null })
      break
    case 'open':
      // An empty board's [Open]: the newest run, by its id.
      if (!RUN_ID.test(k.arg)) return
      setBoardNav(blankBoardNav(k.arg))
      break
    case 'replay':
    case 'note':
    case 'copy': {
      if (!gate) return
      const action: BoardGateAction = k.action
      // Checked against the row as the ledger has it now, so a pick from an older drawing is never acted on blindly.
      const view = await drawBoard(p, litterDir)
      const row = view?.body?.gates?.rows.find(r => r.id === gate)
      if (!row || !(Array.isArray(row.actions) && row.actions.includes(action))) {
        p.toast(notAvailable(action, gate, view, row))
        return
      }
      if (action === 'replay') return replay(p, gate)
      if (action === 'copy') return copyCommit(p, gate, row.oid)
      setBoardNav({ ...n, selected: gate, section: { kind: 'verdict', gate }, notice: null, more: n.selected === gate && n.more })
      break
    }
    case 'plan':
      setBoardNav({ ...n, section: { kind: 'plan' }, notice: null })
      break
    case 'diff':
      if (!gate) return
      setBoardNav({ ...n, selected: gate, section: { kind: 'diff', gate }, notice: null, more: n.selected === gate && n.more })
      break
    case 'close':
      setBoardNav({ ...n, section: null, notice: null })
      break
    case 'rules': {
      p.log('board: [Rules] shows the Rules section')
      const opened = await openSection(p, 'rules', '', { focus: true }).then(
        r => r.placed,
        (err: unknown) => {
          p.log(`board: the Rules section didn't open: ${errText(err)}`)
          return false
        },
      )
      if (opened) return
      setBoardNav({ ...n, notice: { level: 'warning', text: "Rules can't be drawn here now: run /litter rules" } })
      break
    }
    default:
      return
  }
  await drawBoard(p, litterDir)
}

/** Why a menu action isn't there for a row, in one line, with what to do instead. */
function notAvailable(action: BoardGateAction, gate: string, view: BoardView | null, row: BoardGateRow | undefined): string {
  if (!row) return `${gate} isn't a gate of the run the board shows, so that was ignored`
  if (action === 'replay') {
    const status = view?.body?.header?.status.text ?? 'not ended'
    return `run ${view?.run ?? ''} is ${status}, so it can't be replayed yet: wait for it to end, then use /litter:amend ${gate}`
  }
  if (action === 'note') return `${gate} has no critic note yet, so there's nothing to open`
  return row.state === 'landed' ? `${gate}'s land doesn't record a full commit id, so nothing was copied` : `${gate} hasn't landed, so there's no commit to copy`
}

/** Replay: `/litter:amend <gate> ` into the prompt box as your draft. It never submits: you add the change and press Enter. */
async function replay(p: Ports, gate: string): Promise<void> {
  const text = `/litter:amend ${gate} `
  let filled = false
  try {
    filled = await p.fillPrompt(text)
  } catch (err) {
    p.log(`board: the prompt box refused ${text.trim()}: ${errText(err)}`)
  }
  p.log(`board: replay ${gate}: ${filled ? 'filled' : 'refused'}`)
  p.toast(filled ? `/litter:amend ${gate} is in the prompt box: add the change and press Enter` : `the prompt box didn't take it: type /litter:amend ${gate} <change>`)
}

/** Copy: the land's full commit id, checked as one first; the toast says what was copied, or that it wasn't. */
async function copyCommit(p: Ports, gate: string, oid: string | null): Promise<void> {
  if (oid === null || !OID.test(oid)) {
    p.toast(`${gate}'s land doesn't record a full commit id, so nothing was copied`)
    return
  }
  let copied = false
  try {
    copied = await p.copy(oid)
  } catch (err) {
    p.log(`board: the copy of ${gate}'s commit failed: ${errText(err)}`)
  }
  p.toast(copied ? `copied ${oid.slice(0, 7)} (${gate})` : `${oid.slice(0, 7)} (${gate}) wasn't copied: this screen's clipboard refused it`)
}

/** Every action handleBoard knows, so a Client's post can carry any of them. */
export const BOARD_ACTIONS = ['select', 'plan', 'diff', 'close', 'rules', 'replay', 'note', 'copy'] as const

/** The board's ui.message (the gate table's posts), ui.press, ui.input and ui.select; anything not keyed `board:` passes on. */
export const onBoardUi: PaneUiHandlers = {
  message: async (p, e, next) => {
    if (e.element !== GATES_KEY) return next(e)
    const data = e.data !== null && typeof e.data === 'object' && !Array.isArray(e.data) ? (e.data as Record<string, unknown>) : {}
    const action = typeof data.action === 'string' && (BOARD_ACTIONS as readonly string[]).includes(data.action) ? data.action : null
    if (action === null || typeof data.run !== 'string' || (data.gate !== undefined && typeof data.gate !== 'string')) return {}
    await handleBoard(p, `board:${action}${typeof data.gate === 'string' ? `:${data.gate}` : ''}`, { run: data.run })
    return {}
  },
  press: async (p, e, next) => {
    if (!parseKey(e.element)) return next(e)
    await handleBoard(p, e.element)
    return { element: e.element }
  },
  // The board has no fields: a key of its own is answered as it came.
  input: async (p, e, next) => (parseKey(e.element) ? { element: e.element, value: e.value } : next(e)),
  select: async (p, e, next) => (parseKey(e.element) ? { element: e.element, value: e.value } : next(e)),
}

// ---------------------------------------------------------------------------
// The tick

/**
 * Runs' tick (ui/hub.ts's litterTick, every 2 s while Runs is shown): the
 * board when it shows a run, rebuilt only when the run's ledger head (or a
 * rules ledger's, or the navigation) moved; it writes only a view that changed.
 */
export async function boardTick(p: Ports): Promise<void> {
  await restoreBoardNav(p)
  const litterDir = session().litterDir
  if (litterDir && navOf()?.run) await drawBoard(p, litterDir)
}

/** Rebuilds the board's view now, if one is shown (after a /clear, from the ledger); cheap when nothing changed. The rules section's too. */
export async function refreshBoard(p: Ports): Promise<void> {
  await restoreBoardNav(p)
  const litterDir = session().litterDir
  // $.state was wiped, so the view is written even when the build answers the last one.
  if (litterDir && navOf()) await drawBoard(p, litterDir, true)
  await refreshRulesPane(p)
}

export function resetBoardPaneForTests(): void {
  written = -1
  savedRev = -1
}
