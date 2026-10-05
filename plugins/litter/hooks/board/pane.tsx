// /litter-board and /litter-rules, and the board pane (phase 3; plan section
// 11, decision 21): a run drawn from its ledger, rebuilt by a timer while
// the pane is open, its keys `board:<action>[:<arg>]`. Owner: phase 3,
// package AF.
//
// The render is a pure function of the view in $.state (view.ts builds it).
// The gate table is the Client module gates.tsx where the surface has one,
// whose ↑↓ and Enter post `{ run, action: 'select', gate }` (a ui.message
// here), and a static table of buttons elsewhere. [Plan] and [Diff G<n>]
// open a section in the pane; [Rules] opens the rules pane. The table's
// right-click menu (phase 5, package CD; COMMON decision 9) posts `replay`,
// `note` or `copy` for its row; on a surface with no Client the selected
// gate's actions are buttons under the table. A design run gets its bar ×
// version matrix (decision 10) above its records.

import type { RenderElement } from 'claude-code'
import type { Ports } from '../ports'
import type { CommandRunHook, PaneElements, PaneRender, PaneUiHandlers, PortHook } from '../hooktypes'
import type {
  BoardDesign,
  BoardGateAction,
  BoardGateDetail,
  BoardGateRow,
  BoardGatesProps,
  BoardHeader,
  BoardProposalRow,
  BoardRecordRow,
  BoardRuleRow,
  BoardSection,
  BoardView,
} from '../../types/index'
import { session } from '../session'
import { buttons, header, section, tableFor } from '../swarm/builder'
import { oneLine } from '../swarm/view'
import { OID, blankBoardNav, boardNavRev, buildBoard, navOf, restoreBoardNav, saveBoardNav, setBoardNav } from './view'
import { openRulesPane, refreshRulesPane, rulesTick } from '../rules/pane'

export const BOARD_PANE = 'litter-board'
/** The gate table Client's key: `e.element` of its ui.message. */
export const GATES_KEY = 'board-gates'
/** The board's tick (WP-AF): a rebuild only when a ledger head or the navigation moved. */
export const BOARD_TICK_MS = 2000

const GATE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * At session.start's commands step and again after a /clear (clear.ts):
 * `/litter-board [run | execute | design]` and `/litter-rules`.
 */
export async function registerPhase3Commands(p: Ports): Promise<void> {
  await p.registerCommand({
    name: 'litter-board',
    description: 'Open the board: a litter run, its gates, verdicts, rules and proposals, from its ledger',
    argumentHint: '[run | execute | design]',
    immediate: true,
  })
  await p.registerCommand({
    name: 'litter-rules',
    description: 'Open the rules pane: accept, edit, dismiss or retire rules and proposals',
    immediate: true,
  })
}

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
 * command.run on `litter-board`: builds the view (view.ts, buildBoard) for
 * the run named, else the newest `execute` or `design` run, else the active
 * one, else the newest; writes it with `p.setView('board', …)`, opens the
 * `litter-board` pane, and answers a one-line `text`.
 */
export const boardCommand: PortHook<CommandRunHook> = async (p, e, next) => {
  await restoreBoardNav(p)
  const arg = (e.args ?? '').trim().split(/\s+/)[0] || null
  const litterDir = session().litterDir
  if (!litterDir) {
    setBoardNav(blankBoardNav(arg))
    await drawNoDirectory(p)
    const placed = await p.openPane(BOARD_PANE, 'litter board')
    return { text: `litter: the board has no litter directory to read${placed ? '' : " (open, but this screen can't draw it now)"}` }
  }
  setBoardNav(blankBoardNav(arg))
  const view = await drawBoard(p, litterDir)
  const placed = await p.openPane(BOARD_PANE, 'litter board')
  const head = view?.body?.header
  const what = view?.run && head ? `run ${view.run} (${head.workflow}, ${head.status.text})` : `nothing: ${view?.body?.notice?.text ?? 'no run'}`
  return { text: `litter: the board shows ${what}${placed ? '' : " (open, but this screen can't draw it now)"}` }
}

