// WP-N: the builder view's draw (15.5's mockup): the tree as the Client
// module, the inspector's fields with their enforcement badges, the briefs,
// the status strip and the buttons. A pure render function; browser.tsx's
// renderSwarmPane calls it for the builder view. The start screen and a
// proposal are drawn here too, and the pieces every pane shares (the header,
// the notice, buttons and fields), which browser.tsx and doctorpane.tsx use.
//
// Every element's handler is a no-op: the panes' ui.press, ui.input and
// ui.select hooks (panes.ts) answer each key without passing it on. Text in a
// view is already cleaned and cut (view.ts); colors are its theme keys.
//
// Contract owner: phase 2b-1, package N.

import type { RenderElement } from 'claude-code'
import type { PaneElements, PaneRender } from '../hooktypes'
import type { SwarmPaneView } from '../ports'
import type {
  SwarmBadge,
  SwarmBuilderView,
  SwarmField,
  SwarmNotice,
  SwarmOption,
  SwarmProposalView,
  SwarmSpan,
  SwarmStartView,
  SwarmTreeProps,
  SwarmTreeRow,
} from '../../types/index'

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

/** Who enforces a field, strongest to weakest (15.6's table). */
const BADGE_COLOR: Record<SwarmBadge, string> = { engine: 'success', litter: 'ide', prompt: 'inactive', '—': 'subtle' }

const NOTICE: Record<SwarmNotice['level'], { glyph: string; color: string }> = {
  ok: { glyph: '✓', color: 'success' },
  info: { glyph: '·', color: 'subtle' },
  warning: { glyph: '!', color: 'warning' },
  error: { glyph: '✕', color: 'error' },
}

/** The pane's header, left-aligned (the top-right cell is the engine's ×), and the last action's outcome. */
export function header(el: PaneElements, title: readonly SwarmSpan[], notice: SwarmNotice | null): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap">
        {title.map(s => (
          <Text color={s.color} dimColor={s.dim} bold={s.bold}>
            {s.text}
          </Text>
        ))}
      </Box>
      {notice && (
        <Text color={NOTICE[notice.level].color} wrap="wrap">
          {`${NOTICE[notice.level].glyph} ${notice.text}`}
        </Text>
      )}
    </Box>
  )
}

/** A line of spans. */
export function line(el: PaneElements, spans: readonly SwarmSpan[]): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexDirection="row">
      {spans.map(s => (
        <Text color={s.color} dimColor={s.dim} bold={s.bold} wrap="truncate-end">
          {s.text}
        </Text>
      ))}
    </Box>
  )
}

export function section(el: PaneElements, label: string, aside?: SwarmSpan): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexDirection="row" marginTop={1}>
      <Text bold>{label}</Text>
      {aside && <Text color={aside.color} dimColor={aside.dim}>{`  ${aside.text}`}</Text>}
    </Box>
  )
}

export type ButtonSpec = { key: string; label: string; primary?: boolean; dim?: boolean; hotkey?: string }

export function button(el: PaneElements, b: ButtonSpec): RenderElement {
  const { Button } = el
  return (
    <Button
      key={b.key}
      label={b.label}
      {...(b.primary ? { variant: 'primary' as const } : {})}
      {...(b.dim ? { dimColor: true } : {})}
      {...(b.hotkey ? { hotkey: b.hotkey } : {})}
      onPress={noop}
    />
  )
}

/** A row of buttons, wrapping on a narrow pane. */
export function buttons(el: PaneElements, list: readonly (ButtonSpec | null | false)[]): RenderElement {
  const { Box } = el
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      {list.filter((b): b is ButtonSpec => !!b).map(b => button(el, b))}
    </Box>
  )
}

/** A Select's options with its value among them (a value no option has is refused), never empty. */
export function optionsWith(options: readonly SwarmOption[], value: string): SwarmOption[] {
  const out = options.length > 0 ? [...options] : [{ value, label: value || 'not set' }]
  if (!out.some(o => o.value === value)) out.push({ value, label: `${value} (not offered)` })
  const seen = new Set<string>()
  return out.filter(o => (seen.has(o.value) ? false : (seen.add(o.value), true)))
}

