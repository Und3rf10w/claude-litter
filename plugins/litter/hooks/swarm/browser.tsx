// WP-N: the Swarms section's draw (the `litter` pane, phase 5b), every view
// (start, builder, proposal, browser, goal history, recovery card, unsettled
// report, read-only): a pure body renderer of the view in $.state, the hub's
// element table, and the body's context (ui/chrome.tsx). It never sees `$`
// or the ports.
//
// This file draws the live views (15.6's mockup): the browser and its
// read-only form (with a repair swarm's budget row, 2b-2), the goal history,
// the recovery card and the unsettled report; builder.tsx draws the start
// screen, the builder and a proposal.
//
// Contract owner: phase 2b-1, package N.
//
// Phase 5b (WP-DD): each view's first line is its swarm's name and state
// (builder.tsx's titleRow), under the hub's `litter · Swarms`; what needs you
// (the lead's current proposals, the open questions) comes right under it,
// then the exceptions (ownership, a used-up budget, flags), the roster as the
// chrome's list, the summary, the composer, the actions, and the events last.
// Inline or on a short pane the roster leads and the summary is one line.

import type { RenderElement } from 'claude-code'
import type { PaneElements } from '../hooktypes'
import type { SwarmPaneView } from '../ports'
import type { SwarmBrowserView, SwarmBudgetRow, SwarmComposer, SwarmHistoryView, SwarmNodeRow, SwarmRecoveryView, SwarmUnsettledView } from '../../types/index'
import { empty, field, fitCell, heading, itemWidth, notice, packWidths, rows, textRows, type Action, type BodyContext, type KeyHint, type SectionMeta } from '../ui/chrome'
import { list, listPlace, type ListAction, type ListSpec } from '../ui/list'
import { MARK, STYLE } from '../ui/style'
import { cells } from '../band/view'
import { actionRow, choose, drawsClient, headed, needsRow, needsRowCount, noticeRow, renderBuilder, renderProposal, renderStart, tableFor, titleRow } from './builder'

/**
 * The keys a view adds to the keys line, before the hub's: the builder's
 * tree takes ↑↓ ⏎ a d x once a click gives it the keys, and its rows and
 * the browser's roster open a menu on a right-click. Pure.
 */
export function swarmKeys(view: SwarmPaneView | null): readonly KeyHint[] {
  if (!view) return []
  if (view.view === 'builder' && !view.blocked) {
    return [
      { key: 'right-click', word: "a node's edits" },
      { key: 'a d x', word: 'add, duplicate, delete (after a click)' },
    ]
  }
  if (view.view === 'browser' && view.rows.some(r => r.agentId !== null)) return [{ key: 'right-click', word: "an agent's actions" }]
  return []
}

/**
 * Swarms to the hub (chrome.tsx's SectionMeta). `fits` stays false: the
 * builder's inspector and brief, the browser's summary and transcript and a
 * proposal's diffs are drawn whole, and the lists (saved swarms, the roster)
 * draw every row, so the pane's scroll reaches all of it. Windowing them
 * needs footers and a [More] that swarm/panes.ts doesn't handle yet (the
 * report's contract changes).
 */
export const swarmsSection: SectionMeta<SwarmPaneView> = { fits: false, keys: swarmKeys }

/** Swarms' body renderer (ui/pane.tsx calls it with the swarmPane atom under the hub's chrome). */
export function renderSwarmPane(view: SwarmPaneView | null, resolved: PaneElements, e: BodyContext): RenderElement {
  const el = tableFor(resolved, e.surface)
  if (!view) return empty(el, 'nothing to show yet', { command: '/litter swarms', does: 'opens the builder or a live swarm' })
  switch (view.view) {
    case 'start':
      return renderStart(view, el, e)
    case 'builder':
      return renderBuilder(view, el, e)
    case 'proposal':
      return renderProposal(view, el, e)
    case 'browser':
      return renderBrowser(view, el, e)
    case 'history':
      return renderHistory(view, el, e)
    case 'recovery':
      return renderRecovery(view, el, e)
    case 'unsettled':
      return renderUnsettled(view, el, e)
  }
}

const indent = (depth: number) => '  '.repeat(Math.max(0, depth))

/** The browser is drawn compact (the roster first, the summary one line, no events): inline, or on a pane this short. */
export const COMPACT_ROWS = 20
export const compactBrowser = (e: Pick<BodyContext, 'placement' | 'rows'>): boolean => e.placement === 'inline' || (Number.isFinite(e.rows) && e.rows < COMPACT_ROWS)

