// Tier 2: selection and delivery (hooks/rules/select.ts; plan 16.5, 16.6,
// 12:1568-1571 and 12:1633; COMMON decisions 25 and 26; WP-AE), with AD's
// loadRules stood in for through select.ts's `deps`: each gate's rules by
// its Files, a fanout's tasks and verifier, the planner's named paths, the
// cap and its pointers, workflows and roles, what's in force, a local
// override, a ban shared whatever its paths (WP-AH), rule.find { applicable },
// fanout.js's args.verifierRules, and run.start for real: the versions in
// run.json, the rules per gate, and a rule file that never rides along in a
// gate's commit.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Caller, RecordCtx, RecordInput, RecordReply } from '../../hooks/records/core'
import type { LoadedRule, RuleDoc, RuleScope, RuleStanding, SelectInput } from '../../hooks/records/rules'
import type { RunJson, RunStartReply } from '../../hooks/records/run'
import type { LandReply, VerifyReply } from '../../hooks/records/execute'
import { deps as selectDeps, findApplicable, RULES_CAP, selectForRun } from '../../hooks/rules/select'
import { deps as lifecycleDeps, recordRunStart, renderRunRules } from '../../hooks/lifecycle'
import { recordVerify } from '../../hooks/verify'
import { recordLand } from '../../hooks/land'
import { appendRecord } from '../../hooks/ledgercore'
import { modePath, runJsonPath } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { stopLease } from '../../hooks/lock'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'
import { argsWith, NONCE, runFanout, TASK_A, TASK_B, TASK_R, check, done, landedOk, merged, researched } from './fanoutjs-harness'

// run.start, verify and land run real git in scratch repos; a loaded machine takes seconds.
setDefaultTimeout(120_000)

const saved = { select: { ...selectDeps }, lifecycle: { ...lifecycleDeps } }
const cleanups: (() => void)[] = []
afterEach(() => {
  Object.assign(selectDeps, saved.select)
  Object.assign(lifecycleDeps, saved.lifecycle)
  stopLease()
  for (const c of cleanups.splice(0)) c()
})

// ---------------------------------------------------------------------------
// Rules, as AD's loadRules hands them over

type RuleOpts = {
  paths?: string[]
  workflows?: string[]
  roles?: string[]
  when?: string
  rule?: string
  type?: 'rule' | 'ban'
  version?: number
  exceptions?: string[]
  howToCheck?: string[]
  overrides?: string
}

function doc(id: string, o: RuleOpts = {}): RuleDoc {
  return {
    id,
    version: o.version ?? 1,
    status: 'accepted',
    type: o.type ?? 'rule',
    applies: {
      paths: o.paths ?? [],
      ...(o.workflows ? { workflows: o.workflows } : {}),
      ...(o.roles ? { roles: o.roles } : {}),
      when: o.when ?? `working on ${id}`,
    },
    ...(o.overrides ? { overrides: o.overrides } : {}),
    export: true,
    extra: [],
    body: { rule: o.rule ?? `Follow ${id}.`, why: 'because', exceptions: o.exceptions ?? [], howToCheck: o.howToCheck ?? [] },
  }
}

function loaded(d: RuleDoc, o: { scope?: RuleScope; standing?: RuleStanding; delivered?: RuleDoc | null } = {}): LoadedRule {
  const scope = o.scope ?? (d.id.startsWith('U-') ? 'user' : d.id.startsWith('L-') ? 'local' : 'project')
  return {
    doc: d,
    scope,
    path: `/rules/${scope}/${d.id}.md`,
    sha256: 'f'.repeat(64),
    standing: o.standing ?? 'accepted',
    delivered: o.delivered === undefined ? d : o.delivered,
  }
}

/** Stands in for AD's loadRules, counting its calls. */
function store(...rules: (LoadedRule | RuleDoc)[]): { calls: number } {
  const seen = { calls: 0 }
  const list = rules.map(r => ('doc' in r ? r : loaded(r)))
  selectDeps.loadRules = async () => {
    seen.calls++
    return { rules: list, problems: ['one id in two scopes: P-dup'] }
  }
  return seen
}

/** 16.5's compact form, written out here so the spec states it. A ban with paths names what it protects. */
const typeOf = (d: RuleDoc): string => (d.type === 'ban' && d.applies.paths.some(x => x !== '**') ? `ban; protects ${d.applies.paths.join(', ')}` : d.type)
const fullOf = (d: RuleDoc, over = ''): string =>
  [
    `${d.id}@${d.version}${over ? ` (overrides ${over})` : ''} (${typeOf(d)}) ${d.applies.when}: ${d.body.rule}`,
    ...(d.body.exceptions.length ? [`  Exceptions: ${d.body.exceptions.join('; ')}`] : []),
    ...(d.body.howToCheck.length ? [`  How to check: ${d.body.howToCheck.join('; ')}`] : []),
  ].join('\n')
const pointerOf = (d: RuleDoc): string => `${d.id}@${d.version} (${typeOf(d)}) ${d.applies.when}; full text: rule.find with id ${d.id}`

let checkout = ''
/** A checkout with folders on disk, for the Files entries that are folders without a trailing slash. */
function tree(...paths: string[]): string {
  const s = scratch()
  cleanups.push(s.cleanup)
  const dir = realpathSync(s.dir)
  for (const path of paths) {
    const abs = join(dir, path)
    if (path.endsWith('/')) mkdirSync(abs, { recursive: true })
    else {
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, 'x\n')
    }
  }
  return dir
}

