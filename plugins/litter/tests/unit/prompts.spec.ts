// Tier 2: the static prompt checks (plan section 12, "Prompt and skill
// checks"): no backtick, no `${`, no model named, the tags each execute and
// fanout role's calls carry, and the shared parts each role assembles.

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { RoleName } from '../../hooks/hookfiles'
import { PROMPT_TAGS, ROLE_PROMPTS, ROLE_TAGS } from '../../hooks/prompts/index'
import { HARNESS_FRAME, READ_ONLY_LIMITS, SHARED_CORE } from '../../hooks/prompts/shared'
import { ROLE_NAMES, ROLE_TOOLS } from '../../hooks/roles'
import {
  argsWith,
  BIND_A,
  BIND_B,
  check,
  conflict,
  done,
  landedOk,
  merged,
  NONCE,
  nonceTags,
  researched,
  resolvedOk,
  runFanout,
  TASK_A,
  TASK_B,
  TASK_R,
} from './fanoutjs-harness'
import { HERMETIC_GIT_ENV, scratch } from './support/node-ports'

const PLUGIN = resolve(import.meta.dir, '..', '..')

const DESIGN = ['falsifier', 'coverage', 'mechanism', 'reframer', 'author', 'design-critic'] as const
const entries = () => Object.entries(ROLE_PROMPTS)