/** The board when this session has no litter directory: why, and nothing else. */
async function drawNoDirectory(p: Ports): Promise<void> {
  const why = session().litterDirError
  const view: BoardView = {
    view: 'board',
    v: 0,
    run: null,
    body: {
      title: [{ text: 'litter · board', bold: true }],
      notice: { level: 'error', text: `this session has no litter directory${why ? `: ${oneLine(why, 240)}` : ''}` },
      header: null,
      gates: null,
      detail: null,
      design: null,
      records: [],
      rules: [],
      proposals: [],
      section: null,
      buttons: [],
      stamp: '',
    },
  }
  await p.setView('board', view)
  written = -1
}

/**
 * The band's and the card's [Board] (phase 5, WP-CA): the board on `run`, or,
 * for null, on what /litter-board with no argument opens (the active run,
 * else the newest). Answers whether the pane was placed; a failure is logged
 * and answers false, so the caller can say to run /litter-board.
 */
export async function openBoard(p: Ports, run: string | null): Promise<boolean> {
  try {
    await restoreBoardNav(p)
    setBoardNav(blankBoardNav(run))
    const litterDir = session().litterDir
    if (litterDir) await drawBoard(p, litterDir)
    else await drawNoDirectory(p)
    return await p.openPane(BOARD_PANE, 'litter board')
  } catch (err) {
    p.log(`board: it didn't open${run ? ` on run ${run}` : ''}: ${errText(err)}`)
    return false
  }
}

// ---------------------------------------------------------------------------
// The render

/** register.tsx's ui.render hook for `{ component: 'Pane', requestId: 'litter-board' }` calls it with the board atom. A pure renderer. */
export function renderBoardPane(view: BoardView | null, resolved: PaneElements, e: PaneRender): RenderElement {
  const el = tableFor(resolved, e.surface)
  const { Box, Text } = el
  const body = view?.body
  if (!body) {
    return (
      <Box flexDirection="column">
        <Text bold>litter · board</Text>
        <Text dimColor>nothing to show yet: /litter-board opens a run</Text>
      </Box>
    )
  }
  const records = body.records ?? []
  return (
    <Box flexDirection="column">
      {header(el, body.title, body.notice ?? null)}
      {body.header ? headerPart(el, body.header) : null}
      {body.gates ? gatesPart(el, body.gates) : null}
      {body.detail ? detailPart(el, body.detail) : null}
      {body.design ? designPart(el, body.design, e.props.bodyColumns) : null}
      {records.length > 0 ? recordsPart(el, records) : null}
      {body.header ? rulesPart(el, body.rules ?? [], body.proposals ?? []) : null}
      {body.section ? sectionPart(el, body.section) : null}
      <Box marginTop={1}>{buttons(el, (body.buttons ?? []).map(b => ({ key: b.key, label: b.label })))}</Box>
    </Box>
  )
}

// `h` and `Fragment` are the environment's JSX factory, so no name here takes them.
function headerPart(el: PaneElements, head: BoardHeader): RenderElement {
  const { Box, Text } = el
  const run = [head.workflow, `generation ${head.generation}`, head.repairSwarm ? `repair swarm ${head.repairSwarm}` : null].filter(Boolean).join(' · ')
  const where = [head.branch && `branch ${head.branch}`, head.base && `base ${head.base}`].filter(Boolean).join(' · ')
  const when = [head.started && `started ${head.started}`, head.ended && `ended ${head.ended}`].filter(Boolean).join(' · ')
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Text color={head.status.color}>{`${head.status.glyph} ${head.status.text}`}</Text>
        <Text>{run}</Text>
      </Box>
      {where !== '' && <Text color="yellow" wrap="truncate-end">{where}</Text>}
      {head.checkout !== '' && <Text color="blue" wrap="truncate-end">{`checkout ${head.checkout}`}</Text>}
      {when !== '' && <Text dimColor>{when}</Text>}
      {head.tampered && <Text color="error">{`✕ ${head.tampered}`}</Text>}
    </Box>
  )
}

const DIM_SHORT: Record<string, string> = { plan_adherence: 'PA', tests_green: 'TG', no_regressions: 'NR', rules: 'RU' }

