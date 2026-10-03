// The rules pane, `litter-rules` (plan 16.3, 16.8): the only place a rule is
// accepted, dismissed or retired. Its buttons are the only path to store.ts's
// acceptRule, dismissRule and retireRule (COMMON, "Only you accept"). Keys
// are `rules:<action>[:<arg>]`. Owner: phase 3, package AF.
//
// Only `ui.press` reaches those three, through pressRules: a field (ui.input),
// a pick (ui.select), a message, a timer, the record tool and the spool never
// do. A project rule's [Accept] shows the exact file first (AD's
// previewAccept), and [Confirm accept] writes it; [Retire] asks for
// [Confirm retire]. Every call into the store is logged before it's made.

import type { RenderElement } from 'claude-code'
import type { Ports } from '../ports'
import type { CommandRunHook, PaneElements, PaneRender, PaneUiHandlers, PortHook } from '../hooktypes'
import type { ProposalRef, RuleScope, RuleType } from '../records/rules'
import type { RulesBody, RulesPaneView, RulesRow, RulesTab, SwarmNotice } from '../../types/index'
import type { AcceptOpts, AcceptWhat } from './store'
import type { RulesNav, ShownRow } from './paneview'
import { session } from '../session'
import { headKey } from '../ledgercore'
import { repoRulesLedgerDir, userRulesLedgerDir } from '../layout'
import { primaryOf } from '../lifecycle'
import { interactive } from '../swarm/state'
import { button, buttons, header, input, section, select, tableFor } from '../swarm/builder'
import { clean, oneLine } from '../swarm/view'
import { acceptRule, dismissRule, narrowPaths, previewAccept, retireRule } from './store'
import {
  MATCHES_NO_FILE,
  NO_PATHS,
  batchKey,
  blankRulesNav,
  deps as viewDeps,
  instanceNote,
  restoreRulesNav,
  rulesNavOf,
  rulesView,
  saveRulesNav,
  scopeChoices,
  setRulesNav,
} from './paneview'

export const RULES_PANE = 'litter-rules'

// AD's acting functions, through one table so tier 2 can stand in for them
// (COMMON, "Another package's module"). The mod never changes it.
export const deps = {
  acceptRule: (...a: Parameters<typeof acceptRule>) => acceptRule(...a),
  dismissRule: (...a: Parameters<typeof dismissRule>) => dismissRule(...a),
  retireRule: (...a: Parameters<typeof retireRule>) => retireRule(...a),
  previewAccept: (...a: Parameters<typeof previewAccept>) => previewAccept(...a),
  narrowPaths: (...a: Parameters<typeof narrowPaths>) => narrowPaths(...a),
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
        title: [{ text: 'litter · rules', bold: true }],
        notice: { level: 'error', text: `this session has no litter directory${why ? `: ${oneLine(why, 240)}` : ''}, so the rules can't be read` },
        counts: { proposed: 0, inForce: 0 },
        rows: [],
        batch: null,
        focus: null,
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
  lastStamp = await rulesStamp(p, litterDir)
  await saveRulesNav(p)
  return built.view
}

/** command.run on `litter-rules`: opens the `litter-rules` pane on the Proposed tab, answering a one-line `text`. */
export const rulesCommand: PortHook<CommandRunHook> = async (p, e, next) => {
  await restoreRulesNav(p)
  setRulesNav({ ...blankRulesNav('proposed'), held: rulesNavOf()?.held ?? {} })
  const view = await drawRules(p)
  const placed = await p.openPane(RULES_PANE, 'litter rules')
  const c = view?.body?.counts
  const what = session().litterDir && c ? `shows ${c.proposed} proposed or unverified, ${c.inForce} in force` : 'has no litter directory to read'
  return { text: `litter: the rules pane ${what}${placed ? '' : " (open, but this screen can't draw it now)"}` }
}

