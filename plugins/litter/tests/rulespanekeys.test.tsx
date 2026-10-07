// Tier 1: the rules pane's focus ring, state by state, as
// tests/headless/rules.sh (T4-2) presses it. That script reaches each button
// by counting Tab presses from the ring's start (ctrl+x tab enters the pane
// with nothing held, and the first Tab lands on the ring's first element), so
// a change to the pane's tree breaks this test before it breaks a live run.
// Change the two together: each count below is one of rules.sh's.
//
// The ring is CC's: the pane's Button, Input and Select elements in
// depth-first tree order (as 2.1.288 and 2.1.289 walk the drawn tree), the
// same order a mounted drawing's findAll lists them in. The pane chrome's tabs and ✕ come after them, so
// they never move a count. litter's own chrome comes first (phase 5b, WP-DA):
// the `litter` pane's section strip, with Rules shown, is the other six
// sections' Buttons, so each count is the Rules body's place plus 6. The
// state is made by the plugin's own import of
// fixtures/rules-import's deepwork guardrails (rulespanekeys-fixture.ts, which
// tier 2 checks against the fixture's files), and each step is the press
// rules.sh makes.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import { drawText } from './drawing'
import { RULES_IMPORT_DEEPWORK, fixtureText } from './rulespanekeys-fixture'

const SESSION = 'tier1-session'
const LITTER = '/repo/.claude/litter'
const RULES_LEDGER = `${LITTER}/rules-ledger/ledger`

const pane = (title: string) =>
  ({ title, isFocused: false, bodyColumns: 200, placement: 'dock', scroll: { offset: 0, bodyRows: 48 }, view: {} }) as const

/** $.fs from a map and git as a checkout at /repo with no commit (rules.test.ts's world), the panes placed. */
function world(on: On): Map<string, string> {
  const files = new Map<string, string>()
  const isDir = (path: string) => [...files.keys()].some(k => k.startsWith(`${path}/`))
  const ran = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('fs.exists', async (_$, e) => ({ value: files.has(e.path) || isDir(e.path) }))
  on('fs.read', async (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', async (_$, e) => {
    if (!isDir(e.path)) throw new Error(`ENOENT: ${e.path}`)
    const names = new Set([...files.keys()].filter(k => k.startsWith(`${e.path}/`)).map(k => k.slice(e.path.length + 1).split('/')[0]!))
    return { value: [...names].map(name => ({ name, kind: files.has(`${e.path}/${name}`) ? ('file' as const) : ('dir' as const), size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.stat', async (_$, e) => {
    const known = files.has(e.path) || isDir(e.path) || e.path === '/repo' || e.path === '/repo/.git'
    if (!known) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: files.has(e.path) ? 'file' : 'dir', size: 0, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: e.path } : {}) } }
  })
  on('process.run', async (_$, e) => {
    const a = e.argv
    if (a[0] === 'mv') {
      const [from, to] = a.slice(-2) as [string, string]
      files.set(to, files.get(from) ?? '')
      files.delete(from)
      return ran(0)
    }
    if (a[0] === 'git' && a.includes('rev-parse')) {
      if (a.includes('--show-toplevel') && !a.includes('--git-dir')) return ran(0, '/repo\n')
      if (a.includes('--git-dir') && a.includes('--git-common-dir')) return ran(0, '/repo/.git\n/repo/.git\n')
    }
    return ran(1)
  })
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
  on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
  on('agent.list', async () => ({ value: [] }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: SESSION }))
  on('session.cwd', async () => ({ value: '/repo' }))
  return files
}

/** The ring as `<tag> <key> <label>` lines: a Button's label, an Input's or Select's own. */
type Ring = string[]

type Drawn = { findAll: (q: object) => Promise<{ type: string; key: string | undefined; text: string; props: Record<string, unknown> }[]> }

/** The pane's focus ring as drawn: its Button, Input and Select elements in tree order. */
async function ringOf(ui: Drawn): Promise<Ring> {
  return (await ui.findAll({}))
    .filter(e => e.type === 'Button' || e.type === 'Input' || e.type === 'Select')
    .map(e => `${e.type} ${e.key} ${e.type === 'Button' ? e.text : String(e.props.label ?? '')}`)
}

/** How many Tabs from nothing held reach the element keyed `key`: its 1-based place in the ring. */
const tabsTo = (ring: Ring, key: string): number => ring.findIndex(r => r.split(' ')[1] === key) + 1

/** The `litter` pane's strip with Rules shown: each other section a Button, in the strip's order (the shown tab is Text). */
const STRIP: Ring = ['home Home', 'runs Runs', 'swarms Swarms', 'tasks Tasks', 'agents Agents', 'doctor Doctor'].map(s => `Button litter:section:${s}`)
/**
 * The ring's head (WP-DE): the strip, then Rules' tab strip, where the shown
 * tab is Text and the other one Button with its count. The lists are Clients,
 * no Tab stop: a row is picked by a click, or by [next] (j) and [previous] (k).
 */
