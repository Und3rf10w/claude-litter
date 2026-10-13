// Tier 2: where litterDir is (plan section 10, "One litter directory"), in
// scratch repos with real git: the primary checkout, a linked worktree,
// sibling submodules, a separate git dir, a forged record, a bare repository,
// and a non-repo. Then run.find over the runs it finds there.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordError, RecordOk, RecordReply } from '../../hooks/records/core'
import { appendRecord } from '../../hooks/ledgercore'
import { hooksDir, ledgerDir, pointerPath, runDir, runJsonPath } from '../../hooks/layout'
import { LITTER_GITIGNORE, recordRunFind, resolveLitterDir, writeGitignore, type FoundRun, type LitterDirResult } from '../../hooks/litterdir'
import { normalizeOptions, type ConfiguredOptions } from '../../hooks/options'
import { setOptions } from '../../hooks/session'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

// Real git in every test, submodules and worktrees among them; a loaded machine takes seconds.
setDefaultTimeout(120_000)

let p: TestPorts
let root: string
let cleanup: () => void

beforeEach(() => {
  p = nodePorts()
  const s = scratch()
  root = realpathSync(s.dir)
  cleanup = s.cleanup
})
afterEach(() => cleanup())

async function git(cwd: string, ...argv: string[]): Promise<string> {
  const r = await p.run(['git', ...argv], { cwd })
  if (r.code !== 0) throw new Error(`git ${argv.join(' ')}: ${r.stderr.trim()}`)
  return r.stdout.trim()
}

async function repo(name: string): Promise<string> {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  await scratchRepo(p, dir)
  return dir
}