describe('every prompt', () => {
  test('has no backtick and no ${', () => {
    for (const [role, text] of entries()) {
      expect({ role, backtick: text.includes('`') }).toEqual({ role, backtick: false })
      expect({ role, interp: text.includes('${') }).toEqual({ role, interp: false })
    }
  })

  test('names no model and no vendor', () => {
    // `.claude/litter/` is a path, not a model: a name after a dot doesn't count.
    const MODEL = /(?<!\.)\b(claude|anthropic|opus|sonnet|haiku|gpt-?[0-9]|openai|gemini|llama)\b/i
    expect(MODEL.test('under .claude/litter/')).toBe(false)
    expect(MODEL.test('ask Claude')).toBe(true)
    for (const [role, text] of entries()) expect({ role, model: MODEL.exec(text)?.[0] ?? null }).toEqual({ role, model: null })
  })

  test('is non-empty, ends its role with a "when you\'re done" step, and carries the harness frame', () => {
    for (const [role, text] of entries()) {
      expect(text.length).toBeGreaterThan(500)
      expect({ role, done: /StructuredOutput|When you're done/.test(text) }).toEqual({ role, done: true })
      expect({ role, frame: text.includes(HARNESS_FRAME) }).toEqual({ role, frame: true })
    }
  })

  test('the design roles add the shared core and the read-only limits; the prober the core alone', () => {
    for (const role of ROLE_NAMES) {
      const text = ROLE_PROMPTS[role]
      const design = (DESIGN as readonly string[]).includes(role)
      expect({ role, core: text.includes(SHARED_CORE) }).toEqual({ role, core: design || role === 'prober' })
      expect({ role, ro: text.includes(READ_ONLY_LIMITS) }).toEqual({ role, ro: design })
    }
  })
})

describe('tags', () => {
  test("each execute and fanout role names every tag its calls carry, and only the contract's", () => {
    for (const [role, tags] of Object.entries(ROLE_TAGS)) {
      const text = ROLE_PROMPTS[role as keyof typeof ROLE_PROMPTS]
      for (const tag of tags!) expect({ role, tag, named: text.includes(`<${tag}>`) }).toEqual({ role, tag, named: true })
      const named = [...text.matchAll(/<([a-z_]+)>/g)].map(m => m[1]!)
      for (const tag of named) expect({ role, tag, known: (PROMPT_TAGS as readonly string[]).includes(tag) }).toEqual({ role, tag, known: true })
    }
  })

  test('the fanout calls match the prompts doc', () => {
    expect([...ROLE_TAGS.verifier!].sort()).toEqual(['base', 'changed', 'contract', 'integrator', 'rules', 'tasks', 'where'])
    expect([...ROLE_TAGS.integrator!].sort()).toEqual(['authorized', 'conflict', 'contract', 'rules', 'tasks', 'where'])
    expect([...ROLE_TAGS.researcher!].sort()).toEqual(['authorized', 'contract', 'rules', 'task'])
  })

  test('every execute and fanout role is listed', () => {
    const listed = Object.keys(ROLE_TAGS).sort()
    expect(listed).toEqual(ROLE_NAMES.filter(r => !(DESIGN as readonly string[]).includes(r) && r !== 'prober').sort())
  })
})

// ---------------------------------------------------------------------------
// The fanout's calls against its roles' prompts (WP-H): workflows/fanout.js run
// through a conflict, so every fanout role is called once at least.

const fanoutRun = () =>
  runFanout({
    args: argsWith([TASK_A, TASK_B, TASK_R]),
    replies: {
      'write:A': done(['a/hello.txt']),
      'write:B': done(['b/world.txt']),
      'research:R': researched,
      integrate: conflict('B', ['A']),
      'integrator:B': resolvedOk,
      'integrate#2': merged(['A', 'B']),
      verifier: check(['A', 'B', 'R']),
      'land:fanout': landedOk,
    },
  })

describe('the fanout calls', () => {
  test("each call's tags are its role's, and its role's prompt names them", async () => {
    const r = await fanoutRun()
    expect(r.error).toBeNull()
    const roles = new Set<string>()
    for (const c of r.calls) {
      const role = c.agentType.replace(/^litter:/, '') as RoleName
      roles.add(role)
      const allowed: readonly string[] = ROLE_TAGS[role] ?? []
      for (const tag of nonceTags(c.prompt, NONCE)) {
        expect({ call: c.label, tag, theRoles: allowed.includes(tag) }).toEqual({ call: c.label, tag, theRoles: true })
        expect({ call: c.label, tag, named: ROLE_PROMPTS[role].includes(`<${tag}>`) }).toEqual({ call: c.label, tag, named: true })
      }
    }
    expect([...roles].sort()).toEqual(['executor', 'integrator', 'relay', 'researcher', 'verifier'])
  })

  test('the tags read the same once prompt provenance indents every line', async () => {
    const r = await fanoutRun()
    for (const c of r.calls) {
      const framed = c.prompt.split('\n').map(l => `  ${l}`).join('\n')
      expect(nonceTags(framed, NONCE)).toEqual(nonceTags(c.prompt, NONCE))
    }
  })

  test("the relay's prompt names the integrate, with no values, and its id", () => {
    const relay = ROLE_PROMPTS.relay
    expect(relay).toContain('or an integrate, which takes no values')
    expect(relay).toContain('integrate_id')
    expect(relay).toContain('conflict or refused is still the answer')
  })

  test('no prompt carries a bind token or names a model', () => {
    const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    for (const [role, text] of entries()) {
      expect({ role, uuid: UUID.exec(text)?.[0] ?? null }).toEqual({ role, uuid: null })
      expect({ role, attr: text.includes('bind="') }).toEqual({ role, attr: false })
      for (const token of [BIND_A, BIND_B]) expect(text.includes(token)).toBe(false)
    }
  })

  test("the executor binds first, with the record's token field, and returns blocked when refused", () => {
    const text = ROLE_PROMPTS.executor
    expect(text).toContain('make your first call mcp__litter__record with kind task.bind and token set to that exact value')
    expect(text).toContain('call StructuredOutput right away with status blocked, no files and no checks')
    expect(text).toContain("commit only your work's files, on that worktree's branch")
  })
})

// ---------------------------------------------------------------------------
// The skill (plan section 12, "Prompt and skill checks"; litter-prompts.md,
// "What all six skills share").

const SKILL_PATH = join(PLUGIN, 'skills', 'fanout', 'SKILL.md')
const skillText = () => readFileSync(SKILL_PATH, 'utf8')
function frontmatter(text: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!m) throw new Error('SKILL.md has no frontmatter')
  return Bun.YAML.parse(m[1]!) as Record<string, unknown>
}
/** Fenced blocks and `!` shell blocks: where CC would run or show text unescaped. */
const shellParts = (text: string): string[] => [
  ...[...text.matchAll(/^```[\s\S]*?^```/gm)].map(m => m[0]),
  ...[...text.matchAll(/!`[^`]*`/g)].map(m => m[0]),
  ...text.split('\n').filter(l => l.startsWith('!')),
]

describe('skills/fanout/SKILL.md', () => {
  test('stays under about 2.5K tokens, so compaction re-attaches it whole', () => {
    // About four characters a token for this prose; CC re-attaches up to 5K tokens a skill.
    expect(skillText().length).toBeLessThan(10_000)
  })

  test('its frontmatter names the skill, pre-approves only read-only tools, and pins no model', () => {
    const fm = frontmatter(skillText())
    expect(fm.name).toBe('fanout')
    expect(typeof fm.description).toBe('string')
    expect(fm.model).toBeUndefined()
    expect(fm.effort).toBeUndefined()
    const tools = fm['allowed-tools'] as string[]
    expect(tools.length).toBeGreaterThan(0)
    for (const t of tools) expect(t).toMatch(/^(Read|Grep|Glob|Bash\(git (status|log|branch|diff|show):\*\))$/)
  })

  test('loads the record tool with ToolSearch first, and stops without it', () => {
    const text = skillText()
    const at = text.indexOf('select:mcp__litter__record')
    expect(at).toBeGreaterThan(0)
    expect(text.slice(0, at)).toContain('ToolSearch')
    expect(text).toContain("If it isn't found, stop")
    expect(text).toContain("Don't run the tasks another way.")
    // The check comes before anything is recorded or launched.
    expect(at).toBeLessThan(text.indexOf("kind: 'run.find'"))
    expect(at).toBeLessThan(text.indexOf("kind: 'run.start'"))
  })

  test('$ARGUMENTS appears once, in <request>, never in a shell block', () => {
    const text = skillText()
    expect(text.split('$ARGUMENTS').length - 1).toBe(1)
    expect(text).toContain('<request>\n$ARGUMENTS\n</request>')
    for (const part of shellParts(text)) expect(part).not.toContain('$ARGUMENTS')
  })

  test('uses ${user_config.*} only for display, never in a record or a shell block', () => {
    const text = skillText()
    const lines = text.split('\n').filter(l => l.includes('${user_config.'))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) {
      expect(l).not.toContain('kind:')
      expect(l).toMatch(/configured/)
    }
    for (const part of shellParts(text)) expect(part).not.toContain('${user_config.')
  })

  test('records run.start with the fields run.start takes, and launches litter:fanout by name', () => {
    const text = skillText()
    expect(text).toContain("{ kind: 'run.start', workflow: 'fanout', tasks, contract, verify, setup, linkDirs, authorized, mergeOrder, runRules }")
    expect(text).toContain("Call Workflow with `name: 'litter:fanout'`")
  })
})

// ---------------------------------------------------------------------------
// The eval cases (evals/, for `claude plugin eval`): they parse as the 2.1.287
// case schema does, and their scaffolds make the repository they describe.

const EVALS = join(PLUGIN, 'evals')
const caseDirs = () => readdirSync(EVALS, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()
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
const readCase = (dir: string) => Bun.YAML.parse(readFileSync(join(EVALS, dir, 'case.yaml'), 'utf8')) as Record<string, any>

function runScaffold(dir: string): { cwd: string; cleanup: () => void; status: string } {
  const { dir: cwd, cleanup } = scratch('litter-eval-')
  const script = join(EVALS, dir, readCase(dir).context.scaffold_script)
  const env = { ...process.env, ...HERMETIC_GIT_ENV }
  const r = spawnSync('sh', [script], { cwd, env, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${dir}/scaffold failed: ${r.stderr}`)
  const st = spawnSync('git', ['status', '--porcelain'], { cwd, env, encoding: 'utf8' })
  return { cwd, cleanup, status: st.stdout }
}

describe('the eval cases', () => {
  test('are the three fanout cases', () => {
    expect(caseDirs()).toEqual(['fanout-dirty-tree', 'fanout-launch', 'fanout-no-record-tool'])
  })

  test("parse as the case schema, with every grader's keys its type's", () => {
    for (const dir of caseDirs()) {
      const c = readCase(dir)
      for (const k of Object.keys(c)) expect({ dir, key: k, known: TOP_KEYS.includes(k) }).toEqual({ dir, key: k, known: true })
      expect(c.schema_version).toBe('1.1')
      expect(c.name).toBe(dir)
      for (const k of Object.keys(c.execution)) expect({ dir, key: k, known: EXECUTION_KEYS.includes(k) }).toEqual({ dir, key: k, known: true })
      expect(String(c.execution.prompt)).toStartWith('/litter:fanout ')
      expect(c.execution.max_turns).toBeLessThanOrEqual(200)
      expect(c.execution.timeout_seconds).toBeLessThanOrEqual(3600)
      expect(c.runs).toBeLessThanOrEqual(50)
      for (const k of Object.keys(c.execution.env ?? {})) expect(k).toMatch(/^EVAL_[A-Z0-9_]*$/)
      const graders = c.graders as Record<string, unknown>[]
      expect(graders.length).toBeGreaterThan(0)
      expect(new Set(graders.map(g => g.name)).size).toBe(graders.length)
      for (const g of graders) {
        const keys = GRADER_KEYS[String(g.type)]
        expect({ dir, grader: g.name, type: keys !== undefined }).toEqual({ dir, grader: g.name, type: true })
        for (const k of Object.keys(g)) expect({ dir, grader: g.name, key: k, ok: keys!.includes(k) }).toEqual({ dir, grader: g.name, key: k, ok: true })
        if (typeof g.input_match === 'string') expect(() => new RegExp(g.input_match as string)).not.toThrow()
        if (g.type === 'regex') expect(() => new RegExp(String(g.pattern), String(g.flags ?? ''))).not.toThrow()
      }
      // An outcome grader, not only which tools ran.
      expect(graders.some(g => !['tool_used', 'tool_order'].includes(String(g.type)))).toBe(true)
    }
  })

  test("allow the roles' tools and the record tool, which dontAsk would otherwise deny", () => {
    const need = new Set(['Skill', 'ToolSearch', 'Workflow', ...(['executor', 'integrator', 'verifier', 'researcher', 'relay'] as const).flatMap(r => ROLE_TOOLS[r])])
    for (const dir of caseDirs()) {
      const allowed = readCase(dir).execution.allowed_tools as string[]
      for (const t of need) expect({ dir, tool: t, allowed: allowed.includes(t) }).toEqual({ dir, tool: t, allowed: true })
    }
  })

  test('each scaffold is inside its case and makes a repository with a passing check: clean, or dirty for the dirty-tree case', () => {
    for (const dir of caseDirs()) {
      const rel = String(readCase(dir).context.scaffold_script)
      const abs = resolve(EVALS, dir, rel)
      expect(abs.startsWith(join(EVALS, dir) + '/')).toBe(true)
      expect(existsSync(abs)).toBe(true)
      expect(spawnSync('sh', ['-n', abs]).status).toBe(0)
      const s = runScaffold(dir)
      try {
        expect(spawnSync('sh', ['check.sh'], { cwd: s.cwd }).status).toBe(0)
        expect({ dir, dirty: s.status.trim() !== '' }).toEqual({ dir, dirty: dir === 'fanout-dirty-tree' })
        if (dir === 'fanout-dirty-tree') expect(s.status).toContain('a/README')
      } finally {
        s.cleanup()
      }
    }
  }, 120_000) // real git, three times, on a busy machine
})