/** An Input where the surface draws one, else the value as text (the mobile app has no fields). */
export function input(
  el: PaneElements,
  f: { key: string; label: string; value: string; placeholder?: string; submitLabel?: string },
): RenderElement {
  const { Text } = el
  if ('Input' in el) {
    const { Input } = el
    return (
      <Input
        key={f.key}
        label={f.label}
        value={f.value}
        {...(f.placeholder ? { placeholder: f.placeholder } : {})}
        {...(f.submitLabel ? { submitLabel: f.submitLabel } : {})}
        onInput={noop}
        onSubmit={noop}
      />
    )
  }
  return <Text wrap="wrap">{`${f.label}${f.label ? ': ' : ''}${f.value || f.placeholder || ''}`}</Text>
}

/** A Select where the surface draws one, else the value's label as text. */
export function select(el: PaneElements, f: { key: string; label: string; value: string; options: readonly SwarmOption[] }): RenderElement {
  const { Text } = el
  const options = optionsWith(f.options, f.value)
  if ('Select' in el) {
    const { Select } = el
    return <Select key={f.key} label={f.label} options={options} value={f.value} onSelect={noop} />
  }
  const shown = options.find(o => o.value === f.value)?.label ?? f.value
  return <Text>{`${f.label}${f.label ? ': ' : ''}${shown}`}</Text>
}

const hasFields = (el: PaneElements): boolean => 'Input' in el && 'Select' in el

// ---------------------------------------------------------------------------
// The tree, drawn without the Client (a surface that has none) and in a proposal

const indent = (depth: number) => '  '.repeat(Math.max(0, depth))

function treeText(el: PaneElements, r: SwarmTreeRow, selected: boolean): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexDirection="row">
      <Text color={r.markColor ?? undefined}>{r.mark ? `${r.mark} ` : '  '}</Text>
      <Text>{`${selected ? '›' : ' '}${indent(r.depth)}`}</Text>
      <Text color={r.color ?? undefined} dimColor={r.dim} bold={selected}>
        {r.label}
      </Text>
      {r.detail !== '' && <Text dimColor>{`  ${r.detail}`}</Text>}
    </Box>
  )
}

/** The rows as text: a proposal's tree, and the builder's on a surface with no Client and no buttons to spare. */
export function staticTree(el: PaneElements, tree: SwarmTreeProps): RenderElement {
  const { Box } = el
  return <Box flexDirection="column">{tree.rows.map(r => treeText(el, r, r.id === tree.selected))}</Box>
}

/** The builder's tree where there's no Client: each row a plain Button that selects it, and the edits as buttons under it. */
function buttonTree(el: PaneElements, view: SwarmBuilderView): RenderElement {
  const { Box, Button, Text } = el
  const t = view.tree
  const sel = t.rows.find(r => r.id === t.selected) ?? null
  return (
    <Box flexDirection="column">
      {t.rows.map(r => (
        <Box flexDirection="row">
          <Text color={r.markColor ?? undefined}>{r.mark ? `${r.mark} ` : '  '}</Text>
          <Text>{indent(r.depth)}</Text>
          <Button
            key={`swarm:builder:select:${view.swarm}/${r.id}`}
            label={`${r.id === t.selected ? '› ' : ''}${r.label}`}
            plain
            {...(r.dim ? { dimColor: true } : {})}
            onPress={noop}
          />
          {r.detail !== '' && <Text dimColor>{`  ${r.detail}`}</Text>}
        </Box>
      ))}
      {sel &&
        buttons(el, [
          { key: `swarm:builder:add:${view.swarm}/${sel.id}`, label: sel.kind === 'lead' ? 'Add orchestrator' : 'Add worker' },
          sel.kind !== 'lead' && { key: `swarm:builder:duplicate:${view.swarm}/${sel.id}`, label: 'Duplicate' },
          sel.kind !== 'lead' && { key: `swarm:builder:delete:${view.swarm}/${sel.id}`, label: 'Delete' },
          sel.kind !== 'lead' && { key: `swarm:builder:up:${view.swarm}/${sel.id}`, label: 'Up' },
          sel.kind !== 'lead' && { key: `swarm:builder:down:${view.swarm}/${sel.id}`, label: 'Down' },
        ])}
    </Box>
  )
}

function tree(el: PaneElements, view: SwarmBuilderView): RenderElement {
  const { Box, Text } = el
  if ('Client' in el) {
    const { Client } = el
    return (
      <Box flexDirection="column">
        <Client key="swarm-tree" module="./tree.tsx" props={view.tree} width="100%" />
        <Text dimColor wrap="wrap">
          right-click a row: add, duplicate, delete, move · click, then ↑↓ ⏎ a d x
        </Text>
      </Box>
    )
  }
  return buttonTree(el, view)
}

// ---------------------------------------------------------------------------
// The inspector