const validFocus = (focus: { id?: unknown; proposal?: unknown } | null): RulesNav['focus'] => {
  if (!focus) return null
  const out: NonNullable<RulesNav['focus']> = {}
  if (typeof focus.id === 'string' && RULE_ID.test(focus.id)) out.id = focus.id
  const ref = focus.proposal as Partial<ProposalRef> | undefined
  if (ref && (ref.store === 'repo' || ref.store === 'user') && Number.isInteger(ref.seq) && (ref.seq as number) > 0) out.proposal = { store: ref.store, seq: ref.seq as number }
  return out.id || out.proposal ? out : null
}

/**
 * Opens the rules pane focused on a rule id or a proposal (null: the Proposed
 * tab), from the board's [Rules] and AD's rule.open and rule.import. Answers
 * whether the pane was placed; a caller whose open was refused says "run
 * /litter-rules". A proposal that is, or is in, an import batch focuses the
 * batch. Never throws.
 */
export async function openRulesPane(p: Ports, focus: { id?: string; proposal?: ProposalRef } | null): Promise<boolean> {
  try {
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
    await drawRules(p)
    return await p.openPane(RULES_PANE, 'litter rules')
  } catch (err) {
    p.log(`rules pane: it didn't open: ${errText(err)}`)
    return false
  }
}

/** The board's tick: the pane's view again when a rules ledger moved (a critic's proposal, a step taken elsewhere). */
export async function rulesTick(p: Ports): Promise<void> {
  await restoreRulesNav(p)
  const litterDir = session().litterDir
  if (!rulesNavOf() || !litterDir) return
  if ((await rulesStamp(p, litterDir)) === lastStamp) return
  await drawRules(p)
}

/** After a /clear ($.state wiped): the pane's view again, if it was open. */
export async function refreshRulesPane(p: Ports): Promise<void> {
  await restoreRulesNav(p)
  if (rulesNavOf()) await drawRules(p)
}

export function resetRulesPaneForTests(): void {
  lastStamp = ''
}

// ---------------------------------------------------------------------------
// The render

