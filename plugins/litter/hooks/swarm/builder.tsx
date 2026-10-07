// WP-N: the builder view's draw (15.5's mockup): the tree as the Client
// module, the inspector's fields with their enforcement badges, the briefs,
// the status strip and the buttons. A pure render function; browser.tsx's
// renderSwarmPane calls it for the builder view. The start screen and a
// proposal are drawn here too, and `tableFor`, the surface's elements, which
// every section takes.
//
// Phase 5b (WP-DD): the Swarms bodies are drawn with the chrome
// (ui/chrome.tsx, ui/list.tsx): `heading` for every heading, `field` for
// every Input, `list` for the template picker and the saved swarms, one
// primary action per view with the rest dim, packed by width. The pieces
// below (titleRow, choose, actionRow) are this package's own, for its bodies
// alone. The old shared header, line, section, buttons, input and select
// went once every section drew with the chrome.
//
// Every element's handler is a no-op: the panes' ui.press, ui.input and
// ui.select hooks (panes.ts) answer each key without passing it on. Text in a
// view is already cleaned and cut (view.ts); colors are its theme keys.
//
// Contract owner: phase 2b-1, package N.

import type { RenderElement } from 'claude-code'
import type { PaneElements } from '../hooktypes'
import type { BodyContext } from '../ui/chrome'
import type { SwarmPaneView } from '../ports'
import type {
  SwarmBadge,
  SwarmBuilderView,
  SwarmField,
  SwarmFieldGroup,
  SwarmNotice,
  SwarmOption,
  SwarmProposalView,
  SwarmSpan,
  SwarmStartView,
  SwarmTemplateForm,
  SwarmTreeProps,
  SwarmTreeRow,
} from '../../types/index'
import { MARK, NOTICE_STYLE, SELECTED_MARK, STYLE } from '../ui/style'
import {
  MIN_RULE,
  RULE,
  WIDE_COLUMNS,
  action,
  field,
  fieldRows,
  framesFields,
  heading,
  itemWidth,
  notice as noticeLine,
  packWidths,
  panels,
  textRows,
  type Action,
} from '../ui/chrome'
import { list, type ListSpec } from '../ui/list'
import { cells, fitSpans } from '../band/view'
import { BADGE_COLOR, TECHNICAL_DIFF } from './view'

// ---------------------------------------------------------------------------
// Shared pieces

const noop = (): void => {}

/**
 * The table with only what the surface draws: `$.ui.resolve` completes every
 * table to every name (a name the surface lacks draws a fragment), so `'Input'
 * in el` alone can't tell. All but mobile draw Input and Select; the terminal
 * and the desktop draw Client.
 */
export function tableFor(el: PaneElements, surface: string): PaneElements {
  const all = el as unknown as Record<string, unknown>
  const t: Record<string, unknown> = {}
  for (const name of ['Box', 'Text', 'Button', 'Link', 'Code', 'Markdown']) t[name] = all[name]
  if (surface !== 'mobile') {
    t.Input = all.Input
    t.Select = all.Select
  }
  if (surface === 'terminal' || surface === 'desktop') t.Client = all.Client
  return t as unknown as PaneElements
}

/** A Select's options with its value among them (a value no option has is refused), never empty. */
export function optionsWith(options: readonly SwarmOption[], value: string): SwarmOption[] {
  const out = options.length > 0 ? [...options] : [{ value, label: value || 'not set' }]
  if (!out.some(o => o.value === value)) out.push({ value, label: `${value} (not offered)` })
  const seen = new Set<string>()
  return out.filter(o => (seen.has(o.value) ? false : (seen.add(o.value), true)))
}

const hasFields = (el: PaneElements): boolean => 'Input' in el && 'Select' in el

// ---------------------------------------------------------------------------
// WP-DD's pieces: the Swarms and Doctor bodies' own, where the chrome has none

const noopSelect = (): void => {}

/** Whether the table draws Clients (the terminal and the desktop): a list with a menu is one there. */
export const drawsClient = (el: PaneElements, surface: string): boolean => 'Client' in el && (surface === 'terminal' || surface === 'desktop')

/**
 * A view's first line (COMMON-5B, "No title line of your own"): the swarm's
 * name bold in its color and what the view shows, muted (view.ts's title),
 * then a faint rule to `columns`. The spans are cut with `…` before the rule
 * goes under MIN_RULE. The hub's header above already says `litter · Swarms`.
 */
export function titleRow(el: PaneElements, spans: readonly SwarmSpan[], columns: number): RenderElement {
  const { Box, Text } = el
  const finite = Number.isFinite(columns)
  const c = finite ? Math.max(1, Math.floor(columns)) : Number.POSITIVE_INFINITY
  const shown = fitSpans(spans, finite ? Math.max(1, c - 1 - MIN_RULE) : Number.POSITIVE_INFINITY)
  const used = shown.reduce((n, s) => n + cells(s.text), 0)
  const rule = finite ? Math.max(MIN_RULE, c - used - 1) : MIN_RULE
  return (
    <Box flexDirection="row">
      {shown.map(s => (
        <Text color={s.color ?? (s.dim ? STYLE.muted : undefined)} bold={s.bold} wrap="truncate-end">
          {s.text}
        </Text>
      ))}
      <Text color={STYLE.faint}>{` ${RULE.repeat(rule)}`}</Text>
    </Box>
  )
}

/** The last action's outcome under the first line: the chrome's notice, its glyph and its level's color. */
export function noticeRow(el: PaneElements, n: SwarmNotice | null): RenderElement | null {
  return n ? noticeLine(el, n.level, n.text) : null
}

