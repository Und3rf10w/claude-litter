// Selection and delivery (16.5; COMMON decisions 25 and 26): which accepted
// rules reach each call, in compact form under the 8 KiB cap, and which
// versions a run used. Owner: phase 3, package AE; the design branch and
// rule.find's design answer are phase 4's, WP-BD.
//
// AD's loadRules says which files are in force; this file only picks among
// them, by workflow, role and path, and renders them. Nothing here writes.

import type { Ports } from '../ports'
import type { RecordReply } from '../records/core'
import type { LoadedRule, RuleDoc, RuleRef, RuleScope, SelectInput, SelectUnit, Selection } from '../records/rules'
import type { BarItem, RunJson, Workflow } from '../records/run'
import type { LiveSwarm, RunLink, SwarmNode } from '../swarm/types'
import { fail } from '../records/core'
import { emptySelection } from '../records/rules'
import { WORKFLOWS } from '../records/run'
import { runJsonPath } from '../layout'
import { readLedger } from '../ledgercore'
import { parseGates } from '../gates'
import { runGateFiles } from '../widen'
import { git } from '../worktrees'
import { loadRules } from './store'
import { couldMatchUnder, expandBraceSets, isPathless, matches, specificity } from './match'
import { rulesIntoBar, selectedRules } from '../design/bar'

// AD's store, through one table so tier 2 can stand in for it (COMMON, "Another package's module").
export const deps = {
  loadRules: (...a: Parameters<typeof loadRules>) => loadRules(...a),
}

/** Each call's `<rules>` block, counted in UTF-8 bytes (16.5). */
export const RULES_CAP = 8 * 1024

/** The roles an execute gate's `<rules>` calls use: write, adversary, critique (litter-prompts.md's tag table). */
const EXECUTE_ROLES = ['executor', 'gate-critic', 'adversary']

/**
 * A plan-template node's role (15.10; AC's generated spec names its nodes
 * so): its id. The gate-runner orchestrator has none, so a rule with
 * `roles` set never reaches it.
 */
const PLAN_ROLES: Readonly<Record<string, string>> = { executor: 'executor', critic: 'gate-critic', 'gate-critic': 'gate-critic', adversary: 'adversary' }

/** A design's roles (section 6): every call of the run gets the one `<rules>` block, args.rules. */
const DESIGN_ROLES = ['falsifier', 'coverage', 'mechanism', 'prober', 'reframer', 'author', 'design-critic']

/** The verifier's unit key: no task id can take it (lifecycle.ts's TASK_ID). */
const VERIFIER = '@verifier'
const PLANNER = '@planner'
const NODE = '@node'
const DESIGN = '@design'

/** Your run rules, as run.start renders them into args.rules (lifecycle.ts, renderRunRules). */
const RUN_RULE = 'For this run (stated by you): '

/** rule.find's design answer without your draft bar. */
const DESIGN_IDS_NOTE =
  "the ids in 'bar' are numbered from C1 and B1 here; run.start assigns them at launch, after your own items' ids. Pass 'bar', your draft bar, to see them numbered as run.start will"

const bytes = (s: string): number => new TextEncoder().encode(s).length
/** A block's size: each entry and the newline that joins it. */
const size = (entries: readonly string[]): number => entries.reduce((n, e) => n + bytes(e) + 1, 0)
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const more = (n: number): string => (n === 1 ? 'and 1 more accepted rule; rule.find lists it' : `and ${n} more accepted rules; rule.find lists them`)

// ---------------------------------------------------------------------------
// What's in force

/**
 * A rule in force, as selection uses it. `overrides`: the user rule a local
 * one replaces here (16.6). `shared`: every unit gets it, as a rule without
 * paths or a ban.
 */
type Rule = { doc: RuleDoc; scope: RuleScope; overrides: string | null; shared: boolean }

