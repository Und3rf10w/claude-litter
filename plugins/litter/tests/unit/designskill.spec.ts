// Tier 2: skills/design/SKILL.md (litter-prompts.md, "skills/design/SKILL.md",
// with the bar interview as its sections 2 and 3; WP-BF) and the design eval
// cases, checked the way executeskills.spec.ts checks the execute skill and
// prompts.spec.ts the fanout cases: the frontmatter, the record tool loaded
// first, $ARGUMENTS, the interview verbatim, run.start's fields, and plan mode
// only for a delivered plan.

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ROLE_TOOLS } from '../../hooks/roles'
import { HERMETIC_GIT_ENV, scratch } from './support/node-ports'

const PLUGIN = resolve(import.meta.dir, '..', '..')
const SKILL = readFileSync(join(PLUGIN, 'skills', 'design', 'SKILL.md'), 'utf8')

function frontmatter(text: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!m) throw new Error('SKILL.md has no frontmatter')
  return Bun.YAML.parse(m[1]!) as Record<string, unknown>
}
const shellParts = (text: string): string[] => [
  ...[...text.matchAll(/^```[\s\S]*?^```/gm)].map(m => m[0]),
  ...[...text.matchAll(/!`[^`]*`/g)].map(m => m[0]),
  ...text.split('\n').filter(l => l.startsWith('!')),
]
/** From one marker to the next, or to the end. */
const part = (from: string, to: string | null) => {
  const at = SKILL.indexOf(from)
  if (at < 0) throw new Error(`no '${from}' in the skill`)
  const end = to === null ? -1 : SKILL.indexOf(to, at)
  if (to !== null && end < 0) throw new Error(`no '${to}' after '${from}'`)
  return SKILL.slice(at, end < 0 ? undefined : end)
}
const all = (text: string, s: string) => [...text.matchAll(new RegExp(s, 'g'))].map(m => m.index!)

// The bar interview, as litter-prompts.md gives it (":348-369"), headings aside:
// the skill numbers them as its sections 2 and 3. Step 6 is the doc's line with
// phase 4's unknowns after it (decision 3), so it's checked as a prefix.
const INTERVIEW = [
  'A design run costs several agents over several rounds. Suggest the cheaper path, and let the user override, when: the mechanism is already known (just implement it); the answer is in documentation; the problem has nothing falsifiable ("make it faster" with no target); the change is small and reversible; or the user is under deadline pressure. A design run earns its cost when the mechanism is genuinely unknown, the stakes are high (production path, cross-system coupling, irreversible choices, schema changes, user-facing behaviour), a solo attempt got stuck, or a reliable null is needed.',
  "Your goal is a written bar the user agrees to before launch: at least 6 criteria and at least 1 categorical ban. Answer from the repository whatever the repository can answer, and save the user's attention for intent and trade-offs.",
  '1. Restate the problem in one sentence. Ask only about ambiguity that would lead to a different design, for example two readings of the goal that need different mechanisms.',
  '2. Collect anchors: files, functions, docs or past incidents the user knows matter. If there are none, do a short read of the repository to find starting points, and tell the user which you found.',
  "3. Pick the deliverable kind (plan, research, audit, review) and start from that kind's seed bar.",
  "4. Draft the bar yourself. Cover these categories, merging or adding as the problem needs: what it must do; the interaction mode it must preserve; the scope boundary, as an explicit list of what it may touch; coverage across the environments that matter; graceful degradation for the rest; and maintainability bans. Write each criterion as one declarative sentence, with the evidence that would prove it. Give each categorical ban its reason, and cite the incident when there is one: a ban that carries its reason is much harder to argue around.",
  '5. Avoid vague criteria ("must be maintainable"), circular evidence ("the design says it\'s correct"), and more than about 10 criteria; group related concerns instead.',
  '6. Name zero to two empirical unknowns: behaviours the design will hinge on that only a live test can settle.',
  '7. Choose the lenses: what each investigator should focus on. Use two falsifiers when the answer may be a null, two mechanisms when the run is choosing between approaches, and drop coverage when the problem has only one environment.',
  "8. Show the draft bar, unknowns and lenses in one AskUserQuestion: 2 to 4 options, your recommendation first and labelled, each option's trade-off in its description, no \"Other\" option (the interface adds one). Apply the user's edits and confirm once.",
  'Don\'t ask about implementation details, naming, anything the code answers, or "should I proceed?". Two or three well-placed questions beat twelve.',
]
const STEP_6 = INTERVIEW.findIndex(l => l.startsWith('6. '))

/** summary.md's design part, by heading (WP-BE), in its order. */
const SUMMARY_HEADINGS = ['Stop', 'Delivery', 'Verdict card', 'Versions', 'Reframes', 'Probes', 'Ships default-off', 'User decisions', 'Rules']

describe('skills/design/SKILL.md, as every skill', () => {
  test('stays well under the 5K tokens CC re-attaches whole after compaction', () => {
    expect(SKILL.length).toBeLessThan(16_000)
  })

  test('its frontmatter names the skill, pre-approves only read-only tools, and pins no model', () => {
    const fm = frontmatter(SKILL)
    expect(fm.name).toBe('design')
    expect(typeof fm.description).toBe('string')
    expect(typeof fm.when_to_use).toBe('string')
    expect(typeof fm['argument-hint']).toBe('string')
    expect(fm.model).toBeUndefined()
    expect(fm.effort).toBeUndefined()
    expect(fm['allowed-tools']).toEqual(['Read', 'Grep', 'Glob', 'Bash(git status:*)', 'Bash(git log:*)'])
    expect(SKILL).not.toMatch(/\b(opus|sonnet|haiku|fable)\b/i)
  })

  test('loads the record tool with ToolSearch before it records anything, and stops without it', () => {
    const at = SKILL.indexOf('select:mcp__litter__record')
    expect(at).toBeGreaterThan(0)
    expect(SKILL.slice(0, at)).toContain('ToolSearch')
    expect(SKILL).toContain("If it isn't found, stop")
    expect(SKILL).toContain("Don't run the design another way.")
    for (const kind of ['run.find', 'rule.find', 'run.start']) expect(at).toBeLessThan(SKILL.indexOf(`kind: '${kind}'`))
  })

  test('$ARGUMENTS appears once, in <request>, never in a shell block', () => {
    expect(SKILL.split('$ARGUMENTS').length - 1).toBe(1)
    expect(SKILL).toContain('<request>\n$ARGUMENTS\n</request>')
    for (const p of shellParts(SKILL)) expect(p).not.toContain('$ARGUMENTS')
  })

  test('uses ${user_config.*} only to show a configured value, never in a record or a shell block', () => {
    const lines = SKILL.split('\n').filter(l => l.includes('${user_config.'))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) {
      expect(l).not.toContain('kind:')
      expect(l).toMatch(/configured/)
    }
    for (const p of shellParts(SKILL)) expect(p).not.toContain('${user_config.')
  })

  test('every inline code span is closed, and there are no shell blocks', () => {
    const body = SKILL.replace(/^---\n[\s\S]*?\n---\n/, '')
    for (const line of body.split('\n')) expect({ line, even: (line.split('`').length - 1) % 2 === 0 }).toEqual({ line, even: true })
    expect(body).not.toContain('``')
    expect(shellParts(body)).toEqual([])
  })

  test('has sections 1 to 7, in order, the interview as 2 and 3', () => {
    const at = [1, 2, 3, 4, 5, 6, 7].map(n => SKILL.indexOf(`\n## ${n}. `))
    for (const a of at) expect(a).toBeGreaterThan(0)
    expect([...at].sort((x, y) => x - y)).toEqual(at)
    expect(SKILL).toContain('\n## 2. Is this a design run?\n')
    expect(SKILL).toContain('\n## 3. Interview\n')
    expect(SKILL.indexOf('\n## 8. ')).toBe(-1)
  })

  test('only launches: it neither writes the design nor implements it, and never starts a run on its own', () => {
    expect(SKILL).toContain("You don't write the design yourself, and you don't implement it in this skill.")
    expect(SKILL).toContain('Never start another run on your own.')
    expect(part('## 6. While it runs', '## 7.')).toContain("don't poll, re-read run files or guess at results")
  })
})