/** A line that needs you (or a proposal that can't be read): the chrome's notice at its level, wrapping beside its action, a Button that never shrinks. */
export function needsRow(el: PaneElements, text: string, a: Action | readonly Action[] | null, level: 'needsYou' | 'error' = 'needsYou'): RenderElement {
  const { Box } = el
  const list: readonly Action[] = a === null ? [] : 'key' in a ? [a] : a
  return (
    <Box flexDirection="row" columnGap={1}>
      {noticeLine(el, level, text)}
      {list.map(x => (
        <Box flexShrink={0} minWidth={itemWidth({ kind: 'button', label: x.label })}>
          {action(el, x)}
        </Box>
      ))}
    </Box>
  )
}

/** The rows needsRow takes at `columns`: its notice wrapped beside the Buttons. For the wheel's hit tests. */
export function needsRowCount(text: string, label: string | readonly string[] | null, columns: number): number {
  const labels = label === null ? [] : typeof label === 'string' ? [label] : label
  const used = labels.reduce((n, l) => n + 1 + itemWidth({ kind: 'button', label: l }), 0)
  const room = labels.length > 0 && Number.isFinite(columns) ? Math.max(1, columns - used) : columns
  return textRows(`${NOTICE_STYLE.needsYou.glyph} ${text}`, room)
}

/** A short, fixed choice (COMMON-5B item 2): a Select where the surface draws one, else its value's label as text. */
export function choose(el: PaneElements, f: { key: string; label: string; value: string; options: readonly SwarmOption[] }): RenderElement {
  const { Box, Text } = el
  const options = optionsWith(f.options, f.value)
  if ('Select' in el) {
    const { Select } = el
    return <Select key={f.key} label={f.label} options={options} value={f.value} onSelect={noopSelect} />
  }
  const shown = options.find(o => o.value === f.value)?.label ?? f.value
  return (
    <Box flexDirection="row">
      <Text color={STYLE.muted}>{f.label ? `${f.label}: ` : ''}</Text>
      <Text>{shown}</Text>
    </Box>
  )
}

/**
 * A view's actions (COMMON-5B, "One primary action"): the chrome's Buttons,
 * the first one marked primary in the action color and every other dim,
 * packed into rows of `columns` cells by their widths (the chrome's
 * toolbar packing, which takes no autoFocus: the primary keeps it here, so
 * ctrl+x tab and Enter press it).
 */
export function actionRow(el: PaneElements, list: readonly (Action | null | false)[], columns: number): RenderElement {
  const { Box } = el
  let primary = false
  const kept = list
    .filter((a): a is Action => !!a)
    .map(a => {
      const p = a.primary === true && !primary
      if (p) primary = true
      return { ...a, primary: p, ...(p ? {} : { autoFocus: false }) }
    })
  const rows = packWidths(
    kept.map(a => itemWidth({ kind: 'button', label: a.label })),
    columns,
  )
  return (
    <Box flexDirection="column">
      {rows.map(r => (
        <Box flexDirection="row" columnGap={1}>
          {r.map(i => action(el, kept[i]!))}
        </Box>
      ))}
    </Box>
  )
}

/** A heading a row below what's above it, at `columns` (the chrome's, its rule to the body's edge). */
export function headed(el: PaneElements, text: string, columns: number, note?: string | { text: string; color?: string } | null): RenderElement {
  const { Box } = el
  return (
    <Box flexDirection="column" marginTop={1}>
      {heading(el, text, columns, note ?? null)}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// The tree, drawn without the Client (a surface that has none) and in a proposal

const indent = (depth: number) => '  '.repeat(Math.max(0, depth))

/** A tree row as text, the chrome's list rows' way (WP-DD): `›` in the accent beside the selected one, its label bold. */
function treeText(el: PaneElements, r: SwarmTreeRow, selected: boolean): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexDirection="row">
      <Text color={r.markColor ?? undefined}>{r.mark ? `${r.mark} ` : '  '}</Text>
      <Text color={STYLE.accent}>{selected ? SELECTED_MARK : ' '}</Text>
      <Text>{` ${indent(r.depth)}`}</Text>
      <Text color={r.color ?? undefined} bold={selected}>
        {r.label}
      </Text>
      {r.detail !== '' && <Text color={STYLE.muted} wrap="truncate-end">{`  ${r.detail}`}</Text>}
    </Box>
  )
}

/** The rows as text: a proposal's tree, and the builder's on a surface with no Client and no buttons to spare. */
export function staticTree(el: PaneElements, tree: SwarmTreeProps): RenderElement {
  const { Box } = el
  return <Box flexDirection="column">{tree.rows.map(r => treeText(el, r, r.id === tree.selected))}</Box>
}

/** The builder's tree where there's no Client: each row a plain Button that selects it, as the chrome's list rows are, and the edits as buttons under it. */
function buttonTree(el: PaneElements, view: SwarmBuilderView, columns: number): RenderElement {
  const { Box, Button, Text } = el
  const t = view.tree
  const sel = t.rows.find(r => r.id === t.selected) ?? null
  return (
    <Box flexDirection="column">
      {t.rows.map(r => (
        <Box key={`swarm:builder:row#${r.id}`} flexDirection="row" columnGap={1}>
          <Text color={r.markColor ?? undefined}>{r.mark ? r.mark : ' '}</Text>
          <Text color={STYLE.accent}>{r.id === t.selected ? SELECTED_MARK : ' '}</Text>
          {r.depth > 0 && <Text>{indent(r.depth).slice(1)}</Text>}
          <Button key={`swarm:builder:select:${view.swarm}/${r.id}`} label={r.label} plain onPress={noop} />
          {r.detail !== '' && <Text color={STYLE.muted} wrap="truncate-end">{r.detail}</Text>}
        </Box>
      ))}
      {sel &&
        actionRow(
          el,
          [
            { key: `swarm:builder:add:${view.swarm}/${sel.id}`, label: sel.kind === 'lead' ? 'Add orchestrator' : 'Add worker' },
            sel.kind !== 'lead' && { key: `swarm:builder:duplicate:${view.swarm}/${sel.id}`, label: 'Duplicate' },
            sel.kind !== 'lead' && { key: `swarm:builder:delete:${view.swarm}/${sel.id}`, label: 'Delete' },
            sel.kind !== 'lead' && { key: `swarm:builder:up:${view.swarm}/${sel.id}`, label: 'Up' },
            sel.kind !== 'lead' && { key: `swarm:builder:down:${view.swarm}/${sel.id}`, label: 'Down' },
          ],
          columns,
        )}
    </Box>
  )
}