/**
 * The version in force of each loaded file (16.4): `delivered`, which AD sets
 * for an accepted or committed file, and to HEAD's version for an edited
 * committed one. A local rule naming one of your user rules in `overrides`
 * replaces it in this repository, and shows the override on its entry. A
 * ban is shared whatever its paths (16.5): they say what must not change,
 * not where the work is, and a gate at risk of changing them seldom lists
 * them in its Files.
 */
function inForce(loaded: readonly LoadedRule[]): Rule[] {
  const kept = loaded.filter(r => r.delivered !== null && r.delivered.status === 'accepted')
  const users = new Set(kept.filter(r => r.scope === 'user').map(r => r.delivered!.id))
  const replaced = new Set<string>()
  const rules = kept.map(r => {
    const doc = r.delivered!
    const overrides = r.scope === 'local' && typeof doc.overrides === 'string' && users.has(doc.overrides) ? doc.overrides : null
    if (overrides) replaced.add(overrides)
    return { doc, scope: r.scope, overrides, shared: doc.type === 'ban' || isPathless(doc.applies.paths) }
  })
  return rules.filter(r => !(r.scope === 'user' && replaced.has(r.doc.id)))
}

/** `workflows` and `roles` narrow a rule when set (16.2); an empty list narrows nothing. */
function fits(doc: RuleDoc, workflows: readonly string[], roles: readonly string[]): boolean {
  const w = doc.applies.workflows ?? []
  const r = doc.applies.roles ?? []
  return (w.length === 0 || w.some(x => workflows.includes(x))) && (r.length === 0 || r.some(x => roles.includes(x)))
}

// ---------------------------------------------------------------------------
// Which rules a unit's paths bring

/** One path a unit names, repository-relative. `under`: a folder or a glob, which gets every rule that could match under it (decision 25). */
type Entry = { path: string; under: boolean }