const ok = (r: LitterDirResult) => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`)
  return r
}

describe('resolveLitterDir', () => {
  test('the primary checkout, from its root and from a subdirectory, and the record of it', async () => {
    const main = await repo('main')
    mkdirSync(join(main, 'src', 'deep'), { recursive: true })
    const r = ok(await resolveLitterDir(p, main))
    expect(r).toEqual({ ok: true, litterDir: `${main}/.claude/litter`, primary: main, commonDir: `${main}/.git` })
    expect(ok(await resolveLitterDir(p, join(main, 'src', 'deep')))).toEqual(r)
    expect(readFileSync(join(main, '.git', 'litter-primary'), 'utf8')).toBe(`${main}\n`)
    // No pointer in the primary checkout or its subdirectories.
    expect(existsSync(pointerPath(main))).toBe(false)
    expect(existsSync(pointerPath(join(main, 'src', 'deep')))).toBe(false)
  })

  test('the record is written only when it changes', async () => {
    const main = await repo('main')
    await resolveLitterDir(p, main)
    const before = statSync(join(main, '.git', 'litter-primary')).mtimeMs
    await new Promise(r => setTimeout(r, 20))
    await resolveLitterDir(p, main)
    expect(statSync(join(main, '.git', 'litter-primary')).mtimeMs).toBe(before)
  })

  test('a linked worktree resolves to the primary, and gets the pointer at its top level only', async () => {
    const main = await repo('main')
    const wt = join(root, 'wt')
    await git(main, 'worktree', 'add', '-q', '-b', 'side', wt)
    mkdirSync(join(wt, 'sub'), { recursive: true })
    const r = ok(await resolveLitterDir(p, join(wt, 'sub')))
    expect(r.litterDir).toBe(`${main}/.claude/litter`)
    expect(r.primary).toBe(main)
    expect(readFileSync(pointerPath(wt), 'utf8')).toBe(`${hooksDir(r.litterDir)}\n`)
    expect(existsSync(pointerPath(join(wt, 'sub')))).toBe(false)
    // An unchanged pointer isn't rewritten.
    const before = statSync(pointerPath(wt)).mtimeMs
    await new Promise(res => setTimeout(res, 20))
    ok(await resolveLitterDir(p, wt))
    expect(statSync(pointerPath(wt)).mtimeMs).toBe(before)
  })

  test('two sibling submodules get distinct directories, from each and from a worktree of one', async () => {
    const sup = await repo('super')
    const a = await repo('src-a')
    const b = await repo('src-b')
    await git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', a, 'a')
    await git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', b, 'b')
    const ra = ok(await resolveLitterDir(p, join(sup, 'a')))
    const rb = ok(await resolveLitterDir(p, join(sup, 'b')))
    expect(ra.litterDir).toBe(`${sup}/a/.claude/litter`)
    expect(rb.litterDir).toBe(`${sup}/b/.claude/litter`)
    expect(ra.commonDir).toBe(`${sup}/.git/modules/a`)
    const wtA = join(root, 'wt-a')
    await git(join(sup, 'a'), 'worktree', 'add', '-q', '-b', 'side', wtA)
    const rw = ok(await resolveLitterDir(p, wtA))
    expect(rw.litterDir).toBe(ra.litterDir)
    expect(ok(await resolveLitterDir(p, sup)).litterDir).toBe(`${sup}/.claude/litter`)
  })

  test("a separate git dir: its checkout resolves; its worktree only once the primary is recorded", async () => {
    const sep = join(root, 'sep')
    const store = join(root, 'store')
    await git(root, 'init', '-q', '-b', 'main', '--separate-git-dir', store, sep)
    writeFileSync(join(sep, 'f'), 'x\n')
    await git(sep, 'add', 'f')
    await git(sep, 'commit', '-q', '-m', 'init')
    const wt = join(root, 'sep-wt')
    await git(sep, 'worktree', 'add', '-q', '-b', 'side', wt)
    const before = await resolveLitterDir(p, wt)
    expect(before.ok).toBe(false)
    expect((before as { error: string }).error).toContain('Open a session in the primary checkout')
    expect(existsSync(pointerPath(wt))).toBe(false)
    const primary = ok(await resolveLitterDir(p, sep))
    expect(primary.litterDir).toBe(`${sep}/.claude/litter`)
    expect(primary.commonDir).toBe(store)
    expect(ok(await resolveLitterDir(p, wt)).litterDir).toBe(primary.litterDir)
  })

  test('a forged or stale litter-primary is refused', async () => {
    const sep = join(root, 'sep')
    const store = join(root, 'store')
    await git(root, 'init', '-q', '-b', 'main', '--separate-git-dir', store, sep)
    writeFileSync(join(sep, 'f'), 'x\n')
    await git(sep, 'add', 'f')
    await git(sep, 'commit', '-q', '-m', 'init')
    const wt = join(root, 'sep-wt')
    await git(sep, 'worktree', 'add', '-q', '-b', 'side', wt)
    const other = await repo('other')
    for (const forged of [other, join(root, 'nowhere'), wt, 'relative/path']) {
      writeFileSync(join(store, 'litter-primary'), `${forged}\n`)
      expect((await resolveLitterDir(p, wt)).ok).toBe(false)
    }
  })

  test('a bare repository with linked worktrees uses <common dir>/litter from each', async () => {
    const src = await repo('src')
    const bare = join(root, 'b.git')
    await git(root, 'clone', '-q', '--bare', src, bare)
    const wt1 = join(root, 'wt1')
    const wt2 = join(root, 'wt2')
    await git(bare, 'worktree', 'add', '-q', wt1, 'main')
    await git(bare, 'worktree', 'add', '-q', '-b', 'other', wt2)
    const r1 = ok(await resolveLitterDir(p, wt1))
    expect(r1).toEqual({ ok: true, litterDir: `${bare}/litter`, primary: null, commonDir: bare })
    expect(ok(await resolveLitterDir(p, wt2)).litterDir).toBe(r1.litterDir)
    expect(ok(await resolveLitterDir(p, bare)).litterDir).toBe(r1.litterDir)
    expect(readFileSync(pointerPath(wt1), 'utf8')).toBe(`${bare}/litter/hooks\n`)
  })

  test('a non-repo, and a relative directory, are refused with the reason', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    const r = await resolveLitterDir(p, plain)
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toContain("isn't inside a git repository")
    expect((await resolveLitterDir(p, 'relative')).ok).toBe(false)
  })

  test('git that cannot start is a refusal, not a throw', async () => {
    p.run = async () => {
      throw new Error('spawn git ENOENT')
    }
    expect((await resolveLitterDir(p, root)).ok).toBe(false)
  })
})

// WP-AQ: what of .claude/litter/ git leaves out, and what it offers you to commit.
describe("litterDir's .gitignore", () => {
  test("leaves out the hooks' state, the locks, the ledgers and the verify logs, and nothing else of the runs and swarms", async () => {
    const dir = await repo('a')
    const litterDir = join(dir, '.claude', 'litter')
    mkdirSync(litterDir, { recursive: true })
    await writeGitignore(p, litterDir)
    expect(readFileSync(join(litterDir, '.gitignore'), 'utf8')).toBe(LITTER_GITIGNORE)
    const RUN = '20261004-execute-abc123'
    const out = [
      'hooks/policy.json',
      'hooks/agents/a1.json',
      'lock-lease-0123abcd.json',
      'rules-ledger/000001-rule.accept.json',
      `${RUN}/ledger/000001-run.start.json`,
      `${RUN}/ledger-export/x.json`,
      `${RUN}/verify/v1/0001.log`,
      'swarms/alpha/ledger/000001-swarm.propose.json',
      'swarms/alpha/owner-lease-0123abcd.json',
      'swarms/alpha/launches/20261004-063550/ledger/000001-swarm.start.json',
    ]
    const kept = [
      '.gitignore',
      `${RUN}/run.json`,
      `${RUN}/plan.md`,
      `${RUN}/plan.1.md`,
      `${RUN}/summary.md`,
      `${RUN}/verdicts/G1-1.md`,
      `${RUN}/proposals/v1.md`,
      'swarms/alpha/swarm.json',
      'swarms/alpha/briefs/runner.md',
      'swarms/alpha/revisions/1.json',
      'swarms/alpha/launches/20261004-063550/summary.md',
      // A swarm named like a run's folder keeps its spec: only run folders' ledger/, ledger-export/ and verify/ are left out by those lines.
      'swarms/ledger/swarm.json',
      'swarm-templates/review.json',
      'WIKI.md',
    ]
    const ignored = async (rel: string) => (await p.run(['git', 'check-ignore', '-q', '--no-index', `.claude/litter/${rel}`], { cwd: dir })).code === 0
    for (const rel of out) expect({ rel, ignored: await ignored(rel) }).toEqual({ rel, ignored: true })
    for (const rel of kept) expect({ rel, ignored: await ignored(rel) }).toEqual({ rel, ignored: false })
  })

  test("one already there is left as it is, and a bare repository's litterDir gets none", async () => {
    const dir = await repo('a')
    const litterDir = join(dir, '.claude', 'litter')
    mkdirSync(litterDir, { recursive: true })
    writeFileSync(join(litterDir, '.gitignore'), '# mine\n')
    await writeGitignore(p, litterDir)
    expect(readFileSync(join(litterDir, '.gitignore'), 'utf8')).toBe('# mine\n')
    const bare = join(root, 'bare.git', 'litter')
    mkdirSync(bare, { recursive: true })
    await writeGitignore(p, bare)
    expect(existsSync(join(bare, '.gitignore'))).toBe(false)
  })
})

describe('run.find', () => {
  const ctxFor = (litterDir: string | null) => ({ p, caller: { agentId: null, agentType: null }, litterDir, options: normalizeOptions(undefined) })

  async function makeRun(litterDir: string, run: string, workflow: string, at: number, kinds: [string, Record<string, unknown>][]) {
    const dir = runDir(litterDir, run)
    await p.fs.write(runJsonPath(dir), `${JSON.stringify({ v: 1, run, workflow, args: {}, ref: `litter/${run}` })}\n`)
    p.clock.now = at
    for (const [kind, body] of [['run.start', {}] as [string, Record<string, unknown>], ...kinds]) {
      await appendRecord(p, dir, { run, kind, by: { source: 'mod' }, body })
    }
  }

  const tree = (dir: string): string[] =>
    existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : []

  const runsOf = (r: RecordReply) => {
    expect(r.ok).toBe(true)
    return (r as RecordOk).runs as FoundRun[]
  }

  test('the same answer from the main checkout and a linked worktree, newest first, with each checkout', async () => {
    const main = await repo('main')
    const litterDir = ok(await resolveLitterDir(p, main)).litterDir
    await makeRun(litterDir, '20261001-older', 'execute', 1_000, [['run.launch', { generation: 1 }], ['run.end', { status: 'done' }]])
    await makeRun(litterDir, '20261002-newer', 'fanout', 2_000, [])
    await makeRun(litterDir, '20261002-going', 'execute', 3_000, [['run.launch', {}], ['run.stopping', {}]])
    await git(main, 'branch', 'litter/20261001-older')
    const wt = join(root, 'run-wt')
    await git(main, 'worktree', 'add', '-q', wt, 'litter/20261001-older')
    expect(ok(await resolveLitterDir(p, wt)).litterDir).toBe(litterDir)
    const before = tree(litterDir)
    const r = await recordRunFind(ctxFor(litterDir), { kind: 'run.find' })
    expect(r).toEqual({
      ok: true,
      litterDir,
      runs: [
        { run: '20261002-going', runDir: runDir(litterDir, '20261002-going'), checkout: null, workflow: 'execute', status: 'stopping', started: 3_000 },
        { run: '20261002-newer', runDir: runDir(litterDir, '20261002-newer'), checkout: null, workflow: 'fanout', status: 'pending', started: 2_000 },
        { run: '20261001-older', runDir: runDir(litterDir, '20261001-older'), checkout: wt, workflow: 'execute', status: 'done', started: 1_000 },
      ],
    })
    expect(tree(litterDir)).toEqual(before)
    const byRun = await recordRunFind(ctxFor(litterDir), { kind: 'run.find', run: '20261002-newer' })
    expect(runsOf(byRun).map(x => x.run)).toEqual(['20261002-newer'])
    const byWf = await recordRunFind(ctxFor(litterDir), { kind: 'run.find', workflow: 'execute' })
    expect(runsOf(byWf).map(x => x.run)).toEqual(['20261002-going', '20261001-older'])
  })

  test('bad filters name their field; no litterDir and no runs are answered plainly', async () => {
    const main = await repo('main')
    const litterDir = ok(await resolveLitterDir(p, main)).litterDir
    expect((await recordRunFind(ctxFor(litterDir), { kind: 'run.find', run: '../x' }) as RecordError).field).toBe('run')
    const wf = (await recordRunFind(ctxFor(litterDir), { kind: 'run.find', workflow: 'deploy' })) as RecordError
    expect(wf.field).toBe('workflow')
    expect(wf.allowed).toEqual(['execute', 'fanout', 'design', 'plan'])
    expect((await recordRunFind(ctxFor(null), { kind: 'run.find' })).ok).toBe(false)
    expect(await recordRunFind(ctxFor(litterDir), { kind: 'run.find' })).toEqual({ ok: true, litterDir, runs: [] })
  })

  // Design D9: a skill shows the configured options from run.find, where ${user_config.*} gave them before.
  describe("with 'options: true', the configured options", () => {
    afterEach(() => setOptions(undefined))

    test('the options a skill shows, null where unset, and none of the UI and log settings', async () => {
      const main = await repo('main')
      const litterDir = ok(await resolveLitterDir(p, main)).litterDir
      // verify is a `multiple: true` option: it arrives as its argument list.
      setOptions({ verify: ['npm', 'test'], maxAttempts: 5, widen: 'critic', summaryModel: 'claude-haiku-4-5-20251001', bandEndedMinutes: 3 })
      const r = await recordRunFind(ctxFor(litterDir), { kind: 'run.find', options: true })
      expect(r).toEqual({ ok: true, litterDir, runs: [], options: expect.any(Object) })
      const options = (r as RecordOk & { options: ConfiguredOptions }).options
      expect(options.verify).toEqual(['npm', 'test'])
      expect(options.maxAttempts).toBe(5)
      expect(options.widen).toBe('critic')
      expect(options.goalCheck).toBeNull()
      expect(options.setup).toBeNull()
      expect(Object.keys(options).sort()).toEqual([
        'goalCheck', 'linkDirs', 'maxAttempts', 'maxRounds', 'repair', 'repairAgents', 'repairRounds', 'setup', 'trailers', 'verify', 'verifyTimeoutMs', 'widen',
      ])
    })

    test("left out or false, the reply is as it was; anything else is refused, naming 'options'", async () => {
      const main = await repo('main')
      const litterDir = ok(await resolveLitterDir(p, main)).litterDir
      setOptions({ verify: ['npm', 'test'] })
      expect(await recordRunFind(ctxFor(litterDir), { kind: 'run.find', options: false })).toEqual({ ok: true, litterDir, runs: [] })
      for (const options of ['yes', 'true', 1, null]) {
        const e = (await recordRunFind(ctxFor(litterDir), { kind: 'run.find', options })) as RecordError
        expect(e.ok).toBe(false)
        expect(e.field).toBe('options')
        expect(e.error).toBe("litter: 'options' must be true, or left out")
      }
    })
  })

  test('a tampered ledger shows as ledger_tampered, and a run.json that does not parse is skipped', async () => {
    const main = await repo('main')
    const litterDir = ok(await resolveLitterDir(p, main)).litterDir
    await makeRun(litterDir, '20261002-broken', 'execute', 1_000, [['run.launch', {}]])
    const first = join(ledgerDir(runDir(litterDir, '20261002-broken')), '000001-run.start.json')
    writeFileSync(first, readFileSync(first, 'utf8').replace('"body":{}', '"body":{"x":1}'))
    await p.fs.write(runJsonPath(runDir(litterDir, '20261002-junk')), '{not json')
    const r = await recordRunFind(ctxFor(litterDir), { kind: 'run.find' })
    expect(runsOf(r).map(x => [x.run, x.status])).toEqual([['20261002-broken', 'ledger_tampered']])
    expect(p.logs.join('\n')).toContain('20261002-junk/run.json unreadable')
  })
})