/** One row as text, the same columns gates.tsx draws. */
export function rowText(r: BoardGateRow): string {
  const tries = r.attempt === 0 ? '·' : `${r.attempt}/${r.maxAttempts}`
  const failing = r.failing.length > 0 ? `✕ ${r.failing.map(d => DIM_SHORT[d] ?? d).join(' ')}` : ''
  return [r.id.padEnd(5), `${r.glyph} ${r.state}`.padEnd(13), tries.padEnd(5), (r.commit ?? '·').padEnd(8), failing.padEnd(12), r.title].join(' ')
}

/** The gate table: the Client where the surface has one (terminal, desktop), plain buttons elsewhere (11:1426). */
function gatesPart(el: PaneElements, gates: BoardGatesProps): RenderElement {
  const { Box, Text } = el
  const rows = gates.rows ?? []
  if ('Client' in el) {
    const { Client } = el
    return (
      <Box flexDirection="column" marginTop={1}>
        <Client key={GATES_KEY} module="./gates.tsx" props={gates} width="100%" />
      </Box>
    )
  }
  const { Button } = el
  // With no pointer for the menu, the selected gate's actions are buttons under the table (decision 9).
  const picked = rows.find(r => r.id === gates.selected)
  const actions = picked && Array.isArray(picked.actions) ? picked.actions : []
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{'  gate  state         try   commit   failing      title'}</Text>
      {rows.length === 0 && <Text dimColor>no gates</Text>}
      {rows.map(r => (
        <Box flexDirection="row">
          <Text color={r.color}>{r.id === gates.selected ? '› ' : '  '}</Text>
          <Button key={`board:select:${r.id}`} label={rowText(r)} plain {...(r.state === 'waiting' ? { dimColor: true } : {})} onPress={() => {}} />
        </Box>
      ))}
      {rows.some(r => r.earlier) && <Text dimColor>{rows.filter(r => r.earlier).map(r => `${r.id} landed in ${r.earlier}`).join(' · ')}</Text>}
      {picked && actions.length > 0 && buttons(el, actions.map(a => ({ key: `board:${a}:${picked.id}`, label: ACTION_LABEL[a](picked.id) })))}
    </Box>
  )
}

/** The static table's action buttons, named for their gate. */
const ACTION_LABEL: Record<BoardGateAction, (gate: string) => string> = {
  replay: gate => `Replay ${gate} with /litter:amend`,
  note: gate => `Open ${gate}'s critic note`,
  copy: gate => `Copy ${gate}'s commit`,
}

/** A cell of `n` columns: cut with `…`, or padded. */
const fit = (s: string, n: number): string => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s.padEnd(n))

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
      {section(el, 'Bar × versions', { text: `${d.rows.filter(r => !r.outside).length} items, ${d.versions.length + d.hidden} versions`, dim: true })}
      <Box flexDirection="row">
        <Text bold>{`  ${'item'.padEnd(idW)}${d.versions.map(v => v.padEnd(cellW)).join('')}`}</Text>
        {d.hidden > 0 && <Text dimColor>{`${d.hidden} earlier version${d.hidden === 1 ? '' : 's'} hidden`}</Text>}
      </Box>
      {d.rows.map(r => (
        <Box flexDirection="row">
          <Text color={r.outside ? 'warning' : undefined}>{`  ${r.id.padEnd(idW)}`}</Text>
          {r.cells.map(c => (
            <Text color={c.color}>{c.text.padEnd(cellW)}</Text>
          ))}
          <Text color={r.outside ? 'warning' : undefined} dimColor={!r.outside} wrap="truncate-end">
            {fit(r.text, textW).trimEnd()}
          </Text>
        </Box>
      ))}
      {d.versions.length === 0 && <Text dimColor>no version recorded yet</Text>}
      <Text dimColor wrap="truncate-end">{`  ${d.legend}`}</Text>
      {d.lines.map(l => (
        <Box flexDirection="row" columnGap={1}>
          <Text bold>{`  ${l.version.padEnd(cellW)}`}</Text>
          <Text color={l.color}>{l.overall}</Text>
          <Text color={l.sha ? 'yellow' : 'gray'}>{l.sha ? `sha256 ${l.sha}` : 'sha256 not recorded'}</Text>
          {l.sourceChanged && <Text color="warning">! source changed</Text>}
        </Box>
      ))}
    </Box>
  )
}