const input = (o: Partial<SelectInput>): SelectInput => ({
  litterDir: join(checkout, '.claude', 'litter'),
  workflow: 'execute',
  gates: [],
  tasks: [],
  planText: null,
  goal: null,
  anchors: [],
  checkout,
  runRules: [],
  ...o,
})

const p = nodePorts()
const big = (n: number, ch = 'x') => ch.repeat(n)

// ---------------------------------------------------------------------------

describe('execute: each gate by its Files', () => {
  test("a gate whose Files match a rule's paths gets it, in 16.5's compact form; a gate whose Files don't, doesn't", async () => {
    checkout = tree('src/auth/refresh.py')
    const auth = doc('P-auth-retry', {
      paths: ['src/auth/**'],
      when: 'changing the token refresh',
      rule: 'Retry a refresh once,\n  then fail loudly.',
      exceptions: ['A refresh under test may fail at once.'],
      howToCheck: ['tests/test_refresh.py passes', 'grep for a second retry'],
    })
    const lib = doc('P-lib', { paths: ['lib/*.py'] })
    store(auth, lib)
    const sel = await selectForRun(p, input({ gates: [{ id: 'G1', files: ['src/auth/refresh.py'] }, { id: 'G2', files: ['docs/notes.md'] }] }))
    expect(sel.gates).toEqual({
      G1: [
        'P-auth-retry@1 (rule) changing the token refresh: Retry a refresh once, then fail loudly.\n' +
          '  Exceptions: A refresh under test may fail at once.\n' +
          '  How to check: tests/test_refresh.py passes; grep for a second retry',
      ],
      G2: [],
    })
    expect(sel.run).toEqual([])
    expect(sel.versions).toEqual([{ id: 'P-auth-retry', version: 1 }])
    expect(sel.tasks).toEqual({})
    expect(sel.verifier).toEqual([])
    expect(sel.planner).toEqual([])
  })

  test('a folder entry (a trailing / or a folder on disk) and a glob entry get every rule that could match under them', async () => {
    checkout = tree('src/auth/', 'lib/')
    const deep = doc('P-deep', { paths: ['src/auth/tokens/*.py'] })
    const md = doc('P-md', { paths: ['*.md'] })
    const other = doc('P-other', { paths: ['vendor/x.py'] })
    store(deep, md, other)
    const sel = await selectForRun(
      p,
      input({
        gates: [
          { id: 'G1', files: ['src/'] },
          { id: 'G2', files: ['src/auth'] },
          { id: 'G3', files: ['src/**/*.py'] },
          { id: 'G4', files: ['lib/'] },
          { id: 'G5', files: ['lib/a.py'] },
        ],
      }),
    )
    // P-deep's prefix src/auth/tokens overlaps src/ and src/auth; *.md is unanchored, so it could match under any folder.
    expect(sel.gates).toEqual({
      G1: [fullOf(deep), fullOf(md)],
      G2: [fullOf(deep), fullOf(md)],
      G3: [fullOf(deep), fullOf(md)],
      G4: [fullOf(md)],
      G5: [],
    })
    expect(sel.versions.map(v => v.id).sort()).toEqual(['P-deep', 'P-md'])
  })

  test('rules without paths go to run (args.rules), and every version delivered is in versions, once', async () => {
    checkout = tree()
    const a = doc('P-always', { version: 3 })
    const star = doc('P-star', { paths: ['**'] })
    const sh = doc('P-sh', { paths: ['*.sh'], version: 2 })
    store(a, star, sh)
    const sel = await selectForRun(p, input({ gates: [{ id: 'G1', files: ['bin/a.sh'] }, { id: 'G2', files: ['bin/b.sh'] }] }))
    expect(sel.run).toEqual([fullOf(a), fullOf(star)])
    expect(sel.gates).toEqual({ G1: [fullOf(sh)], G2: [fullOf(sh)] })
    expect(sel.versions).toEqual([
      { id: 'P-always', version: 3 },
      { id: 'P-star', version: 1 },
      { id: 'P-sh', version: 2 },
    ])
  })

  test('a design selects into run alone: the rules without paths, the bans, and those its anchors bring (WP-BD)', async () => {
    checkout = tree('src/a.ts')
    const always = doc('P-always')
    const vendor = doc('P-vendor', { type: 'ban', paths: ['vendor/**'] })
    const src = doc('P-src', { paths: ['src/**'] })
    const docs = doc('P-docs', { paths: ['docs/**'] })
    const seen = store(always, vendor, src, docs)
    const sel = await selectForRun(p, input({ workflow: 'design', anchors: ['src/a.ts'], runRules: ['For this run (stated by you): keep it small'] }))
    expect(sel).toEqual({
      run: [fullOf(always), fullOf(vendor), fullOf(src)],
      gates: {},
      tasks: {},
      verifier: [],
      planner: [],
      versions: [
        { id: 'P-always', version: 1 },
        { id: 'P-vendor', version: 1 },
        { id: 'P-src', version: 1 },
      ],
    })
    expect(seen.calls).toBe(1)
  })
})

