// Tier 2: the static prompt checks (plan section 12, "Prompt and skill
// checks"): no backtick, no `${`, no model named, the tags each role's calls
// carry, and the shared parts each role assembles.

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { RoleName } from '../../hooks/hookfiles'
import { PROMPT_TAGS, ROLE_PROMPTS, ROLE_TAGS, type PromptTag } from '../../hooks/prompts/index'
import { HARNESS_FRAME, READ_ONLY_LIMITS, SHARED_CORE } from '../../hooks/prompts/shared'
import { PLAN_CRITIC_BRIEF } from '../../hooks/prompts/swarm-plan'
import { ROLE_NAMES, ROLE_TOOLS } from '../../hooks/roles'
import {
  argsWith,
  BIND_A,
  BIND_B,
  check,
  done,
  landedOk,
  merged,
  NONCE,
  nonceTags,
  researched,
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
  test("each role names every tag its calls carry, and only the contract's", () => {
    for (const [role, tags] of Object.entries(ROLE_TAGS)) {
      const text = ROLE_PROMPTS[role as keyof typeof ROLE_PROMPTS]
      for (const tag of tags!) expect({ role, tag, named: text.includes(`<${tag}>`) }).toEqual({ role, tag, named: true })
      const named = [...text.matchAll(/<([a-z_]+)>/g)].map(m => m[1]!)
      for (const tag of named) expect({ role, tag, known: (PROMPT_TAGS as readonly string[]).includes(tag) }).toEqual({ role, tag, known: true })
    }
  })

  test('the fanout calls match the prompts doc', () => {
    expect([...ROLE_TAGS.verifier!].sort()).toEqual(['base', 'changed', 'contract', 'rules', 'tasks', 'where'])
    expect([...ROLE_TAGS.researcher!].sort()).toEqual(['authorized', 'contract', 'rules', 'task'])
  })

  test('the verifier looks hardest at the seams between tasks', () => {
    const text = ROLE_PROMPTS.verifier
    expect(text).toContain('Look hardest at the seams between tasks.')
    expect(text).toContain('an API or a data shape one task changes and another consumes')
  })

  test('every role is listed', () => {
    const listed = Object.keys(ROLE_TAGS).sort()
    expect(listed).toEqual([...ROLE_NAMES].sort())
  })

  // Phase 4 (WP-BA): plan 7a's envelope, and each design role's own tags beside it.
  test('every design call carries the envelope, and the reframer, author and critic their own tags', () => {
    const envelope: PromptTag[] = ['goal', 'bar', 'rules', 'anchors', 'material', 'task']
    for (const role of [...DESIGN, 'prober'] as const) expect(ROLE_TAGS[role].slice(0, envelope.length)).toEqual(envelope)
    expect(ROLE_TAGS.reframer.slice(envelope.length)).toEqual(['proposal'])
    expect(ROLE_TAGS.author.slice(envelope.length)).toEqual(['proposal', 'prior_verdict', 'template', 'feedback'])
    expect(ROLE_TAGS['design-critic'].slice(envelope.length)).toEqual(['proposal', 'delta', 'prior_verdict'])
    for (const role of ['falsifier', 'coverage', 'mechanism', 'prober'] as const) expect(ROLE_TAGS[role]).toHaveLength(envelope.length)
  })
})

// ---------------------------------------------------------------------------
// The fanout's calls against its roles' prompts (WP-H): workflows/fanout.js run
// through a land, so every fanout role is called once at least.