function tree(el: PaneElements, view: SwarmBuilderView, columns: number): RenderElement {
  const { Box, Text } = el
  if ('Client' in el) {
    const { Client } = el
    return (
      <Box flexDirection="column">
        <Client key="swarm-tree" module="./tree.tsx" props={view.tree} width="100%" />
        <Text color={STYLE.muted} wrap="wrap">
          right-click a row: add, duplicate, delete, move · click, then ↑↓ ⏎ a d x
        </Text>
      </Box>
    )
  }
  return buttonTree(el, view, columns)
}

// ---------------------------------------------------------------------------
// The inspector

/** The inspector's headings, in order (WP-DD; the review's "group execution, limits, tools, paths, and authority"). */
export const GROUPS: readonly { group: SwarmFieldGroup; title: string }[] = [
  { group: 'swarm', title: 'The swarm' },
  { group: 'execution', title: 'Execution' },
  { group: 'limits', title: 'Limits' },
  { group: 'tools', title: 'Tools' },
  { group: 'paths', title: 'Paths' },
  { group: 'authority', title: 'Authority' },
]

/**
 * A badge's color: view.ts's, but `— nothing` muted, not faint (style.ts:
 * `faint` is for rules, never words). Its warning note under the field says
 * what it means.
 */
const badgeColor = (b: SwarmBadge): string => (b === '—' ? STYLE.muted : BADGE_COLOR[b])

/** Who enforces a field, in its word and color (15.3): engine, litter, prompt, or `— nothing` for an unset authority field. */
function badge(el: PaneElements, b: SwarmBadge | null): RenderElement | null {
  const { Text } = el
  if (b === null) return null
  return <Text color={badgeColor(b)}>{b === '—' ? '— nothing' : b}</Text>
}

/**
 * A field's note under it: what's wrong with a typed value as an error;
 * an unset authority field's as a warning, never folded away (nothing
 * checks it); any other unset field's as a muted caption.
 */
function noteOf(el: PaneElements, f: SwarmField): RenderElement | null {
  const { Text } = el
  if (f.note === null) return null
  if (f.noteColor === STYLE.failed) return noticeLine(el, 'error', f.note)
  if (f.badge === '—') return noticeLine(el, 'warning', f.note)
  return (
    <Text color={STYLE.muted} wrap="wrap">
      {f.note}
    </Text>
  )
}

/**
 * One inspector field (COMMON-5B item 3): an Input through the chrome's
 * field, a Select as a short choice, a text field as a label and its value;
 * the badge beside it (on the frame's middle row), the note under it.
 */
function fieldRow(el: PaneElements, f: SwarmField, e: BodyContext): RenderElement {
  const { Box, Text } = el
  const framed = 'Input' in el && framesFields(e.surface)
  const control =
    f.kind === 'select' ? (
      choose(el, { key: f.key, label: f.label, value: f.value, options: f.options })
    ) : f.kind === 'input' ? (
      <Box flexDirection="column" flexGrow={1}>
        {field(el, { key: f.key, label: f.label, value: f.value, ...(f.placeholder ? { placeholder: f.placeholder } : {}) }, null, { surface: e.surface, isFocused: e.isFocused, focused: e.focused })}
      </Box>
    ) : (
      <Box flexDirection="row" columnGap={1}>
        <Text color={STYLE.muted}>{`${f.label}:`}</Text>
        <Text>{f.value}</Text>
      </Box>
    )
  const b = badge(el, f.badge)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        {control}
        {b && f.kind === 'input' && framed ? (
          <Box flexDirection="column">
            <Text> </Text>
            {b}
          </Box>
        ) : (
          b
        )}
      </Box>
      {noteOf(el, f)}
    </Box>
  )
}

/** The inspector: its title, then its fields under their headings, then the enforcement legend (honest: engine, litter, prompt, nothing). */
function inspector(el: PaneElements, view: SwarmBuilderView, e: BodyContext, columns: number): RenderElement {
  const { Box, Text } = el
  const fields = view.inspector.fields
  return (
    <Box flexDirection="column">
      <Text bold color={STYLE.label}>
        {view.inspector.title}
      </Text>
      {GROUPS.map(g => {
        const mine = fields.filter(f => (f.group ?? 'execution') === g.group)
        if (mine.length === 0) return null
        return (
          <Box flexDirection="column">
            {headed(el, g.title, columns)}
            {mine.map(f => fieldRow(el, f, e))}
          </Box>
        )
      })}
      {!hasFields(el) && <Text color={STYLE.muted}>fields are edited on the terminal or the desktop</Text>}
      <Box flexDirection="row" columnGap={1} flexWrap="wrap" marginTop={1}>
        <Text color={STYLE.muted}>enforced by:</Text>
        <Text color={BADGE_COLOR.engine}>engine</Text>
        <Text color={BADGE_COLOR.litter}>litter</Text>
        <Text color={BADGE_COLOR.prompt}>prompt</Text>
        <Text color={badgeColor('—')}>— nothing</Text>
      </Box>
    </Box>
  )
}

