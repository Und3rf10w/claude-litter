// WP-J: the templates (15.5): the four built-ins as data, params and
// `repeat`, instantiating and validating, and saving yours or this project's.
//
// A template is the swarm schema with `{param}` in its strings, plus
// `params` and `repeat`. `repeat: { <node id>: <list param> }` makes one
// copy of that node per item, `{item}` filled in its id, brief, task and
// worktree, and every `spawns` naming it then names each copy. In an id, a
// spawns key and the swarm's name, a value is cut to a slug (lowercase
// letters, digits and dashes), so a branch like `feature/login` makes the
// node `feature-login`. A project template is repository content: listing
// one reads it and does nothing else.
//
// Owner: phase 2b-1, package J. The stub's signatures are the contract.

import type { Ports } from '../ports'
import type { Authority, SpecCheck, SpecError, SwarmNode, SwarmSpec, Template, TemplateListing, TemplateParam } from './types'
import { projectTemplatesDir, userTemplatesDir } from '../layout'
import { atomicWriteJson } from '../fsx'
import { BRIEF_MAX_BYTES, validateCtxFor, validateSpec } from './spec'

const TEMPLATE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const PARAM_NAME = /^[a-z][a-z0-9_]{0,31}$/
const PLACEHOLDER = /\{([a-z][a-z0-9_]{0,31})\}/g
const DESCRIPTION_MAX = 1024
const TEMPLATE_KEYS = ['name', 'description', 'params', 'repeat', 'spec', 'briefs']

type Raw = Record<string, unknown>
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const bytes = (s: string): number => new TextEncoder().encode(s).length
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// ---------------------------------------------------------------------------
// The built-ins. Their briefs are short and generic and name no model.

const READ_ONLY: Authority = { commit: false, push: 'none', forcePush: false, rewriteHistory: false, worktreeOps: false }
const COMMITS: Authority = { commit: true, push: 'none', forcePush: false, rewriteHistory: false, worktreeOps: false }
const NO_WRITES = { deny: ['Edit', 'Write', 'NotebookEdit'] }
const NAME_PARAM: TemplateParam = { name: 'name', type: 'string', description: "The swarm's name: lowercase letters, digits and dashes" }
const GOAL_PARAM: TemplateParam = { name: 'goal', type: 'string', description: 'What the swarm is for, in a sentence or two' }

const reviewerBrief =
  'You review the changes your parent names, without editing anything. Read the diff and the code around it, run the checks you can, ' +
  'and report each problem with its file, line and why it matters, the most serious first. Say what you checked and what you could not.\n'

