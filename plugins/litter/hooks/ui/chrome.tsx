// The chrome every section of the `litter` pane shares (phase 5b, WP-DA):
// pure helpers over the surface's element table, so every section reads the
// same way. The hub draws the header, the strip and the keys line with them;
// the sections' bodies use the rest as their packages restyle them.
//
// The rules:
//  - what goes first: state, then what needs you, then detail, then evidence;
//    exceptions above rosters;
//  - one primary action per view (`actions` keeps one), the rest secondary;
//    a destructive action never sits beside a finished thing;
//  - plain words over codes ("plan ✓ tests ✓", not "PA TG");
//  - a glyph and a word with every color (style.ts's MARK): dark-ansi folds
//    several keys into one color;
//  - colors from style.ts only, and no background but SELECTED_BG;
//  - columns from `ctx.bodyColumns` (`planColumns`), never a fixed width;
//    a body fits `ctx.rows` (`plan`), so the keys line stays in the pane;
//  - an empty state names the next step, as a command;
//  - secondary text is `muted`, never `dimColor` alone: `themed` draws a dim
//    Text with no color in `muted` (style.ts says why).
//
// `h` and `Fragment` are the environment's JSX factory, so no name here takes them.

import type { RenderElement } from 'claude-code'
import type { PaneElements, PaneRender } from '../hooktypes'
import type { HubSection, HubTab, SwarmSpan } from '../../types/index'
import { cells, fitSpans } from '../band/view'
import { NOTICE_STYLE, SELECTED_MARK, STYLE, type NoticeLevel } from './style'

const noop = (): void => {}

// ---------------------------------------------------------------------------
// The body contract

/** What a section's body renderer gets beside its view and the element table. */
export type BodyContext = {
  surface: PaneRender['surface']
  /** Cells across the body (the Pane's own). */
  bodyColumns: number
  /** The person gave the pane the keyboard: hotkeys and Tab reach it. */
  isFocused: boolean
  /** `dock` beside the transcript, or `inline` above the prompt. */
  placement: 'dock' | 'inline'
  /** The engine's window over the tree (the Pane's own). */
  scroll: { offset: number; bodyRows: number }
  /** The rows the body has under the chrome (plan's `bodyRows`); fit them and the keys line stays in the pane. */
  rows: number
  /** The element the pane's focus ring is on (ui.focus, kept in the hub's atom), or null: a list's focused row, a field's accent frame (WP-DA2). */
  focused: string | null
  /** Each list's window offset, by the list's id (ui.scroll over it, its footer's Buttons; kept in the hub's atom). */
  lists: Readonly<Record<string, number>>
}

/** A section's body: its view (null before the first build), the hub's themed table, and the context. Pure. */
export type BodyRenderer<V> = (view: V | null, el: PaneElements, ctx: BodyContext) => RenderElement

/**
 * What a section tells the hub beside its body, exported by the section's own
 * module so each section package edits only its own files (phase 5b): `fits`,
 * once the body keeps to `ctx.rows` (the hub then clips it there in the dock,
 * so the keys line stays at the pane's foot); `keys`, the section's own keys
 * for the keys line, drawn before the hub's. Pure.
 */
export type SectionMeta<V> = { fits: boolean; keys: (view: V | null) => readonly KeyHint[] }

/**
 * The table with its Text drawing a dim Text that names no color in `muted`
 * (the theme's `inactive`), not the terminal's faint attribute. Buttons keep
 * their own `dimColor`: the engine draws a dim Button at full strength under
 * the focus. Apply it once, over `tableFor`'s table; a body's own `tableFor`
 * of the result keeps it.
 */
export function themed(el: PaneElements): PaneElements {
  const Text = el.Text
  const MutedText: typeof Text = props => {
    if (props.dimColor !== true || props.color !== undefined) return Text(props)
    const { dimColor: _faint, ...rest } = props
    return Text({ ...rest, color: STYLE.muted })
  }
  return { ...el, Text: MutedText }
}

// ---------------------------------------------------------------------------
// The layout plan: a pure row budget

/** From this many body columns, panels sit side by side. */
export const WIDE_COLUMNS = 100

export type Layout = {
  /** Panels side by side. */
  wide: boolean
  headerRows: number
  stripRows: number
  keysRows: number
  /** What's left for the body, the gaps taken: `ctx.rows`. Infinite when the surface gives no bound. */
  bodyRows: number
}