function briefPanel(el: PaneElements, view: SwarmBuilderView, columns: number): RenderElement | null {
  const { Box, Markdown, Text } = el
  const b = view.brief
  if (!b) return null
  return (
    <Box flexDirection="column">
      {headed(el, `Brief · ${b.node}`, columns, b.differs ? { text: 'unsaved', color: STYLE.draft } : null)}
      {b.markdown === '' ? <Text color={STYLE.muted}>no brief yet: only the generic node prompt</Text> : <Markdown text={b.markdown} />}
      {b.more && <Text color={STYLE.muted}>… more in the file</Text>}
      <Box flexDirection="row" columnGap={1}>
        {b.href && <Markdown text={`[Open](${b.href})`} />}
        {actionRow(el, [{ key: `swarm:builder:ask-brief:${view.swarm}/${b.node}`, label: 'Ask lead' }], columns)}
      </Box>
    </Box>
  )
}

/** J's checks of the draft, under their heading: each row its glyph and words in its color. */
function checks(el: PaneElements, view: SwarmBuilderView, columns: number): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexDirection="column">
      {headed(el, 'Checks', columns, view.checking ? 'checking…' : null)}
      {view.strip.length === 0 && !view.checking && <Text color={STYLE.muted}>nothing to report</Text>}
      {view.strip.map(r => (
        <Text color={r.color} wrap="wrap">
          {`${r.glyph} ${r.text}`}
        </Text>
      ))}
    </Box>
  )
}

/** Ask the lead for a change: the field, what it does as its caption, and [Ask]. */
function askLead(el: PaneElements, view: SwarmBuilderView, e: BodyContext, columns: number): RenderElement {
  const { Box } = el
  return (
    <Box flexDirection="column">
      {headed(el, 'Ask the lead', columns)}
      {fieldWith(
        el,
        field(
          el,
          { key: `swarm:builder:ask:${view.swarm}`, value: view.askLead, placeholder: 'what to change', submitLabel: 'ask' },
          'the lead stages a proposal for you to review',
          { surface: e.surface, isFocused: e.isFocused, focused: e.focused },
        ),
        { key: `swarm:builder:ask-send:${view.swarm}`, label: 'Ask' },
        e,
      )}
    </Box>
  )
}

function saveAsForm(el: PaneElements, view: SwarmBuilderView, e: BodyContext, columns: number): RenderElement | null {
  const { Box, Text } = el
  const f = view.saveAs
  if (!f) return null
  const s = view.swarm
  const at = { surface: e.surface, isFocused: e.isFocused, focused: e.focused, columns }
  const body = (
    <Box flexDirection="column">
      {field(el, { key: `swarm:builder:saveas-name:${s}`, label: 'Name', value: f.name }, 'a-z, 0-9 and -, up to 24', at)}
      {field(el, { key: `swarm:builder:saveas-description:${s}`, label: 'Description', value: f.description, placeholder: 'what it builds' }, null, at)}
      {choose(el, {
        key: `swarm:builder:saveas-scope:${s}`,
        label: 'Scope',
        value: f.scope,
        options: [
          { value: 'user', label: 'yours (every project)' },
          { value: 'project', label: 'this project' },
        ],
      })}
      <Text color={STYLE.muted} wrap="wrap">
        Parameters: the values tied to this repository or this job
      </Text>
      {f.candidates.length === 0 && <Text color={STYLE.muted}>none to offer</Text>}
      {f.candidates.map(c => (
        <Box flexDirection="row" columnGap={1}>
          {action(el, { key: `swarm:builder:saveas-param:${s}/${c.id}`, label: c.param ? '[x]' : '[ ]' })}
          <Text>{c.label}</Text>
          <Text color={STYLE.muted} wrap="truncate-end">
            {c.value}
          </Text>
        </Box>
      ))}
      {actionRow(
        el,
        [
          { key: `swarm:builder:saveas-save:${s}`, label: 'Save template', primary: true, autoFocus: true },
          { key: `swarm:builder:saveas-cancel:${s}`, label: 'Cancel' },
        ],
        Math.max(1, columns - 4),
      )}
    </Box>
  )
  return panels(el, [{ title: 'Save as template', body }], false)
}

/**
 * The builder's one primary action from the draft's state (the rule this
 * view always had): [Save] for an unsaved draft, [Launch] for a saved swarm
 * that isn't live, none while it's live; while the save-as form is open,
 * its [Save template] instead. Pure, for tier 2.
 */
export function builderPrimary(view: Pick<SwarmBuilderView, 'unsaved' | 'live' | 'saveAs'>): 'save' | 'launch' | 'save-template' | null {
  if (view.saveAs) return 'save-template'
  if (view.unsaved) return 'save'
  return view.live ? null : 'launch'
}

/** The builder's actions: the primary first, then Validate, Discard, Save as template, Doctor, Browser and Swarms, dim. */
function builderActions(view: SwarmBuilderView): Action[] {
  const s = view.swarm
  const primary = builderPrimary(view)
  const save: Action = { key: `swarm:builder:save:${s}`, label: 'Save', ...(primary === 'save' ? { primary: true, autoFocus: true } : {}) }
  const launch: Action = { key: `swarm:builder:launch:${s}`, label: 'Launch', ...(primary === 'launch' ? { primary: true, autoFocus: true } : {}) }
  const rest: (Action | false)[] = [
    { key: `swarm:builder:validate:${s}`, label: 'Validate' },
    view.unsaved && view.base > 0 && { key: `swarm:builder:discard:${s}`, label: 'Discard draft' },
    !view.saveAs && { key: `swarm:builder:save-as:${s}`, label: 'Save as template' },
    { key: `swarm:builder:doctor:${s}`, label: 'Doctor' },
    view.live && { key: `swarm:builder:browser:${s}`, label: 'Browser' },
    { key: `swarm:builder:back:${s}`, label: 'Swarms' },
  ]
  const kept = rest.filter((a): a is Action => !!a)
  return primary === 'save' ? [save, launch, ...kept] : primary === 'launch' ? [launch, save, ...kept] : [save, launch, ...kept]
}