describe('the 8 KiB cap', () => {
  test('a block over 8 KiB keeps the most specific rules in full and the rest as pointers', async () => {
    checkout = tree()
    const four = doc('P-z-four', { paths: ['a/b/c/x.ts'], rule: big(3000, 'f') })
    const two = doc('P-y-two', { paths: ['a/b/**'], rule: big(3000, 't') })
    const one = doc('P-a-one', { paths: ['*.ts'], rule: big(3000, 'o') })
    store(one, two, four)
    const sel = await selectForRun(p, input({ gates: [{ id: 'G1', files: ['a/b/c/x.ts'] }] }))
    expect(sel.gates.G1).toEqual([fullOf(four), fullOf(two), pointerOf(one)])
    expect(sel.versions.map(v => v.id)).toEqual(['P-z-four', 'P-y-two', 'P-a-one'])
    expect(new TextEncoder().encode(sel.gates.G1!.join('\n')).length).toBeLessThanOrEqual(RULES_CAP)
  })

  test('a pathless rule that one gate needed as a pointer is a pointer for every gate (decision 26)', async () => {
    checkout = tree()
    const wide = doc('P-wide', { rule: big(3000, 'w') })
    const g1a = doc('P-g1a', { paths: ['g1/x.ts'], rule: big(3000, 'a') })
    const g1b = doc('P-g1b', { paths: ['g1/y.ts'], rule: big(3000, 'b') })
    store(wide, g1a, g1b)
    const sel = await selectForRun(p, input({ gates: [{ id: 'G1', files: ['g1/x.ts', 'g1/y.ts'] }, { id: 'G2', files: ['g2/z.ts'] }] }))
    expect(sel.run).toEqual([pointerOf(wide)])
    expect(sel.gates).toEqual({ G1: [fullOf(g1a), fullOf(g1b)], G2: [] })
  })

  test('your run rules count against the cap, in full, and the selection after them fills what is left', async () => {
    checkout = tree()
    const r = doc('P-r', { paths: ['a.ts'], rule: big(2000) })
    store(r)
    const runRules = [`For this run (stated by you): ${big(7000, 'y')}`]
    const sel = await selectForRun(p, input({ gates: [{ id: 'G1', files: ['a.ts'] }], runRules }))
    expect(sel.gates.G1).toEqual([pointerOf(r)])
    expect(sel.run).toEqual([])
  })

  test('past even the pointers, the block ends with how many more there are, and those are not in versions', async () => {
    checkout = tree()
    const rules = ['P-1', 'P-2', 'P-3'].map(id => doc(id, { paths: ['a.ts'] }))
    store(...rules)
    const sel = await selectForRun(p, input({ gates: [{ id: 'G1', files: ['a.ts'] }], runRules: [big(RULES_CAP - 60)] }))
    expect(sel.gates.G1).toEqual(['and 3 more accepted rules; rule.find lists them'])
    expect(sel.versions).toEqual([])
  })
})

describe('workflows and roles', () => {
  test("a rule reaches a run only when its workflows include the run's, and its roles a role the unit's calls use", async () => {
    checkout = tree()
    const forFanout = doc('P-fanout-only', { workflows: ['fanout'] })
    const forExecute = doc('P-execute', { workflows: ['execute', 'swarm'] })
    const planner = doc('P-planner', { roles: ['planner'] })
    const critic = doc('P-critic', { roles: ['gate-critic'], paths: ['a.ts'] })
    const emptyLists = doc('P-empty-lists', { workflows: [], roles: [] })
    store(forFanout, forExecute, planner, critic, emptyLists)
    const sel = await selectForRun(p, input({ gates: [{ id: 'G1', files: ['a.ts'] }] }))
    expect(sel.run).toEqual([fullOf(emptyLists), fullOf(forExecute)])
    expect(sel.gates.G1).toEqual([fullOf(critic)])
  })

  test("fanout: a writer gets executor rules, a reader's researcher rules ride in run, and the verifier gets its own", async () => {
    checkout = tree()
    const exec = doc('P-exec', { roles: ['executor'], paths: ['a.txt'] })
    const verifier = doc('P-verifier', { roles: ['verifier'], paths: ['a.txt'] })
    const researcher = doc('P-researcher', { roles: ['researcher'] })
    const designer = doc('P-designer', { roles: ['design-critic'] })
    store(exec, verifier, researcher, designer)
    const sel = await selectForRun(p, input({ workflow: 'fanout', tasks: [{ id: 'a', files: ['a.txt'] }, { id: 'r', files: [] }] }))
    expect(sel.run).toEqual([fullOf(researcher)])
    expect(sel.tasks).toEqual({ a: [fullOf(exec)], r: [] })
    expect(sel.verifier).toEqual([fullOf(verifier)])
  })
})