export const BUILTIN_TEMPLATES: readonly Template[] = [
  {
    name: 'branch-per-orchestrator',
    description: 'One orchestrator per branch, each with reviewers, fixers in worktrees of their own, and a fix reviewer. Each commits on its own branch; push is off.',
    scope: 'builtin',
    params: [NAME_PARAM, GOAL_PARAM, { name: 'branches', type: 'list', description: 'The branches, one orchestrator each' }],
    repeat: { '{item}': 'branches' },
    spec: {
      name: '{name}',
      goal: '{goal}',
      nodes: [
        {
          id: '{item}',
          kind: 'orchestrator',
          brief: 'briefs/{item}.md',
          task: 'Work on branch {item} toward the goal, as your brief describes.',
          worktree: { new: { from: '{item}', branch: '{item}' } },
          authority: COMMITS,
          spawns: { reviewer: 2, fixer: 2, 'fix-reviewer': 1 },
          report: ['ready-to-push', 'belongs-elsewhere', 'blocked'],
        },
        { id: 'reviewer', kind: 'worker', brief: 'briefs/reviewer.md', tools: NO_WRITES, authority: READ_ONLY },
        { id: 'fixer', kind: 'worker', brief: 'briefs/fixer.md', worktree: 'own', authority: COMMITS },
        { id: 'fix-reviewer', kind: 'worker', brief: 'briefs/fix-reviewer.md', tools: NO_WRITES, authority: READ_ONLY },
      ],
    },
    briefs: {
      '{item}':
        'You own branch {item}. Work toward the goal on it: send reviews to reviewer, fixes to fixer, and each fix to fix-reviewer, ' +
        'then merge a fixer\'s branch into {item} once its review is clean. Commit on {item} only; the lead pushes. Done means the branch ' +
        'does what the goal asks and its checks pass. Report it as ready to push with the commit, and send anything that belongs to another branch up to the lead.\n',
      reviewer: reviewerBrief,
      fixer:
        'You fix what your parent sends you, in a worktree and on a branch of your own. Make the smallest change that fixes it, run the ' +
        'checks that cover it, and commit. Report the commit, what you changed, how you checked it, and anything you could not fix.\n',
      'fix-reviewer':
        'You check one fixer\'s commit before your parent merges it, without editing anything. Compare it with the problem it was meant to ' +
        'fix, look for anything it breaks, and report whether it is ready to merge, with your evidence.\n',
    },
  },
  {
    name: 'research-fan-out',
    description: 'One orchestrator that splits a question across read-only researchers, and a synthesizer that combines what they find.',
    scope: 'builtin',
    params: [NAME_PARAM, GOAL_PARAM],
    spec: {
      name: '{name}',
      goal: '{goal}',
      nodes: [
        {
          id: 'research',
          kind: 'orchestrator',
          brief: 'briefs/research.md',
          task: 'Split the goal into questions, send each to a researcher, then have the synthesizer combine the findings.',
          worktree: 'none',
          tools: NO_WRITES,
          authority: READ_ONLY,
          spawns: { researcher: 4, synthesizer: 1 },
          report: ['blocked', 'done'],
        },
        { id: 'researcher', kind: 'worker', brief: 'briefs/researcher.md', tools: NO_WRITES, authority: READ_ONLY },
        { id: 'synthesizer', kind: 'worker', brief: 'briefs/synthesizer.md', tools: NO_WRITES, authority: READ_ONLY },
      ],
    },
    briefs: {
      research:
        'You lead the research. Split the goal into questions that can be answered apart, give each to a researcher, and hand their ' +
        'reports to the synthesizer. Report the synthesis, with what is settled, what is open, and where the evidence is thin.\n',
      researcher:
        'You answer one question, without editing anything. Look for the evidence first: the code, the docs, the history. Report your ' +
        'answer with each source, how sure you are, and what you could not find.\n',
      synthesizer:
        'You combine the researchers\' reports into one answer to the goal, without editing anything. Keep each claim tied to its source, ' +
        'say where the reports disagree, and list what is still open.\n',
    },
  },
  {
    name: 'review-panel',
    description: 'Read-only reviewers, one per lens, each reporting to the lead.',
    scope: 'builtin',
    params: [
      NAME_PARAM,
      GOAL_PARAM,
      { name: 'lenses', type: 'list', description: 'What each reviewer looks for, one reviewer each', default: ['correctness', 'security', 'tests'] },
    ],
    repeat: { 'review-{item}': 'lenses' },
    spec: {
      name: '{name}',
      goal: '{goal}',
      nodes: [
        {
          id: 'review-{item}',
          kind: 'orchestrator',
          brief: 'briefs/review-{item}.md',
          task: 'Review what the goal names through one lens: {item}.',
          worktree: 'none',
          tools: NO_WRITES,
          authority: READ_ONLY,
          report: ['blocked', 'done'],
        },
      ],
    },
    briefs: {
      'review-{item}':
        'You are one reviewer on a panel, and your lens is {item}. Read what the goal names, without editing anything. Report each ' +
        'finding with its file and line, why it matters under your lens, and how sure you are. Leave the other lenses to the other reviewers.\n',
    },
  },
  {
    name: 'pipeline',
    description: 'One orchestrator taking the goal through a planner, an implementer in a worktree of its own, and a reviewer, in turn.',
    scope: 'builtin',
    params: [
      NAME_PARAM,
      GOAL_PARAM,
      { name: 'base', type: 'string', description: 'The commit or branch the work starts from', default: 'HEAD' },
      { name: 'branch', type: 'string', description: 'The new branch the work goes on' },
    ],
    spec: {
      name: '{name}',
      goal: '{goal}',
      nodes: [
        {
          id: 'pipeline',
          kind: 'orchestrator',
          brief: 'briefs/pipeline.md',
          task: 'Take the goal through planning, implementation and review, one step at a time.',
          worktree: { new: { from: '{base}', branch: '{branch}' } },
          authority: COMMITS,
          spawns: { planner: 1, implementer: 1, reviewer: 1 },
          report: ['ready-to-push', 'blocked'],
        },
        { id: 'planner', kind: 'worker', brief: 'briefs/planner.md', tools: NO_WRITES, authority: READ_ONLY },
        { id: 'implementer', kind: 'worker', brief: 'briefs/implementer.md', worktree: 'own', authority: COMMITS },
        { id: 'reviewer', kind: 'worker', brief: 'briefs/reviewer.md', tools: NO_WRITES, authority: READ_ONLY },
      ],
    },
    briefs: {
      pipeline:
        'You take the goal through three steps on branch {branch}: the planner writes the plan, the implementer carries it out on a branch ' +
        'of its own, and the reviewer checks it. Merge the implementer\'s branch once the review is clean, and send it back otherwise. ' +
        'Commit on {branch} only; the lead pushes. Report it as ready to push with the commit.\n',
      planner:
        'You plan the change the goal asks for, without editing anything. Read the code it touches, then report the steps in order, ' +
        'each with the files it changes and how to check it.\n',
      implementer:
        'You carry out the plan your parent sends, in a worktree and on a branch of your own. Follow the plan, run the checks it names, and ' +
        'commit. Report the commit, anything you did differently from the plan and why, and anything left undone.\n',
      reviewer: reviewerBrief,
    },
  },
]

