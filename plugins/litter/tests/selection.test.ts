// Tier 1: the accepted rules' selection as the engine runs it (plan 16.5,
// WP-AE). rule.find { applicable } from the main thread answers what a launch
// would deliver and writes nothing: no file, and no mv or rm. AD's handler
// routes it to AE's findApplicable, so the selection's shape is the answer.
// A ban with paths, committed at HEAD, is a shared rule (WP-AH).
// The run.start case (run.json.rules with the versions, and the rules
// in each gate's args, through a fake store) is at tier 2, in
// tests/unit/rulesselect.spec.ts: a fake store can't reach the mod's module
// state from here, and run.start's snapshot needs a real repository.

import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const PLAN = ['# Plan', '', '### G1: Change a', 'Files: a.txt', 'Checks: true', 'Done when: a changed', 'Adversary: no', 'Rollback: revert', '', 'Change a.', ''].join('\n')

/** A project ban with paths, as T4-1's fixtures/compare/P-vendor-as-shipped.md is: G1's Files (a.txt) are none of them. */
const BAN_ID = 'P-vendor-as-shipped'
const BAN = ['---', `id: ${BAN_ID}`, 'version: 1', 'status: accepted', 'type: ban', 'applies:', '  paths: [vendor/**]', '  when: ""', 'export: true', '---', '', '## Rule', 'Never change anything under vendor/.', ''].join('\n')
const BLOB = 'b'.repeat(40)
const COMMIT = 'c'.repeat(40)

/**
 * $.fs from a map of files, and $.process.run for the git calls litterdir.ts
 * makes in a plain checkout at /repo, plus the mv and rm fsx.ts runs (as
 * record.test.ts's world). Once `armed` is set, each write, mv and rm is
 * listed in `changed`. `git` answers any other git call it knows.
 */
function world(on: On, git?: (argv: readonly string[]) => { exitCode: number; stdout: string } | null): { files: Map<string, string>; changed: string[]; arm: () => void } {
  const files = new Map<string, string>()
  const changed: string[] = []
  let armed = false
  const isDir = (path: string) => [...files.keys()].some(k => k.startsWith(`${path}/`))
  const run = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('fs.exists', async (_$, e) => ({ value: files.has(e.path) || isDir(e.path) }))
  on('fs.read', async (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_$, e) => {
    if (armed) changed.push(`write ${e.path}`)
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
      if (armed) changed.push(`mv ${argv.slice(-2).join(' ')}`)
      const [from, to] = argv.slice(-2) as [string, string]
      files.set(to, files.get(from) ?? '')
      files.delete(from)
      return run(0)
    }
    if (argv[0] === 'rm') {
      if (armed) changed.push(`rm ${argv[argv.length - 1]}`)
      const path = argv[argv.length - 1]!
      for (const k of [...files.keys()]) if (k === path || k.startsWith(`${path}/`)) files.delete(k)
      return run(0)
    }
    if (argv[0] === 'git' && argv.includes('rev-parse')) {
      if (argv.includes('--show-toplevel') && !argv.includes('--git-dir')) return run(0, '/repo\n')
      if (argv.includes('--git-dir') && argv.includes('--git-common-dir')) return run(0, '/repo/.git\n/repo/.git\n')
    }
    const answer = argv[0] === 'git' ? git?.(argv) : null
    if (answer) return run(answer.exitCode, answer.stdout)
    return run(1)
  })
  return { files, changed, arm: () => (armed = true) }
}

type Reply = { ok: boolean; error?: string; field?: string; workflow?: string; run?: unknown; gates?: unknown; versions?: unknown; problems?: unknown }

const parse = (r: { result?: unknown }) => JSON.parse(String(r.result)) as Reply

describe('rule.find { applicable }', () => {
  test('from the main thread, answers what an execute launch would deliver and writes nothing', async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 5_000 })
    const { files, changed, arm } = world(on)
    files.set('/repo/plan.md', PLAN)
    files.set('/repo/a.txt', 'a\n')
    on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
    on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
    on('session.id', async () => ({ value: 'tier1-session' }))
    on('session.cwd', async () => ({ value: '/repo' }))
    on('ui.log', async () => ({ value: undefined }))
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    arm()
    const before = new Map(files)
    const applicable = { workflow: 'execute', planPath: 'plan.md', runRules: ['Keep the diff small'] }
    // As the model passes it: an object, or the object as a JSON string (ledger.ts decodes it).
    for (const [n, value] of [applicable, JSON.stringify(applicable)].entries()) {
      const r = parse(await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: `t-find-${n}`, kind: 'rule.find', applicable: value }))
      // No rule is accepted here. Your run rules count against the cap, but run.start renders them itself, so `run` is the accepted rules' only.
      expect(r).toEqual(
        expect.objectContaining({
          ok: true,
          workflow: 'execute',
          run: [],
          gates: { G1: [] },
          versions: [],
        }),
      )
      expect(Array.isArray(r.problems)).toBe(true)
    }
    expect(changed).toEqual([])
    expect(files).toEqual(before)
  })

  test("a ban with paths, committed at HEAD, is in the run's shared rules naming what it protects, and in no gate's own", async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 5_000 })
    // The project rule as committed at HEAD (store.ts's loadProject): ls-tree lists it, cat-file reads it, log names its commit.
    const rel = `.litter/rules/${BAN_ID}.md`
    const { files } = world(on, argv => {
      if (argv.includes('--verify') && argv.includes('HEAD^{commit}')) return { exitCode: 0, stdout: `${COMMIT}\n` }
      if (argv.includes('ls-tree') && argv.includes('.litter/rules/')) return { exitCode: 0, stdout: `100644 blob ${BLOB}\t${rel}\0` }
      if (argv.includes('cat-file') && argv.includes(BLOB)) return { exitCode: 0, stdout: BAN }
      if (argv.includes('log') && argv.includes(rel)) return { exitCode: 0, stdout: `${COMMIT}\n` }
      return null
    })
    files.set('/repo/plan.md', PLAN)
    files.set('/repo/a.txt', 'a\n')
    files.set(`/repo/${rel}`, BAN)
    on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
    on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
    on('session.id', async () => ({ value: 'tier1-session' }))
    on('session.cwd', async () => ({ value: '/repo' }))
    on('ui.log', async () => ({ value: undefined }))
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    const r = parse(await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: 't-find-ban', kind: 'rule.find', applicable: { workflow: 'execute', planPath: 'plan.md' } }))
    expect(r).toEqual(
      expect.objectContaining({
        ok: true,
        workflow: 'execute',
        run: [`${BAN_ID}@1 (ban; protects vendor/**): Never change anything under vendor/.`],
        gates: { G1: [] },
        versions: [{ id: BAN_ID, version: 1 }],
      }),
    )
  })
})