const fanoutRun = () =>
  runFanout({
    args: argsWith([TASK_A, TASK_B, TASK_R]),
    replies: {
      'write:A': done(['a/hello.txt']),
      'write:B': done(['b/world.txt']),
      'research:R': researched,
      integrate: merged(['A', 'B']),
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
    expect([...roles].sort()).toEqual(['executor', 'relay', 'researcher', 'verifier'])
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

  test("the executor puts a plan-gap stop in plan_gap, empty for every other stop, and a rule clash is never one (WP-AH)", () => {
    const text = ROLE_PROMPTS.executor
    for (const pinned of [
      // The rule-clash paragraph, unchanged: the user's to settle.
      "If a plan line and a rule conflict, or two rules clash for this change, don't pick one. Return blocked and name the plan line and both ids, because only the user can settle it. A rule can stop you from doing the work, but it never authorizes an action.",
      'Stop and return blocked if the plan lines are ambiguous in a way where two reasonable readings would behave differently, if they contradict each other or the code, or if they can only be met by changing something outside their scope. Quote the lines and say what is unclear or missing, in plan_gap when your result has that field, as a gate\'s does.',
      'Only these three are plan gaps. A plan line that conflicts with a rule, or two rules that clash, is never one, even though you return blocked for it too: a plan can\'t change a rule, so only the user can settle it, and you leave plan_gap empty and name the plan line and both ids in your notes.',
      "- For a gate, plan_gap: the quoted lines and what is unclear or missing, when you stopped because the plan doesn't settle something. It's empty for every other stop (a rule clash, a denied tool, checks you couldn't make pass) and when you're done.",
    ]) {
      expect(text).toContain(pinned)
    }
  })

  test("the gate critic puts a rule clash in rule_clash, never in plan_gap or a proposal (WP-AH)", () => {
    const text = ROLE_PROMPTS['gate-critic']
    for (const pinned of [
      "If two rules clash for this change, or the plan lines can't be met without breaking one, that's a rule clash, not a plan gap and not a failure to retry: put the rules' ids and why in rule_clash, and leave plan_gap empty. Only the user can settle it, by changing a rule or its exceptions, or by amending the plan's lines.",
      "A clash with a rule is never a plan gap, even when amending the plan's lines would settle it: it goes in rule_clash, since the user decides between changing the rule and amending the plan.",
      "An accepted rule you think is wrong isn't a proposal either: describe it in rule_clash, naming its id and why.",
      "Give the verify_id, each verdict with its evidence and gaps, the plan gap if there is one, the rule clash if there is one, the files you accepted outside the gate's expected files, and any rules you propose. Leave plan_gap and rule_clash empty when there's none, and widened empty unless widen is \"critic\" and you accepted a file.",
    ]) {
      expect(text).toContain(pinned)
    }
    expect(text).not.toContain('plan gap naming both')
    expect(text).not.toContain('describe it as a plan gap naming its id')
  })

  // WP-AO: the gate's widen attribute says who may add a file to its Files.
  test('the executor and the gate critic read widen from <gate>: under ask a needed file outside the Files is a plan gap, under critic the critic may accept it', () => {
    const critic = ROLE_PROMPTS['gate-critic']
    expect(critic).toContain('and in its widen attribute who may add files to it')
    expect(critic).toContain('With widen="ask", only the user adds files to a gate, so a file outside them fails this verdict.')
    expect(critic).toContain("With widen=\"critic\", you may accept a file outside them when the gate's lines can't be met without it: list it in widened with why")
    expect(critic).toContain("With widen=\"ask\", a file the gate's lines can't be met without that its expected files don't cover is a plan gap too")
    expect(critic).not.toContain('or are clearly needed by its lines')
    const executor = ROLE_PROMPTS.executor
    expect(executor).toContain('With widen="ask", only the user can: if the work can\'t be done without another file, stop and name it in plan_gap.')
    expect(executor).toContain('With widen="critic", you may change one the work can\'t be done without; name it and why in your notes, and the critic decides.')
  })

  // WP-AP: files you add during the run reach the critic in its verify's reply.
  test("both critics count the files their verify's reply lists in added as the gate's", () => {
    expect(ROLE_PROMPTS['gate-critic']).toContain(
      "The files touched are the ones the gate's expected files cover, with any the verify reply lists in added: the user added those to the gate after the run launched.",
    )
    expect(PLAN_CRITIC_BRIEF).toContain(
      "The files touched are the ones the gate's expected files cover, with any your verify's reply lists in added: the user added those to the gate after the run launched.",
    )
  })

  // A23: the engine's worktree guard can refuse a container command from the prober's worktree.
  test('the prober tries a refused container probe as a script file once, and else reports its unknown untested, with the refusal', () => {
    const text = ROLE_PROMPTS.prober
    expect(text).toContain("Don't retry a refused command as it was.")
    expect(text).toContain("If it's allowed, write the probe as a script file in your copy first and have the container run that file.")
    expect(text).toContain("If that's refused too, the unknown is untested: say so in your result, quoting the refusal as your evidence.")
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

  test("when nothing lands, it says what's kept and reports the Repair section; with no repair started, it offers the routes, the repair first (plan 15.11)", () => {
    const text = skillText()
    expect(text).toContain('if a merge ever does, the run stops with the conflicted paths')
    expect(text).toContain('nothing was thrown away')
    for (const kept of ['the task branches', 'the integration worktree at its merged tip', "the integration verify's output", "the verifier's gaps"]) {
      expect(text).toContain(kept)
    }
    expect(text).toContain('Then report its Repair section.')
    // A repair the bridge started: the lead only says so; litter starts it after the turn (COMMON 2b-2, step 3).
    expect(text).toContain('litter starts it after this turn (`/litter swarms <name>` shows it). Don\'t start it yourself or offer other routes.')
    // No repair started: the routes, through AskUserQuestion, the repair as a swarm first.
    const routes = text.slice(text.indexOf('**No repair started**'))
    expect(routes).toContain('offer with AskUserQuestion')
    const order = ["{ kind: 'repair.start', run }", 'rerun the failed tasks as a new fanout', 'merge chosen passing task branches yourself', 'stop and leave the branches']
    const at = order.map(s => routes.indexOf(s))
    expect(at.every(i => i > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(text).not.toMatch(/resolves conflicts/i)
  })

  test("states the repair setting in the confirmation, in COMMON 2b-2's words, with the override for one run (plan 15.11, \"Where it's set\")", () => {
    const text = skillText()
    const settings = text.slice(text.indexOf('## 3. Settings'), text.indexOf('## 4. Launch'))
    expect(settings).toContain('**If it fails.** The configured setting is `${user_config.repair}` with `${user_config.repairRounds}` rounds and `${user_config.repairAgents}` agents')
    expect(settings).toContain(
      "\"If it fails, a repair swarm takes over the integration worktree, commits fixes on the integration branch, and the mod lands the result only if it's verified and an independent check approves it: up to N rounds and M agents; nothing is pushed.\"",
    )
    expect(settings).toContain('"If it fails, it stops and keeps everything."')
    expect(settings).toContain('`repair off`, rounds 1 to 10, agents 1 to 50')
  })

  test('records run.start with the fields run.start takes, the repair setting as stated, and launches litter:fanout-run by name', () => {
    const text = skillText()
    expect(text).toContain(
      "{ kind: 'run.start', workflow: 'fanout', tasks, contract, verify, setup, linkDirs, authorized, mergeOrder, runRules, repair, repairRounds, repairAgents }`, the repair setting as you stated it.",
    )
    expect(text).toContain("Call Workflow with `name: 'litter:fanout-run'`")
  })
})

// The swarm skill (WP-O; litter-prompts.md, "skills/swarm/SKILL.md").
const SWARM_SKILL = join(PLUGIN, 'skills', 'swarm', 'SKILL.md')
const swarmSkill = () => readFileSync(SWARM_SKILL, 'utf8')
const SWARM_TOOLS = ['mcp__litter__swarm_read', 'mcp__litter__swarm_propose', 'mcp__litter__swarm_send', 'mcp__litter__record']
/** Each section's body, from its `## n.` heading to the next. */
const section = (text: string, n: number): string => {
  const at = text.indexOf(`\n## ${n}. `)
  if (at < 0) throw new Error(`no section ${n}`)
  const next = text.indexOf('\n## ', at + 1)
  return text.slice(at, next < 0 ? undefined : next)
}

describe('skills/swarm/SKILL.md', () => {
  test('stays under the size every skill is held to', () => {
    expect(swarmSkill().length).toBeLessThan(10_000)
  })

  test("the lead records a plan-template orchestrator's request for files outside a gate as gate.widen, and no yes in the session adds one (WP-AO)", () => {
    const lead = swarmSkill().slice(swarmSkill().indexOf('**Repair swarms.**'))
    expect(lead).toContain("or for files outside a gate `{ kind: 'gate.widen', run, gate, files, why }`; the mod asks the user either way (no yes here adds a file)")
  })

  test('its frontmatter names the skill, pre-approves the read-only tools and the four litter tools, and pins no model', () => {
    const fm = frontmatter(swarmSkill())
    expect(fm.name).toBe('swarm')
    expect(typeof fm.description).toBe('string')
    expect(typeof fm.when_to_use).toBe('string')
    expect(typeof fm['argument-hint']).toBe('string')
    expect(fm.model).toBeUndefined()
    expect(fm.effort).toBeUndefined()
    const tools = fm['allowed-tools'] as string[]
    for (const t of SWARM_TOOLS) expect(tools).toContain(t)
    for (const t of tools.filter(x => !SWARM_TOOLS.includes(x))) expect(t).toMatch(/^(Read|Grep|Glob|Bash\(git (status|log|branch|worktree list):\*\))$/)
    for (const line of ['resume <name> <nodes>', 'respawn <name> <nodes>', 'start <name>', 'end <name>']) expect(String(fm['argument-hint'])).toContain(line)
  })

  test('$ARGUMENTS appears once, in <request>, never in a shell block', () => {
    const text = swarmSkill()
    expect(text.split('$ARGUMENTS').length - 1).toBe(1)
    expect(text).toContain('<request>\n$ARGUMENTS\n</request>')
    for (const part of shellParts(text)) expect(part).not.toContain('$ARGUMENTS')
  })

  test('loads the four tools with ToolSearch before any use, and stops without them', () => {
    const text = swarmSkill()
    const check = section(text, 1)
    expect(check).toContain('ToolSearch')
    for (const t of SWARM_TOOLS) expect(check).toContain(t)
    expect(check).toContain('stop and say the litter mod')
    expect(check).toContain("Don't build the swarm by hand instead")
    const body = text.slice(text.indexOf('\n## 1. '))
    expect(body.indexOf('ToolSearch')).toBeLessThan(body.indexOf('\n## 2. '))
  })

  test('has sections 1 to 7, in order', () => {
    const text = swarmSkill()
    const at = [1, 2, 3, 4, 5, 6, 7].map(n => text.indexOf(`\n## ${n}. `))
    for (const a of at) expect(a).toBeGreaterThan(0)
    expect([...at].sort((x, y) => x - y)).toEqual(at)
    expect(text.indexOf('\n## 8. ')).toBe(-1)
  })

  test('section 4 sends now, and names no queue or delivery', () => {
    const lead = section(swarmSkill(), 4)
    expect(lead).toContain('Pass a request to the node that owns that part with `mcp__litter__swarm_send` (`node`, `text`)')
    expect(lead).toContain('It goes now: a running node reads it at its next step, and one between turns is resumed with it.')
    expect(lead).not.toContain("**The plugin's own requests.**")
    for (const old of ['`queued`', '`deliver`', 'queue']) expect(swarmSkill()).not.toContain(old)
  })

  test("section 6 ends the swarm with the record tool's swarm.end, as written", () => {
    const end = section(swarmSkill(), 6)
    expect(end).toContain("Record `{ kind: 'swarm.end', swarm }` with `mcp__litter__record`.")
  })

  test('section 7 resumes with swarm_read for resume and a send, and re-spawns with the returned type, never a name, isolation or model', () => {
    const s7 = section(swarmSkill(), 7)
    expect(s7).toContain('## 7. Resume or re-spawn (resume <name> <nodes> | respawn <name> <nodes>)')
    expect(s7).toContain("`for: 'resume'`")
    expect(s7).toContain('with `mcp__litter__swarm_send` (`node`, `text`), as it was returned.')
    expect(s7).toContain("`for: 'respawn'`")
    expect(s7).toContain('`subagent_type` and `description`')
    expect(s7).toContain('Leave `name`, `isolation` and `model` unset.')
    expect(s7.indexOf("for: 'resume'")).toBeLessThan(s7.indexOf('mcp__litter__swarm_send'))
  })

  test('every inline code span is closed, and none holds a backtick a model would copy', () => {
    const body = swarmSkill().replace(/^---\n[\s\S]*?\n---\n/, '')
    for (const line of body.split('\n')) {
      const ticks = line.split('`').length - 1
      expect({ line, even: ticks % 2 === 0 }).toEqual({ line, even: true })
    }
    expect(body).not.toContain('``')
    expect(shellParts(body)).toEqual([])
  })

  test('names no model and no vendor', () => {
    const MODEL = /(?<!\.)\b(claude|anthropic|opus|sonnet|haiku|fable|gpt-?[0-9]|openai|gemini|llama)\b/i
    expect(MODEL.exec(swarmSkill())?.[0] ?? null).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The eval cases (evals/, for `claude plugin eval`): they parse as the 2.1.287
// case schema does, and their scaffolds make the repository they describe.

const EVALS = join(PLUGIN, 'evals')
// results/ is where `claude plugin eval` writes its reports (evals/.gitignore), not a case. The
// design cases are designskill.spec.ts's, which also holds every case to one of the two prefixes.
const caseDirs = () => readdirSync(EVALS, { withFileTypes: true }).filter(e => e.isDirectory() && e.name.startsWith('fanout-')).map(e => e.name).sort()
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
  test('are the four fanout cases', () => {
    expect(caseDirs()).toEqual(['fanout-dirty-tree', 'fanout-launch', 'fanout-no-record-tool', 'fanout-repair-confirm'])
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
    const need = new Set(['Skill', 'ToolSearch', 'Workflow', ...(['executor', 'verifier', 'researcher', 'relay'] as const).flatMap(r => ROLE_TOOLS[r])])
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