// ---------------------------------------------------------------------------
// Template files

/** A template as read from JSON, or why it isn't one. `scope` comes from where it was found. */
export function asTemplate(raw: unknown, scope: Template['scope']): Template | string {
  if (!isObj(raw)) return 'a template is a JSON object'
  const extra = Object.keys(raw).find(k => !TEMPLATE_KEYS.includes(k))
  if (extra) return `unknown field '${extra}'`
  if (typeof raw.name !== 'string' || !TEMPLATE_NAME.test(raw.name)) return "'name' must be lowercase letters, digits and dashes, at most 64 characters"
  if (typeof raw.description !== 'string' || raw.description.length > DESCRIPTION_MAX) return `'description' must be text, at most ${DESCRIPTION_MAX} characters`
  if (!Array.isArray(raw.params) || raw.params.length > 20) return "'params' must be a list of at most 20 parameters"
  const params: TemplateParam[] = []
  for (const x of raw.params) {
    if (!isObj(x) || typeof x.name !== 'string' || !PARAM_NAME.test(x.name) || x.name === 'item') {
      return "each parameter needs a 'name': a lowercase letter, then letters, digits or '_' ('item' is repeat's own)"
    }
    if (x.type !== 'string' && x.type !== 'list') return `parameter ${x.name}: 'type' is 'string' or 'list'`
    if (params.some(q => q.name === x.name)) return `parameter ${x.name} is listed twice`
    if (x.description !== undefined && typeof x.description !== 'string') return `parameter ${x.name}: 'description' is text`
    const d = x.default
    const okDefault = d === undefined || (x.type === 'string' ? typeof d === 'string' : Array.isArray(d) && d.every(i => typeof i === 'string'))
    if (!okDefault) return `parameter ${x.name}: its default must be ${x.type === 'string' ? 'text' : 'a list of text'}`
    params.push({ name: x.name, type: x.type, ...(x.description !== undefined ? { description: x.description } : {}), ...(d !== undefined ? { default: d as string | string[] } : {}) })
  }
  if (!isObj(raw.spec) || !Array.isArray(raw.spec.nodes) || !raw.spec.nodes.every(n => isObj(n) && typeof n.id === 'string')) {
    return "'spec' must be a swarm spec whose nodes each have an id"
  }
  const ids = (raw.spec.nodes as Raw[]).map(n => n.id as string)
  let repeat: Record<string, string> | undefined
  if (raw.repeat !== undefined) {
    if (!isObj(raw.repeat)) return "'repeat' maps node ids to list parameters"
    for (const [node, param] of Object.entries(raw.repeat)) {
      if (!ids.includes(node)) return `repeat names a node '${node}' the spec doesn't have`
      if (!params.some(q => q.name === param && q.type === 'list')) return `repeat for ${node} names '${String(param)}', which isn't a list parameter`
    }
    repeat = raw.repeat as Record<string, string>
  }
  if (!isObj(raw.briefs) || Object.keys(raw.briefs).length > 100) return "'briefs' maps node ids to brief text"
  for (const [node, text] of Object.entries(raw.briefs)) {
    if (typeof text !== 'string' || bytes(text) > BRIEF_MAX_BYTES) return `the brief for ${node} must be text, at most 16 KiB`
  }
  return {
    name: raw.name,
    description: raw.description,
    scope,
    params,
    ...(repeat ? { repeat } : {}),
    spec: structuredClone(raw.spec) as unknown as SwarmSpec,
    briefs: structuredClone(raw.briefs) as Record<string, string>,
  }
}