/**
 * The pane's rows, top to bottom: the header (the title and live lines, and
 * a context line when there's one), the strip packed into `bodyColumns`, a
 * gap, the body, a gap and the keys line (on the terminal). The body gets
 * what's left of `bodyRows`, never less than 0.
 */
export function plan(o: { bodyColumns: number; bodyRows: number; context: boolean; strip: readonly number[]; keys: boolean }): Layout {
  const headerRows = o.context ? 3 : 2
  const stripRows = o.strip.length === 0 ? 0 : packWidths(o.strip, o.bodyColumns).length
  const keysRows = o.keys ? 2 : 0
  const used = headerRows + stripRows + 1 + keysRows
  const bodyRows = Number.isFinite(o.bodyRows) ? Math.max(0, Math.floor(o.bodyRows) - used) : Number.POSITIVE_INFINITY
  return { wide: Number.isFinite(o.bodyColumns) && o.bodyColumns >= WIDE_COLUMNS, headerRows, stripRows, keysRows, bodyRows }
}

/** Items of these widths in rows of `width` cells with one cell between: each row's item indexes. Never an empty row. */
export function packWidths(widths: readonly number[], width: number): number[][] {
  const room = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : Number.POSITIVE_INFINITY
  const out: number[][] = []
  let used = 0
  for (let i = 0; i < widths.length; i++) {
    const w = widths[i]!
    const last = out[out.length - 1]
    if (last && used + 1 + w <= room) {
      last.push(i)
      used += 1 + w
    } else {
      out.push([i])
      used = w
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Header and title

/** A title: the name bold in the accent, then ` · <mode>` muted. */
export function title(el: PaneElements, name: string, mode?: string | null): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexDirection="row">
      <Text bold color={STYLE.accent}>
        {name}
      </Text>
      {mode ? <Text color={STYLE.muted}>{` · ${mode}`}</Text> : null}
    </Box>
  )
}

/** The header: `litter · <Section>`, the live line, and a muted context line when the section has one. */
export function header(el: PaneElements, head: { section: string; live: readonly SwarmSpan[]; context?: string | null }, columns: number): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexDirection="column">
      {title(el, 'litter', head.section)}
      {spansLine(el, head.live, columns)}
      {head.context ? (
        <Text color={STYLE.muted} wrap="truncate-end">
          {head.context}
        </Text>
      ) : null}
    </Box>
  )
}

/** One line of spans cut to `columns` with `…`: a dim span with no color is muted. */
export function spansLine(el: PaneElements, spans: readonly SwarmSpan[], columns: number): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexDirection="row">
      {fitSpans(spans, Number.isFinite(columns) ? columns : Number.POSITIVE_INFINITY).map(s => (
        <Text color={s.color ?? (s.dim ? STYLE.muted : undefined)} bold={s.bold} wrap="truncate-end">
          {s.text}
        </Text>
      ))}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// The strip

export const STRIP_PREFIX = 'litter:section:'
/** A strip Button's key. */
export const stripKey = (section: HubSection): string => `${STRIP_PREFIX}${section}`

/** A tab's label: the section, its count, and `⚑` when something there needs you. */
export const tabLabel = (tab: HubTab): string => `${tab.label}${tab.count !== null && tab.count > 0 ? ` ${tab.count}` : ''}${tab.needsYou ? ' ⚑' : ''}`

/** How wide each tab draws on the terminal: a plain Button is `1: label` with its hotkey, the label alone without; the shown one `› `. */
export function stripWidths(tabs: readonly HubTab[], shown: HubSection, isFocused: boolean): number[] {
  return tabs.map(t => cells(tabLabel(t)) + (isFocused ? 3 : 0) + (t.section === shown ? 2 : 0))
}

/**
 * The strip: each section a plain Button keyed `litter:section:<id>`, with
 * hotkey 1–7 while the pane is focused (a Pane's hotkeys never reach the
 * composer). The shown one is bold text with `›`, not a Button: pressing it
 * would do nothing. Sections use letters for their own hotkeys, never digits.
 */