describe('the bar interview (sections 2 and 3)', () => {
  const interview = part('## 2. Is this a design run?', '## 4. Settings')
  const lines = interview.split('\n')

  test("is the prompts doc's text, verbatim and in order", () => {
    let from = 0
    INTERVIEW.forEach((want, i) => {
      const at = lines.findIndex((l, k) => k >= from && (i === STEP_6 ? l.startsWith(`${want} `) : l === want))
      expect({ line: want, found: at >= 0 }).toEqual({ line: want, found: true })
      from = at + 1
    })
  })

  test('step 6 asks for each unknown as a question, its smallest test and its kill result, as run.start takes them (decision 3)', () => {
    expect(interview).toContain(
      `${INTERVIEW[STEP_6]} Write each as a question, the smallest test that would settle it, and the result that would kill the design; \`run.start\` takes each as \`{ question, smallest_test, kill_result }\`.`,
    )
  })
})

describe('settings and launch', () => {
  const settings = part('## 4. Settings', '## 5. Launch')
  const launch = part('## 5. Launch', '## 6. While it runs')

  test("the rules come from rule.find's design answer before Launch, shown with the bar items they add, joined as 16.5 says", () => {
    expect(settings).toContain("Record `{ kind: 'rule.find', applicable: { workflow: 'design', anchors, goal, runRules } }`")
    expect(settings).toContain('replies `{ ok, workflow, run, bar, versions, problems }`')
    expect(settings).toContain('Show each rule in `run` on one line, then the items in `bar` that the rules add, as they\'ll appear in the frozen bar')
    expect(settings).toContain('each ban as a categorical ban, and the rest as one criterion, "consistent with these rules, or asks before changing one, as a blocking user decision"')
    expect(settings.indexOf('**Rules.**')).toBeLessThan(settings.indexOf('ask for an explicit "Launch"'))
  })

  test("the probers' dependencies are a setup argv the mod has approved, or linked ignored directories (decision 11)", () => {
    const authorized = settings.slice(settings.indexOf('**Authorized actions.**'), settings.indexOf('**Rules.**'))
    expect(authorized).toContain('name a setup command as a list of arguments (`setup`; the mod asks the user to approve it), or the ignored directories to link from the checkout (`linkDirs`)')
    expect(authorized).toContain('the configured `${user_config.setup}` and `${user_config.linkDirs}` apply')
  })

  test('keeps the checkout note and asks for an explicit "Launch"', () => {
    expect(settings).toContain('the run works on the checkout as it is now, uncommitted changes included, and that editing files during the run stops it at the end of the current round')
    expect(settings).toContain('Then ask for an explicit "Launch". This is the user\'s opt-in, so ask for it even if the user didn\'t type the command.')
  })

  test("records run.start with the design's fields, then launches litter:design-run with the returned args", () => {
    expect(launch).toContain(
      "Record `{ kind: 'run.start', workflow: 'design', goal, deliverable, bar, lenses, empiricalUnknowns, anchors, maxRounds, authorized, runRules }`, adding `setup` or `linkDirs` when a probe needs dependencies, and `priorRun` and `feedback` when this run follows an earlier one.",
    )
    expect(launch).toContain("Call Workflow with `name: 'litter:design-run'` and the returned `args` as a JSON object.")
    expect(launch.indexOf("kind: 'run.start'")).toBeLessThan(launch.indexOf('litter:design-run'))
  })

  test("passes the bar minimum's refusal or warning on (decision 5)", () => {
    expect(launch).toContain('The mod refuses a bar with fewer than 6 of your items or no ban, and warns past 12; pass a warning on to the user with the launch.')
    expect(launch).toContain('If it refuses, pass the reason on and stop.')
  })

  test('keeps the mode refusal in the preflight', () => {
    expect(part('## 1. Preflight', '## 2.')).toContain('The mod refuses to launch in bypass-permissions or accept-edits mode.')
  })
})