/** The roster list's id: under Swarms' prefix, so its Client's posts press on Swarms. */
export const rosterId = (swarm: string): string => `swarm:browser:roster:${swarm}`

/** Stop and Hard stop are offered on a row: a node that's still running, in a live swarm this session owns (no Stop beside a finished one). */
export const stoppable = (view: Pick<SwarmBrowserView, 'readOnly' | 'lost'>, r: Pick<SwarmNodeRow, 'agentId' | 'running'>): boolean =>
  r.agentId !== null && r.running && !view.readOnly && !view.lost

/** A roster row's description, beside or under it once it's focused: its turns, tokens and last report. Pure. */
export function rosterDescription(r: Pick<SwarmNodeRow, 'turns' | 'tokens' | 'report'>): string {
  return [r.turns !== null && `${r.turns} turn${r.turns === 1 ? '' : 's'}`, r.tokens !== '' && `${r.tokens} tokens`, r.report !== '' && `last report: ${r.report}`]
    .filter((x): x is string => typeof x === 'string' && x !== '')
    .join(' · ')
}

/** A row's actions, the same in its right-click menu and as Buttons under the list: Transcript, and Stop node and Hard stop where stoppable. */
export function rosterActions(view: SwarmBrowserView, r: SwarmNodeRow): ListAction[] {
  if (r.agentId === null) return []
  const s = view.swarm
  return [
    { key: `swarm:browser:transcript:${s}/${r.agentId}`, label: view.transcript?.agentId === r.agentId ? 'Hide transcript' : 'Transcript' },
    ...(stoppable(view, r)
      ? [
          { key: `swarm:browser:stop:${s}/${r.agentId}`, label: 'Stop node' },
          { key: `swarm:browser:hard-stop:${s}/${r.agentId}`, label: 'Hard stop', color: STYLE.failed },
        ]
      : []),
  ]
}

/**
 * The roster as the chrome's list: each agent its indent and name, its role
 * muted, its status (glyph, word, color), the call in flight and its flags;
 * its turns, tokens and last report the focused row's description. The lead
 * is the heading's note. Every row is drawn (see swarmsSection's `fits`).
 * The right-click menu is given where the rows are a Client; elsewhere the
 * selected row's actions are the Buttons under the list. Pure.
 */
export function rosterList(view: SwarmBrowserView, client: boolean): ListSpec {
  const agents = view.rows.filter(r => r.agentId !== null)
  return {
    id: rosterId(view.swarm),
    rows: Math.max(1, agents.length),
    items: agents.map(r => {
      const flags = [r.flagged ? '! flagged' : '', r.queued.length > 0 ? `${r.queued.length} queued` : ''].filter(x => x !== '').join(' · ')
      const acts = client ? rosterActions(view, r) : []
      return {
        key: `swarm:browser:select:${view.swarm}/${r.agentId}`,
        label: `${indent(r.depth - 1)}${r.name}`,
        cells: [
          { text: `${r.statusGlyph ? `${r.statusGlyph} ` : ''}${r.status}`, color: r.statusColor },
          { text: r.role, color: STYLE.muted },
          { text: flags, color: STYLE.warning },
          { text: r.tool === '' ? '' : `${MARK.running.glyph} ${r.tool}`, color: STYLE.muted },
        ],
        description: rosterDescription(r),
        selected: r.agentId === view.selected,
        ...(acts.length > 0 ? { actions: acts } : {}),
      }
    }),
    // The status never drops; the call in flight goes first, then the role, then the flags.
    columns: [{ drop: 0 }, { drop: 2 }, { drop: 1 }, { drop: 3 }],
    empty: 'no agent yet: the lead spawns them',
  }
}

/**
 * [Review] on the browser's banner: the browser's `builder` action, the
 * proposal's number after the swarm. swarm/panes.ts opens the builder for
 * it today, whose first line is the same proposal with its own [Review];
 * the report's contract change opens the proposal itself.
 */
export const reviewKey = (swarm: string, n: number): string => `swarm:browser:builder:${swarm}/${n}`

/**
 * What needs you, the first thing under the first line (the user's "It says
 * it needs me, but where", 2026-10-07: wherever the hub raises ⚑ the section
 * shows why): each current proposal of the lead's with [Review], then each
 * open question, who asks and its first line, with [Answer] (it selects the
 * asker, so the composer goes to it). Pure.
 */