describe('fanout: the tasks and the verifier', () => {
  test("each task gets the rules by its owned files, and the verifier the union, beyond args.rules", async () => {
    checkout = tree()
    // Anchored: an unanchored a.txt could match under task b's folder, so b would get it too (decision 25).
    const a = doc('P-a', { paths: ['/a.txt'] })
    const b = doc('P-b', { paths: ['b/**'] })
    const none = doc('P-none')
    store(a, b, none)
    const sel = await selectForRun(
      p,
      input({ workflow: 'fanout', tasks: [{ id: 'a', files: ['a.txt'] }, { id: 'b', files: ['b/'] }, { id: 'r', files: [] }] }),
    )
    expect(sel.run).toEqual([fullOf(none)])
    expect(sel.tasks).toEqual({ a: [fullOf(a)], b: [fullOf(b)], r: [] })
    expect(sel.verifier).toEqual([fullOf(a), fullOf(b)])
    expect(sel.gates).toEqual({})
  })

  test("fanout.js gives the verifier args.rules then args.verifierRules when run.start passed them, not the tasks' own", async () => {
    const args = argsWith([TASK_A, TASK_B, TASK_R], { verifierRules: ['P-a@1 (rule) owning a: keep a/ POSIX sh'] })
    const r = await runFanout({
      args,
      replies: { 'write:A': done(['a/hello.txt']), 'write:B': done(['b/world.txt']), 'research:R': researched, integrate: merged(['A', 'B']), verifier: check(['A', 'B', 'R']), 'land:fanout': landedOk },
    })
    const verifier = r.calls.find(c => c.label === 'verifier')!
    const rules = new RegExp(`<rules id="${NONCE}">\\n([\\s\\S]*?)\\n</rules id="${NONCE}">`).exec(verifier.prompt)?.[1]
    expect(rules).toBe('For this run (stated by you): keep changes small\nP-a@1 (rule) owning a: keep a/ POSIX sh')
    // A writer still gets args.rules and its own.
    const writer = r.calls.find(c => c.label === 'write:A')!
    expect(writer.prompt).toContain(`<rules id="${NONCE}">\nFor this run (stated by you): keep changes small\nR1 v1: keep a/ POSIX sh\n</rules id="${NONCE}">`)
  })
})

describe('plan: the planner', () => {
  test('gets every rule without paths, plus those for the paths the plan or goal names that exist in the checkout', async () => {
    checkout = tree('hooks/land.ts', 'docs/', 'src/a.ts', 'gates/g.ts')
    const land = doc('P-land', { paths: ['hooks/land.ts'] })
    const docs = doc('P-docs', { paths: ['docs/*.md'] })
    const src = doc('P-src', { paths: ['src/*.ts'] })
    const gate = doc('P-gate', { paths: ['gates/**'] })
    // Anchored: missing/** reads as missing, a name at any depth, which could match under docs/.
    const missing = doc('P-missing', { paths: ['/missing/**'] })
    const unnamed = doc('P-unnamed', { paths: ['hooks/verify.ts'] })
    const always = doc('P-always')
    store(land, docs, src, gate, missing, unnamed, always)
    const planText = [
      '# Plan',
      'See [the land](hooks/land.ts) and `docs/`, but not `missing/x.ts` or [the site](https://example.com/hooks/verify.ts).',
      '',
      '### G1: One',
      'Files: gates/g.ts',
      'Checks: true',
      'Done when: done',
      '',
    ].join('\n')
    const sel = await selectForRun(p, input({ workflow: 'plan', planText, goal: 'fix `src/a.ts:12` quickly' }))
    expect(sel.planner).toEqual([fullOf(always), fullOf(land), fullOf(docs), fullOf(gate), fullOf(src)])
    expect(sel.run).toEqual([])
    expect(sel.versions.map(v => v.id).sort()).toEqual(['P-always', 'P-docs', 'P-gate', 'P-land', 'P-src'])
  })
})

describe("what's in force", () => {
  test("an unverified edit of a committed rule delivers HEAD's version; an unverified file with nothing in force, nothing", async () => {
    checkout = tree()
    const head = doc('P-edited', { paths: ['a.ts'], version: 1, rule: 'The committed text.' })
    const edited = doc('P-edited', { paths: ['a.ts'], version: 2, rule: 'An edit nobody accepted.' })
    const fresh = doc('P-fresh', { paths: ['a.ts'] })
    const notAccepted = { ...doc('P-proposed', { paths: ['a.ts'] }), status: 'proposed' as const }
    store(
      loaded(edited, { standing: 'unverified', delivered: head }),
      loaded(fresh, { standing: 'unverified', delivered: null }),
      loaded(doc('P-committed', { paths: ['a.ts'] }), { standing: 'accepted (committed)' }),
      loaded(notAccepted),
    )
    const sel = await selectForRun(p, input({ gates: [{ id: 'G1', files: ['a.ts'] }] }))
    expect(sel.gates.G1).toEqual([fullOf(doc('P-committed', { paths: ['a.ts'] })), fullOf(head)])
    expect(sel.versions).toEqual([
      { id: 'P-committed', version: 1 },
      { id: 'P-edited', version: 1 },
    ])
  })

  test('a local override shows on its entry, and the user rule it replaces is not delivered here (16.6)', async () => {
    checkout = tree()
    const user = doc('U-tabs', { rule: 'Indent with tabs.' })
    const local = doc('L-spaces', { rule: 'Indent with two spaces.', overrides: 'U-tabs' })
    const project = doc('P-style', { rule: 'Run the formatter.' })
    // An override of a project rule is refused by the store; here it's shown as nothing, and the project rule stands.
    const bad = doc('L-bad', { overrides: 'P-style' })
    store(user, local, project, bad)
    const sel = await selectForRun(p, input({ gates: [{ id: 'G1', files: ['a.ts'] }] }))
    expect(sel.run).toEqual([fullOf(bad), fullOf(local, 'U-tabs'), fullOf(project)])
    expect(sel.run[1]).toStartWith('L-spaces@1 (overrides U-tabs) (rule) ')
    expect(sel.versions.map(v => v.id)).toEqual(['L-bad', 'L-spaces', 'P-style'])
  })
})