/** The tree's share of a wide body: its rows are short, the inspector's fields wide. */
const TREE_SHARE = 0.4

export function renderBuilder(view: SwarmPaneView, resolved: PaneElements, e: BodyContext): RenderElement {
  const el = tableFor(resolved, e.surface)
  const { Box, Text } = el
  if (view.view !== 'builder') return <Text color={STYLE.muted}>litter: not the builder</Text>
  const s = view.swarm
  const columns = e.bodyColumns
  if (view.blocked) {
    return (
      <Box flexDirection="column">
        {titleRow(el, view.title, columns)}
        {noticeRow(el, view.notice)}
        {noticeLine(el, 'error', view.blocked)}
        {actionRow(el, [{ key: `swarm:builder:back:${s}`, label: 'Swarms', primary: true }], columns)}
      </Box>
    )
  }
  // Side by side past WIDE_COLUMNS (the chrome's), stacked below it.
  const wide = Number.isFinite(columns) && columns >= WIDE_COLUMNS
  const treeColumns = wide ? Math.floor(columns * TREE_SHARE) : columns
  const rightColumns = wide ? columns - treeColumns - 2 : columns
  const left = (
    <Box flexDirection="column" {...(wide ? { width: treeColumns } : {})}>
      {heading(el, 'Tree', treeColumns)}
      {tree(el, view, treeColumns)}
    </Box>
  )
  const right = (
    <Box flexDirection="column" {...(wide ? { width: rightColumns } : {})}>
      {inspector(el, view, e, rightColumns)}
      {briefPanel(el, view, rightColumns)}
    </Box>
  )
  // What needs you first, under the first line (the ⚑ rule): the lead's current proposals, then those J can't read.
  return (
    <Box flexDirection="column">
      {titleRow(el, view.title, columns)}
      {view.proposals.map(n => needsRow(el, `the lead's proposal ${n} waits on you`, { key: `swarm:builder:proposal:${s}/${n}`, label: 'Review' }))}
      {view.unreadable.map(u => needsRow(el, `the lead's proposal ${u.n} can't be read: ${u.error}`, { key: `swarm:builder:reject:${s}/${u.n}`, label: 'Reject' }, 'error'))}
      {noticeRow(el, view.notice)}
      <Box flexDirection="row" columnGap={1}>
        <Box flexShrink={0} minWidth={4}>
          <Text color={STYLE.muted}>Goal</Text>
        </Box>
        {view.goal === '' ? (
          <Text color={STYLE.warning}>{`${NOTICE_STYLE.warning.glyph} none yet: set it on the lead's row`}</Text>
        ) : (
          <Text wrap="wrap">{view.goal}</Text>
        )}
      </Box>
      <Box marginTop={1}>{actionRow(el, builderActions(view), columns)}</Box>
      {saveAsForm(el, view, e, columns)}
      {wide ? (
        <Box flexDirection="row" columnGap={2} marginTop={1}>
          {left}
          {right}
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1} rowGap={1}>
          {left}
          {right}
        </Box>
      )}
      {checks(el, view, columns)}
      {olderProposals(el, view, columns)}
      {askLead(el, view, e, columns)}
    </Box>
  )
}

/** [Reject all older]'s key: swarm/panes.ts's builder action for it is the report's contract change. */
export const rejectOlderKey = (swarm: string): string => `swarm:builder:reject-older:${swarm}`

/**
 * The undecided proposals a later decision or revision superseded: muted
 * under their heading, each with [Reject] (J's rejectProposal, `accepted:
 * 'none'`), and [Reject all older] for two or more. They don't need you, so
 * they sit with the lead's other business, after the checks.
 */
function olderProposals(el: PaneElements, view: SwarmBuilderView, columns: number): RenderElement | null {
  const { Box, Text } = el
  if (view.superseded.length === 0) return null
  const s = view.swarm
  return (
    <Box flexDirection="column">
      {headed(el, 'Older proposals, superseded', columns, `${view.superseded.length}`)}
      <Text color={STYLE.muted} wrap="wrap">
        a later proposal was decided, or a revision saved, after these were staged
      </Text>
      {view.superseded.map(n => (
        <Box flexDirection="row" columnGap={1}>
          <Text color={STYLE.muted} wrap="truncate-end">{`the lead's proposal ${n}`}</Text>
          <Box flexShrink={0} minWidth={itemWidth({ kind: 'button', label: 'Reject' })}>
            {action(el, { key: `swarm:builder:reject:${s}/${n}`, label: 'Reject' })}
          </Box>
        </Box>
      ))}
      {view.superseded.length > 1 && actionRow(el, [{ key: rejectOlderKey(s), label: 'Reject all older' }], columns)}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// The start screen

const SCOPE_ORDER = { builtin: 0, user: 1, project: 2 } as const
const SCOPE_LABEL = { builtin: 'built-in', user: 'yours', project: 'this project' } as const

/** The start screen's template list (WP-DA2): its id, which keeps its window in the hub, and its footer's keys' base. */
export const TEMPLATE_LIST = 'swarm:start:templates'
/** Its row budget: the rows past it are a scroll away. */
export const TEMPLATE_ROWS = 6
/** A template row's key: a press picks it, as the Select's pick did. */
export const templateKey = (id: string): string => `swarm:start:template:${id}`

/** The templates as a list: the built-ins first, each row its name and scope, its description beside the focused one. Pure. */
export function templateList(view: SwarmStartView): ListSpec {
  const templates = [...view.templates].sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope])
  return {
    id: TEMPLATE_LIST,
    rows: TEMPLATE_ROWS,
    items: templates.map(x => ({
      key: templateKey(x.id),
      label: x.name,
      cells: [{ text: SCOPE_LABEL[x.scope], color: STYLE.muted }],
      description: x.description,
      selected: view.template?.id === x.id,
    })),
    columns: [{ drop: 1 }],
    empty: 'no templates',
  }
}