function detailPart(el: PaneElements, d: BoardGateDetail): RenderElement {
  const { Box, Text } = el
  // The dimensions are of the attempt the verdict judged, which an executor's later stop isn't (WP-AH).
  const judged = d.dimensions.length === 0 ? 'no verdict yet' : d.verdictAttempt !== null ? `the last verdict, on attempt ${d.verdictAttempt}` : 'the last verdict'
  const gapBy = d.gapBy?.who === 'executor' ? ` (the executor stopped${d.gapBy.attempt !== null ? ` on attempt ${d.gapBy.attempt}` : ''})` : ''
  return (
    <Box flexDirection="column">
      {section(el, d.gate, { text: judged, dim: true })}
      {d.dimensions.map(x => (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            <Text color={x.pass ? 'success' : 'error'}>{x.pass ? '✓' : '✕'}</Text>
            <Text bold>{x.name}</Text>
          </Box>
          {x.evidence !== '' && <Text wrap="wrap">{`    ${x.evidence}`}</Text>}
          {x.gaps.map(g => (
            <Text color="warning" wrap="wrap">{`    − ${g}`}</Text>
          ))}
        </Box>
      ))}
      {d.verify && (
        <Box flexDirection="column">
          <Text>{`verify ${d.verify.id}: ${d.verify.ended}`}</Text>
          <Text color="blue" wrap="truncate-end">{`  log ${d.verify.log}`}</Text>
        </Box>
      )}
      {d.planGap !== '' && <Text color="warning" wrap="wrap">{`⚑ plan gap${gapBy}: ${d.planGap}`}</Text>}
      {d.ruleClash !== '' && <Text color="warning" wrap="wrap">{`⚑ rule clash: ${d.ruleClash}`}</Text>}
    </Box>
  )
}

function recordsPart(el: PaneElements, records: readonly BoardRecordRow[]): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexDirection="column">
      {section(el, 'Records', { text: `the last ${records.length}`, dim: true })}
      {records.map(r => (
        <Box flexDirection="row" columnGap={1}>
          <Text dimColor>{String(r.seq).padStart(4)}</Text>
          <Text bold>{r.kind}</Text>
          <Text wrap="truncate-end">{r.text}</Text>
        </Box>
      ))}
    </Box>
  )
}