/** One folder's templates, `<name>.json` each: a file that isn't one is logged and left out. Reading is all it does. */
async function readFolder(p: Ports, dir: string, scope: 'user' | 'project'): Promise<{ template: Template; path: string }[]> {
  if (!(await p.fs.exists(dir))) return []
  const out: { template: Template; path: string }[] = []
  for (const e of await p.fs.list(dir)) {
    const m = /^([a-z0-9][a-z0-9-]{0,63})\.json$/.exec(e.name)
    if (e.kind !== 'file' || e.isLink || !m) continue
    const path = `${dir}/${e.name}`
    try {
      const t = asTemplate(JSON.parse(await p.fs.read(path)), scope)
      if (typeof t === 'string') p.log(`template ${path} skipped: ${t}`)
      else if (t.name !== m[1]) p.log(`template ${path} skipped: it's named '${t.name}', not '${m[1]}'`)
      else out.push({ template: t, path })
    } catch (err) {
      p.log(`template ${path} skipped: ${errText(err)}`)
    }
  }
  return out.sort((a, b) => (a.template.name < b.template.name ? -1 : 1))
}

/** Yours: `<config dir>/litter/swarm-templates/`, or none when there's no config dir. */
async function userDir(p: Ports): Promise<string | null> {
  try {
    return userTemplatesDir(await p.configDir())
  } catch {
    return null
  }
}

async function found(p: Ports, litterDir: string): Promise<{ template: Template; path: string | null }[]> {
  const mine = await userDir(p)
  return [
    ...BUILTIN_TEMPLATES.map(template => ({ template, path: null })),
    ...(mine ? await readFolder(p, mine, 'user') : []),
    ...(await readFolder(p, projectTemplatesDir(litterDir), 'project')),
  ]
}

/** The built-ins, then yours (`p.configDir()`), then this project's. A project template is only read. */
export async function listTemplates(p: Ports, litterDir: string): Promise<TemplateListing[]> {
  return (await found(p, litterDir)).map(({ template: t, path }) => ({ name: t.name, description: t.description, scope: t.scope, params: t.params, path }))
}

/** One template whole, by its scope and name, for `instantiate`; null when there's none. */
export async function loadTemplate(p: Ports, litterDir: string, scope: Template['scope'], name: string): Promise<Template | null> {
  return (await found(p, litterDir)).find(x => x.template.scope === scope && x.template.name === name)?.template ?? null
}

/**
 * Writes `<config dir>/litter/swarm-templates/<name>.json` (scope `user`) or
 * `<litterDir>/swarm-templates/<name>.json` (scope `project`). C's choice: the
 * whole template, its `scope` saying where; it answers the file's path.
 * Rejects a built-in's scope and a template that doesn't read as one.
 */