/** The saved swarms' list: every row drawn (the pane's scroll reaches them all; see swarmsSection's `fits`). */
export const SAVED_LIST = 'swarm:start:swarms'

/**
 * The saved swarms as a list: each row its name, `▸ live` in the running
 * color when it's live, its revision and node count muted; its goal the
 * focused row's description. A press opens it (the builder, or the browser
 * when it's live). No right-click menu yet: open is the only action a key
 * of the start screen can take today (see the report), and a menu of one
 * action the press already takes adds nothing. Pure.
 */
export function savedList(view: SwarmStartView): ListSpec {
  const anyLive = view.swarms.some(s => s.live)
  return {
    id: SAVED_LIST,
    rows: Math.max(1, view.swarms.length),
    items: view.swarms.map(s => ({
      key: `swarm:start:open:${s.name}`,
      label: s.name,
      cells: [
        ...(anyLive ? [s.live ? { text: `${MARK.running.glyph} live`, color: STYLE.running } : { text: '' }] : []),
        { text: `rev ${s.revision} · ${s.nodes} node${s.nodes === 1 ? '' : 's'}`, color: STYLE.muted },
      ],
      description: s.goal,
    })),
    // The revision drops before the live mark.
    columns: anyLive ? [{ drop: 1 }, { drop: 2 }] : [{ drop: 1 }],
    empty: 'no saved swarms yet',
  }
}

/**
 * The start screen's one primary action (COMMON-5B, "One primary action"):
 * [Ask the lead] while the ask has text, else the picked template's [Use
 * template], else none. Pure, for tier 2.
 */
export function startPrimary(view: Pick<SwarmStartView, 'ask' | 'template'>): 'ask' | 'template' | null {
  if (view.ask.trim() !== '') return 'ask'
  return view.template ? 'template' : null
}

/** What the Ask field does, under it. */
const ASK_CAPTION = 'the lead proposes one; you review it here'
const NAME_CAPTION = 'a-z, 0-9 and -, up to 24, not starting with -'

/** A template's list beside its form, past WIDE_COLUMNS: the list's share of the body. */
const PICKED_LIST_SHARE = 0.45

/**
 * The context the template list is drawn at: the body's, but past
 * WIDE_COLUMNS with a template picked, the list's own share of the columns
 * (its form's box takes the rest). For the wheel's hit test too
 * (swarm/panes.ts's onUiScroll should place the list at this context, so a
 * tick over the form's box isn't the list's: the report's contract change).
 * Pure.
 */
export function templateListCtx<C extends Pick<BodyContext, 'bodyColumns'>>(view: Pick<SwarmStartView, 'template'>, ctx: C): C {
  const columns = ctx.bodyColumns
  if (!view.template || !Number.isFinite(columns) || columns < WIDE_COLUMNS) return ctx
  return { ...ctx, bodyColumns: Math.max(30, Math.floor(columns * PICKED_LIST_SHARE)) }
}

/**
 * The rows the start screen draws above its template list at `ctx` (the hit
 * test for a wheel tick over the list, swarm/panes.ts's onUiScroll): the
 * notice wrapped, the Name field and its caption, "Ask the lead" (a gap and
 * its heading) and its field with its caption ([Ask the lead] beside it is
 * no taller), then "From a template" (a gap and its heading, [Blank]
 * beside it). Kept in step with renderStart: a row added above the list is
 * added here.
 */
export function startListTop(view: SwarmStartView, ctx: Pick<BodyContext, 'bodyColumns' | 'surface'>): number {
  const needs = startNeeds(view).reduce((n, x) => n + needsRowCount(x.text, x.action.label, ctx.bodyColumns), 0)
  const notice = view.notice ? textRows(`${NOTICE_STYLE[view.notice.level].glyph} ${view.notice.text}`, ctx.bodyColumns) : 0
  const headed = 2
  return needs + notice + fieldRows(ctx.surface, true) + headed + fieldRows(ctx.surface, true) + headed
}

/** `2, 5 and 6`. */
const andList = (ns: readonly number[]): string => (ns.length < 2 ? ns.join('') : `${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`)

/** Who a question went to, as its row says it (WP-DG): `port asks the lead:`, `fixer asks part-a:`, or `asks:` when not recorded. Pure. */
export const asksWhom = (who: string, to: string | null | undefined): string => `${who} asks${to ? ` ${to}` : ''}:`

/**
 * The start screen's needs-you lines (WP-DD, "wherever ⚑ is raised, the
 * section shows it"), first in its body: for each saved swarm that needs
 * you, its current proposals with [Review], and a live one's first open
 * question (who asks, its first line) with [Answer]. Each opens the swarm,
 * its builder or its browser when live, where the same lines come first
 * with their own actions. Pure.
 */