function rulesPart(el: PaneElements, rules: readonly BoardRuleRow[], proposals: readonly BoardProposalRow[]): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexDirection="column">
      {section(el, 'Rules used', { text: 'the versions this run launched with', dim: true })}
      {rules.length === 0 && <Text dimColor>none delivered</Text>}
      {rules.map(r => (
        <Box flexDirection="row" columnGap={1}>
          <Text>{r.ref}</Text>
          <Text color={r.color}>{r.standing}</Text>
        </Box>
      ))}
      {proposals.length > 0 && section(el, 'Proposed in this run', { text: 'reach no agent until you accept them', dim: true })}
      {proposals.map(x => (
        <Box flexDirection="column">
          <Text wrap="wrap">{`"${x.text}"`}</Text>
          <Box flexDirection="row" columnGap={1}>
            <Text dimColor>{[x.source, x.gate].filter(Boolean).join(' · ')}</Text>
            <Text color="permission">{`⚑ ${x.label}`}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

function sectionPart(el: PaneElements, s: BoardSection): RenderElement {
  const { Box, Code, Text } = el
  return (
    <Box flexDirection="column">
      {section(el, s.title, s.path ? { text: s.path, color: 'blue' } : undefined)}
      {s.text === '' ? <Text dimColor>nothing to show</Text> : <Code source={s.text} {...(s.kind === 'diff' ? {} : { language: 'markdown' })} />}
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
    p.toast('litter: the board was closed, so that was ignored')
    return
  }
  if (from.run !== undefined && from.run !== n.run) {
    p.toast(`litter: that was for run ${oneLine(from.run, 60)}, and the board shows ${n.run ?? 'no run'} now, so it was ignored`)
    await drawBoard(p, litterDir)
    return
  }
  const gate = GATE_ID.test(k.arg) ? k.arg : null
  switch (k.action) {
    case 'select':
      if (!gate) return
      // A diff or a critic note was the last gate's; the plan scrolls to the new one.
      setBoardNav({ ...n, selected: gate, section: n.section?.kind === 'diff' || n.section?.kind === 'verdict' ? null : n.section, notice: null })
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
        p.toast(`litter: ${notAvailable(action, gate, view, row)}`)
        return
      }
      if (action === 'replay') return replay(p, gate)
      if (action === 'copy') return copyCommit(p, gate, row.oid)
      setBoardNav({ ...n, selected: gate, section: { kind: 'verdict', gate }, notice: null })
      break
    }
    case 'plan':
      setBoardNav({ ...n, section: { kind: 'plan' }, notice: null })
      break
    case 'diff':
      if (!gate) return
      setBoardNav({ ...n, selected: gate, section: { kind: 'diff', gate }, notice: null })
      break
    case 'close':
      setBoardNav({ ...n, section: null, notice: null })
      break
    case 'rules': {
      p.log('board: [Rules] opens the rules pane')
      const opened = await openRulesPane(p, null)
      if (opened) return
      setBoardNav({ ...n, notice: { level: 'warning', text: "the rules pane can't be drawn here now: run /litter-rules" } })
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
  p.toast(filled ? `litter: /litter:amend ${gate} is in the prompt box: add the change and press Enter` : `litter: the prompt box didn't take it: type /litter:amend ${gate} <change>`)
}

/** Copy: the land's full commit id, checked as one first; the toast says what was copied, or that it wasn't. */
async function copyCommit(p: Ports, gate: string, oid: string | null): Promise<void> {
  if (oid === null || !OID.test(oid)) {
    p.toast(`litter: ${gate}'s land doesn't record a full commit id, so nothing was copied`)
    return
  }
  let copied = false
  try {
    copied = await p.copy(oid)
  } catch (err) {
    p.log(`board: the copy of ${gate}'s commit failed: ${errText(err)}`)
  }
  p.toast(copied ? `litter: copied ${oid.slice(0, 7)} (${gate})` : `litter: ${oid.slice(0, 7)} (${gate}) wasn't copied: this screen's clipboard refused it`)
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

let timer: { cancel(): void } | null = null
let ticking = false

/**
 * At session.start's timers step: `p.every(2000, …)` rebuilds the board's
 * view while it's open, only when the run's ledger head (or a rules
 * ledger's, or the navigation) moved, and the rules pane's the same way.
 */
export function startBoardTimer(p: Ports): void {
  timer?.cancel()
  timer = p.every(BOARD_TICK_MS, () => {
    if (ticking) return
    ticking = true
    boardTick(p)
      .catch((err: unknown) => p.log(`board: the tick failed: ${errText(err)}`))
      .finally(() => {
        ticking = false
      })
  })
}

/** One tick: the board when it shows a run, then the rules pane; each writes only a view that changed. */
export async function boardTick(p: Ports): Promise<void> {
  await restoreBoardNav(p)
  const litterDir = session().litterDir
  if (litterDir && navOf()?.run) await drawBoard(p, litterDir)
  await rulesTick(p)
}

/** Rebuilds the board's view now, if one is shown (after a /clear, from the ledger); cheap when nothing changed. The rules pane's too. */
export async function refreshBoard(p: Ports): Promise<void> {
  await restoreBoardNav(p)
  const litterDir = session().litterDir
  // $.state was wiped, so the view is written even when the build answers the last one.
  if (litterDir && navOf()) await drawBoard(p, litterDir, true)
  await refreshRulesPane(p)
}

export function resetBoardPaneForTests(): void {
  timer?.cancel()
  timer = null
  ticking = false
  written = -1
  savedRev = -1
}