function badge(el: PaneElements, b: SwarmBadge | null): RenderElement | null {
  const { Text } = el
  if (b === null) return null
  return <Text color={BADGE_COLOR[b]}>{b === '—' ? ' —' : ` ${b}`}</Text>
}

function fieldRow(el: PaneElements, f: SwarmField): RenderElement {
  const { Box, Text } = el
  const control =
    f.kind === 'select'
      ? select(el, { key: f.key, label: f.label, value: f.value, options: f.options })
      : f.kind === 'input'
        ? input(el, { key: f.key, label: f.label, value: f.value, placeholder: f.placeholder })
        : <Text>{`${f.label}: ${f.value}`}</Text>
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        {control}
        {badge(el, f.badge)}
      </Box>
      {f.note !== null && (
        <Text color={f.noteColor ?? undefined} dimColor={f.noteColor === null} wrap="wrap">
          {`    ${f.note}`}
        </Text>
      )}
    </Box>
  )
}

function inspector(el: PaneElements, view: SwarmBuilderView): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexDirection="column">
      <Text bold>{view.inspector.title}</Text>
      {view.inspector.fields.map(f => fieldRow(el, f))}
      {!hasFields(el) && <Text dimColor>fields are edited on the terminal or the desktop</Text>}
      <Box flexDirection="row" columnGap={1}>
        <Text dimColor>enforced by:</Text>
        <Text color={BADGE_COLOR.engine}>engine</Text>
        <Text color={BADGE_COLOR.litter}>litter</Text>
        <Text color={BADGE_COLOR.prompt}>prompt</Text>
        <Text color={BADGE_COLOR['—']}>— nothing</Text>
      </Box>
    </Box>
  )
}

function briefPanel(el: PaneElements, view: SwarmBuilderView): RenderElement | null {
  const { Box, Markdown, Text } = el
  const b = view.brief
  if (!b) return null
  return (
    <Box flexDirection="column">
      {section(el, `Brief · ${b.node}`, b.differs ? { text: '(unsaved)', color: 'gray' } : undefined)}
      {b.markdown === '' ? <Text dimColor>no brief yet: only the generic node prompt</Text> : <Markdown text={b.markdown} />}
      {b.more && <Text dimColor>…</Text>}
      <Box flexDirection="row" columnGap={1}>
        {b.href && <Markdown text={`[Open](${b.href})`} />}
        {button(el, { key: `swarm:builder:ask-brief:${view.swarm}/${b.node}`, label: 'Ask lead' })}
      </Box>
    </Box>
  )
}

function strip(el: PaneElements, view: SwarmBuilderView): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexDirection="column">
      {section(el, 'Checks', view.checking ? { text: 'checking…', color: 'subtle' } : undefined)}
      {view.strip.length === 0 && !view.checking && <Text dimColor>nothing to report</Text>}
      {view.strip.map(r => (
        <Text color={r.color} wrap="wrap">
          {`${r.glyph} ${r.text}`}
        </Text>
      ))}
      <Box flexDirection="row" columnGap={1}>
        {input(el, { key: `swarm:builder:ask:${view.swarm}`, label: 'Ask lead', value: view.askLead, placeholder: 'what to change', submitLabel: 'ask' })}
        {button(el, { key: `swarm:builder:ask-send:${view.swarm}`, label: 'Ask' })}
      </Box>
    </Box>
  )
}

function saveAsForm(el: PaneElements, view: SwarmBuilderView): RenderElement | null {
  const { Box, Text } = el
  const f = view.saveAs
  if (!f) return null
  const s = view.swarm
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Save as template</Text>
      {input(el, { key: `swarm:builder:saveas-name:${s}`, label: 'Name', value: f.name, placeholder: 'a-z, 0-9 and -' })}
      {input(el, { key: `swarm:builder:saveas-description:${s}`, label: 'Description', value: f.description, placeholder: 'what it builds' })}
      {select(el, {
        key: `swarm:builder:saveas-scope:${s}`,
        label: 'Scope',
        value: f.scope,
        options: [
          { value: 'user', label: 'yours (every project)' },
          { value: 'project', label: 'this project' },
        ],
      })}
      <Text dimColor>Parameters: the values tied to this repository or this job</Text>
      {f.candidates.length === 0 && <Text dimColor>none to offer</Text>}
      {f.candidates.map(c => (
        <Box flexDirection="row" columnGap={1}>
          {button(el, { key: `swarm:builder:saveas-param:${s}/${c.id}`, label: c.param ? '[x]' : '[ ]' })}
          <Text>{c.label}</Text>
          <Text dimColor wrap="truncate-end">{c.value}</Text>
        </Box>
      ))}
      {buttons(el, [
        { key: `swarm:builder:saveas-save:${s}`, label: 'Save template', primary: true },
        { key: `swarm:builder:saveas-cancel:${s}`, label: 'Cancel' },
      ])}
    </Box>
  )
}