const tabs = (shown: 'proposed' | 'in-force', proposed: number, inForce: number): Ring => [
  ...STRIP,
  shown === 'proposed' ? `Button rules:tab:in-force ✓ In force ${inForce}` : `Button rules:tab:proposed ⚑ Proposed ${proposed}`,
]
/** [previous] and [next] on the picked row's heading, from two rows. */
const PAGER: Ring = ['Button rules:prev previous', 'Button rules:next next']
/** A new rule's scope pick: each scope but the picked one a Button (an import's is project already). */
const scopes = (key: string, picked = 'project'): Ring => ['user', 'project', 'local'].filter(s => s !== picked).map(s => `Button rules:scope-${s}:${key} ${s}`)
const actions = (key: string): Ring => [`Button rules:accept:${key} Accept`, `Button rules:edit:${key} Edit…`, `Button rules:dismiss:${key} Dismiss`]
/** The picked batch row's detail: [previous] [next], its scope, its own buttons and its check. */
const batchRow = (key: string, checked: boolean): Ring => [...PAGER, ...scopes(key), ...actions(key), `Button rules:check:${key} ${checked ? 'Uncheck' : 'Check'}`]
/** The lists beside the detail come first: the batch's [Accept selected] is the left column's last. */
const acceptSelected = (seq: number): Ring => [`Button rules:accept-selected:${seq} Accept selected`]

const ruleLedger = (files: Map<string, string>) =>
  [...files.keys()]
    .filter(k => k.startsWith(`${RULES_LEDGER}/`))
    .sort()
    .map(k => JSON.parse(files.get(k)!) as { seq: number; kind: string; body: Record<string, unknown> })

/** The proposals the import made, by guardrail text: rules.sh finds its rows by these. */
const proposalKeys = (files: Map<string, string>): Record<string, string> =>
  Object.fromEntries(ruleLedger(files).filter(r => r.kind === 'rule.propose').map(r => [String(r.body.rule), `repo:${r.seq}`]))

async function started($: Engine, on: On): Promise<Map<string, string>> {
  mock.store(on)
  mock.clock(on, { now: 1_800_000_000_000 })
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', HOME: '/home/tier1' })
  const files = world(on)
  // Where rules.sh moves the fixture's deepwork/.
  for (const [path, value] of Object.entries(RULES_IMPORT_DEEPWORK)) files.set(`/repo/.claude/deepwork/${path}`, fixtureText(path, value))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  return files
}

/**
 * rules.sh's Tab counts, each from nothing held (ctrl+x tab), then Enter; the
 * Paths field takes `send a/**` instead. Before [Edit…] and [Dismiss] it
 * types `j` once: [next], so the row is the picked one, whose buttons are drawn.
 */
const RULES_SH = { edit: 14, paths: 13, done: 15, accept: 13, confirm: 8, dismiss: 15, inForce: 7 }