export function strip(el: PaneElements, tabs: readonly HubTab[], shown: HubSection, isFocused: boolean): RenderElement {
  const { Box, Button, Text } = el
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      {tabs.map((t, i) =>
        t.section === shown ? (
          <Text bold color={STYLE.label}>{`${SELECTED_MARK} ${isFocused ? `${i + 1}: ` : ''}${tabLabel(t)}`}</Text>
        ) : (
          <Button key={stripKey(t.section)} label={tabLabel(t)} plain {...(isFocused ? { hotkey: String(i + 1) } : {})} onPress={noop} />
        ),
      )}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Headings, rows, pairs

/** A heading's note: muted, or in a color of its own (a path's, a warning's). */
export type Note = { text: string; color?: string }

/** The heading's rule. */
export const RULE = '─'
/** The fewest `─` a heading's rule has, however narrow the body (WP-DA2). */
export const MIN_RULE = 3
/** The rule's end after a note: ` ──`. */
export const RULE_TAIL = 2
/** A rule with no width to fill to: this many `─`, wrapped in a one-row Box that shows the first row's worth. */
const RULE_FILL = 400

/** A heading at `columns`: the title, cut only when even the shortest rule wouldn't fit beside it; the rule's length; the note, when it fits. Infinite columns: the rule fills by flex (`rule` Infinity). Pure. */
export function headingPlan(text: string, columns: number, note?: string | null): { title: string; rule: number; note: string | null } {
  const n = note ? note : null
  if (!Number.isFinite(columns)) return { title: text, rule: Number.POSITIVE_INFINITY, note: n }
  const c = Math.max(1, Math.floor(columns))
  const t = cells(text)
  // title ␣ rule [␣ note ␣ ──]
  if (n !== null) {
    const rule = c - t - 1 - (1 + cells(n) + 1 + RULE_TAIL)
    if (rule >= MIN_RULE) return { title: text, rule, note: n }
  }
  const rule = c - t - 1
  if (rule >= MIN_RULE) return { title: text, rule, note: null }
  const title = fitSpans([{ text }], Math.max(1, c - 1 - MIN_RULE))[0]?.text ?? ''
  return { title, rule: Math.max(MIN_RULE, c - cells(title) - 1), note: null }
}

/**
 * A section heading on one row (WP-DA2, "make each title stand out more"):
 * the title bold in the heading color, then a faint rule (`─`) to the end of
 * `columns` (the body's, or a panel's inner width), the optional note muted
 * (or in its own color) just before the rule's end. A narrow body cuts the
 * title before the rule goes under MIN_RULE, and drops the note first. With
 * no `columns` the rule fills what the row has left, by flex.
 */
export function heading(el: PaneElements, text: string, columns?: number, note?: string | Note | null): RenderElement {
  const { Box, Text } = el
  const n: Note | null = typeof note === 'string' ? (note === '' ? null : { text: note }) : (note ?? null)
  const plan = headingPlan(text, columns ?? Number.POSITIVE_INFINITY, n?.text ?? null)
  return (
    <Box flexDirection="row" columnGap={1}>
      <Text bold color={STYLE.heading} wrap="truncate-end">
        {plan.title}
      </Text>
      {Number.isFinite(plan.rule) ? (
        <Text color={STYLE.faint}>{RULE.repeat(plan.rule)}</Text>
      ) : (
        // No width of its own (so the title keeps its cells): it grows into the rest of the row, its one row showing.
        <Box flexGrow={1} width={0} minWidth={MIN_RULE} height={1} overflow="hidden">
          <Text color={STYLE.faint} wrap="wrap">
            {RULE.repeat(RULE_FILL)}
          </Text>
        </Box>
      )}
      {plan.note !== null ? (
        <Text color={n?.color ?? STYLE.muted} wrap="truncate-end">
          {plan.note}
        </Text>
      ) : null}
      {plan.note !== null ? <Text color={STYLE.faint}>{RULE.repeat(RULE_TAIL)}</Text> : null}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Fields

/** An Input's spec, as field() draws it: `label` drawn before it (no `label`, no `: ` marker). */
export type FieldInput = { key: string; label?: string; value: string; placeholder?: string; submitLabel?: string; autoFocus?: boolean }

/** Where a field is drawn: the surface, and the ring (the pane's keys, the element holding them) when known. */
export type FieldAt = { surface: string; isFocused?: boolean; focused?: string | null }

/**
 * Whether the surface draws a field's frame: the terminal does. A desktop and
 * VS Code draw a native field with its own outline, and the mobile app no
 * field at all (its Input-less table draws the value as text).
 */
export const framesFields = (surface: string): boolean => surface === 'terminal'

/** The rows a field takes: its frame's three (or the Input's one), and the caption's. */
export const fieldRows = (surface: string, caption: boolean): number => (framesFields(surface) ? 3 : 1) + (caption ? 1 : 0)

/**
 * A field that reads as one (WP-DA2, "differentiate between placeholder text
 * and caption text"): the Input in a round box in the frame color (the
 * accent while it holds the ring and the pane the keys), its `label` set
 * when given, and the caption, if any, one muted line under the box, never
 * above the field. The engine draws the placeholder dim and the `: ` after a
 * label; neither is litter's to style. Where no frame is drawn, the Input
 * alone with its caption; with no Input (mobile), the value as text.
 */
export function field(el: PaneElements, input: FieldInput, caption?: string | null, at?: FieldAt): RenderElement {
  const { Box, Text } = el
  const cap = caption ? (
    <Text color={STYLE.muted} wrap="truncate-end">
      {caption}
    </Text>
  ) : null
  if (!('Input' in el)) {
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">{`${input.label ? `${input.label}: ` : ''}${input.value || input.placeholder || ''}`}</Text>
        {cap}
      </Box>
    )
  }
  const { Input } = el
  const control = (
    <Input
      key={input.key}
      {...(input.label ? { label: input.label } : {})}
      value={input.value}
      {...(input.placeholder ? { placeholder: input.placeholder } : {})}
      {...(input.submitLabel ? { submitLabel: input.submitLabel } : {})}
      {...(input.autoFocus ? { autoFocus: true as const } : {})}
      onInput={noop}
      onSubmit={noop}
    />
  )
  const ringed = at?.isFocused === true && at.focused === input.key
  return (
    <Box flexDirection="column">
      {at === undefined || framesFields(at.surface) ? (
        <Box flexDirection="row" borderStyle="round" borderColor={ringed ? STYLE.accent : STYLE.frame} paddingX={1}>
          {control}
        </Box>
      ) : (
        control
      )}
      {cap}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Rows a text takes

/** The rows a Text with `wrap="wrap"` takes at `columns`: words broken greedily at spaces, a word wider than the line hard-broken (as the engine's wrap does). Pure. */
export function textRows(text: string, columns: number): number {
  if (!Number.isFinite(columns)) return Math.max(1, text.split('\n').length)
  const c = Math.max(1, Math.floor(columns))
  let rows = 0
  for (const line of text.split('\n')) {
    let used = 0
    let lineRows = 1
    for (const word of line.split(' ')) {
      const w = cells(word)
      const need = used === 0 ? w : used + 1 + w
      if (need <= c) {
        used = need
        continue
      }
      // A new line for the word, hard-broken when it's wider than one.
      if (used > 0) lineRows++
      lineRows += Math.max(0, Math.ceil(w / c) - 1)
      used = w % c === 0 && w > 0 ? c : w % c
    }
    rows += lineRows
  }
  return Math.max(1, rows)
}

/** The rows a wrapping row of Texts (no gap) takes at `columns`: each Text whole on a row while it fits. Pure. */
export function spanRows(spans: readonly { text: string }[], columns: number): number {
  if (!Number.isFinite(columns) || spans.length === 0) return 1
  const c = Math.max(1, Math.floor(columns))
  let rows = 1
  let used = 0
  for (const s of spans) {
    const w = cells(s.text)
    if (used > 0 && used + w > c) {
      rows++
      used = 0
    }
    used += w
  }
  return rows
}

/** One cell of a row. */
export type Cell = { text: string; color?: string; bold?: boolean; dim?: boolean }
/**
 * A column of a row: `drop` 0 is essential, never dropped; a higher number
 * drops sooner. `fill` (one per row) takes what's left and is cut with `…`.
 */
export type Column = { drop: number; fill?: boolean }

/**
 * Which columns a table of rows keeps at `width`, and each one's width: the
 * widest cell of each, one cell between. When they don't fit, the column with
 * the highest `drop` goes first, then the next; then the fill column is cut.
 */
export function planColumns(columns: readonly Column[], rows: readonly (readonly Cell[])[], width: number): { shown: number[]; widths: number[] } {
  const natural = columns.map((_, i) => Math.max(0, ...rows.map(r => cells(r[i]?.text ?? ''))))
  const shown = columns.map((_, i) => i)
  const total = () => shown.reduce((n, i) => n + natural[i]!, 0) + Math.max(0, shown.length - 1)
  const room = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : Number.POSITIVE_INFINITY
  while (total() > room) {
    let worst = -1
    for (const i of shown) if (columns[i]!.drop > 0 && (worst < 0 || columns[i]!.drop >= columns[worst]!.drop)) worst = i
    if (worst < 0) break
    shown.splice(shown.indexOf(worst), 1)
  }
  const widths = columns.map((_, i) => natural[i]!)
  const fill = shown.find(i => columns[i]!.fill)
  const over = total() - room
  if (over > 0 && fill !== undefined) widths[fill] = Math.max(1, natural[fill]! - over)
  return { shown, widths }
}

/** A cell's text padded or cut (`…`) to `n` cells. */
export function fitCell(text: string, n: number): string {
  const w = cells(text)
  if (w <= n) return text + ' '.repeat(n - w)
  return (fitSpans([{ text }], n)[0]?.text ?? '').padEnd(n)
}

/** One row of a table planned by planColumns: its kept cells, aligned. */
export function row(el: PaneElements, cellsOf: readonly Cell[], planned: { shown: number[]; widths: number[] }): RenderElement {
  const { Box, Text } = el
  const last = planned.shown[planned.shown.length - 1]
  return (
    <Box flexDirection="row" columnGap={1}>
      {planned.shown.map(i => {
        const c = cellsOf[i] ?? { text: '' }
        const text = i === last ? fitCell(c.text, planned.widths[i]!).trimEnd() : fitCell(c.text, planned.widths[i]!)
        return (
          <Text color={c.color ?? (c.dim ? STYLE.muted : undefined)} bold={c.bold} wrap="truncate-end">
            {text}
          </Text>
        )
      })}
    </Box>
  )
}

/** Rows as a table at `width`: columns aligned, the least important dropped first. */
export function rows(el: PaneElements, columns: readonly Column[], data: readonly (readonly Cell[])[], width: number): RenderElement {
  const { Box } = el
  const planned = planColumns(columns, data, width)
  return <Box flexDirection="column">{data.map(r => row(el, r, planned))}</Box>
}

/** Label-value pairs on a wrapping line: the label muted, the value in the label color. */
export function pairs(el: PaneElements, list: readonly { label: string; value: string; color?: string }[]): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      {list.map(x => (
        <Box flexDirection="row" columnGap={1}>
          <Text color={STYLE.muted}>{x.label}</Text>
          <Text color={x.color ?? STYLE.label}>{x.value}</Text>
        </Box>
      ))}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Actions, toolbars

/** A Button's spec: `primary` is the view's one main action. */
export type Action = { key: string; label: string; primary?: boolean; hotkey?: string; autoFocus?: boolean }

/** One Button: the primary in the action color (`variant: 'primary'`), a secondary dim. */
export function action(el: PaneElements, a: Action): RenderElement {
  const { Button } = el
  return (
    <Button
      key={a.key}
      label={a.label}
      {...(a.primary ? { variant: 'primary' as const } : { dimColor: true })}
      {...(a.hotkey ? { hotkey: a.hotkey } : {})}
      {...(a.autoFocus ? { autoFocus: true as const } : {})}
      onPress={noop}
    />
  )
}

/** A row of actions, wrapping when narrow; only the first one marked primary stays primary. */
export function actions(el: PaneElements, list: readonly (Action | null | false)[]): RenderElement {
  const { Box } = el
  let primary = false
  const kept = list.filter((a): a is Action => !!a).map(a => {
    const p = a.primary === true && !primary
    if (p) primary = true
    return { ...a, primary: p }
  })
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      {kept.map(a => action(el, a))}
    </Box>
  )
}

/** A toolbar item as data: a Button, a plain Button (`1: label` with a hotkey), or text. */
export type ToolItem = { kind: 'button' | 'plain' | 'text'; key?: string; label: string; hotkey?: string; primary?: boolean; dim?: boolean; bold?: boolean; color?: string }

/** The cells an item draws on the terminal: `[ label ]`, `1: label`, or the text. */
export function itemWidth(item: ToolItem): number {
  if (item.kind === 'button') return cells(item.label) + 4
  if (item.kind === 'plain') return cells(item.label) + (item.hotkey ? cells(item.hotkey) + 2 : 0)
  return cells(item.label)
}

/** Items packed into rows of `width` cells. */
export function packItems(items: readonly ToolItem[], width: number): ToolItem[][] {
  return packWidths(items.map(itemWidth), width).map(r => r.map(i => items[i]!))
}

/** A toolbar: the items packed by width, each row one line. */
export function toolbar(el: PaneElements, items: readonly ToolItem[], width: number): RenderElement {
  const { Box, Button, Text } = el
  return (
    <Box flexDirection="column">
      {packItems(items, width).map(r => (
        <Box flexDirection="row" columnGap={1}>
          {r.map(item =>
            item.kind === 'text' ? (
              <Text color={item.color ?? (item.dim ? STYLE.muted : undefined)} bold={item.bold}>
                {item.label}
              </Text>
            ) : (
              <Button
                key={item.key ?? item.label}
                label={item.label}
                {...(item.kind === 'plain' ? { plain: true as const } : {})}
                {...(item.primary ? { variant: 'primary' as const } : {})}
                {...(item.dim ? { dimColor: true } : {})}
                {...(item.hotkey ? { hotkey: item.hotkey } : {})}
                onPress={noop}
              />
            ),
          )}
        </Box>
      ))}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Empty states, notices, banners

/** An empty state that names the next step: `<what>: <command> <does>`, the command in the link color. */
export function empty(el: PaneElements, what: string, next?: { command: string; does: string } | null): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexDirection="row" flexWrap="wrap">
      <Text color={STYLE.muted}>{next ? `${what}: ` : what}</Text>
      {next ? <Text color={STYLE.link}>{next.command}</Text> : null}
      {next ? <Text color={STYLE.muted}>{` ${next.does}`}</Text> : null}
    </Box>
  )
}

/** One line at its level: the glyph and the text in the level's key. */
export function notice(el: PaneElements, level: NoticeLevel, text: string): RenderElement {
  const { Text } = el
  const s = NOTICE_STYLE[level]
  return (
    <Text color={s.color} wrap="wrap">
      {`${s.glyph} ${text}`}
    </Text>
  )
}

/** A notice the person can dismiss: the line, then a [Dismiss] keyed `dismissKey`. */
export function banner(el: PaneElements, level: NoticeLevel, text: string, dismissKey: string): RenderElement {
  const { Box, Button } = el
  return (
    <Box flexDirection="row" columnGap={1}>
      {notice(el, level, text)}
      <Button key={dismissKey} label="Dismiss" role="dismiss" dimColor onPress={noop} />
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Panels and the keys line

/** A round-bordered box: the frame in `frame`, or the accent while it waits on you. */
export type Panel = { title: string; waiting?: boolean; body: RenderElement }

/** Panels side by side when `wide`, else stacked. */
export function panels(el: PaneElements, list: readonly Panel[], wide: boolean): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexDirection={wide ? 'row' : 'column'} columnGap={1}>
      {list.map(x => (
        <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={x.waiting ? STYLE.accent : STYLE.frame} paddingX={1}>
          <Text bold color={x.waiting ? STYLE.accent : STYLE.heading}>
            {x.title}
          </Text>
          {x.body}
        </Box>
      ))}
    </Box>
  )
}

/** One key of the keys line. */
export type KeyHint = { key: string; word: string }

/**
 * The keys line, at the pane's foot: each key bold in the heading color, its
 * word muted, a faint `·` between. Unfocused, how to give the pane the keys:
 * `ctrl+x tab` in the warning color.
 */
export function keysLine(el: PaneElements, keys: readonly KeyHint[], isFocused: boolean): RenderElement {
  const { Box, Text } = el
  if (!isFocused) {
    return (
      <Box flexDirection="row" marginTop={1}>
        <Text color={STYLE.warning}>ctrl+x tab</Text>
        <Text color={STYLE.muted}> gives the pane the keys</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
      {keys.map((k, i) => (
        <Box flexDirection="row">
          {i > 0 ? <Text color={STYLE.faint}> · </Text> : null}
          <Text bold color={STYLE.heading}>
            {k.key}
          </Text>
          <Text color={STYLE.muted}>{` ${k.word}`}</Text>
        </Box>
      ))}
    </Box>
  )
}