export function browserNeeds(view: SwarmBrowserView): { text: string; action: Action | null }[] {
  const s = view.swarm
  const live = !view.readOnly && !view.lost
  return [
    ...(view.proposals ?? []).map(n => ({ text: `the lead's proposal ${n} waits on you`, action: { key: reviewKey(s, n), label: 'Review' } })),
    ...view.rows
      .filter(r => r.question !== null)
      .map(r => ({
        text: `${r.name} asks: ${r.question}`,
        action: live && r.agentId !== null && r.agentId !== view.selected ? { key: `swarm:browser:select:${s}/${r.agentId}`, label: 'Answer' } : null,
      })),
  ]
}

/** The exceptions, under what needs you (COMMON-5B, "Order"): ownership, a used-up budget, the flags. */
function exceptions(el: PaneElements, view: SwarmBrowserView, columns: number): RenderElement {
  const { Box, Text } = el
  const s = view.swarm
  const live = !view.readOnly && !view.lost
  return (
    <Box flexDirection="column">
      {view.owner && (
        <Box flexDirection="column">
          {notice(el, view.lost ? 'error' : 'warning', view.lost ? `this session lost it: ${view.owner.text}` : `read-only: ${view.owner.text}`)}
          {view.owner.why !== null && (
            <Box paddingLeft={2}>
              <Text color={STYLE.muted} wrap="wrap">
                {view.owner.why}
              </Text>
            </Box>
          )}
          {view.owner.canTakeOver && actionRow(el, [{ key: `swarm:browser:takeover:${s}`, label: 'Take over', primary: true, autoFocus: true }], columns)}
        </Box>
      )}
      {view.budget && view.budget.note !== null && notice(el, 'warning', view.budget.note)}
      {view.flags.map(f => (
        <Box flexDirection="column">
          {notice(el, 'warning', f.text)}
          {live &&
            actionRow(
              el,
              [
                { key: `swarm:browser:ack:${s}/${f.seq}`, label: 'That was me' },
                f.running.length > 0 && { key: `swarm:browser:stop-them:${s}/${f.seq}`, label: 'Stop them' },
              ],
              columns,
            )}
        </Box>
      ))}
    </Box>
  )
}

/** A repair swarm's budget (2b-2): rounds and agents used of what you approved, a used-up part with its glyph and words. */
function budgetRow(el: PaneElements, b: SwarmBudgetRow): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexDirection="row" columnGap={1} flexWrap="wrap">
      <Text color={STYLE.muted}>Repair budget</Text>
      {[b.rounds, b.agents].map((x, i) => (
        <Box flexDirection="row" columnGap={1}>
          {i > 0 && <Text color={STYLE.faint}>·</Text>}
          <Text color={x.color ?? STYLE.label}>{`${x.glyph ? `${x.glyph} ` : ''}${x.text}`}</Text>
        </Box>
      ))}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// The transcript's window (the user's ask, 2026-10-07: "Why isn't this mouse
// wheel scrollable?"): the view holds the last 200 lines (view.ts's
// TRANSCRIPT_LINES); the box draws a window of them, as many rows as the body
// leaves it under the roster, at least TRANSCRIPT_MIN_ROWS. Its offset is the
// hub's (ctx.lists, moved by moveList), counted from the newest line: 0, the
// default, keeps the newest in sight as lines arrive; a tick up moves it
// back. chrome's list windows from the top, so the arithmetic is here.

/** The fewest rows the transcript's window has. */
export const TRANSCRIPT_MIN_ROWS = 6
/** Its rows where nothing bounds the body (inline). */
export const TRANSCRIPT_INLINE_ROWS = 12
/** The box's rows beside its lines: the frame's two, the heading, the footer, [Close]. */
const TRANSCRIPT_CHROME = 5

/** The transcript window's id in the hub's `lists`: per swarm and agent, so another agent's starts at its newest. */
export const transcriptListId = (swarm: string, agentId: string): string => `swarm:browser:transcript-window:${swarm}/${agentId}`

/** Which of `count` lines a window of `rows` shows, `fromNewest` lines back from the newest, clamped: [start, end), how many are earlier and newer, and the offset's max. Pure. */
export function transcriptWindow(count: number, fromNewest: number, rows: number): { start: number; end: number; earlier: number; newer: number; offset: number; max: number } {
  const n = Math.max(0, Math.floor(count))
  const budget = Math.max(1, Math.floor(Number.isFinite(rows) ? rows : n || 1))
  const max = Math.max(0, n - budget)
  const offset = Math.min(max, Math.max(0, Math.floor(Number.isFinite(fromNewest) ? fromNewest : 0)))
  const end = n - offset
  const start = Math.max(0, end - budget)
  return { start, end, earlier: start, newer: n - end, offset, max }
}