describe("rules.sh's key presses (T4-2)", () => {
  // Eight pane states, each rebuilt from the plugin's own store: past the default 5 s under a loaded machine.
  test('the ring, state by state, from the import to the In force tab', { timeoutMs: 20000 }, async ($, on) => {
    const files = await started($, on)
    const imported = JSON.parse(String((await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: 't1', kind: 'rule.import', from: 'deepwork' })).result)) as Record<string, unknown>
    expect(imported).toEqual(expect.objectContaining({ ok: true, kind: 'rule.import', seq: 6, proposals: 5, live: 4, archived: 1, preselected: 2, opened: true }))
    // live1's four in state.json's order (its incident repeats the orchestrator one), then old1's.
    expect(proposalKeys(files)).toEqual({
      'never call curl in a/': 'repo:1',
      'never write to a/out.txt': 'repo:2',
      'never run the b/ tests twice in one gate': 'repo:3',
      'never touch files outside a/ and b/': 'repo:4',
      'never delete a test in b/': 'repo:5',
    })
    const ui = await $.ui.mount({ plugin: 'litter', surface: 'terminal', component: 'Pane', requestId: 'litter', props: pane('litter') })

    // Step 1: the pane opens on Rules, on the batch, live1's user and flag rows checked, the first row picked.
    const batch = (key: string, checked: boolean, proposed = 5, inForce = 0): Ring => [...tabs('proposed', proposed, inForce), ...acceptSelected(6), ...batchRow(key, checked)]
    expect(await ringOf(ui)).toEqual(batch('repo:1', true))
    // `j`: [next] picks the flag row.
    await ui.press({ key: 'rules:next' })
    expect(await ringOf(ui)).toEqual(batch('repo:2', true))
    expect(tabsTo(batch('repo:2', true), 'rules:edit:repo:2')).toBe(RULES_SH.edit)

    // Step 2: [Edit…] on the flag row adds its Paths, Type and [Done] after its scope, before its own buttons.
    await ui.press({ key: 'rules:edit:repo:2' })
    const editing = [
      ...tabs('proposed', 5, 0),
      ...acceptSelected(6),
      ...PAGER,
      ...scopes('repo:2'),
      'Input rules:paths:repo:2 Paths',
      'Select rules:type:repo:2 Type',
      'Button rules:edit-done:repo:2 Done',
      ...actions('repo:2'),
      'Button rules:check:repo:2 Uncheck',
    ]
    expect(await ringOf(ui)).toEqual(editing)
    expect(tabsTo(editing, 'rules:paths:repo:2')).toBe(RULES_SH.paths)
    // A ban's field says what its paths are.
    expect(await ui.find({ type: 'Text', text: 'globs it protects; a ban reaches every gate' })).toBeDefined()

    // The paths, set with Enter: the ring stays, the field holding them.
    await ui.input({ key: 'rules:paths:repo:2', text: 'a/**' })
    expect(await ringOf(ui)).toEqual(editing)
    expect((await ui.find({ type: 'Input', key: 'rules:paths:repo:2' }))?.text).toBe('a/**')
    expect(tabsTo(editing, 'rules:edit-done:repo:2')).toBe(RULES_SH.done)

    // [Done]: the batch's ring again, the paths kept for the accept.
    await ui.press({ key: 'rules:edit-done:repo:2' })
    expect(await ringOf(ui)).toEqual(batch('repo:2', true))
    // An import is a ban, so its description shows its paths as what it protects (WP-AH).
    expect(await ui.find({ type: 'Text', text: 'protects ' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: 'a/**' }))?.props.color).toBe('suggestion')
    expect(tabsTo(batch('repo:2', true), 'rules:accept:repo:2')).toBe(RULES_SH.accept)

    // The row's own [Accept]: an import's scope is project already, so no scope is asked; the file takes the body, [Confirm accept] first.
    await ui.press({ key: 'rules:accept:repo:2' })
    const preview = [...tabs('proposed', 5, 0), 'Button rules:confirm:repo:2 Confirm accept', 'Button rules:cancel:repo:2 Cancel']
    expect(await ringOf(ui)).toEqual(preview)
    expect(await ui.find({ type: 'Text', text: '.litter/rules/P-never-write-to-a-out-txt.md' })).toBeDefined()
    expect(await ui.find({ type: 'Code', text: '  paths: [a/**]' })).toBeDefined()
    expect(tabsTo(preview, 'rules:confirm:repo:2')).toBe(RULES_SH.confirm)

    // [Confirm accept]: the flag row leaves the batch, one rule in force; the first row is picked again.
    await ui.press({ key: 'rules:confirm:repo:2' })
    expect(await ringOf(ui)).toEqual(batch('repo:1', true, 4, 1))
    expect(files.has('/repo/.litter/rules/P-never-write-to-a-out-txt.md')).toBe(true)

    // Step 3: `j` picks the orchestrator row, then its [Dismiss].
    await ui.press({ key: 'rules:next' })
    expect(await ringOf(ui)).toEqual(batch('repo:3', false, 4, 1))
    expect(tabsTo(batch('repo:3', false, 4, 1), 'rules:dismiss:repo:3')).toBe(RULES_SH.dismiss)
    await ui.press({ key: 'rules:dismiss:repo:3' })
    expect(await ringOf(ui)).toEqual(batch('repo:1', true, 3, 1))
    expect(ruleLedger(files).map(r => r.kind).slice(6)).toEqual(['rule.accept', 'rule.dismiss'])

    // /litter rules: the Proposed tab with no batch (no checks, no [Accept selected]), then its In force tab.
    const r = await $.command.run({ command: 'litter', args: 'rules', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 200 } })
    expect(r.text).toBe('Rules shows 3 proposed or unverified, 1 in force')
    const proposed = [...tabs('proposed', 3, 1), ...PAGER, ...scopes('repo:1'), ...actions('repo:1')]
    expect(await ringOf(ui)).toEqual(proposed)
    expect(tabsTo(proposed, 'rules:tab:in-force')).toBe(RULES_SH.inForce)
    await ui.press({ key: 'rules:tab:in-force' })
    expect(await ringOf(ui)).toEqual([...tabs('in-force', 3, 1), 'Button rules:edit:P-never-write-to-a-out-txt Edit…', 'Button rules:retire:P-never-write-to-a-out-txt Retire'])
    // What rules.sh's c_rules_pane reads off the screen: the row, in force, with its id and version.
    const listed = drawText(await ui.drawn({ in: 'rules:list:main' }), 108)
    expect(listed.filter(row => /never write to a\/out\.txt +✓ in force +project +ban +P-never-write-to-a-out-txt@1/.test(row))).toHaveLength(1)
    expect(await ui.find({ type: 'Text', text: 'P-never-write-to-a-out-txt@1' })).toBeDefined()
  })
})
