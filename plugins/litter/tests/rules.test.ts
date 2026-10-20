// Tier 1: the rules store as the engine runs it (WP-AD; plan 16.9, 12:1566).
// rule.accept, rule.dismiss and rule.retire through mcp__litter__record are
// refused from the main thread and from an agent, and nothing is written;
// rule.find writes nothing; a gate critic's proposed rules land in the
// repository's rules ledger with the run id, through output.ts's drain; and
// rule.import and rule.open record, then try Rules in the `litter` pane,
// answering "run /litter rules" when it doesn't open. $.fs is a map, git answers as for a
// checkout with no commit, and the config dir is CLAUDE_CONFIG_DIR's /cfg.

import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

const RUN = '20261003-rules'
const SESSION = 'tier1-session'
const LITTER = '/repo/.claude/litter'
const RULES_LEDGER = `${LITTER}/rules-ledger/ledger`

/** $.fs from a map, and $.process.run for litterdir.ts's git calls in a checkout at /repo (record.test.ts's world). */
function world(on: On): Map<string, string> {
  const files = new Map<string, string>()
  const isDir = (path: string) => [...files.keys()].some(k => k.startsWith(`${path}/`))
  const run = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
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
    return {
      value: [...names].map(name => ({ name, kind: files.has(`${e.path}/${name}`) ? ('file' as const) : ('dir' as const), size: 0, mtimeMs: 0, isLink: false })),
    }
  })
  on('fs.stat', async (_$, e) => {
    const known = files.has(e.path) || isDir(e.path) || e.path === '/repo' || e.path === '/repo/.git'
    if (!known) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: files.has(e.path) ? 'file' : 'dir', size: 0, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: e.path } : {}) } }
  })
  on('process.run', async (_$, e) => {
    const argv = e.argv
    if (argv[0] === 'mv') {
      const [from, to] = argv.slice(-2) as [string, string]
      files.set(to, files.get(from) ?? '')
      files.delete(from)
      return run(0)
    }
    if (argv[0] === 'rm') {
      const path = argv[argv.length - 1]!
      for (const k of [...files.keys()]) if (k === path || k.startsWith(`${path}/`)) files.delete(k)
      return run(0)
    }
    if (argv[0] === 'git' && argv.includes('rev-parse')) {
      if (argv.includes('--show-toplevel') && !argv.includes('--git-dir')) return run(0, '/repo\n')
      if (argv.includes('--git-dir') && argv.includes('--git-common-dir')) return run(0, '/repo/.git\n/repo/.git\n')
    }
    // Anything else (HEAD among it) fails, as in a checkout with no commit.
    return run(1)
  })
  return files
}

/** Agents the map knows, as consumeAgents stores them (policy.ts): a gate critic and a falsifier of RUN. */
const AGENTS = Object.fromEntries(
  [
    ['gc', 'gate-critic'],
    ['a1', 'falsifier'],
  ].map(([id, role]) => [`litter.agent.${id}`, { agentId: id, agentType: `litter:${role}`, role, run: RUN, cwd: '/w', started: 1, stopped: null }]),
)

type Reply = { ok: boolean; error?: string; field?: string; allowed?: string[]; [k: string]: unknown }
const parse = (r: { result?: unknown }) => JSON.parse(String(r.result)) as Reply

/** The world, the mocks and a started session at /repo; the panes the mod asked to open. */
async function started($: Engine, on: On): Promise<{ files: Map<string, string>; opens: { id: string; focus: boolean }[] }> {
  mock.store(on, AGENTS)
  mock.clock(on, { now: 5_000 })
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg' })
  const files = world(on)
  const opens: { id: string; focus: boolean }[] = []
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
  on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
  on('session.id', async () => ({ value: SESSION }))
  on('ui.log', async () => ({ value: undefined }))
  // A session that places no panes: whatever opens the `litter` pane on Rules is answered undrawn.
  on('ui.open', async (_$, e) => {
    opens.push({ id: e.id, focus: e.focus === true })
    return { value: { isPlaced: false, reason: 'tier 1 places no panes' } }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  return { files, opens }
}

let n = 0
const record = async ($: Engine, fields: Record<string, unknown>, agentId?: string) =>
  parse(await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: `t${++n}`, ...(agentId ? { agentId } : {}), ...fields }))

const snapshot = (files: Map<string, string>) => new Map(files)
const ruleLedger = (files: Map<string, string>) =>
  [...files.keys()]
    .filter(k => k.startsWith(`${RULES_LEDGER}/`))
    .sort()
    .map(k => JSON.parse(files.get(k)!) as { seq: number; kind: string; run: string; by: unknown; body: Record<string, unknown> })

describe('the steps that are yours alone', () => {
  test('rule.accept, rule.dismiss and rule.retire are refused from the main thread and from an agent, and nothing is written', async ($, on) => {
    const { files } = await started($, on)
    expect((await record($, { kind: 'rule.propose', rule: 'Keep fixtures small.' })).ok).toBe(true)
    const before = snapshot(files)
    for (const kind of ['rule.accept', 'rule.dismiss', 'rule.retire']) {
      for (const agentId of [undefined, 'a1', 'gc']) {
        const r = await record($, { kind, proposal: { store: 'repo', seq: 1 }, id: 'P-keep-fixtures-small', version: 1, scope: 'project', via: 'ui' }, agentId)
        expect(r).toEqual(expect.objectContaining({ ok: false, field: 'kind', allowed: ['rule.propose', 'rule.open'] }))
        expect(r.error).toContain('rules pane (/litter rules)')
      }
    }
    expect(files).toEqual(before)
    expect([...files.keys()].some(k => k.startsWith('/cfg/') || k.includes('/.litter/') || k.includes('/.litter.local/'))).toBe(false)
  })

  // Phase 6 (16.7): a rule file the mod exported is recorded by the mod alone.
  test('rule.export is refused from the main thread and from an agent, as litter records it itself', async ($, on) => {
    const { files } = await started($, on)
    const before = snapshot(files)
    for (const agentId of [undefined, 'gc']) {
      const r = await record($, { kind: 'rule.export', id: 'P-x', version: 1, scope: 'project', path: '/repo/.claude/rules/litter/P-x.md', sha256: null }, agentId)
      expect(r).toEqual(expect.objectContaining({ ok: false, field: 'kind', error: "litter: 'rule.export' is recorded by litter itself, never through this tool" }))
    }
    expect(files).toEqual(before)
  })
})