describe('a ban: shared by every unit, whatever its paths (16.5)', () => {
  test("goes to run (args.rules) for every gate and into no gate's own list, naming what it protects; a rule with the same paths still goes by Files", async () => {
    checkout = tree('vendor/')
    const ban = doc('P-vendor', { type: 'ban', paths: ['vendor/**', 'third_party/*.sh'], when: 'changing code', rule: 'Never change vendored code.' })
    const style = doc('P-vendor-style', { paths: ['vendor/**'] })
    const bare = doc('P-bare-ban', { type: 'ban' })
    const star = doc('P-star-ban', { type: 'ban', paths: ['**'] })
    store(ban, style, bare, star)
    const sel = await selectForRun(p, input({ gates: [{ id: 'G1', files: ['lib/a.sh'] }, { id: 'G2', files: ['vendor/'] }] }))
    // A ban without paths (none, or only **) reads as it always did.
    expect(sel.run).toEqual([
      'P-bare-ban@1 (ban) working on P-bare-ban: Follow P-bare-ban.',
      'P-star-ban@1 (ban) working on P-star-ban: Follow P-star-ban.',
      'P-vendor@1 (ban; protects vendor/**, third_party/*.sh) changing code: Never change vendored code.',
    ])
    expect(sel.gates).toEqual({ G1: [], G2: [fullOf(style)] })
    expect(sel.versions.map(v => v.id)).toEqual(['P-bare-ban', 'P-star-ban', 'P-vendor', 'P-vendor-style'])
  })

  test('a local ban overriding a user rule shows both, the override first', async () => {
    checkout = tree()
    const user = doc('U-gen', { rule: 'Regenerate the client after a schema change.' })
    const local = doc('L-gen', { type: 'ban', paths: ['gen/**'], overrides: 'U-gen', rule: 'Never edit gen/ by hand.' })
    store(user, local)
    const sel = await selectForRun(p, input({ gates: [{ id: 'G1', files: ['src/a.ts'] }] }))
    expect(sel.run).toEqual(['L-gen@1 (overrides U-gen) (ban; protects gen/**) working on L-gen: Never edit gen/ by hand.'])
    expect(sel.gates).toEqual({ G1: [] })
  })

  test("fills the cap as a shared rule at specificity 0, after a gate's own rules however specific its paths, and one gate's pointer is every gate's (decision 26)", async () => {
    checkout = tree()
    const g1a = doc('P-g1a', { paths: ['g1/a.ts'], rule: big(3000, 'a') })
    const g1b = doc('P-g1b', { paths: ['g1/b.ts'], rule: big(3000, 'b') })
    const gates = [{ id: 'G1', files: ['g1/deep/x.ts', 'g1/a.ts', 'g1/b.ts'] }, { id: 'G2', files: ['g2/z.ts'] }]
    // As a rule, its paths' specificity (3) fills it first in G1's block, in full, and g1b's goes as a pointer.
    const asRule = doc('P-deep', { paths: ['g1/deep/x.ts'], rule: big(3000, 'd') })
    store(asRule, g1a, g1b)
    let sel = await selectForRun(p, input({ gates }))
    expect(sel.run).toEqual([])
    expect(sel.gates).toEqual({ G1: [fullOf(asRule), fullOf(g1a), pointerOf(g1b)], G2: [] })
    // As a ban it fills after G1's own, so it's a pointer there, and so a pointer in args.rules for G2 too.
    const asBan = doc('P-deep', { type: 'ban', paths: ['g1/deep/x.ts'], rule: big(3000, 'd') })
    store(asBan, g1a, g1b)
    sel = await selectForRun(p, input({ gates }))
    expect(sel.run).toEqual(['P-deep@1 (ban; protects g1/deep/x.ts) working on P-deep; full text: rule.find with id P-deep'])
    expect(sel.run).toEqual([pointerOf(asBan)])
    expect(sel.gates).toEqual({ G1: [fullOf(g1a), fullOf(g1b)], G2: [] })
    expect(sel.versions.map(v => v.id)).toEqual(['P-deep', 'P-g1a', 'P-g1b'])
  })

  test("fanout: goes to run for every task and the verifier, in no task's own list, and fanout.js puts it in every task's prompt and the verifier's", async () => {
    checkout = tree()
    const ban = doc('P-vendor', { type: 'ban', paths: ['/vendor/**'], rule: 'Never change vendor/.' })
    const a = doc('P-a', { paths: ['/a/**'] })
    const style = doc('P-vendor-style', { paths: ['/vendor/**'] })
    store(ban, a, style)
    const sel = await selectForRun(p, input({ workflow: 'fanout', tasks: [{ id: 'A', files: ['a/'] }, { id: 'B', files: ['b/'] }, { id: 'R', files: [] }] }))
    const entry = 'P-vendor@1 (ban; protects /vendor/**) working on P-vendor: Never change vendor/.'
    expect(sel.run).toEqual([entry])
    expect(sel.tasks).toEqual({ A: [fullOf(a)], B: [], R: [] })
    expect(sel.verifier).toEqual([fullOf(a)])

    // As run.start passes them (lifecycle.ts): after your run rules in args.rules, each task's own, and args.verifierRules.
    const tasks = [TASK_A, TASK_B, TASK_R].map(t => ({ ...t, rules: sel.tasks[t.id]! }))
    const args = argsWith(tasks, { rules: ['For this run (stated by you): keep changes small', ...sel.run], verifierRules: sel.verifier })
    const r = await runFanout({
      args,
      replies: { 'write:A': done(['a/hello.txt']), 'write:B': done(['b/world.txt']), 'research:R': researched, integrate: merged(['A', 'B']), verifier: check(['A', 'B', 'R']), 'land:fanout': landedOk },
    })
    const rulesOf = (label: string) => {
      const c = r.calls.find(x => x.label === label)
      return c ? new RegExp(`<rules id="${NONCE}">\\n([\\s\\S]*?)\\n</rules id="${NONCE}">`).exec(c.prompt)?.[1] : `no ${label} call`
    }
    expect(rulesOf('write:A')).toBe(['For this run (stated by you): keep changes small', entry, fullOf(a)].join('\n'))
    expect(rulesOf('write:B')).toBe(['For this run (stated by you): keep changes small', entry].join('\n'))
    expect(rulesOf('research:R')).toBe(['For this run (stated by you): keep changes small', entry].join('\n'))
    expect(rulesOf('verifier')).toBe(['For this run (stated by you): keep changes small', entry, fullOf(a)].join('\n'))
  })

  test('reaches the planner though the plan and goal name none of its paths; a rule with those paths does not', async () => {
    checkout = tree('src/a.ts', 'vendor/x.sh')
    const ban = doc('P-vendor', { type: 'ban', paths: ['/vendor/**'] })
    const style = doc('P-vendor-style', { paths: ['/vendor/**'] })
    const src = doc('P-src', { paths: ['src/*.ts'] })
    store(ban, style, src)
    const sel = await selectForRun(p, input({ workflow: 'plan', goal: 'fix `src/a.ts`' }))
    expect(sel.planner).toEqual([fullOf(ban), fullOf(src)])
    expect(sel.versions.map(v => v.id)).toEqual(['P-vendor', 'P-src'])
  })
})