export async function saveTemplate(p: Ports, litterDir: string, template: Template): Promise<string> {
  if (template.scope !== 'user' && template.scope !== 'project') throw new Error("litter: a template is saved as yours ('user') or this project's ('project')")
  const { scope, ...file } = template
  const t = asTemplate(file, scope)
  if (typeof t === 'string') throw new Error(`litter: the template can't be saved: ${t}`)
  const dir = scope === 'user' ? await userDir(p) : projectTemplatesDir(litterDir)
  if (!dir) throw new Error("litter: there's no config dir (CLAUDE_CONFIG_DIR or HOME) to save your template in; save it to this project instead")
  const path = `${dir}/${t.name}.json`
  await atomicWriteJson(p, path, file)
  return path
}

// ---------------------------------------------------------------------------
// Filling one in

/** Lowercase letters, digits and dashes, at most 24: a value as an id takes it. */
const slugOf = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 24)
    .replace(/-+$/, '')

type Values = Map<string, string | string[]>

function fill(text: string, values: Values, item: string | null, asId: boolean): string {
  return text.replace(PLACEHOLDER, (whole, key: string) => {
    const v = key === 'item' ? item : values.get(key)
    if (v === undefined || v === null) return whole
    const s = Array.isArray(v) ? v.join(', ') : v
    return asId ? slugOf(s) : s
  })
}

function fillDeep(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === 'string') return f(v)
  if (Array.isArray(v)) return v.map(x => fillDeep(x, f))
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x, f)]))
  return v
}

/**
 * Fills a template's params and `repeat`, then validates the result.
 * C's choice: `values` by param name (a string, or a list for a `list` param),
 * and the answer carries the spec, its briefs and the check. A list given as
 * one string is split at commas and new lines. A param with no value is an
 * error at `params.<name>`, before the spec's own.
 */
export async function instantiate(
  p: Ports,
  litterDir: string,
  template: Template,
  values: Readonly<Record<string, string | readonly string[]>>,
): Promise<{ spec: SwarmSpec; briefs: Record<string, string>; check: SpecCheck }> {
  const errors: SpecError[] = []
  const vals: Values = new Map()
  for (const prm of template.params) {
    let v: unknown = Object.hasOwn(values, prm.name) ? values[prm.name] : prm.default
    if (prm.type === 'list') {
      if (typeof v === 'string') v = v.split(/[\n,]/)
      const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(x => x !== '') : []
      if (list.length === 0) errors.push({ field: `params.${prm.name}`, error: `${prm.name} needs at least one item${prm.description ? `: ${prm.description}` : ''}` })
      vals.set(prm.name, list)
    } else {
      const s = typeof v === 'string' ? v.trim() : ''
      if (s === '') errors.push({ field: `params.${prm.name}`, error: `${prm.name} needs a value${prm.description ? `: ${prm.description}` : ''}` })
      vals.set(prm.name, s)
    }
  }

  const repeat = template.repeat ?? {}
  const itemsOf = (id: string): (string | null)[] => {
    const prm = repeat[id]
    if (prm === undefined) return [null]
    const v = vals.get(prm)
    return Array.isArray(v) ? v : []
  }
  /** A template node id as its copies' ids. */
  const copiesOf = (id: string): string[] => itemsOf(id).map(item => fill(id, vals, item, true))

  const nodes: SwarmNode[] = []
  const briefs: Record<string, string> = {}
  const templateNodes = Array.isArray(template.spec.nodes) ? template.spec.nodes : []
  for (const tn of templateNodes) {
    for (const item of itemsOf(tn.id)) {
      const { id: _id, brief, spawns, ...rest } = tn
      const id = fill(tn.id, vals, item, true)
      const node = { id, ...(fillDeep(rest, s => fill(s, vals, item, false)) as Omit<SwarmNode, 'id'>) } as SwarmNode
      if (brief !== undefined) node.brief = `briefs/${id}.md`
      if (spawns !== undefined) {
        const out: Record<string, number> = {}
        for (const [k, count] of Object.entries(spawns)) {
          const isRepeated = templateNodes.some(x => x.id === k) && repeat[k] !== undefined
          for (const target of isRepeated ? copiesOf(k) : [fill(k, vals, item, true)]) out[target] = count
        }
        node.spawns = out
      }
      nodes.push(node)
      const text = template.briefs[tn.id]
      if (text !== undefined) briefs[id] = fill(text, vals, item, false)
    }
  }
  const spec: SwarmSpec = {
    ...(fillDeep(template.spec, s => fill(s, vals, null, false)) as SwarmSpec),
    name: fill(template.spec.name, vals, null, true),
    nodes,
  }

  const ctx = await validateCtxFor(p, litterDir, async node => (Object.hasOwn(briefs, node) ? briefs[node]! : null))
  const check = await validateSpec(p, spec, ctx)
  const all = [...errors, ...check.errors]
  return { spec, briefs, check: { ok: all.length === 0, errors: all, warnings: check.warnings } }
}