const buttonWidth = (label: string): number => itemWidth({ kind: 'button', label })
/** An action row's rows at `columns`: its Buttons packed by width. */
const actionRows = (labels: readonly string[], columns: number): number => (labels.length === 0 ? 0 : packWidths(labels.map(buttonWidth), columns).length)
const noticeRows = (text: string, columns: number): number => textRows(`! ${text}`, columns)

/**
 * The rows renderBrowser draws above the transcript's first line at `ctx`:
 * the title, the notice, the exceptions, the budget, the roster's heading,
 * list and the rows under it, then the box's frame and heading. For the
 * window's height and the wheel's hit test (browserWheel). Kept in step with
 * renderBrowser: a row added above the transcript is added here.
 */
export function browserTranscriptTop(view: SwarmBrowserView, ctx: Pick<BodyContext, 'bodyColumns' | 'surface' | 'focused' | 'lists'>): number {
  const c = ctx.bodyColumns
  const live = !view.readOnly && !view.lost
  let rows = 1
  for (const x of browserNeeds(view)) rows += needsRowCount(x.text, x.action?.label ?? null, c)
  if (view.notice) rows += noticeRows(view.notice.text, c)
  if (view.owner) {
    rows += noticeRows(`${view.lost ? 'this session lost it: ' : 'read-only: '}${view.owner.text}`, c)
    if (view.owner.why !== null) rows += textRows(view.owner.why, Number.isFinite(c) ? c - 2 : c)
    if (view.owner.canTakeOver) rows += 1
  }
  if (view.budget && view.budget.note !== null) rows += noticeRows(view.budget.note, c)
  for (const f of view.flags) rows += noticeRows(f.text, c) + (live ? actionRows(['That was me', ...(f.running.length > 0 ? ['Stop them'] : [])], c) : 0)
  if (view.budget) {
    const b = view.budget
    rows += packWidths([cells('Repair budget'), cells(`${b.rounds.glyph ? `${b.rounds.glyph} ` : ''}${b.rounds.text}`), 2 + cells(`${b.agents.glyph ? `${b.agents.glyph} ` : ''}${b.agents.text}`)], c).length
  }
  // The roster: its heading a row below, the list, the selected row's actions, the queued messages.
  rows += 2 + listPlace(rosterList(view, ctx.surface === 'terminal' || ctx.surface === 'desktop'), ctx).height
  const sel = view.rows.find(r => r.agentId !== null && r.agentId === view.selected) ?? null
  if (sel) rows += Math.max(1, actionRows(rosterActions(view, sel).map(a => a.label), Math.max(1, c - cells(sel.name) - 2)))
  rows += view.rows.reduce((n, r) => n + r.queued.length, 0)
  // The box's top frame and its heading.
  return rows + 2
}

/** The transcript window's rows at `ctx`: what the body leaves under the roster, at least TRANSCRIPT_MIN_ROWS. */
export function transcriptRows(view: SwarmBrowserView, ctx: Pick<BodyContext, 'bodyColumns' | 'surface' | 'focused' | 'lists' | 'rows'>): number {
  if (!Number.isFinite(ctx.rows)) return TRANSCRIPT_INLINE_ROWS
  return Math.max(TRANSCRIPT_MIN_ROWS, Math.floor(ctx.rows) - browserTranscriptTop(view, ctx) - (TRANSCRIPT_CHROME - 2))
}

/**
 * Where a wheel tick goes in the browser, for swarm/panes.ts's onUiScroll
 * (the report's contract change): over the transcript's lines (`row`, the
 * body's row the pointer is on, the pane's scroll counted in), its window's
 * new offset from the newest, `by` > 0 toward the newest; null to pass the
 * tick on (anywhere else, every roster row being drawn, or at the window's
 * edge). Pure.
 */
export function browserWheel(view: SwarmBrowserView, ctx: Pick<BodyContext, 'bodyColumns' | 'surface' | 'focused' | 'lists' | 'rows'>, row: number, by: number): { id: string; to: number; max: number } | null {
  const t = view.transcript
  if (!t || !t.readable || t.lines.length === 0 || by === 0) return null
  const id = transcriptListId(view.swarm, t.agentId)
  const budget = transcriptRows(view, ctx)
  const w = transcriptWindow(t.lines.length, ctx.lists?.[id] ?? 0, budget)
  const top = browserTranscriptTop(view, ctx)
  if (row < top || row >= top + (w.end - w.start)) return null
  const to = transcriptWindow(t.lines.length, w.offset - Math.trunc(by), budget).offset
  return to === w.offset ? null : { id, to, max: w.max }
}