// ---------------------------------------------------------------------------
// rule.find { applicable }, and run.start for real

const PLAN = [
  '# Plan',
  '',
  '### G1: First',
  'Files: a.txt',
  'Checks: test -f a.txt',
  'Done when: a.txt exists',
  '',
  '### G2: Second',
  'Files: b/',
  'Checks: test -d b',
  'Done when: b exists',
  '',
].join('\n')

type World = { p: TestPorts; dir: string; litterDir: string; git: (...argv: string[]) => Promise<string>; ctx: (c?: Caller) => RecordCtx }

async function world(): Promise<World> {
  const s = scratch()
  cleanups.push(s.cleanup)
  const dir = realpathSync(s.dir)
  const base = nodePorts({ sessionId: 'session-a' })
  const wp: TestPorts = {
    ...base,
    cwd: async () => dir,
    run: (argv, init) =>
      argv[0] === 'jq' ? Promise.resolve({ code: 0, stdout: 'jq-1.7.1\n', stderr: '', truncated: false }) : base.run(argv, init?.cwd ? init : { ...init, cwd: dir }),
  }
  const { git } = await scratchRepo(wp, dir)
  await wp.fs.write(join(dir, 'plan.md'), PLAN)
  await git('add', 'plan.md')
  await git('commit', '-q', '-m', 'plan')
  const litterDir = join(dir, '.claude', 'litter')
  await wp.fs.write(modePath(litterDir), 'default\n')
  const ctx = (caller: Caller = { agentId: null, agentType: null }): RecordCtx => ({ p: wp, caller, litterDir, options: normalizeOptions({ verify: ['true'] }) })
  return { p: wp, dir, litterDir, git, ctx }
}

/** Every file under `dir`, with its size and mtime: what a call that writes nothing leaves as it was. */
function listing(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, e.name)
      if (e.isDirectory()) walk(abs)
      else out.push(`${abs} ${statSync(abs).size} ${statSync(abs).mtimeMs}`)
    }
  }
  walk(dir)
  return out.sort()
}