export function startNeeds(view: Pick<SwarmStartView, 'needsYou'>): { text: string; action: Action }[] {
  const out: { text: string; action: Action }[] = []
  for (const x of view.needsYou ?? []) {
    const open = `swarm:start:open:${x.swarm}`
    const ns = x.proposals
    if (ns.length > 0) {
      const what = ns.length === 1 ? `the lead's proposal ${ns[0]} waits on you` : `the lead's proposals ${andList(ns)} wait on you`
      out.push({ text: `${x.swarm}: ${what}`, action: { key: open, label: 'Review' } })
    }
    const q = x.questions[0]
    if (q) {
      const more = x.questions.length > 1 ? ` (+${x.questions.length - 1} more)` : ''
      out.push({ text: `${x.swarm}: ${asksWhom(q.who, q.to)} ${q.text}${more}`, action: { key: open, label: 'Answer' } })
    }
  }
  return out
}

/** A field with an action beside it, the action on the frame's middle row where the field is framed; the action never shrinks, the field takes the rest. */
export function fieldWith(el: PaneElements, fieldEl: RenderElement, a: Action, e: Pick<BodyContext, 'surface'>): RenderElement {
  const { Box, Text } = el
  const framed = 'Input' in el && framesFields(e.surface)
  return (
    <Box flexDirection="row" columnGap={1}>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {fieldEl}
      </Box>
      <Box flexDirection="column" flexShrink={0} minWidth={itemWidth({ kind: 'button', label: a.label })}>
        {framed && <Text> </Text>}
        {action(el, a)}
      </Box>
    </Box>
  )
}

/** A template's form: its description, a field per parameter (its description and examples the caption), its errors, and its actions. */
function templateForm(el: PaneElements, t: SwarmTemplateForm, primary: boolean, e: BodyContext, columns: number): RenderElement {
  const { Box, Text } = el
  const at = { surface: e.surface, isFocused: e.isFocused, focused: e.focused }
  return (
    <Box flexDirection="column">
      {t.description !== '' && (
        <Text color={STYLE.muted} wrap="wrap">
          {t.description}
        </Text>
      )}
      {t.params.length === 0 && <Text color={STYLE.muted}>no parameters but its name</Text>}
      {t.params.map(x => {
        const examples = x.suggestions.length > 0 ? `e.g. ${x.suggestions.slice(0, 8).join(', ')}` : ''
        const caption = [x.description, examples].filter(s => s !== '').join(' · ')
        return field(
          el,
          { key: `swarm:start:param:${x.name}`, label: x.name, value: x.value, ...(x.list ? { placeholder: 'comma-separated' } : {}) },
          caption === '' ? null : caption,
          at,
        )
      })}
      {t.errors.map(x => noticeLine(el, 'error', x))}
      {actionRow(
        el,
        [
          { key: 'swarm:start:use-template', label: 'Use template', primary },
          { key: 'swarm:start:cancel-template', label: 'Cancel' },
        ],
        columns,
      )}
    </Box>
  )
}