/** The transcript, read-only, in a frame: its window of lines, `↑ n earlier` / `↓ n newer` muted under them, and [Close]. */
function transcriptBox(el: PaneElements, view: SwarmBrowserView, e: BodyContext, columns: number): RenderElement | null {
  const { Box, Text } = el
  const t = view.transcript
  if (!t) return null
  const inner = Number.isFinite(columns) ? Math.max(1, columns - 4) : columns
  const w = transcriptWindow(t.lines.length, e.lists?.[transcriptListId(view.swarm, t.agentId)] ?? 0, transcriptRows(view, e))
  const footer = [w.earlier > 0 ? `↑ ${w.earlier} earlier` : '', w.newer > 0 ? `↓ ${w.newer} newer` : ''].filter(x => x !== '').join(' · ')
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={STYLE.frame} paddingX={1}>
      {heading(el, `Transcript · ${t.name}`, Number.isFinite(inner) ? inner : undefined, 'read-only')}
      {!t.readable && <Text color={STYLE.muted}>its transcript can't be read in this session</Text>}
      {t.readable && t.lines.length === 0 && <Text color={STYLE.muted}>nothing in it yet</Text>}
      {t.lines.slice(w.start, w.end).map(l => (
        <Box flexDirection="row">
          {l.map(x => (
            <Text color={x.color ?? (x.dim ? STYLE.muted : undefined)} bold={x.bold} wrap="truncate-end">
              {x.text}
            </Text>
          ))}
        </Box>
      ))}
      {footer !== '' && <Text color={STYLE.muted}>{footer}</Text>}
      {actionRow(el, [{ key: `swarm:browser:close-transcript:${view.swarm}`, label: 'Close' }], inner)}
    </Box>
  )
}

/** The roster: its heading (the lead's state its note), the list, the selected row's actions, the queued messages, the transcript. */
function roster(el: PaneElements, view: SwarmBrowserView, e: BodyContext, columns: number): RenderElement {
  const { Box, Text } = el
  const s = view.swarm
  const lead = view.rows.find(r => r.agentId === null) ?? null
  const leadMark = lead ? (lead.running ? MARK.running : MARK.idle) : null
  const client = drawsClient(el, e.surface)
  const sel = view.rows.find(r => r.agentId !== null && r.agentId === view.selected) ?? null
  const queued = view.rows.flatMap(r => r.queued.map(q => ({ name: r.name, ...q })))
  // What's above the transcript keeps to browserTranscriptTop's rows.
  return (
    <Box flexDirection="column">
      {headed(el, 'Agents', columns, lead && leadMark ? { text: `lead ${leadMark.glyph} ${lead.status}`, color: lead.statusColor } : null)}
      {list(el, rosterList(view, client), e)}
      {sel && (
        <Box flexDirection="row" columnGap={1}>
          <Box flexShrink={0} minWidth={cells(sel.name) + 1}>
            <Text color={STYLE.muted}>{`${sel.name}:`}</Text>
          </Box>
          {actionRow(el, rosterActions(view, sel), Math.max(1, columns - cells(sel.name) - 2))}
        </Box>
      )}
      {queued.map(q => (
        <Box flexDirection="row" columnGap={1}>
          <Text color={STYLE.warning} wrap="truncate-end">{`queued for ${q.name}: ${q.text}`}</Text>
          {!view.readOnly && !view.lost && (
            <Box flexShrink={0} minWidth={itemWidth({ kind: 'button', label: 'Cancel' })}>
              {actionRow(el, [{ key: `swarm:browser:cancel:${s}/${q.id}`, label: 'Cancel' }], 12)}
            </Box>
          )}
        </Box>
      ))}
      {transcriptBox(el, view, e, columns)}
    </Box>
  )
}