/** register.tsx's ui.render hook for `{ component: 'Pane', requestId: 'litter-rules' }` calls it with the rulesPane atom. A pure renderer. */
export function renderRulesPane(view: RulesPaneView | null, resolved: PaneElements, e: PaneRender): RenderElement {
  const el = tableFor(resolved, e.surface)
  const { Box, Text } = el
  const body = view?.body
  if (!view || !body) {
    return (
      <Box flexDirection="column">
        <Text bold>litter · rules</Text>
        <Text dimColor>nothing to show yet: /litter-rules opens the rules pane</Text>
      </Box>
    )
  }
  const rows = body.rows ?? []
  const batch = view.tab === 'proposed' ? (body.batch ?? null) : null
  const inBatch = (r: RulesRow) => r.checked !== undefined
  return (
    <Box flexDirection="column">
      {header(el, body.title, body.notice ?? null)}
      <Box marginTop={1}>
        {buttons(el, [
          { key: 'rules:tab:proposed', label: `Proposed (${body.counts?.proposed ?? 0})`, primary: view.tab === 'proposed' },
          { key: 'rules:tab:in-force', label: `In force (${body.counts?.inForce ?? 0})`, primary: view.tab === 'in-force' },
        ])}
      </Box>
      {batch ? batchPart(el, body, rows.filter(inBatch)) : null}
      {rows.filter(r => !batch || !inBatch(r)).map(r => rowPart(el, body, r))}
      {rows.length === 0 && (
        <Text dimColor>{view.tab === 'proposed' ? 'nothing proposed: /litter:rules add drafts a rule' : 'no rules in force yet'}</Text>
      )}
      {(body.problems ?? []).length > 0 && (
        <Box flexDirection="column">
          {section(el, 'Problems')}
          {(body.problems ?? []).map(x => (
            <Text color="warning" wrap="wrap">{`! ${x}`}</Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

function batchPart(el: PaneElements, body: RulesBody, rows: readonly RulesRow[]): RenderElement {
  const { Box, Text } = el
  const b = body.batch!
  const checked = rows.filter(r => r.checked).length
  const preview = body.pending?.kind === 'preview' && body.pending.key === batchKey(b.seq) ? body.pending : null
  const instanceOf = (r: RulesRow) => b.instances.find(i => r.notes[0] === instanceNote(i.id))
  return (
    <Box flexDirection="column">
      {section(el, 'Import from deepwork', { text: `${checked} of ${rows.length} checked`, dim: true })}
      {b.instances.map(i => (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" columnGap={1}>
            <Text color={i.archived ? 'inactive' : 'success'}>{i.archived ? '− archived' : '✓ live'}</Text>
            <Text bold>{i.id}</Text>
            {i.date && <Text dimColor>{i.date}</Text>}
          </Box>
          {i.goal !== '' && <Text wrap="wrap">{`  ${i.goal}`}</Text>}
          {rows.filter(r => instanceOf(r)?.id === i.id).map(r => rowPart(el, body, r))}
        </Box>
      ))}
      {rows.filter(r => !instanceOf(r)).map(r => rowPart(el, body, r))}
      {preview && (
        <Box flexDirection="column">
          {section(el, 'The files [Confirm accept] writes', { text: preview.path, color: 'blue' })}
          {fileText(el, preview.text)}
        </Box>
      )}
      <Box marginTop={1}>
        {buttons(el, [
          preview
            ? { key: `rules:confirm:${batchKey(b.seq)}`, label: 'Confirm accept', primary: true }
            : { key: `rules:accept-selected:${b.seq}`, label: 'Accept selected', primary: true },
          preview && { key: `rules:cancel:${batchKey(b.seq)}`, label: 'Cancel' },
        ])}
      </Box>
    </Box>
  )
}

/** A file as it will be written. */
function fileText(el: PaneElements, text: string): RenderElement {
  const { Code, Text } = el
  return text === '' ? <Text dimColor>(empty)</Text> : <Code source={text} language="markdown" />
}

function rowPart(el: PaneElements, body: RulesBody, r: RulesRow): RenderElement {
  const { Box, Button, Text } = el
  const focused = body.focus === r.key
  const pending = body.pending?.key === r.key ? body.pending : null
  const editing = body.editing?.key === r.key ? body.editing : null
  const name = r.id ? `${r.id}@${r.version ?? '?'}` : 'new rule'
  const notes = r.checked !== undefined ? r.notes.slice(1) : r.notes
  const flag = (n: string) => n === MATCHES_NO_FILE || / overrides /.test(n)
  const action = (a: string) =>
    a === 'accept'
      ? { key: `rules:accept:${r.key}`, label: 'Accept', primary: true }
      : a === 'edit'
        ? { key: `rules:edit:${r.key}`, label: 'Edit…' }
        : a === 'dismiss'
          ? { key: `rules:dismiss:${r.key}`, label: 'Dismiss' }
          : a === 'retire'
            ? { key: `rules:retire:${r.key}`, label: 'Retire' }
            : null
  const askScope = r.kind === 'proposal' && (pending?.kind === 'scope' || r.source === 'import')
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row" columnGap={1}>
        <Text color="claude">{focused ? '›' : ' '}</Text>
        {r.checked !== undefined && <Button key={`rules:check:${r.key}`} label={r.checked ? '[x]' : '[ ]'} plain onPress={() => {}} />}
        <Text color={r.status.color}>{`${r.status.glyph} ${r.status.text}`}</Text>
        <Text bold>{name}</Text>
        <Text>{r.type}</Text>
        <Text dimColor>{r.scope ? `${r.scope} scope` : 'no scope yet'}</Text>
      </Box>
      {r.when !== '' && <Text wrap="wrap">{`  when: ${r.when}`}</Text>}
      <Text wrap="wrap">{`  ${r.rule}`}</Text>
      {r.paths.length > 0 ? (
        <Text color="blue" wrap="wrap">{`  paths: ${r.paths.join(', ')}`}</Text>
      ) : (
        <Text color="warning">{`  ${r.kind === 'accepted' ? 'no paths: applies everywhere' : NO_PATHS}`}</Text>
      )}
      {notes.map(n => (
        <Text color={flag(n) ? 'warning' : undefined} dimColor={!flag(n)} wrap="wrap">{`  ${flag(n) ? '! ' : ''}${n}`}</Text>
      ))}
      {r.diff && (
        <Box flexDirection="column">
          <Text dimColor>{'  against the version in force:'}</Text>
          {r.diff.map(s => (
            <Text color={s.color} dimColor={s.dim} wrap="truncate-end">{`  ${s.text}`}</Text>
          ))}
        </Box>
      )}
      {askScope && scopePart(el, r, pending?.kind === 'scope')}
      {editing && (
        <Box flexDirection="column">
          {input(el, { key: `rules:paths:${r.key}`, label: 'Paths', value: editing.paths, placeholder: 'globs, comma-separated; empty for every gate', submitLabel: 'Set' })}
          {editing.error && <Text color="error" wrap="wrap">{`  ✕ ${editing.error}`}</Text>}
          {select(el, { key: `rules:type:${r.key}`, label: 'Type', value: editing.type, options: TYPES.map(t => ({ value: t, label: t })) })}
          {buttons(el, [{ key: `rules:edit-done:${r.key}`, label: 'Done' }])}
        </Box>
      )}
      {pending?.kind === 'preview' && (
        <Box flexDirection="column">
          {section(el, 'The file [Confirm accept] writes', { text: pending.path, color: 'blue' })}
          {fileText(el, pending.text)}
          {buttons(el, [
            { key: `rules:confirm:${r.key}`, label: 'Confirm accept', primary: true },
            { key: `rules:cancel:${r.key}`, label: 'Cancel' },
          ])}
        </Box>
      )}
      {pending?.kind === 'retire' && (
        <Box flexDirection="column">
          <Text color="warning" wrap="wrap">{`  ! retire ${name}? Its file moves to .history, and no later run gets it`}</Text>
          {buttons(el, [
            { key: `rules:confirm-retire:${r.key}`, label: 'Confirm retire', primary: true },
            { key: `rules:cancel:${r.key}`, label: 'Cancel' },
          ])}
        </Box>
      )}
      {!pending && r.actions.length > 0 && <Box marginTop={0}>{buttons(el, r.actions.map(action))}</Box>}
    </Box>
  )
}

/** The scope a proposal is accepted into: a Select where the surface draws one, else a button per scope. */
function scopePart(el: PaneElements, r: RulesRow, asked: boolean): RenderElement {
  const { Box, Text } = el
  const choices = scopeChoices({ source: r.source })
  const value = asked ? '' : (r.scope ?? '')
  if ('Select' in el) {
    const options = [...(value === '' ? [{ value: '', label: 'pick a scope' }] : []), ...choices.map(s => ({ value: s, label: s }))]
    return select(el, { key: `rules:scope:${r.key}`, label: 'Scope', value, options })
  }
  return (
    <Box flexDirection="row" columnGap={1}>
      <Text>Scope</Text>
      {choices.map(s => button(el, { key: `rules:scope-${s}:${r.key}`, label: s, ...(s === r.scope ? { primary: true } : {}) }))}
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
  p.toast("litter: that rule isn't shown any more, so it was ignored")
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
  }
}

/** Where a written file is, as you'd commit it: relative to the primary checkout. */
function shownPath(path: string | undefined, litterDir: string): string {
  if (!path) return ''
  const primary = primaryOf(litterDir)
  return primary && path.startsWith(`${primary}/`) ? path.slice(primary.length + 1) : path
}

const nonInteractive = (n: RulesNav): boolean => {
  if (interactive() !== false) return false
  say(n, 'warning', "this session isn't interactive, so nothing can be accepted here (16.3)")
  return true
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
  setRulesNav({ ...forget(n, key), notice: { level: 'ok', text: `accepted into ${scope} scope: ${done.text}` } })
}

async function confirmAccept(p: Ports, litterDir: string, n: RulesNav, key: string): Promise<void> {
  if (n.pending?.kind !== 'preview' || n.pending.key !== key) {
    p.toast('litter: there was no file waiting to be confirmed, so that was ignored')
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
  setRulesNav({ ...forget(n, key), notice: { level: 'ok', text: `accepted: ${done.text}` } })
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
    p.toast("litter: that import batch isn't shown any more, so it was ignored")
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
      else files.push(`--- ${r.value.path}\n${r.value.text}`)
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
  const text = failed.length === 0 ? `accepted ${done.length} of ${picked.length}${commit}` : `accepted ${done.length} of ${picked.length}${commit}; not accepted: ${failed.join('; ')}`
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
    p.toast('litter: there was no retire waiting to be confirmed, so that was ignored')
    return say(n, 'warning', 'there was no retire waiting to be confirmed, so the press was ignored')
  }
  const r = await call(p, `retireRule ${row.id}@${row.version}`, () => deps.retireRule(p, litterDir, { id: row.id!, version: row.version! }))
  if (!r.ok) return say(n, 'error', `not retired: ${r.error}`)
  if (!r.value.ok) return say(n, 'error', `not retired: ${r.value.reason}`)
  const where = row.scope === 'project' ? '; commit the removal yourself' : ''
  setRulesNav({ ...forget(n, key), notice: { level: 'ok', text: `retired ${row.id}@${row.version}${where}` } })
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

/** One press: the stale check, the action, then the redraw. The only path to acceptRule, dismissRule and retireRule. */
export async function pressRules(p: Ports, key: string): Promise<void> {
  const k = parseKey(key)
  if (!k) return
  await restoreRulesNav(p)
  const cur = rulesNavOf()
  const litterDir = session().litterDir
  if (!cur || !litterDir) {
    p.toast('litter: the rules pane was closed, so that was ignored')
    return
  }
  // A new action's outcome replaces the last one's.
  const n: RulesNav = { ...cur, notice: null }
  setRulesNav(n)
  try {
    switch (k.action) {
      case 'tab':
        if ((TABS as readonly string[]).includes(k.arg)) setRulesNav({ ...n, tab: k.arg as RulesTab, pending: null, editing: null })
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
    }
  } catch (err) {
    p.log(`rules pane: ${key} failed: ${errText(err)}`)
    say(rulesNavOf() ?? n, 'error', `that failed: ${errText(err)}`)
  }
  await drawRules(p)
}

/** A field: the paths [Edit…] holds for a proposal, checked by AD's narrowPaths on Enter. */
async function inputRules(p: Ports, key: string, value: string, kind: 'change' | 'submit' | undefined): Promise<void> {
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

/** A pick: a proposal's scope, or the type [Edit…] holds. Never accepts. */
async function selectRules(p: Ports, key: string, value: string): Promise<void> {
  const k = parseKey(key)
  if (!k) return
  await restoreRulesNav(p)
  const n = rulesNavOf()
  if (!n) return
  if (k.action === 'scope') pickScope(p, n, k.arg, value)
  else if (k.action === 'type') {
    const row = n.shown[k.arg]
    if (!row || row.kind !== 'proposal' || !(TYPES as readonly string[]).includes(value)) return
    const type = value as RuleType
    setRulesNav({
      ...n,
      held: { ...n.held, [k.arg]: { ...(n.held[k.arg] ?? {}), type } },
      editing: n.editing?.key === k.arg ? { ...n.editing, type } : n.editing,
      pending: n.pending?.key === k.arg ? null : n.pending,
    })
  } else return
  await drawRules(p)
}

/** The rules pane's ui.message, ui.press, ui.input and ui.select; anything not keyed `rules:` passes on. Each action refreshes the view. */
export const onRulesUi: PaneUiHandlers = {
  // The pane draws no Client, so nothing of its own posts.
  message: async (p, e, next) => next(e),
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