const GLOB = /[*?[]/

/**
 * A unit's files as entries, relative to `top` (the checkout they're under):
 * brace sets expanded, `./` and a leading `/` dropped, an absolute path under
 * `top` made relative. A path outside the repository is no entry. A folder
 * is one with a trailing `/`, or one `top` has.
 */
async function entriesOf(p: Ports, top: string, files: readonly string[]): Promise<Entry[]> {
  const out: Entry[] = []
  for (const file of files) {
    let alts: string[]
    try {
      alts = expandBraceSets(file)
    } catch {
      alts = [file.normalize('NFC')]
    }
    for (const alt of alts) {
      let x = alt.trim()
      if (x.startsWith(`${top}/`)) x = x.slice(top.length + 1)
      x = x.replace(/^(\.\/)+/, '').replace(/^\/+/, '')
      if (x === '' || x.split('/').includes('..')) continue
      const under = x.endsWith('/') || GLOB.test(x) || (await isDir(p, `${top}/${x}`))
      out.push({ path: x, under })
    }
  }
  return out
}

async function isDir(p: Ports, path: string): Promise<boolean> {
  try {
    return (await p.fs.stat(path)).kind === 'dir'
  } catch {
    return false
  }
}

/** The most specific of the rule's patterns that applies to one of `entries`, or null when none does. */
function hit(rule: Rule, entries: readonly Entry[]): number | null {
  let best: number | null = null
  for (const pattern of rule.doc.applies.paths) {
    if (entries.some(e => (e.under ? couldMatchUnder(pattern, e.path) : matches(pattern, e.path)))) {
      best = Math.max(best ?? 0, specificity(pattern))
    }
  }
  return best
}

const topSpecificity = (rule: Rule): number => Math.max(0, ...rule.doc.applies.paths.map(specificity))

// ---------------------------------------------------------------------------
// Rendering and the cap

/**
 * `<id>@<v>`, a local override, the type and the situation (16.5's compact
 * form). A ban with paths reaches units that don't touch them, so its type
 * names them: `(ban; protects vendor/**)`.
 */
function label(r: Rule): string {
  const when = oneLine(r.doc.applies.when ?? '')
  const paths = r.doc.applies.paths
  const type = r.doc.type === 'ban' && !isPathless(paths) ? `ban; protects ${paths.map(oneLine).join(', ')}` : r.doc.type
  return `${r.doc.id}@${r.doc.version}${r.overrides ? ` (overrides ${r.overrides})` : ''} (${type})${when ? ` ${when}` : ''}`
}

/** `<id>@<v> (<type>) <when>: <rule>`, then `Exceptions: …` and `How to check: …` when it has them. */
function renderFull(r: Rule): string {
  const lines = [`${label(r)}: ${oneLine(r.doc.body.rule)}`]
  const exceptions = r.doc.body.exceptions.map(oneLine).filter(x => x !== '')
  const checks = r.doc.body.howToCheck.map(oneLine).filter(x => x !== '')
  if (exceptions.length > 0) lines.push(`  Exceptions: ${exceptions.join('; ')}`)
  if (checks.length > 0) lines.push(`  How to check: ${checks.join('; ')}`)
  return lines.join('\n')
}

/** One line in place of the rule, past the cap: `<id>@<v> (<type>) <when>; full text: rule.find with id <id>`. */
function renderPointer(r: Rule): string {
  return `${label(r)}; full text: rule.find with id ${r.doc.id}`
}

/** A rule a block may hold, with both its forms; `pointer` is the full text when that's shorter. */
type Cand = { key: string; rule: Rule; spec: number; full: string; pointer: string }
type Form = 'full' | 'pointer' | 'dropped'

function cand(rule: Rule, spec: number): Cand {
  const full = renderFull(rule)
  const pointer = renderPointer(rule)
  return { key: `${rule.scope}:${rule.doc.id}`, rule, spec, full, pointer: bytes(pointer) < bytes(full) ? pointer : full }
}

/** The fill order (16.5): most specific first, then by id. */
const ordered = (cands: readonly Cand[]): Cand[] =>
  [...cands].sort((a, b) => b.spec - a.spec || (a.rule.doc.id < b.rule.doc.id ? -1 : a.rule.doc.id > b.rule.doc.id ? 1 : a.key < b.key ? -1 : 1))

/**
 * One block's forms within `avail` bytes, `cands` in fill order. Every rule
 * gets at least its pointer when the pointers fit; then full entries, in
 * order, while the rest still fit as pointers, and pointers after the first
 * that doesn't. `forced` ones stay pointers (decision 26). When even the
 * pointers don't fit, pointers in order while they do, then a line counting
 * the rest.
 */
function fill(avail: number, cands: readonly Cand[], forced: ReadonlySet<string>): Map<string, Form> {
  const forms = new Map<string, Form>()
  const pointers = cands.reduce((n, c) => n + bytes(c.pointer) + 1, 0)
  if (pointers <= avail) {
    let slack = avail - pointers
    let open = true
    for (const c of cands) {
      const extra = bytes(c.full) - bytes(c.pointer)
      if (open && !forced.has(c.key) && extra <= slack) {
        forms.set(c.key, 'full')
        slack -= extra
      } else {
        forms.set(c.key, 'pointer')
        if (!forced.has(c.key)) open = false
      }
    }
    return forms
  }
  let room = avail - (bytes(more(cands.length)) + 1)
  let open = true
  for (const c of cands) {
    const n = bytes(c.pointer) + 1
    if (open && n <= room) {
      forms.set(c.key, 'pointer')
      room -= n
    } else {
      forms.set(c.key, 'dropped')
      open = false
    }
  }
  return forms
}

function rendered(cands: readonly Cand[], forms: Map<string, Form>): string[] {
  const out: string[] = []
  let dropped = 0
  for (const c of cands) {
    const f = forms.get(c.key)
    if (f === 'full') out.push(c.full)
    else if (f === 'pointer') out.push(c.pointer)
    else dropped++
  }
  if (dropped > 0) out.push(more(dropped))
  return out
}

type Unit = { key: string; own: Cand[] }
type Capped = { run: string[]; own: Record<string, string[]>; versions: RuleRef[] }

/**
 * The cap over every call's block (16.5; decision 26). Each block is your
 * run rules (always in full, first), then the shared rules, then the unit's
 * own. The shared rules are one list for every unit, so a shared rule any
 * unit's block needed as a pointer is a pointer in all of them. Then each
 * unit fills what's left after the shared list.
 */
function capAll(runRules: readonly string[], shared: readonly Cand[], units: readonly Unit[]): Capped {
  const avail = RULES_CAP - size(runRules)
  const s = ordered(shared)
  const forced = new Set<string>()
  const each = units.length > 0 ? units : [{ key: '', own: [] }]
  for (let again = true; again; ) {
    again = false
    for (const u of each) {
      const forms = fill(avail, ordered([...s, ...u.own]), forced)
      for (const c of s) {
        if (forms.get(c.key) !== 'full' && !forced.has(c.key)) {
          forced.add(c.key)
          again = true
        }
      }
    }
  }
  const sharedForms = fill(avail, s, forced)
  const run = rendered(s, sharedForms)
  const left = avail - size(run)
  const delivered: Cand[] = s.filter(c => sharedForms.get(c.key) !== 'dropped')
  const own: Record<string, string[]> = {}
  for (const u of units) {
    const o = ordered(u.own)
    const forms = fill(left, o, new Set())
    own[u.key] = rendered(o, forms)
    delivered.push(...o.filter(c => forms.get(c.key) !== 'dropped'))
  }
  const versions: RuleRef[] = []
  const seen = new Set<string>()
  for (const c of delivered) {
    const at = `${c.rule.doc.id}@${c.rule.doc.version}`
    if (seen.has(at)) continue
    seen.add(at)
    versions.push({ id: c.rule.doc.id, version: c.rule.doc.version })
  }
  return { run, own, versions }
}

/** The path-matched rules among `rules` for one unit's entries, each at its specificity there; a shared one is never a unit's own. */
function ownOf(rules: readonly Rule[], entries: readonly Entry[]): Cand[] {
  const out: Cand[] = []
  for (const r of rules) {
    if (r.shared) continue
    const spec = hit(r, entries)
    if (spec !== null) out.push(cand(r, spec))
  }
  return out
}

// ---------------------------------------------------------------------------
// run.start

/**
 * The rules for a launch, from run.start's prepare (lifecycle.ts) before it
 * writes anything: each entry rendered, per unit, with every version
 * delivered. A throw refuses the launch.
 */
export async function selectForRun(p: Ports, input: SelectInput): Promise<Selection> {
  const { rules } = await deps.loadRules(p, input.litterDir)
  return select(p, input, rules)
}

async function select(p: Ports, input: SelectInput, loaded: readonly LoadedRule[]): Promise<Selection> {
  const sel = emptySelection()
  const rules = inForce(loaded)
  const top = input.checkout

  if (input.workflow === 'design') {
    // design (16.5): every rule without paths and every ban, plus those for the run's anchors and the
    // files the goal names, in one block every call shares. run.start puts them into the bar too (design/bar.ts).
    const fitting = rules.filter(r => fits(r.doc, ['design'], DESIGN_ROLES))
    const entries = await entriesOf(p, top, [...anchorPaths(top, input.anchors), ...(await namedPaths(p, top, null, input.goal))])
    const capped = capAll(input.runRules, fitting.filter(r => r.shared).map(r => cand(r, 0)), [{ key: DESIGN, own: ownOf(fitting, entries) }])
    sel.run = [...capped.run, ...(capped.own[DESIGN] ?? [])]
    sel.versions = capped.versions
    return sel
  }

  if (input.workflow === 'execute') {
    const fitting = rules.filter(r => fits(r.doc, ['execute'], EXECUTE_ROLES))
    const units: Unit[] = []
    for (const g of input.gates) units.push({ key: g.id, own: ownOf(fitting, await entriesOf(p, top, g.files)) })
    const capped = capAll(input.runRules, fitting.filter(r => r.shared).map(r => cand(r, 0)), units)
    sel.run = capped.run
    for (const g of input.gates) sel.gates[g.id] = capped.own[g.id] ?? []
    sel.versions = capped.versions
    return sel
  }

  if (input.workflow === 'fanout') {
    // A task with owned files writes (an executor); one without researches. The verifier judges them all.
    const roleOf = (t: SelectUnit) => (t.files.length > 0 ? 'executor' : 'researcher')
    const roles = [...new Set([...input.tasks.map(roleOf), 'verifier'])]
    const units: Unit[] = []
    const all: Entry[] = []
    for (const t of input.tasks) {
      const entries = await entriesOf(p, top, t.files)
      all.push(...entries)
      units.push({ key: t.id, own: ownOf(rules.filter(r => fits(r.doc, ['fanout'], [roleOf(t)])), entries) })
    }
    units.push({ key: VERIFIER, own: ownOf(rules.filter(r => fits(r.doc, ['fanout'], ['verifier'])), all) })
    const shared = rules.filter(r => r.shared && fits(r.doc, ['fanout'], roles)).map(r => cand(r, 0))
    const capped = capAll(input.runRules, shared, units)
    sel.run = capped.run
    for (const t of input.tasks) sel.tasks[t.id] = capped.own[t.id] ?? []
    sel.verifier = capped.own[VERIFIER] ?? []
    sel.versions = capped.versions
    return sel
  }

  // plan: the planner's own block, every rule without paths and every ban, plus those for the paths the plan or goal names.
  const fitting = rules.filter(r => fits(r.doc, ['plan'], ['planner']))
  const entries = await entriesOf(p, top, await namedPaths(p, top, input.planText, input.goal))
  const capped = capAll(input.runRules, fitting.filter(r => r.shared).map(r => cand(r, 0)), [{ key: PLANNER, own: ownOf(fitting, entries) }])
  sel.planner = [...capped.run, ...(capped.own[PLANNER] ?? [])]
  sel.versions = capped.versions
  return sel
}

/** Past this many, the named paths aren't checked further: a plan names a few dozen, not thousands. */
const NAMED_MAX = 500

/**
 * The repository paths a plan or goal names (16.5, the planner): each
 * `[label](path)` link, each backticked path, and each gate's Files, that
 * exists in the checkout. A `#anchor` and a `:line` suffix are dropped.
 */
async function namedPaths(p: Ports, top: string, planText: string | null, goal: string | null): Promise<string[]> {
  const named = new Set<string>()
  for (const text of [planText ?? '', goal ?? '']) {
    for (const m of text.matchAll(/\[[^\]\n]*\]\(<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\)/g)) named.add(m[1]!)
    for (const m of text.matchAll(/`([^`\n]+)`/g)) named.add(m[1]!)
  }
  if (planText) {
    const parsed = parseGates(planText)
    if (parsed.ok) for (const g of parsed.gates) for (const f of g.files) named.add(f)
  }
  const out: string[] = []
  for (const raw of [...named].slice(0, NAMED_MAX)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !raw.startsWith(`${top}/`)) continue // a URL, or `C:`
    let x = raw.trim().replace(/#.*$/, '').replace(/:\d+(?:[-:]\d+)?$/, '')
    if (x.startsWith(`${top}/`)) x = x.slice(top.length + 1)
    x = x.replace(/^(\.\/)+/, '')
    if (x === '' || x.startsWith('/') || x.split('/').includes('..') || /\s/.test(x)) continue
    if (await p.fs.exists(`${top}/${x.replace(/\/+$/, '')}`).catch(() => false)) out.push(x)
  }
  return out
}

/**
 * A design's anchors as paths (16.5's design line): each anchor, and each
 * link or backticked path in it, with a `#anchor` or `:line` suffix dropped.
 * Unlike the goal's, they needn't exist: you named them as where the problem
 * is, and a folder or glob among them gets every rule that could match under
 * it, as a gate's Files entry does. A URL, a phrase with spaces (a function's
 * description, an incident) and a path outside the checkout are no path.
 */
function anchorPaths(top: string, anchors: readonly string[]): string[] {
  const out = new Set<string>()
  for (const anchor of anchors) {
    const raws = [anchor.trim().replace(/^`([^`\n]+)`$/, '$1')]
    for (const m of anchor.matchAll(/\[[^\]\n]*\]\(<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\)/g)) raws.push(m[1]!)
    for (const m of anchor.matchAll(/`([^`\n]+)`/g)) raws.push(m[1]!)
    for (const raw of raws) {
      // The suffix first, so `a.ts:12` isn't read as a URL's scheme.
      const x = raw.trim().replace(/#.*$/, '').replace(/:\d+(?:[-:]\d+)?$/, '')
      if (/^[a-z][a-z0-9+.-]*:/i.test(x)) continue // a URL, or `C:`
      if (x === '' || /\s/.test(x) || (x.startsWith('/') && !x.startsWith(`${top}/`))) continue
      out.add(x)
    }
  }
  return [...out]
}

// ---------------------------------------------------------------------------
// A swarm spawn

/**
 * A swarm spawn's `<rules>` entries (swarm/spawn.ts, before the spawn's
 * reservation): the rules for the node's `paths` (or a plan-template node's
 * run's unlanded gates, or every rule) in `dir`, the node's working
 * directory, absolute.
 *
 * The workflow is `swarm`; a plan-template swarm's nodes (an execute run's
 * bridge, 15.10) also take `execute` rules and count as their role. A node's
 * `paths` are relative to its directory, so they're read from where that
 * directory sits in its repository; a directory that doesn't exist yet (an
 * `own` worktree, made after the reservation) is a worktree's top. A node
 * with neither gets every rule that could match under its directory: at the
 * top, every rule (decision 25). Every node gets the rules without paths and
 * every ban (16.5).
 */
export async function selectForSpawn(p: Ports, litterDir: string, input: { swarm: LiveSwarm; node: SwarmNode; dir: string }): Promise<string[]> {
  const { swarm, node, dir } = input
  const { rules: loaded } = await deps.loadRules(p, litterDir)
  const rules = inForce(loaded)
  const link = swarm.run ? await linkedExecute(p, swarm.run) : null
  const role = link ? PLAN_ROLES[node.id] : undefined
  const fitting = rules.filter(r => fits(r.doc, link ? ['swarm', 'execute'] : ['swarm'], role ? [role] : []))

  let entries: Entry[] | null
  if (node.paths && node.paths.length > 0) {
    const at = await whereIs(p, dir)
    entries = await entriesOf(p, at.top, node.paths.map(x => at.prefix + x.replace(/^(\.\/)+/, '')))
  } else if (link) {
    entries = await entriesOf(p, link.checkout, link.files)
  } else {
    const at = await whereIs(p, dir)
    entries = at.prefix === '' ? null : [{ path: at.prefix, under: true }]
  }
  const own =
    entries === null ? fitting.filter(r => !r.shared).map(r => cand(r, topSpecificity(r))) : ownOf(fitting, entries)
  const capped = capAll([], fitting.filter(r => r.shared).map(r => cand(r, 0)), [{ key: NODE, own }])
  return [...capped.run, ...(capped.own[NODE] ?? [])]
}

/** Where `dir` sits: its checkout's top and its path under it (`plugins/x/`, or '' at the top). */
async function whereIs(p: Ports, dir: string): Promise<{ top: string; prefix: string }> {
  if (!(await p.fs.exists(dir).catch(() => false))) return { top: dir, prefix: '' }
  const r = await git(p, dir, ['rev-parse', '--show-toplevel', '--show-prefix'])
  const [top, prefix = ''] = r.stdout.split('\n')
  return r.code === 0 && top ? { top, prefix: prefix.trim() } : { top: dir, prefix: '' }
}

/**
 * For a swarm whose run is an execute run (the bridge's plan template): the
 * Files of the run's gates with no land, with your widenings during the run,
 * and the run's checkout. Null for
 * any other run. Records past a broken chain don't count, so a gate landed
 * there still brings its rules.
 */
async function linkedExecute(p: Ports, link: RunLink): Promise<{ files: string[]; checkout: string } | null> {
  const json = JSON.parse(await p.fs.read(runJsonPath(link.runDir))) as RunJson
  if (json.workflow !== 'execute') return null
  const gates = Array.isArray(json.args?.gates) ? (json.args.gates as { id?: unknown; files?: unknown }[]) : []
  const ledger = await readLedger(p, link.runDir, link.run)
  const before = ledger.records.filter(r => ledger.tampered === null || r.seq < ledger.tampered.seq)
  const landed = new Set(before.filter(r => r.kind === 'land').map(r => r.body.gate))
  // With the files you added during the run (gate.widen, WP-AO), so a node spawned after it gets their rules.
  const files = gates
    .filter(g => typeof g.id === 'string' && !landed.has(g.id))
    .flatMap(g => runGateFiles(json, before, g.id as string))
  return { files, checkout: json.checkout }
}

// ---------------------------------------------------------------------------
// rule.find { applicable }

/**
 * `rule.find { applicable: { workflow, planPath | tasks | anchors, goal } }`
 * (records.ts, AD's, through its deps): exactly what selectForRun would give
 * for that launch, as `{ ok: true, run, gates | tasks, versions, problems }`.
 * Writes nothing. `applicable` is the call's field as given, unchecked.
 *
 * A design's answer is `{ ok: true, workflow, run, bar, versions, problems }`:
 * `bar` is the items run.start would add to the bar (design/bar.ts), numbered
 * on from the highest C and B of `applicable.bar` (your draft bar, as
 * run.start takes it) as run.start would number them. Without it they're
 * numbered from C1 and B1, and `note` says the ids are assigned at launch.
 */
export async function findApplicable(p: Ports, litterDir: string, applicable: Record<string, unknown>): Promise<RecordReply> {
  const a = applicable ?? {}
  const workflow = a.workflow
  if (typeof workflow !== 'string' || !(WORKFLOWS as readonly string[]).includes(workflow)) {
    return fail("litter: 'applicable.workflow' is the launch's workflow: execute, fanout, plan or design", 'applicable', WORKFLOWS)
  }
  const runRules = strings(a.runRules)
  if (runRules === null) return fail("litter: 'applicable.runRules' is your run rules as a list of strings, as run.start takes them", 'applicable')
  const goal = typeof a.goal === 'string' && a.goal.trim() !== '' ? a.goal : null
  const anchors = workflow === 'design' ? strings(a.anchors) : []
  if (anchors === null) return fail("litter: 'applicable.anchors' is the design's anchors as a list of strings, as run.start takes them", 'applicable')
  const mine = workflow === 'design' ? barIds(a.bar) : []
  if (mine === null) return fail("litter: 'applicable.bar' is your bar as run.start takes it, a list of { id, text, evidence, reason? }, so the rules' items number on from your ids", 'applicable')
  try {
    const checkout = await checkoutOf(p, litterDir)
    let gates: SelectUnit[] = []
    let tasks: SelectUnit[] = []
    let planText: string | null = null
    if (workflow === 'execute' || (workflow === 'plan' && a.planPath !== undefined)) {
      if (typeof a.planPath !== 'string' || a.planPath.trim() === '') {
        return fail(`litter: rule.find { applicable } for ${workflow} needs 'planPath', the plan the launch would read, absolute or relative to the checkout`, 'applicable')
      }
      const path = a.planPath.startsWith('/') ? a.planPath : `${checkout}/${a.planPath.replace(/^\.\//, '')}`
      try {
        planText = await p.fs.read(path)
      } catch (err) {
        return fail(`litter: can't read the plan '${a.planPath}' (${errText(err)}); pass its path, absolute or relative to the checkout`, 'applicable')
      }
      if (workflow === 'execute') {
        const parsed = parseGates(planText)
        if (!parsed.ok) return fail(`litter: ${parsed.error}`, 'applicable')
        if (parsed.gates.length === 0) return fail("litter: the plan has no gate sections ('### G<n>: <title>'), so run.start would refuse it", 'applicable')
        gates = parsed.gates.map(g => ({ id: g.id, files: [...g.files] }))
      }
    }
    if (workflow === 'fanout') {
      const t = tasksOf(a.tasks)
      if (typeof t === 'string') return fail(t, 'applicable')
      tasks = t
    }
    const { rules, problems } = await deps.loadRules(p, litterDir)
    const input: SelectInput = {
      litterDir,
      workflow: workflow as Workflow,
      gates,
      tasks,
      planText,
      goal,
      anchors,
      checkout,
      runRules: runRules.map(r => `${RUN_RULE}${r}`),
    }
    const sel = await select(p, input, rules)
    if (workflow === 'design') {
      // The same load the selection read, so every version it delivered is there.
      const picked = selectedRules(rules, sel.versions)
      if ('changed' in picked) throw new Error(`rule ${picked.changed.id}@${picked.changed.version} was selected but isn't loaded`)
      const bar = rulesIntoBar(mine, picked.rules).slice(mine.length)
      return { ok: true, workflow, run: sel.run, bar, versions: sel.versions, problems, ...(a.bar === undefined || a.bar === null ? { note: DESIGN_IDS_NOTE } : {}) }
    }
    const units =
      workflow === 'execute' ? { run: sel.run, gates: sel.gates } : workflow === 'fanout' ? { run: sel.run, tasks: sel.tasks, verifier: sel.verifier } : { planner: sel.planner }
    return { ok: true, workflow, ...units, versions: sel.versions, problems }
  } catch (err) {
    return fail(`litter: the accepted rules couldn't be selected (${errText(err)}); /litter-rules shows them and their problems`)
  }
}

const strings = (v: unknown): string[] | null =>
  v === undefined || v === null ? [] : Array.isArray(v) && v.every(x => typeof x === 'string') ? v.map(x => x.trim()).filter(x => x !== '') : null

/**
 * Your bar's items, as far as the rules' numbering needs them: their ids
 * (run.start checks the rest). Null for anything but a list.
 */
function barIds(v: unknown): BarItem[] | null {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) return null
  return v.flatMap(b => (typeof b === 'object' && b !== null && typeof (b as BarItem).id === 'string' ? [{ id: (b as BarItem).id, text: '', evidence: '' }] : []))
}

/** A fanout's tasks as run.start reads their files: a task that doesn't write owns none. */
function tasksOf(v: unknown): SelectUnit[] | string {
  const usage = "litter: rule.find { applicable } for fanout needs 'tasks', each { id, files, writes? } as run.start takes them"
  if (!Array.isArray(v) || v.length === 0) return usage
  const out: SelectUnit[] = []
  for (const t of v as Record<string, unknown>[]) {
    if (typeof t !== 'object' || t === null || typeof t.id !== 'string' || t.id === '') return usage
    const files = strings(t.files)
    if (files === null) return usage
    const writes = typeof t.writes === 'boolean' ? t.writes : files.length > 0
    out.push({ id: t.id, files: writes ? files : [] })
  }
  return out
}

/** The checkout a launch from this session checks in: the session directory's top (lifecycle.ts, sessionCheckout), else the primary. */
async function checkoutOf(p: Ports, litterDir: string): Promise<string> {
  const cwd = await p.cwd()
  const top = await p.run(['git', 'rev-parse', '--show-toplevel'], { cwd })
  if (top.code === 0 && top.stdout.trim() !== '') return top.stdout.trim()
  const suffix = '/.claude/litter'
  return litterDir.endsWith(suffix) ? litterDir.slice(0, -suffix.length) : cwd
}