describe('rule.find', () => {
  test('writes nothing, in any of its four forms', async ($, on) => {
    const { files } = await started($, on)
    expect((await record($, { kind: 'rule.propose', rule: 'Keep fixtures small.', scope: 'local' })).ok).toBe(true)
    const before = snapshot(files)
    const forms: Record<string, unknown>[] = [
      { id: 'L-keep-fixtures-small' },
      { status: JSON.stringify(['accepted', 'proposed', 'dismissed', 'retired']) },
      { similar: 'keep FIXTURES small.' },
      { applicable: { workflow: 'execute', planPath: '/repo/plan.md' } },
    ]
    for (const form of forms) for (const agentId of [undefined, 'a1']) await record($, { kind: 'rule.find', ...form }, agentId)
    const status = await record($, { kind: 'rule.find', status: ['proposed'] })
    expect(status).toEqual(expect.objectContaining({ ok: true, rules: [] }))
    expect((status.proposals as { rule: string; status: string }[]).map(x => [x.rule, x.status])).toEqual([['Keep fixtures small.', 'proposed']])
    expect(files).toEqual(before)
  })
})

describe("a gate critic's proposals", () => {
  test("land in the repository's rules ledger with the run id, through output.ts's drain", async ($, on) => {
    const { files } = await started($, on)
    const VERDICT = {
      verify_id: 'vf1',
      plan_adherence: { pass: true, evidence: 'a.ts:3', gaps: [] },
      tests_green: { pass: true, evidence: 'exit 0', gaps: [] },
      no_regressions: { pass: true, evidence: 'ok', gaps: [] },
      rules: { pass: true, evidence: 'none apply', gaps: [] },
      plan_gap: '',
      rule_clash: '',
      proposed_rules: ['When a test touches the clock, freeze it.', '', 'Keep fixtures small.'],
    }
    const line = { v: 1, ev: 'output', ts: 6, session_id: SESSION, agent_id: 'gc', agent_type: 'litter:gate-critic', tool_use_id: 'tu-gc', input: VERDICT }
    files.set(`${LITTER}/hooks/spool/${SESSION}.jsonl`, `${JSON.stringify(line)}\n`)
    // Any record call drains the spool first.
    const r = await record($, { kind: 'rule.find', status: ['proposed'] })
    expect(r.ok).toBe(true)
    const rules = ruleLedger(files)
    expect(rules.map(x => [x.seq, x.kind, x.run])).toEqual([
      [1, 'rule.propose', 'rules'],
      [2, 'rule.propose', 'rules'],
    ])
    expect(rules[0]!.by).toEqual({ source: 'agent', agentId: 'gc', agentType: 'litter:gate-critic' })
    expect(rules[0]!.body).toEqual({ rule: 'When a test touches the clock, freeze it.', source: 'critic', run: RUN, index: 0, tool_use_id: 'tu-gc' })
    expect(rules[1]!.body).toEqual(expect.objectContaining({ rule: 'Keep fixtures small.', run: RUN, index: 2 }))
    // The verdict is the run's; the proposals aren't.
    const runLedger = [...files.keys()].filter(k => k.startsWith(`${LITTER}/${RUN}/ledger/`))
    expect(runLedger.map(k => k.slice(k.lastIndexOf('/') + 1))).toEqual(['000001-verdict.json'])
    expect((r.proposals as { run?: string }[]).map(x => x.run)).toEqual([RUN, RUN])
  })
})

describe('rule.import and rule.open', () => {
  test("record, then try Rules in the `litter` pane; one that doesn't open answers run /litter rules", async ($, on) => {
    const { files, opens } = await started($, on)
    files.set(
      '/repo/.claude/deepwork/live-1/state.json',
      JSON.stringify({ goal: 'Ship it', started_at: '2026-10-01T00:00:00Z', guardrails: [{ rule: 'Never push to main.', source: 'user' }, { rule: 'Ask first.', source: 'orchestrator' }] }),
    )
    const NOTE = "litter's Rules section didn't open here; tell the user to run /litter rules"
    const imported = await record($, { kind: 'rule.import', from: 'deepwork' })
    expect(imported).toEqual(expect.objectContaining({ ok: true, kind: 'rule.import', seq: 3, proposals: 2, preselected: 1, opened: false, note: NOTE }))
    const opened = await record($, { kind: 'rule.open', proposal: JSON.stringify({ store: 'repo', seq: 1 }) })
    expect(opened).toEqual({ ok: true, kind: 'rule.open', seq: 4, opened: false, note: NOTE })
    expect(ruleLedger(files).map(x => x.kind)).toEqual(['rule.propose', 'rule.propose', 'rule.import', 'rule.open'])
    // Each open was the `litter` pane, and none asked for the keyboard: the model called, not the person.
    expect(opens.length).toBeGreaterThan(0)
    for (const o of opens) expect(o).toEqual({ id: 'litter', focus: false })
    // An agent may open a rule but not import.
    expect(await record($, { kind: 'rule.import', from: 'deepwork' }, 'a1')).toEqual(expect.objectContaining({ ok: false, field: 'kind' }))
  })
})