export function renderBuilder(view: SwarmPaneView, resolved: PaneElements, e: PaneRender): RenderElement {
  const el = tableFor(resolved, e.surface)
  const { Box, Text } = el
  if (view.view !== 'builder') return <Text dimColor>litter: not the builder</Text>
  const s = view.swarm
  const wide = e.props.bodyColumns >= 110
  if (view.blocked) {
    return (
      <Box flexDirection="column">
        {header(el, view.title, view.notice)}
        <Text color="error" wrap="wrap">{`✕ ${view.blocked}`}</Text>
        {buttons(el, [{ key: `swarm:builder:back:${s}`, label: 'Back' }])}
      </Box>
    )
  }
  const left = (
    <Box flexDirection="column" {...(wide ? { width: '45%' } : {})}>
      {tree(el, view)}
    </Box>
  )
  const right = (
    <Box flexDirection="column" {...(wide ? { width: '55%' } : {})}>
      {inspector(el, view)}
      {briefPanel(el, view)}
    </Box>
  )
  return (
    <Box flexDirection="column">
      {header(el, view.title, view.notice)}
      {view.proposals.length > 0 &&
        buttons(el, view.proposals.map(n => ({ key: `swarm:builder:proposal:${s}/${n}`, label: `Lead's proposal ${n}`, primary: true })))}
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
      {strip(el, view)}
      {saveAsForm(el, view)}
      <Box marginTop={1}>
        {buttons(el, [
          { key: `swarm:builder:validate:${s}`, label: 'Validate' },
          { key: `swarm:builder:save:${s}`, label: 'Save', primary: view.unsaved },
          view.unsaved && view.base > 0 && { key: `swarm:builder:discard:${s}`, label: 'Discard draft' },
          !view.saveAs && { key: `swarm:builder:save-as:${s}`, label: 'Save as template' },
          { key: `swarm:builder:launch:${s}`, label: 'Launch', primary: !view.unsaved && !view.live },
          { key: `swarm:builder:doctor:${s}`, label: 'Doctor' },
          view.live && { key: `swarm:builder:browser:${s}`, label: 'Browser' },
          { key: `swarm:builder:back:${s}`, label: 'Swarms' },
        ])}
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// The start screen

const SCOPE_ORDER = { builtin: 0, user: 1, project: 2 } as const
const SCOPE_LABEL = { builtin: 'built-in', user: 'yours', project: 'this project' } as const

export function renderStart(view: SwarmStartView, resolved: PaneElements, e: PaneRender): RenderElement {
  const el = tableFor(resolved, e.surface)
  const { Box, Text } = el
  if (view.blocked) {
    return (
      <Box flexDirection="column">
        {header(el, view.title, view.notice)}
        <Text color="error" wrap="wrap">{`✕ ${view.blocked}`}</Text>
      </Box>
    )
  }
  const templates = [...view.templates].sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope])
  const t = view.template
  return (
    <Box flexDirection="column">
      {header(el, view.title, view.notice)}
      {input(el, { key: 'swarm:start:name', label: 'Name', value: view.name, placeholder: 'a-z, 0-9 and -, up to 24' })}
      {section(el, 'Ask the lead')}
      <Box flexDirection="row" columnGap={1}>
        {input(el, { key: 'swarm:start:ask', label: '', value: view.ask, placeholder: 'what the swarm is for', submitLabel: 'ask' })}
        {button(el, { key: 'swarm:start:ask-send', label: 'Ask the lead', primary: true })}
      </Box>
      {section(el, 'From a template')}
      {templates.length === 0 ? (
        <Text dimColor>no templates</Text>
      ) : (
        select(el, {
          key: 'swarm:start:template',
          label: 'Template',
          value: t?.id ?? '',
          options: [{ value: '', label: 'pick one' }, ...templates.map(x => ({ value: x.id, label: `${x.name} (${SCOPE_LABEL[x.scope]})` }))],
        })
      )}
      {t && (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold>{t.name}</Text>
          {t.description !== '' && <Text dimColor wrap="wrap">{t.description}</Text>}
          {t.params.map(x => (
            <Box flexDirection="column">
              {input(el, { key: `swarm:start:param:${x.name}`, label: x.name, value: x.value, placeholder: x.list ? 'comma-separated' : x.description })}
              {x.list && x.description !== '' && <Text dimColor wrap="wrap">{`    ${x.description}`}</Text>}
              {x.suggestions.length > 0 && <Text dimColor wrap="wrap">{`    e.g. ${x.suggestions.slice(0, 8).join(', ')}`}</Text>}
            </Box>
          ))}
          {buttons(el, [
            { key: 'swarm:start:use-template', label: 'Use template', primary: true },
            { key: 'swarm:start:cancel-template', label: 'Cancel' },
          ])}
        </Box>
      )}
      {section(el, 'Or')}
      {buttons(el, [{ key: 'swarm:start:blank', label: 'Blank' }])}
      {view.swarms.length > 0 && section(el, 'Saved swarms')}
      {view.swarms.map(s => (
        <Box flexDirection="row" columnGap={1}>
          {button(el, { key: `swarm:start:open:${s.name}`, label: s.name })}
          <Text dimColor>{`rev ${s.revision} · ${s.nodes} node${s.nodes === 1 ? '' : 's'}`}</Text>
          {s.live && <Text color="background">live</Text>}
          <Text wrap="truncate-end">{s.goal}</Text>
        </Box>
      ))}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// A proposal

export function renderProposal(view: SwarmProposalView, resolved: PaneElements, e: PaneRender): RenderElement {
  const el = tableFor(resolved, e.surface)
  const { Box, Text } = el
  const k = (action: string, rest = '') => `swarm:proposal:${action}:${view.swarm}/${view.n}${rest === '' ? '' : `/${rest}`}`
  const open = view.decided === null
  return (
    <Box flexDirection="column">
      {header(el, view.title, view.notice)}
      <Text dimColor>{view.counts}</Text>
      {view.decided && <Text color="subtle">{`decided: ${view.decided}`}</Text>}
      <Box marginTop={1}>{staticTree(el, view.tree)}</Box>
      {section(el, 'Changes')}
      {view.changes.length === 0 && <Text dimColor>no field changes</Text>}
      {view.changes.map(c => (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            {open && !c.conflict && button(el, { key: k('pick', String(c.index)), label: c.picked ? '[x]' : '[ ]' })}
            <Text color={c.color}>{c.glyph}</Text>
            <Text>{c.path}</Text>
            <Text color={c.color} wrap="truncate-end">
              {c.text}
            </Text>
          </Box>
          {c.reason !== null && <Text dimColor wrap="wrap">{`    lead: ${c.reason}`}</Text>}
          {c.conflict && (
            <Box flexDirection="column">
              <Text color="warning" wrap="wrap">{`    ! you changed it too: yours ${c.yours ?? ''}`}</Text>
              {open &&
                buttons(el, [
                  { key: k('keep', String(c.index)), label: c.picked ? 'Keep yours' : '✓ Keeping yours' },
                  { key: k('take', String(c.index)), label: c.picked ? "✓ Taking the lead's" : "Take the lead's" },
                ])}
            </Box>
          )}
        </Box>
      ))}
      {view.briefs.length > 0 && section(el, 'Briefs')}
      {view.briefs.map(b => (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            {open && button(el, { key: k('pick-brief', b.node), label: b.picked ? '[x]' : '[ ]' })}
            <Text color={b.color}>{`${b.glyph} brief`}</Text>
            <Text>{b.node}</Text>
            {b.conflict && <Text color="warning">! you edited it too</Text>}
            {button(el, { key: k('diff', b.node), label: b.open ? 'Hide diff' : 'Diff' })}
          </Box>
          {b.reason !== null && <Text dimColor wrap="wrap">{`    lead: ${b.reason}`}</Text>}
          {b.open && (
            <Box flexDirection="column" paddingLeft={2}>
              {b.lines.map(l => (
                <Text color={l.color} dimColor={l.dim} wrap="truncate-end">
                  {l.text}
                </Text>
              ))}
            </Box>
          )}
        </Box>
      ))}
      <Box marginTop={1}>
        {buttons(el, [
          open && { key: k('accept-all'), label: 'Accept all', primary: true },
          open && { key: k('accept-selected'), label: `Accept selected (${view.picked})` },
          open && { key: k('reject'), label: 'Reject' },
          { key: k('back'), label: 'Back to builder' },
        ])}
      </Box>
    </Box>
  )
}