/** The summary under its heading, its age beside it (a warning when it's older than the latest event); one line when compact. */
function summary(el: PaneElements, view: SwarmBrowserView, compact: boolean, columns: number): RenderElement {
  const { Box, Text } = el
  const sum = view.summary
  if (compact) {
    return (
      <Box flexDirection="row" columnGap={1} marginTop={1}>
        <Box flexShrink={0} minWidth={8}>
          <Text color={STYLE.muted}>Goal now</Text>
        </Box>
        <Text wrap="truncate-end">{sum ? sum.goal : 'no summary yet'}</Text>
      </Box>
    )
  }
  const note = sum ? { text: `generated ${sum.age}${sum.stale ? ', before the latest event' : ''}`, color: sum.stale ? STYLE.warning : STYLE.muted } : null
  return (
    <Box flexDirection="column">
      {headed(el, 'Summary', columns, note)}
      {sum ? (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            <Box flexShrink={0} minWidth={8}>
              <Text color={STYLE.muted}>Goal now</Text>
            </Box>
            <Text wrap="wrap">{sum.goal}</Text>
          </Box>
          {sum.progress.map(x => (
            <Text wrap="wrap">{`· ${x}`}</Text>
          ))}
          {sum.waiting.map(x => notice(el, 'needsYou', `waiting on you: ${x}`))}
        </Box>
      ) : (
        <Text color={STYLE.muted}>no summary yet: litter writes one as the swarm reports</Text>
      )}
    </Box>
  )
}

/** Where a message goes and how, the composer's caption: "to reader · interjects now · direct". Pure. */
export function composerCaption(c: Pick<SwarmComposer, 'to' | 'targets' | 'when' | 'route' | 'routes'>): string {
  const to = c.to === null ? 'pick who it goes to' : `to ${c.targets.find(t => t.value === c.to)?.label ?? c.to}`
  const when = c.when === 'queue' ? 'queues until it settles' : 'interjects now'
  const route = c.routes.find(r => r.value === c.route)?.label ?? c.route
  return `${to} · ${when} · ${route}`
}

/** The composer: who and how as short choices, the message as a field with where it goes as its caption, and [Send]. */
function composer(el: PaneElements, view: SwarmBrowserView, e: BodyContext, columns: number): RenderElement | null {
  const { Box, Text } = el
  const c = view.composer
  if (!c) return null
  const s = view.swarm
  const address = c.address ? `/${c.address}` : ''
  return (
    <Box flexDirection="column">
      {headed(el, 'Message', columns)}
      {c.targets.length === 0 ? (
        <Text color={STYLE.muted}>no agent to send to yet</Text>
      ) : (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={2} flexWrap="wrap">
            {choose(el, { key: `swarm:browser:to:${s}`, label: 'To', value: c.to ?? '', options: c.to === null ? [{ value: '', label: 'pick an agent' }, ...c.targets] : c.targets })}
            {choose(el, {
              key: `swarm:browser:when:${s}`,
              label: 'When',
              value: c.when,
              options: [
                { value: 'interject', label: 'Interject' },
                { value: 'queue', label: 'Queue' },
              ],
            })}
            {choose(el, { key: `swarm:browser:route:${s}`, label: 'Route', value: c.route, options: c.routes })}
          </Box>
          {field(el, { key: `swarm:browser:text:${s}`, value: c.text, placeholder: 'your message', submitLabel: 'send' }, composerCaption(c), {
            surface: e.surface,
            isFocused: e.isFocused,
            focused: e.focused,
          })}
          {actionRow(
            el,
            [
              { key: `swarm:browser:send:${s}${address}`, label: 'Send', primary: true },
              c.offerQueue && { key: `swarm:browser:queue-instead:${s}${address}`, label: 'Queue instead' },
            ],
            columns,
          )}
        </Box>
      )}
    </Box>
  )
}

/** The widest the events' who column gets; a longer name is cut with `…`. */
const EVENT_WHO_MAX = 20
/** The fewest cells an event's own text keeps beside the time and who; with less, who goes, then the time. */
const EVENT_TEXT_MIN = 24

/**
 * The events' columns at `columns` (the user's live look, 2026-10-07: the
 * time and who cells wrapped, `00:4` over `7`): the time and who are fixed
 * widths that never shrink or wrap, the widest of each (who at most
 * EVENT_WHO_MAX); the event's text takes the rest and wraps in its own
 * column. On a narrow body who goes first, then the time. Pure.
 */
export function eventColumns(list: readonly { at: string; who: string }[], columns: number): { at: number; who: number } {
  const at = Math.max(0, ...list.map(ev => cells(ev.at)))
  const who = Math.min(EVENT_WHO_MAX, Math.max(0, ...list.map(ev => cells(ev.who))))
  if (!Number.isFinite(columns)) return { at, who }
  const room = (a: number, w: number) => columns - (a > 0 ? a + 1 : 0) - (w > 0 ? w + 1 : 0)
  if (room(at, who) >= EVENT_TEXT_MIN) return { at, who }
  if (room(at, 0) >= EVENT_TEXT_MIN) return { at, who: 0 }
  return { at: 0, who: 0 }
}