export function renderStart(view: SwarmStartView, resolved: PaneElements, e: BodyContext): RenderElement {
  const el = tableFor(resolved, e.surface)
  const { Box, Text } = el
  const columns = e.bodyColumns
  if (view.blocked) {
    return (
      <Box flexDirection="column">
        {noticeRow(el, view.notice)}
        {noticeLine(el, 'error', view.blocked)}
      </Box>
    )
  }
  const t = view.template
  const primary = startPrimary(view)
  const at = { surface: e.surface, isFocused: e.isFocused, focused: e.focused }
  const wide = Number.isFinite(columns) && columns >= WIDE_COLUMNS
  // "or [ Blank ]" beside the template heading: its cells off the heading's.
  const blank = 3 + itemWidth({ kind: 'button', label: 'Blank' })
  const templates = templateList(view)
  const listCtx = templateListCtx(view, e)
  const listColumns = listCtx.bodyColumns
  const picker = list(el, templates, listCtx)
  const form = t ? panels(el, [{ title: t.name, body: templateForm(el, t, primary === 'template', e, wide ? columns - listColumns - 5 : columns - 4) }], false) : null
  // What's above the list keeps to startListTop's rows: what needs you first (the ⚑ rule), then the notice.
  return (
    <Box flexDirection="column">
      {startNeeds(view).map(x => needsRow(el, x.text, x.action))}
      {noticeRow(el, view.notice)}
      {field(el, { key: 'swarm:start:name', label: 'Name', value: view.name }, NAME_CAPTION, at)}
      {headed(el, 'Ask the lead', columns)}
      {fieldWith(
        el,
        field(el, { key: 'swarm:start:ask', value: view.ask, placeholder: 'what the swarm is for', submitLabel: 'ask' }, ASK_CAPTION, at),
        { key: 'swarm:start:ask-send', label: 'Ask the lead', primary: primary === 'ask' },
        e,
      )}
      <Box flexDirection="row" columnGap={1} marginTop={1}>
        {heading(el, 'From a template', Number.isFinite(columns) ? Math.max(1, columns - blank - 1) : undefined)}
        <Text color={STYLE.muted}>or</Text>
        {action(el, { key: 'swarm:start:blank', label: 'Blank' })}
      </Box>
      {t && wide ? (
        <Box flexDirection="row" columnGap={1}>
          <Box flexDirection="column" width={listColumns} flexShrink={0}>
            {picker}
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            {form}
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          {picker}
          {form}
        </Box>
      )}
      {view.swarms.length > 0 && headed(el, 'Saved swarms', columns, '/litter swarms <name> opens one')}
      {view.swarms.length > 0 && list(el, savedList(view), e)}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// A proposal

/** [Technical diff]'s key: the proposal's `diff` action on its own arg (one diff is open at a time, a brief's or this). */
export const technicalKey = (view: Pick<SwarmProposalView, 'swarm' | 'n'>): string => `swarm:proposal:diff:${view.swarm}/${view.n}/${TECHNICAL_DIFF}`

/** A pick box: `[x]` or `[ ]`, a plain Button. */
function pickBox(el: PaneElements, key: string, picked: boolean): RenderElement {
  const { Button } = el
  return <Button key={key} label={picked ? '[x]' : '[ ]'} plain onPress={noop} />
}

export function renderProposal(view: SwarmProposalView, resolved: PaneElements, e: BodyContext): RenderElement {
  const el = tableFor(resolved, e.surface)
  const { Box, Text } = el
  const columns = e.bodyColumns
  const k = (act: string, rest = '') => `swarm:proposal:${act}:${view.swarm}/${view.n}${rest === '' ? '' : `/${rest}`}`
  const open = view.decided === null
  const techLabel = view.technical ? 'Hide technical diff' : 'Technical diff'
  const tech = itemWidth({ kind: 'button', label: techLabel })
  return (
    <Box flexDirection="column">
      {titleRow(el, view.title, columns)}
      {noticeRow(el, view.notice)}
      <Text color={STYLE.muted} wrap="wrap">
        {view.counts}
      </Text>
      {view.decided && <Text color={STYLE.muted}>{`decided: ${view.decided}`}</Text>}
      <Box marginTop={1}>{staticTree(el, view.tree)}</Box>
      <Box flexDirection="row" columnGap={1} marginTop={1}>
        {heading(el, 'Changes', !Number.isFinite(columns) ? undefined : view.changes.length > 0 ? Math.max(1, columns - tech - 1) : columns)}
        {view.changes.length > 0 && action(el, { key: technicalKey(view), label: techLabel })}
      </Box>
      {view.changes.length === 0 && <Text color={STYLE.muted}>no field changes</Text>}
      {view.changes.map(c => (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            {open && !c.conflict ? pickBox(el, k('pick', String(c.index)), c.picked) : <Text>{'   '}</Text>}
            <Text color={c.color}>{c.glyph}</Text>
            <Text wrap="wrap">{c.words}</Text>
          </Box>
          {c.reason !== null && (
            <Box paddingLeft={6}>
              <Text color={STYLE.muted} wrap="wrap">{`lead: ${c.reason}`}</Text>
            </Box>
          )}
          {view.technical && (
            <Box flexDirection="row" columnGap={1} paddingLeft={6}>
              <Text color={STYLE.muted}>{c.path}</Text>
              <Text color={c.color} wrap="truncate-end">
                {c.text}
              </Text>
            </Box>
          )}
          {c.conflict && (
            <Box flexDirection="column" paddingLeft={6}>
              {noticeLine(el, 'warning', `you changed it too: yours ${c.yoursWords ?? c.yours ?? ''}`)}
              {open &&
                actionRow(
                  el,
                  [
                    { key: k('keep', String(c.index)), label: c.picked ? 'Keep yours' : '✓ Keeping yours' },
                    { key: k('take', String(c.index)), label: c.picked ? "✓ Taking the lead's" : "Take the lead's" },
                  ],
                  Number.isFinite(columns) ? columns - 6 : columns,
                )}
            </Box>
          )}
        </Box>
      ))}
      {view.briefs.length > 0 && headed(el, 'Briefs', columns)}
      {view.briefs.map(b => (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            {open && !b.withNode && !b.conflict ? pickBox(el, k('pick-brief', b.node), b.picked) : <Text>{'   '}</Text>}
            <Text color={b.color}>{b.glyph}</Text>
            <Text>{`brief of ${b.node}`}</Text>
            {b.withNode && <Text color={STYLE.muted}>with its node</Text>}
            {action(el, { key: k('diff', b.node), label: b.open ? 'Hide diff' : 'Diff' })}
          </Box>
          {b.reason !== null && (
            <Box paddingLeft={6}>
              <Text color={STYLE.muted} wrap="wrap">{`lead: ${b.reason}`}</Text>
            </Box>
          )}
          {b.conflict && (
            <Box flexDirection="column" paddingLeft={6}>
              {noticeLine(el, 'warning', 'you edited it too')}
              {open &&
                !b.withNode &&
                actionRow(
                  el,
                  [
                    { key: k('keep-brief', b.node), label: b.picked ? 'Keep yours' : '✓ Keeping yours' },
                    { key: k('take-brief', b.node), label: b.picked ? "✓ Taking the lead's" : "Take the lead's" },
                  ],
                  Number.isFinite(columns) ? columns - 6 : columns,
                )}
            </Box>
          )}
          {b.open && (
            <Box flexDirection="column" paddingLeft={6}>
              {b.conflict && <Text color={STYLE.muted}>{"the lead's"}</Text>}
              {b.lines.map(l => (
                <Text color={l.color ?? (l.dim ? STYLE.muted : undefined)} wrap="truncate-end">
                  {l.text}
                </Text>
              ))}
              {b.conflict && <Text color={STYLE.muted}>yours</Text>}
              {b.conflict &&
                b.yoursLines.map(l => (
                  <Text color={l.color ?? (l.dim ? STYLE.muted : undefined)} wrap="truncate-end">
                    {l.text}
                  </Text>
                ))}
            </Box>
          )}
        </Box>
      ))}
      <Box marginTop={1}>
        {actionRow(
          el,
          [
            open && { key: k('accept-all'), label: 'Accept all', primary: true },
            open && { key: k('accept-selected'), label: `Accept selected (${view.picked})` },
            open && { key: k('reject'), label: 'Reject' },
            { key: k('back'), label: 'Back to builder', primary: !open },
          ],
          columns,
        )}
      </Box>
    </Box>
  )
}