const okOf = (r: RecordReply) => {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r)}`)
  return r as Record<string, unknown>
}

describe('rule.find { applicable }', () => {
  test('gives exactly what selectForRun gives for the same launch, per workflow, with the store\'s problems, writing nothing', async () => {
    const w = await world()
    checkout = w.dir
    const rules = [doc('P-a', { paths: ['/a.txt'] }), doc('P-b', { paths: ['b/**'] }), doc('P-all'), doc('P-plan', { roles: ['planner'], paths: ['plan.md'] })]
    store(...rules)
    const before = listing(w.dir)
    const runRules = ['keep the public API']
    // rule.find renders your run rules with run.start's own renderer (A11).
    const rendered = renderRunRules(runRules)
    expect(rendered).toEqual(['For this run (stated by you): keep the public API'])

    const ex = okOf(await findApplicable(w.p, w.litterDir, { workflow: 'execute', planPath: 'plan.md', runRules }))
    const exSel = await selectForRun(w.p, input({ checkout: w.dir, litterDir: w.litterDir, gates: [{ id: 'G1', files: ['a.txt'] }, { id: 'G2', files: ['b/'] }], planText: PLAN, runRules: rendered }))
    expect(ex).toEqual({ ok: true, workflow: 'execute', run: exSel.run, gates: exSel.gates, versions: exSel.versions, problems: ['one id in two scopes: P-dup'] })
    expect(ex.gates).toEqual({ G1: [fullOf(rules[0]!)], G2: [fullOf(rules[1]!)] })

    const tasks = [{ id: 'a', files: ['a.txt'] }, { id: 'b', files: ['b/'] }, { id: 'r', files: ['ignored.txt'], writes: false }]
    const fan = okOf(await findApplicable(w.p, w.litterDir, { workflow: 'fanout', tasks }))
    const fanSel = await selectForRun(w.p, input({ workflow: 'fanout', checkout: w.dir, litterDir: w.litterDir, tasks: [{ id: 'a', files: ['a.txt'] }, { id: 'b', files: ['b/'] }, { id: 'r', files: [] }] }))
    expect(fan).toEqual({ ok: true, workflow: 'fanout', run: fanSel.run, tasks: fanSel.tasks, verifier: fanSel.verifier, versions: fanSel.versions, problems: ['one id in two scopes: P-dup'] })

    const plan = okOf(await findApplicable(w.p, w.litterDir, { workflow: 'plan', goal: 'split `plan.md` into gates' }))
    const planSel = await selectForRun(w.p, input({ workflow: 'plan', checkout: w.dir, litterDir: w.litterDir, goal: 'split `plan.md` into gates' }))
    expect(plan).toEqual({ ok: true, workflow: 'plan', planner: planSel.planner, versions: planSel.versions, problems: ['one id in two scopes: P-dup'] })
    expect(plan.planner).toEqual([fullOf(rules[2]!), fullOf(rules[3]!)])

    expect(listing(w.dir)).toEqual(before)
  })

  test("a ban with paths is in run for execute and fanout and in the planner's block, in no gate's or task's own, as selectForRun gives it", async () => {
    const w = await world()
    checkout = w.dir
    const ban = doc('P-vendor', { type: 'ban', paths: ['vendor/**'] })
    const b = doc('P-b', { paths: ['b/**'] })
    store(ban, b)
    const ex = okOf(await findApplicable(w.p, w.litterDir, { workflow: 'execute', planPath: 'plan.md' }))
    expect([ex.run, ex.gates]).toEqual([[fullOf(ban)], { G1: [], G2: [fullOf(b)] }])
    const fan = okOf(await findApplicable(w.p, w.litterDir, { workflow: 'fanout', tasks: [{ id: 'a', files: ['a.txt'] }, { id: 'r', files: [], writes: false }] }))
    expect([fan.run, fan.tasks, fan.verifier]).toEqual([[fullOf(ban)], { a: [], r: [] }, []])
    const plan = okOf(await findApplicable(w.p, w.litterDir, { workflow: 'plan', goal: 'tidy a.txt' }))
    expect(plan.planner).toEqual([fullOf(ban)])
  })

  test("a design answers with selectForRun's run and versions, and the items they add to the bar (WP-BD); a bad call names the field and the fix", async () => {
    const w = await world()
    checkout = w.dir
    const all = doc('P-all')
    const ban = doc('P-no-sleep', { type: 'ban', rule: 'Never sleep in a test.' })
    store(all, ban)
    const sel = await selectForRun(w.p, input({ workflow: 'design', checkout: w.dir, litterDir: w.litterDir, goal: 'g' }))
    expect(await findApplicable(w.p, w.litterDir, { workflow: 'design', goal: 'g', bar: [{ id: 'C3' }, { id: 'B2' }] })).toEqual({
      ok: true,
      workflow: 'design',
      run: sel.run,
      bar: [
        { id: 'B3', text: 'Never sleep in a test.', evidence: "the proposal's file list and design, checked against the ban", reason: 'because', rule: { id: 'P-no-sleep', version: 1 } },
        {
          id: 'C4',
          text: 'Consistent with rules P-all@1, or asks before changing one, as a blocking user decision.',
          evidence: 'each rule checked against the proposal, by id',
          rules: [{ id: 'P-all', version: 1 }],
        },
      ],
      versions: sel.versions,
      problems: ['one id in two scopes: P-dup'],
    })
    expect(sel.run).toEqual([fullOf(all), fullOf(ban)])
    const refusals: [Record<string, unknown>, string][] = [
      [{ workflow: 'swarm' }, "litter: 'applicable.workflow' is the launch's workflow: execute, fanout, plan or design"],
      [{ workflow: 'execute' }, "litter: rule.find { applicable } for execute needs 'planPath', the plan the launch would read, absolute or relative to the checkout"],
      [{ workflow: 'execute', planPath: 'nope.md' }, "litter: can't read the plan 'nope.md'"],
      [{ workflow: 'fanout', tasks: [{ files: ['a'] }] }, "litter: rule.find { applicable } for fanout needs 'tasks', each { id, files, writes? } as run.start takes them"],
      [{ workflow: 'plan', runRules: 'one' }, "litter: 'applicable.runRules' is your run rules as a list of strings, as run.start takes them"],
      [{ workflow: 'design', anchors: 'src/a.ts' }, "litter: 'applicable.anchors' is the design's anchors as a list of strings, as run.start takes them"],
      [{ workflow: 'design', bar: 'C1' }, "litter: 'applicable.bar' is your bar as run.start takes it"],
    ]
    for (const [applicable, error] of refusals) {
      const r = await findApplicable(w.p, w.litterDir, applicable)
      expect(r.ok).toBe(false)
      expect({ error: (r as { error: string }).error.slice(0, error.length), field: (r as { field?: string }).field }).toEqual({ error, field: 'applicable' })
    }
    const bad = await findApplicable(w.p, w.litterDir, { workflow: 'execute', planPath: 'README.md' })
    expect(bad).toEqual(expect.objectContaining({ ok: false, field: 'applicable' }))
  })

  test('a store that throws is a refusal naming it', async () => {
    const w = await world()
    selectDeps.loadRules = async () => {
      throw new Error('the rules ledger is tampered at seq 4')
    }
    expect(await findApplicable(w.p, w.litterDir, { workflow: 'execute', planPath: 'plan.md' })).toEqual({
      ok: false,
      error: "litter: the accepted rules couldn't be selected (the rules ledger is tampered at seq 4); /litter rules shows them and their problems",
    })
  })
})

const CRITIC: Caller = { agentId: 'critic-1', agentType: 'litter:gate-critic' }
const RELAY: Caller = { agentId: 'relay-1', agentType: 'litter:relay' }
const PASS = { pass: true, evidence: 'checked', gaps: [] as string[] }

describe('run.start with the selection', () => {
  test("an execute run's args carry each gate's rules after the run's, and run.json the versions", async () => {
    const w = await world()
    const a = doc('P-a', { paths: ['/a.txt'] })
    const all = doc('P-all', { version: 2 })
    store(a, all)
    const r = okOf(await recordRunStart(w.ctx(), { kind: 'run.start', workflow: 'execute', planPath: 'plan.md', authorized: ['change a.txt'], runRules: ['no new deps'] } as RecordInput)) as unknown as RunStartReply
    expect(r.args.rules).toEqual(['For this run (stated by you): no new deps', fullOf(all)])
    expect((r.args.gates as { id: string; rules: string[] }[]).map(g => [g.id, g.rules])).toEqual([
      ['G1', [fullOf(a)]],
      ['G2', []],
    ])
    const json = JSON.parse(await w.p.fs.read(runJsonPath(r.runDir))) as RunJson
    expect(json.rules).toEqual([
      { id: 'P-all', version: 2 },
      { id: 'P-a', version: 1 },
    ])
  })

  test("a ban whose paths G1's Files match is in args.rules, in no gate's rules, and in run.json's versions (T4-2's case)", async () => {
    const w = await world()
    const ban = doc('P-a-ban', { type: 'ban', paths: ['a.txt'], rule: 'Never write a.txt.' })
    store(ban)
    const r = okOf(await recordRunStart(w.ctx(), { kind: 'run.start', workflow: 'execute', planPath: 'plan.md', authorized: ['change a.txt'] } as RecordInput)) as unknown as RunStartReply
    expect(r.args.rules).toEqual(['P-a-ban@1 (ban; protects a.txt) working on P-a-ban: Never write a.txt.'])
    expect((r.args.gates as { id: string; rules: string[] }[]).map(g => [g.id, g.rules])).toEqual([
      ['G1', []],
      ['G2', []],
    ])
    const json = JSON.parse(await w.p.fs.read(runJsonPath(r.runDir))) as RunJson
    expect(json.rules).toEqual([{ id: 'P-a-ban', version: 1 }])
  })

  // 12:1633, the rule snapshot case.
  test("with an accepted, uncommitted project rule and its rule file, run.start doesn't refuse, and no gate's commit contains either", async () => {
    const w = await world()
    const ruleFile = join(w.dir, '.litter', 'rules', 'P-a.md')
    const exported = join(w.dir, '.claude', 'rules', 'litter', 'P-a.md')
    await w.p.fs.write(ruleFile, '---\nid: P-a\nversion: 1\n---\n\n## Rule\nKeep a.txt short.\n')
    await w.p.fs.write(exported, 'Keep a.txt short.\n')
    const a = doc('P-a', { paths: ['a.txt'], rule: 'Keep a.txt short.' })
    store(loaded(a, { scope: 'project', standing: 'accepted' }))

    const r = okOf(await recordRunStart(w.ctx(), { kind: 'run.start', workflow: 'execute', planPath: 'plan.md', authorized: ['change a.txt'] } as RecordInput)) as unknown as RunStartReply
    expect((r.args.gates as { rules: string[] }[])[0]!.rules).toEqual([fullOf(a)])

    await w.p.fs.write(join(w.dir, 'a.txt'), 'short\n')
    const v = (await recordVerify(w.ctx(CRITIC), { kind: 'verify', run: r.run, gate: 'G1', attempt: 1 })) as VerifyReply
    expect(v.ok && v.green).toBe(true)
    await appendRecord(w.p, r.runDir, {
      run: r.run,
      kind: 'verdict',
      by: { source: 'agent', agentId: CRITIC.agentId!, agentType: CRITIC.agentType },
      body: { verify_id: v.verify_id, plan_adherence: PASS, tests_green: PASS, no_regressions: PASS, rules: PASS, plan_gap: '', proposed_rules: [] },
    })
    const landed = (await recordLand(w.ctx(RELAY), { kind: 'land', run: r.run, gate: 'G1', verify_id: v.verify_id })) as LandReply
    if (!landed.ok || !landed.landed) throw new Error(`not landed: ${JSON.stringify(landed)}`)
    expect((await w.git('show', '--name-only', '--format=', landed.commit)).trim().split('\n')).toEqual(['a.txt'])
    // Both files are still there, untracked, as you left them.
    expect(await w.p.fs.read(ruleFile)).toContain('Keep a.txt short.')
    expect((await w.git('status', '--porcelain', '--untracked-files=all', '--', '.litter', '.claude/rules')).trim().split('\n').sort()).toEqual([
      '?? .claude/rules/litter/P-a.md',
      '?? .litter/rules/P-a.md',
    ])
  })
})