/** The events, evidence: muted, last; each row the time and who in fixed cells, then the event, wrapping in its column. */
function events(el: PaneElements, view: SwarmBrowserView, columns: number): RenderElement {
  const { Box, Text } = el
  const w = eventColumns(view.events, columns)
  const cell = (text: string, width: number) => (
    <Box width={width} minWidth={width} flexShrink={0}>
      <Text color={STYLE.muted} wrap="truncate-end">
        {fitCell(text, width)}
      </Text>
    </Box>
  )
  return (
    <Box flexDirection="column">
      {headed(el, 'Events', columns, view.events.length > 0 ? `the last ${view.events.length}` : null)}
      {view.events.length === 0 && <Text color={STYLE.muted}>none yet</Text>}
      {view.events.map(ev => (
        <Box flexDirection="row" columnGap={1}>
          {w.at > 0 && cell(ev.at, w.at)}
          {w.who > 0 && cell(ev.who, w.who)}
          <Box flexGrow={1} flexShrink={1}>
            <Text color={ev.color ?? STYLE.muted} wrap="wrap">
              {ev.text}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

function renderBrowser(view: SwarmBrowserView, el: PaneElements, e: BodyContext): RenderElement {
  const { Box } = el
  const s = view.swarm
  const live = !view.readOnly && !view.lost
  const columns = e.bodyColumns
  const compact = compactBrowser(e)
  // End swarm asks every node to stop and then cleans up (a request, not a hard stop): swarm/panes.ts gives it no confirm step yet.
  const toolbar: Action[] = [
    { key: `swarm:browser:history:${s}`, label: 'History' },
    { key: `swarm:browser:builder:${s}`, label: 'Builder' },
    ...(live && view.state === 'live' ? [{ key: `swarm:browser:end:${s}`, label: 'End swarm' }] : []),
  ]
  // What's above the transcript keeps to browserTranscriptTop's rows.
  return (
    <Box flexDirection="column">
      {titleRow(el, view.title, columns)}
      {browserNeeds(view).map(x => needsRow(el, x.text, x.action))}
      {noticeRow(el, view.notice)}
      {exceptions(el, view, columns)}
      {view.budget && budgetRow(el, view.budget)}
      {roster(el, view, e, columns)}
      {summary(el, view, compact, columns)}
      {composer(el, view, e, columns)}
      <Box marginTop={1}>{actionRow(el, toolbar, columns)}</Box>
      {!compact && events(el, view, columns)}
    </Box>
  )
}

function renderHistory(view: SwarmHistoryView, el: PaneElements, e: BodyContext): RenderElement {
  const { Box, Text } = el
  const columns = e.bodyColumns
  return (
    <Box flexDirection="column">
      {titleRow(el, view.title, columns)}
      {noticeRow(el, view.notice)}
      {headed(el, 'The goal, summary by summary', columns, view.entries.length > 0 ? `${view.entries.length}` : null)}
      {view.entries.length === 0 && <Text color={STYLE.muted}>no summary yet</Text>}
      {view.entries.map(x => (
        <Box flexDirection="row" columnGap={1}>
          <Box flexShrink={0} minWidth={cells(x.at)}>
            <Text color={STYLE.muted}>{x.at}</Text>
          </Box>
          <Text wrap="wrap">{x.goal}</Text>
        </Box>
      ))}
      <Box marginTop={1}>{actionRow(el, [{ key: `swarm:history:back:${view.swarm}`, label: 'Back to browser', primary: true }], columns)}</Box>
    </Box>
  )
}

/** A recovery row's pick box: `[x]` or `[ ]`, a plain Button. */
function pickBox(el: PaneElements, key: string, picked: boolean): RenderElement {
  const { Button } = el
  return <Button key={key} label={picked ? '[x]' : '[ ]'} plain onPress={() => {}} />
}

function renderRecovery(view: SwarmRecoveryView, el: PaneElements, e: BodyContext): RenderElement {
  const { Box, Text } = el
  const s = view.swarm
  const columns = e.bodyColumns
  return (
    <Box flexDirection="column">
      {titleRow(el, view.title, columns)}
      {noticeRow(el, view.notice)}
      {notice(
        el,
        'needsYou',
        view.stopping
          ? 'It was ending when the session stopped: finish ending it, or leave it stopped.'
          : 'These were running when the session stopped. Resume or re-spawn the orchestrators (their workers come back through them), or leave them stopped.',
      )}
      {headed(el, view.stopping ? 'What was running' : 'Orchestrators and their workers', columns)}
      {view.rows.map(r => (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            {r.pickable ? pickBox(el, `swarm:recovery:pick:${s}/${r.node}`, r.picked) : !view.stopping && <Text>{'   '}</Text>}
            <Text color={STYLE.name} bold={r.kind === 'orchestrator'}>
              {r.node}
            </Text>
            <Text color={STYLE.muted}>{r.kind}</Text>
            {r.note !== '' && <Text color={STYLE.muted}>{`· ${r.note}`}</Text>}
          </Box>
          {r.instances.map(x => (
            <Box flexDirection="column" paddingLeft={4}>
              <Box flexDirection="row" columnGap={1}>
                <Text>{x.name}</Text>
                <Text color={x.color}>{`${x.glyph ? `${x.glyph} ` : ''}${x.state}`}</Text>
              </Box>
              {x.report !== '' && (
                <Box paddingLeft={2}>
                  <Text color={STYLE.muted} wrap="truncate-end">{`last report: ${x.report}`}</Text>
                </Box>
              )}
            </Box>
          ))}
        </Box>
      ))}
      <Box marginTop={1}>
        {view.stopping
          ? actionRow(
              el,
              [
                { key: `swarm:recovery:finish:${s}`, label: 'Finish ending', primary: true },
                { key: `swarm:recovery:leave:${s}`, label: 'Leave stopped' },
              ],
              columns,
            )
          : actionRow(
              el,
              [
                { key: `swarm:recovery:resume-all:${s}`, label: 'Resume all', primary: true },
                { key: `swarm:recovery:resume-selected:${s}`, label: 'Resume selected' },
                { key: `swarm:recovery:respawn:${s}`, label: 'Re-spawn …' },
                { key: `swarm:recovery:leave:${s}`, label: 'Leave stopped' },
              ],
              columns,
            )}
      </Box>
    </Box>
  )
}

function renderUnsettled(view: SwarmUnsettledView, el: PaneElements, e: BodyContext): RenderElement {
  const { Box, Text } = el
  const s = view.swarm
  const columns = e.bodyColumns
  return (
    <Box flexDirection="column">
      {titleRow(el, view.title, columns)}
      {noticeRow(el, view.notice)}
      <Text color={STYLE.muted}>{`ending since ${view.since}`}</Text>
      {headed(el, 'Still running', columns, view.nodes.length > 0 ? String(view.nodes.length) : null)}
      {view.nodes.length === 0 && <Text color={STYLE.muted}>no node</Text>}
      {view.nodes.length > 0 &&
        rows(
          el,
          [{ drop: 0 }, { drop: 0, fill: true }],
          view.nodes.map(x => [{ text: x.name, color: STYLE.name }, { text: x.status }]),
          columns,
        )}
      {view.calls.length > 0 && headed(el, 'Open tool calls', columns)}
      {view.calls.length > 0 &&
        rows(
          el,
          [{ drop: 0 }, { drop: 0, fill: true }, { drop: 1 }],
          view.calls.map(x => [{ text: x.name, color: STYLE.name }, { text: x.tool }, { text: `for ${x.age}`, color: STYLE.muted }]),
          columns,
        )}
      {view.shells.length > 0 && headed(el, 'Shells', columns)}
      {view.shells.length > 0 &&
        rows(
          el,
          [{ drop: 0 }, { drop: 0, fill: true }, { drop: 1 }],
          view.shells.map(x => [{ text: x.name, color: STYLE.name }, { text: x.shellId }, { text: `for ${x.age}`, color: STYLE.muted }]),
          columns,
        )}
      {view.reservations > 0 && <Text color={STYLE.muted}>{`${view.reservations} spawn${view.reservations === 1 ? '' : 's'} still reserved`}</Text>}
      <Box marginTop={1}>
        {actionRow(
          el,
          [
            { key: `swarm:unsettled:wait:${s}`, label: 'Wait longer', primary: true },
            { key: `swarm:unsettled:hard-stop:${s}`, label: 'Hard stop' },
            { key: `swarm:unsettled:keep:${s}`, label: 'End, keep everything' },
          ],
          columns,
        )}
      </Box>
    </Box>
  )
}