// ---------------------------------------------------------------------------
// Saving the current tree as a template

/** A value tied to this repository or this job that saving can turn into a parameter (15.5, "Saving offers to make parameters"). */
export type TemplateOffer = { field: string; value: string; param: string }

const paramName = (s: string): string => s.replace(/-/g, '_').replace(/^[^a-z]+/, '').slice(0, 32) || 'value'

/** The goal, the name, each orchestrator's task, each `existing` path, and each `new` worktree's from and branch. */
export function templateOffers(spec: SwarmSpec): TemplateOffer[] {
  const out: TemplateOffer[] = [
    { field: 'name', value: spec.name, param: 'name' },
    { field: 'goal', value: spec.goal, param: 'goal' },
  ]
  // `<node>_<what>` within PARAM_NAME's 32 characters, and unique: two long ids can share their start.
  const taken = new Set(['name', 'goal'])
  const param = (id: string, what: string): string => {
    for (let i = 1; ; i++) {
      const tail = i === 1 ? `_${what}` : `_${what}${i}`
      const name = `${paramName(id).slice(0, 32 - tail.length).replace(/_+$/, '') || 'value'}${tail}`
      if (!taken.has(name)) {
        taken.add(name)
        return name
      }
    }
  }
  for (const n of spec.nodes) {
    if (n.kind === 'orchestrator' && n.task !== undefined) out.push({ field: `nodes.${n.id}.task`, value: n.task, param: param(n.id, 'task') })
    const wt = n.worktree
    if (typeof wt === 'object' && 'existing' in wt) out.push({ field: `nodes.${n.id}.worktree.existing`, value: wt.existing, param: param(n.id, 'worktree') })
    if (typeof wt === 'object' && 'new' in wt) {
      out.push({ field: `nodes.${n.id}.worktree.new.from`, value: wt.new.from, param: param(n.id, 'from') })
      out.push({ field: `nodes.${n.id}.worktree.new.branch`, value: wt.new.branch, param: param(n.id, 'branch') })
    }
  }
  return out
}

/**
 * The tree as a template: each offer you picked becomes `{param}` in its
 * field, with today's value as the param's default. Save the answer with
 * saveTemplate.
 */
export function parameterize(
  head: { name: string; description: string; scope: 'user' | 'project' },
  spec: SwarmSpec,
  briefs: Readonly<Record<string, string>>,
  picked: readonly TemplateOffer[],
): Template {
  const out = structuredClone(spec) as unknown as Raw
  const params: TemplateParam[] = []
  for (const o of picked) {
    const keys = o.field.split('.')
    let at: unknown = out
    if (keys[0] === 'nodes') {
      at = (out.nodes as Raw[]).find(n => n.id === keys[1])
      keys.splice(0, 2)
    }
    for (const k of keys.slice(0, -1)) at = isObj(at) ? at[k] : undefined
    const last = keys[keys.length - 1]!
    if (!isObj(at) || typeof at[last] !== 'string') continue
    at[last] = `{${o.param}}`
    if (!params.some(q => q.name === o.param)) params.push({ name: o.param, type: 'string', default: o.value })
  }
  return { ...head, params, spec: out as unknown as SwarmSpec, briefs: { ...briefs } }
}