describe('when the run finishes', () => {
  const end = part('## 7. When the run finishes', null)
  const approved = part('**Approved, plan kind,**', '**Delivery refused,**')

  test("reads summary.md's design part by WP-BE's headings, in order, and reports from them", () => {
    expect(end).toContain(`each left out when it has nothing to say: ${SUMMARY_HEADINGS.join(', ')}.`)
    for (const ref of ['from Stop', 'from the Verdict card', 'from Reframes', 'from Probes', 'from Ships default-off', 'from Delivery', 'from Versions', 'Reframes or User decisions']) {
      expect(end).toContain(ref)
    }
    expect(end).toContain("quoting the critic's evidence for any that isn't PASS")
    expect(end).toContain("record `{ kind: 'run.end', run, taskId, status, result }`")
  })

  test('EnterPlanMode and ExitPlanMode appear only in the approved-plan part, which needs Delivery to say delivered', () => {
    const start = SKILL.indexOf(approved)
    for (const tool of ['EnterPlanMode', 'ExitPlanMode']) {
      const at = all(SKILL, tool)
      expect(at.length).toBeGreaterThan(0)
      for (const i of at) expect({ tool, inside: i > start && i < start + approved.length }).toEqual({ tool, inside: true })
    }
    expect(approved).toContain('only when Delivery says the plan was delivered')
  })

  test('the approval-option warning comes first, then plan mode, the plan file unchanged, ExitPlanMode, and the /litter:execute offer', () => {
    const order = [
      'because litter refuses /litter:execute in accept-edits mode',
      'then call EnterPlanMode',
      'Write the contents of `<runDir>/plan.md` into it unchanged, gates included.',
      'Call ExitPlanMode.',
      'Offer `/litter:execute <runDir>/plan.md`, with the absolute path filled in.',
    ].map(s => approved.indexOf(s))
    expect(order.every(i => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(approved.indexOf('accept-edits')).toBeLessThan(approved.indexOf('ExitPlanMode'))
    expect(approved).toContain("The approval message invites you to start coding, but don't")
    expect(approved).toContain("record `{ kind: 'design.feedback', run, feedback }`")
  })

  test("a refused delivery, another kind, or a run the critic didn't approve never uses plan mode", () => {
    expect(part('**Delivery refused,**', '**Approved, other kinds.**')).toContain("say why, from Delivery, and don't use plan mode")
    expect(part('**Approved, other kinds.**', '**Not approved.**')).toContain("Don't use plan mode.")
    const not = part('**Not approved.**', 'Never start another run')
    expect(not).toContain("Don't use plan mode. Approving there would look like the critic's approval, and the critic didn't give it.")
    expect(not).toContain('each with the kind of work that would close it (investigation, design, wording, or a user decision)')
    for (const offer of ['another run with more rounds', 'a narrower scope or an adjusted bar', 'stopping']) expect(not).toContain(offer)
  })

  test('keeps the early returns, the checkout-changed stop and the rule-change check', () => {
    expect(end).toContain('**An early return for the user.** Ask the question the run stopped on with AskUserQuestion')
    expect(end).toContain('Open it with /litter:rules show so the user can edit it')
    expect(end).toContain("so offer a new run from the current state rather than using it")
    expect(end).toContain('check that the new version is accepted (`rule.find` with its id) before offering /litter:execute')
  })
})

// ---------------------------------------------------------------------------
// The design eval cases (evals/design-*, for `claude plugin eval`): the
// 2.1.287 case schema, as prompts.spec.ts holds the fanout cases to it.

const EVALS = join(PLUGIN, 'evals')
const dirs = () => readdirSync(EVALS, { withFileTypes: true }).filter(e => e.isDirectory() && e.name !== 'results').map(e => e.name).sort()
const designDirs = () => dirs().filter(d => d.startsWith('design-'))
const TOP_KEYS = ['schema_version', 'name', 'description', 'tags', 'plugins', 'context', 'execution', 'runs', 'graders', 'expected_outcome']
const EXECUTION_KEYS = ['prompt', 'max_turns', 'timeout_seconds', 'model', 'allowed_tools', 'artifact_publish', 'growthbook_overrides', 'append_system_prompt', 'env']
const GRADER_KEYS: Record<string, string[]> = {
  regex: ['type', 'name', 'target', 'pattern', 'flags', 'match', 'weight', 'arm'],
  tool_order: ['type', 'name', 'before', 'after', 'weight', 'arm'],
  tool_used: ['type', 'name', 'tool', 'input_match', 'min', 'max', 'weight', 'arm'],
  file_exists: ['type', 'name', 'path', 'exists', 'weight', 'arm'],
  llm: ['type', 'name', 'criteria', 'focus', 'weight', 'arm'],
  baseline: ['type', 'name', 'baseline_file', 'criteria', 'weight', 'arm'],
}
const FOCUS = ['trace', 'last_message', 'files', 'mock_calls']
const caseText = (dir: string) => readFileSync(join(EVALS, dir, 'case.yaml'), 'utf8')
const readCase = (dir: string) => Bun.YAML.parse(caseText(dir)) as Record<string, any>
type Grader = Record<string, any>
const grader = (dir: string, name: string): Grader => {
  const g = (readCase(dir).graders as Grader[]).find(x => x.name === name)
  if (!g) throw new Error(`${dir} has no grader ${name}`)
  return g
}

describe('the design eval cases', () => {
  test('are design-launch and design-holding, and every case is a fanout or a design one', () => {
    expect(designDirs()).toEqual(['design-holding', 'design-launch'])
    for (const d of dirs()) expect({ d, known: /^(fanout|design)-/.test(d) }).toEqual({ d, known: true })
  })

  test("parse as the case schema, with every grader's keys its type's", () => {
    for (const dir of designDirs()) {
      const c = readCase(dir)
      for (const k of Object.keys(c)) expect({ dir, key: k, known: TOP_KEYS.includes(k) }).toEqual({ dir, key: k, known: true })
      expect(c.schema_version).toBe('1.1')
      expect(c.name).toBe(dir)
      for (const k of Object.keys(c.execution)) expect({ dir, key: k, known: EXECUTION_KEYS.includes(k) }).toEqual({ dir, key: k, known: true })
      expect(String(c.execution.prompt)).toStartWith('/litter:design ')
      expect(c.execution.max_turns).toBeLessThanOrEqual(200)
      expect(c.execution.timeout_seconds).toBeLessThanOrEqual(3600)
      expect(c.runs).toBeLessThanOrEqual(50)
      const graders = c.graders as Grader[]
      expect(new Set(graders.map(g => g.name)).size).toBe(graders.length)
      for (const g of graders) {
        const keys = GRADER_KEYS[String(g.type)]
        expect({ dir, grader: g.name, type: keys !== undefined }).toEqual({ dir, grader: g.name, type: true })
        for (const k of Object.keys(g)) expect({ dir, grader: g.name, key: k, ok: keys!.includes(k) }).toEqual({ dir, grader: g.name, key: k, ok: true })
        for (const m of [g.input_match, g.before?.input_match, g.after?.input_match]) if (typeof m === 'string') expect(() => new RegExp(m)).not.toThrow()
        if (g.type === 'regex') expect(() => new RegExp(String(g.pattern), String(g.flags ?? ''))).not.toThrow()
        if (g.focus !== undefined) expect(FOCUS).toContain(g.focus)
      }
      expect(graders.some(g => g.type === 'llm')).toBe(true)
      // The header says how to run it, as the fanout cases' does.
      expect(caseText(dir)).toStartWith('# Run ')
      expect(caseText(dir)).toContain(`claude plugin eval plugins/litter --scaffold --ablation none --runs 1 --no-publish`)
      expect(caseText(dir)).toContain(`--case ${dir}`)
    }
  })

  test("allow the design roles' tools, the record tool and plan mode's two tools", () => {
    const roles = ['falsifier', 'coverage', 'mechanism', 'reframer', 'prober', 'author', 'design-critic'] as const
    const need = new Set(['Skill', 'ToolSearch', 'Workflow', 'EnterPlanMode', 'ExitPlanMode', ...roles.flatMap(r => ROLE_TOOLS[r])])
    for (const dir of designDirs()) {
      const allowed = readCase(dir).execution.allowed_tools as string[]
      for (const t of need) expect({ dir, tool: t, allowed: allowed.includes(t) }).toEqual({ dir, tool: t, allowed: true })
    }
  })

  test('each request gives a bar run.start takes: at least 6 items, at least one a ban, and Launch', () => {
    for (const dir of designDirs()) {
      const prompt = String(readCase(dir).execution.prompt)
      const ids = [...prompt.matchAll(/^- ([CB][0-9]+): /gm)].map(m => m[1]!)
      expect(ids.length).toBeGreaterThanOrEqual(6)
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids.some(id => id.startsWith('B'))).toBe(true)
      expect(prompt).toContain('Launch.')
    }
  })

  test('design-launch grades rule.find before run.start before the launch, summary.md read, and plan mode only when delivered', () => {
    const order = (name: string) => {
      const g = grader('design-launch', name)
      return [g.type, g.before.tool, g.before.input_match, g.after.tool, g.after.input_match]
    }
    expect(order('rule-find-before-run-start')).toEqual(['tool_order', 'mcp__litter__record', 'rule\\.find', 'mcp__litter__record', 'run\\.start'])
    expect(order('run-start-before-launch')).toEqual(['tool_order', 'mcp__litter__record', 'run\\.start', 'Workflow', 'litter:design-run'])
    expect(grader('design-launch', 'read-the-summary')).toMatchObject({ type: 'tool_used', tool: 'Read', input_match: 'summary\\.md', min: 1 })
    const plan = grader('design-launch', 'plan-mode-only-when-delivered')
    expect(plan).toMatchObject({ type: 'llm', focus: 'trace' })
    expect(plan.criteria).toContain('the session called neither EnterPlanMode nor ExitPlanMode')
    expect(String(readCase('design-launch').execution.prompt)).toContain('The result that would kill the design')
  })

  test('design-holding runs one round, uses no plan mode, and grades the open criteria reported', () => {
    const c = readCase('design-holding')
    expect(String(c.execution.prompt)).toContain('max rounds 1')
    expect(new RegExp(grader('design-holding', 'run-start-has-one-round').input_match).test('{"kind":"run.start","maxRounds":1,"goal":"g"}')).toBe(true)
    for (const tool of ['EnterPlanMode', 'ExitPlanMode']) {
      const g = (c.graders as Grader[]).find(x => x.type === 'tool_used' && x.tool === tool)
      expect(g).toMatchObject({ min: 0, max: 0 })
    }
    expect(grader('design-holding', 'names-the-open-criterion')).toMatchObject({ type: 'regex', pattern: '\\bC6\\b' })
    expect(grader('design-holding', 'reports-the-open-criteria').criteria).toContain("the critic's evidence and the kind of work that would close it")
  })

  test('each scaffold is inside its case and makes a clean repository whose check passes, with no export file to time', () => {
    for (const dir of designDirs()) {
      const abs = resolve(EVALS, dir, String(readCase(dir).context.scaffold_script))
      expect(abs.startsWith(join(EVALS, dir) + '/')).toBe(true)
      expect(existsSync(abs)).toBe(true)
      expect(spawnSync('sh', ['-n', abs]).status).toBe(0)
      const { dir: cwd, cleanup } = scratch('litter-eval-')
      try {
        const env = { ...process.env, ...HERMETIC_GIT_ENV }
        const r = spawnSync('sh', [abs], { cwd, env, encoding: 'utf8' })
        expect({ dir, status: r.status, stderr: r.stderr }).toEqual({ dir, status: 0, stderr: '' })
        expect(spawnSync('git', ['status', '--porcelain'], { cwd, env, encoding: 'utf8' }).stdout).toBe('')
        expect(spawnSync('sh', ['check.sh'], { cwd }).status).toBe(0)
        expect(spawnSync('sh', ['report.sh'], { cwd, encoding: 'utf8' }).stdout).toBe('apples 1234\npears 5\nplums 0\ntotal 1239\n')
        expect(existsSync(join(cwd, 'data', 'export-2024.csv'))).toBe(false)
      } finally {
        cleanup()
      }
    }
  }, 120_000) // real git, twice, on a busy machine
})
