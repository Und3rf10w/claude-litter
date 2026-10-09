// plan.write, gate.amend and gate.widen (COMMON steps 2 and 3; WP-AO): the
// planner's gates rendered into plan.md in section 10's format, a re-split of
// a halted chain's plan, an amended gate, and files you added to a gate's
// Files. Every rewrite keeps the previous file as
// plan.<n>.md, and is refused unless parseGates reads the new text back to the
// same gates. Owner: phase 3, package AB.
//
// The plan text written here is the mod's: a planner's or an amend's gate
// reaches plan.md only through renderGateSection or as one section parseGates
// reads back exactly, so nothing a model wrote can add, drop or reshape
// another gate (plan section 10, "Gate sections in plan.md are a contract").

import type { RecordCtx, RecordError, RecordHandler } from './records/core'
import type { GateWidenBody, PlannedGate } from './records/execute'
import type { RunJson } from './records/run'
import type { Ports } from './ports'
import type { Gate } from './gates'
import { fail } from './records/core'
import { needText, store } from './records/design'
import { parseGates } from './gates'
import { planPath, runDir as runDirOf, runJsonPath, RUN_ID } from './layout'
import { readJson, serial } from './fsx'
import { chainLanded, gitAt, repoOf, resolveChain } from './lifecycle'
import { writePlanVersion } from './planversion'
import { applyWidening, askWiden, dateOf, parseWidening } from './widen'

const GATE_ID = /^G[0-9]+$/
const FENCE = /^[ \t]{0,3}(```|~~~)/
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Prose on one line: each line break, with the blanks around it, as one
 * space. Blanks inside a line stay as written, so a literal a gate quotes
 * ('      -¤7.50') reaches the plan unchanged (design.sh basic, 2026-10-04:
 * collapsing them made the critic hold the same literal three rounds).
 */
const oneLine = (s: string): string => s.replace(/[ \t]*(?:\r\n?|[\n\v\f\p{Zl}\p{Zp}])[ \t]*/gu, ' ').trim()
/** A Files or Checks entry as the gate format reads it: trimmed, and one surrounding pair of backticks dropped (gates.ts). */
const entry = (s: string): string => s.trim().replace(/^`(.*)`$/, '$1').trim()

// ---------------------------------------------------------------------------
// The renderer

/** What a gate must read back as: section 10's fields, as parseGates gives them. */
type Expected = { id: string; files: string[]; checks: string; doneWhen: string; adversary: boolean; rollback: string | null }

const expectedOf = (g: Gate): Expected => ({ id: g.id, files: g.files, checks: g.checks, doneWhen: g.doneWhen, adversary: g.adversary, rollback: g.rollback })

/** The first difference between what a gate parsed as and what it should be, or null. */
function differs(got: Gate, want: Expected): string | null {
  if (got.id !== want.id) return `it reads as gate ${got.id}`
  if (got.files.length !== want.files.length || got.files.some((f, i) => f !== want.files[i])) return `its Files read as ${JSON.stringify(got.files)}`
  if (got.checks !== want.checks) return `its Checks read as ${JSON.stringify(got.checks)}`
  if (got.doneWhen !== want.doneWhen) return `its Done when reads as ${JSON.stringify(got.doneWhen)}`
  if (got.adversary !== want.adversary) return `its Adversary reads as ${got.adversary ? 'yes' : 'no'}`
  if (got.rollback !== want.rollback) return `its Rollback reads as ${JSON.stringify(got.rollback)}`
  return null
}

/** Whether a code fence the text opens is still open at its end, as parseGates tracks fences. */
function fenceLeftOpen(text: string): boolean {
  let fence: string | null = null
  for (const line of text.split('\n')) {
    const f = FENCE.exec(line)
    if (!f) continue
    if (fence === null) fence = f[1]!
    else if (fence === f[1]) fence = null
  }
  return fence !== null
}

/**
 * One gate's section in section 10's format: the heading, the Files, Checks
 * and Done when lines (and `Adversary: yes`, then `Rollback: <rollback>` when
 * the gate has one: a design author's, decision 6), then the scope as prose,
 * ending with `Plan lines: <lines>` when it cites any. The one renderer;
 * phase 4's proposals reuse it. A gate without `rollback` (the planner's)
 * renders as it did before phase 4.
 *
 * Throws, naming the gate and the field, when the gate can't be written in
 * the format: a missing field, a Files or Checks entry with a line break, a
 * scope that opens a code fence it doesn't close, or a section that parseGates
 * doesn't read back as exactly this gate (a scope line that is a heading ends
 * the section early). The title, Done when and Rollback are prose, so their
 * line breaks become spaces.
 */
export function renderGateSection(g: PlannedGate): string {
  const id = typeof g.id === 'string' ? g.id : String(g.id)
  const bad = (field: string, why: string) => new Error(`gate ${id}: '${field}' ${why}`)
  if (!GATE_ID.test(id)) throw bad('id', 'must be a gate id like G1')
  const title = typeof g.title === 'string' ? oneLine(g.title) : ''
  if (title === '') throw bad('title', 'is required')
  const list = (field: 'files' | 'checks', what: string): string[] => {
    const raw = g[field]
    if (!Array.isArray(raw) || raw.length === 0) throw bad(field, `needs at least one ${what}`)
    return raw.map((v, i) => {
      if (typeof v !== 'string') throw bad(`${field}[${i}]`, `must be a ${what}, as text`)
      if (/[\r\n]/.test(v)) throw bad(`${field}[${i}]`, `holds a line break; give each ${what} on one line`)
      const e = entry(v)
      if (e === '') throw bad(`${field}[${i}]`, `is empty; give a ${what}`)
      return e
    })
  }
  const files = list('files', 'path')
  const checks = list('checks', 'check')
  const doneWhen = typeof g.done_when === 'string' ? oneLine(g.done_when) : ''
  if (doneWhen === '') throw bad('done_when', 'is required: what must hold when the gate is done')
  const adversary = g.adversary === true
  // Unset for the planner's gates, so their sections don't change.
  let rollback: string | null = null
  if (g.rollback !== undefined) {
    if (typeof g.rollback !== 'string') throw bad('rollback', 'must be text: how to undo the gate')
    rollback = oneLine(g.rollback)
    if (rollback === '') throw bad('rollback', 'is empty; say how to undo the gate')
  }

  const lines = [`### ${id}: ${title}`]
  // A path with a comma can't go on the comma-separated line, so the list form holds it.
  if (files.some(f => f.includes(','))) lines.push('Files:', ...files.map(f => `- ${f}`))
  else lines.push(`Files: ${files.join(', ')}`)
  if (checks.length === 1) lines.push(`Checks: ${checks[0]}`)
  else lines.push('Checks:', ...checks.map(c => `- ${c}`))
  lines.push(`Done when: ${doneWhen}`)
  if (adversary) lines.push('Adversary: yes')
  if (rollback !== null) lines.push(`Rollback: ${rollback}`)
  const scope = (typeof g.scope === 'string' ? g.scope : '').replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd()
  const cites = typeof g.lines === 'string' ? oneLine(g.lines) : ''
  const prose = [scope, cites ? `Plan lines: ${cites}` : ''].filter(x => x !== '')
  if (prose.length > 0) lines.push('', prose.join('\n\n'))
  const text = `${lines.join('\n')}\n`

  if (fenceLeftOpen(text)) throw bad('scope', 'opens a code fence it never closes, which would hide every gate after it; close the fence')
  const back = parseGates(text)
  if (!back.ok) throw bad(back.field ?? 'scope', `doesn't read back: ${back.error}`)
  if (back.gates.length !== 1) {
    throw bad('scope', `holds another gate's heading (${back.gates.map(x => x.id).join(', ')}); reword that line so it isn't a '### G<n>:' heading`)
  }
  const why = differs(back.gates[0]!, { id, files, checks: checks.join('\n'), doneWhen, adversary, rollback })
  if (why) throw bad('scope', `doesn't read back as this gate: ${why}`)
  if (back.gates[0]!.excerpt !== text.slice(0, -1)) {
    throw bad('scope', 'holds a heading that ends the section early; make it a level-4 heading or plain text')
  }
  return text
}

/** A planner gate as plan.write takes it, before it renders: the fields its schema requires, with the optional ones filled in. */
function plannedGate(v: Record<string, unknown>): PlannedGate {
  return {
    id: String(v.id),
    title: typeof v.title === 'string' ? v.title : '',
    scope: typeof v.scope === 'string' ? v.scope : '',
    lines: typeof v.lines === 'string' ? v.lines : '',
    files: v.files as string[],
    done_when: typeof v.done_when === 'string' ? v.done_when : '',
    checks: v.checks as string[],
    adversary: v.adversary === true,
  }
}

/** What a rendered gate must read back as. */
const expectedFrom = (text: string): Expected => expectedOf((parseGates(text) as { ok: true; gates: Gate[] }).gates[0]!)

/**
 * Why `text` doesn't read back as `want`, in order, or null when it does
 * (COMMON step 2: every rewrite of a plan.md is refused unless it does).
 */
function readsBack(text: string, want: Expected[]): { gate: string | null; why: string } | null {
  const back = parseGates(text)
  if (!back.ok) return { gate: back.gate, why: back.error }
  const ids = back.gates.map(g => g.id)
  const wanted = want.map(g => g.id)
  if (ids.join(',') !== wanted.join(',')) {
    const missing = wanted.find(id => !ids.includes(id))
    return { gate: missing ?? ids.find(id => !wanted.includes(id)) ?? null, why: `the plan reads back with gates ${ids.join(', ') || 'none'}, not ${wanted.join(', ')}` }
  }
  for (let i = 0; i < want.length; i++) {
    const why = differs(back.gates[i]!, want[i]!)
    if (why) return { gate: want[i]!.id, why }
  }
  return null
}

// ---------------------------------------------------------------------------
// Plan versions: planversion.ts's writer, which run.start's widenings use too (WP-AO).

export { writePlanVersion }

// ---------------------------------------------------------------------------
// The handlers

type Chain = { rootRun: string; rootDir: string; landed: Map<string, string> }

/** The chain `run` belongs to, its root's folder, and the gates landed anywhere in it (records or trailers). */
async function chainOf(ctx: RecordCtx, run: string, field: string): Promise<Chain | RecordError> {
  const litterDir = ctx.litterDir!
  const chain = await resolveChain(ctx.p, litterDir, run)
  if (!chain.ok) return { ...chain, field }
  if (chain.root.json.workflow !== 'execute') {
    return fail(`litter: run ${run}'s chain starts at a ${chain.root.json.workflow} run, ${chain.root.run}; name an execute run`, field)
  }
  const { landed } = await chainLanded(gitAt(ctx.p, repoOf(litterDir)), chain.root, chain.members)
  return { rootRun: chain.root.run, rootDir: runDirOf(litterDir, chain.root.run), landed }
}

/** The plan.md text of a run folder, or the error naming `field`. */
async function readPlanText(p: Ports, dir: string, run: string, field: string): Promise<string | RecordError> {
  try {
    return await p.fs.read(planPath(dir))
  } catch (err) {
    return fail(`litter: run ${run} has no readable plan.md (${errText(err)})`, field)
  }
}

/** The lines of a text, without the empty string a trailing newline leaves. */
function linesOf(text: string): string[] {
  const out = text.split('\n')
  if (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}

/** The planner gates of a plan.write, checked one by one before anything renders. */
function checkGates(gates: unknown): PlannedGate[] | RecordError {
  if (!Array.isArray(gates) || gates.length === 0) return fail("litter: 'gates' is required: the approved gates, in order", 'gates')
  // The ids and titles first, across every gate, as before phase 3; then each gate's other fields.
  const seen = new Set<string>()
  for (let i = 0; i < gates.length; i++) {
    const g = gates[i] as Record<string, unknown> | null
    if (!g || typeof g !== 'object' || typeof g.id !== 'string' || !GATE_ID.test(g.id)) {
      return fail(`litter: 'gates[${i}].id' must be a gate id like G1`, `gates[${i}].id`)
    }
    if (seen.has(g.id)) return fail(`litter: gate id ${g.id} appears twice in 'gates'`, `gates[${i}].id`)
    seen.add(g.id)
    if (typeof g.title !== 'string' || g.title.trim() === '') return fail(`litter: 'gates[${i}].title' is required`, `gates[${i}].title`)
  }
  const out: PlannedGate[] = []
  for (let i = 0; i < gates.length; i++) {
    const g = gates[i] as Record<string, unknown> & { id: string }
    for (const field of ['files', 'checks'] as const) {
      const v = g[field]
      if (!Array.isArray(v) || v.length === 0 || !v.every(x => typeof x === 'string')) {
        return fail(`litter: 'gates[${i}].${field}' (gate ${g.id}) must be a list of ${field === 'files' ? 'paths' : 'checks'}, at least one`, `gates[${i}].${field}`)
      }
    }
    if (typeof g.done_when !== 'string' || g.done_when.trim() === '') {
      return fail(`litter: 'gates[${i}].done_when' (gate ${g.id}) is required: what must hold when the gate is done`, `gates[${i}].done_when`)
    }
    for (const field of ['scope', 'lines'] as const) {
      if (g[field] !== undefined && typeof g[field] !== 'string') return fail(`litter: 'gates[${i}].${field}' (gate ${g.id}) must be text`, `gates[${i}].${field}`)
    }
    if (g.adversary !== undefined && typeof g.adversary !== 'boolean') {
      return fail(`litter: 'gates[${i}].adversary' (gate ${g.id}) must be true or false`, `gates[${i}].adversary`)
    }
    out.push(plannedGate(g))
  }
  return out
}

/** Each gate rendered, or the refusal naming the one that doesn't render. */
function renderAll(gates: PlannedGate[]): string[] | RecordError {
  const out: string[] = []
  for (let i = 0; i < gates.length; i++) {
    try {
      out.push(renderGateSection(gates[i]!))
    } catch (err) {
      return fail(`litter: gate ${gates[i]!.id} doesn't render in the plan's gate format: ${errText(err)}`, `gates[${i}]`)
    }
  }
  return out
}

const refusedReadBack = (r: { gate: string | null; why: string }, gates: PlannedGate[]): RecordError => {
  const i = r.gate === null ? -1 : gates.findIndex(g => g.id === r.gate)
  return fail(
    `litter: the new plan.md doesn't read back to the same gates${r.gate ? ` at gate ${r.gate}` : ''} (${r.why}); nothing was written`,
    i >= 0 ? `gates[${i}]` : 'gates',
  )
}

/**
 * `plan.write { run, gates, continueOf? }` (a PlanWriteInput): the approved
 * planner gates, for the plan run `run`.
 *  - Without `continueOf`: a short header, then every gate's section, as the
 *    plan run's plan.md; answers `{ ok: true, path }`.
 *  - With `continueOf` (a re-split): the chain root's plan.md, keeping the
 *    text before the first gate and every landed gate's section byte for
 *    byte, with the halted gate and every unlanded gate after it replaced by
 *    the new ones. A new gate can't take a landed gate's id.
 * Stored in the plan run's ledger, with the path written and the previous file.
 */
export const recordPlanWrite: RecordHandler = async (ctx, input) => {
  const gates = checkGates(input.gates)
  if (!Array.isArray(gates)) return gates
  const run = input.run as string
  const runDir = runDirOf(ctx.litterDir!, run)
  const json = await readJson<RunJson>(ctx.p, runJsonPath(runDir)).catch(() => undefined)
  if (json?.workflow !== 'plan') {
    return fail(`litter: plan.write writes a plan run's gates, and run ${run} is ${json ? `a ${json.workflow} run` : 'unreadable'}; name the plan run that proposed them`, 'run')
  }
  const continueOf = input.continueOf
  if (continueOf !== undefined && (typeof continueOf !== 'string' || !RUN_ID.test(continueOf))) {
    return fail("litter: 'continueOf' must be the execute run this re-split continues, <yyyymmdd>-<slug>", 'continueOf')
  }
  const sections = renderAll(gates)
  if (!Array.isArray(sections)) return sections
  const wanted = sections.map(expectedFrom)

  if (continueOf === undefined) {
    // On one line, so no goal text can start a heading or a fence.
    const goal = oneLine(typeof json.args.goal === 'string' ? json.args.goal : '')
    const what = goal || (json.planPath ? oneLine(json.planPath) : 'no goal recorded')
    const text = [`Gates planned by litter for run ${run}: ${what}`, '', ...sections].join('\n')
    const back = readsBack(text, wanted)
    if (back) return refusedReadBack(back, gates)
    return serial(`plan:${runDir}`, async () => {
      const wrote = await writePlanVersion(ctx.p, runDir, text)
      return store(ctx, input, { gates, path: wrote.path, previous: wrote.previous }, { path: wrote.path, previous: wrote.previous })
    })
  }

  const chain = await chainOf(ctx, continueOf, 'continueOf')
  if ('ok' in chain) return chain
  for (let i = 0; i < gates.length; i++) {
    const commit = chain.landed.get(gates[i]!.id)
    if (commit !== undefined) {
      return fail(
        `litter: gate ${gates[i]!.id} has landed in run ${chain.rootRun}'s chain (${commit}), so a new gate can't take its id; give it another`,
        `gates[${i}].id`,
      )
    }
  }
  return serial(`plan:${chain.rootDir}`, async () => {
    const old = await readPlanText(ctx.p, chain.rootDir, chain.rootRun, 'continueOf')
    if (typeof old !== 'string') return old
    const parsed = parseGates(old)
    if (!parsed.ok) return fail(`litter: run ${chain.rootRun}'s plan.md doesn't parse (${parsed.error}), so it can't be re-split`, 'continueOf')
    const lines = linesOf(old)
    const first = parsed.gates[0]
    const kept = parsed.gates.filter(g => chain.landed.has(g.id))
    // The text before the first gate, then each landed section as it was, then the new
    // ones; a blank line goes between two pieces only where the first doesn't end with one.
    const out = lines.slice(0, first ? first.lines.start - 1 : lines.length)
    const piece = (xs: string[]) => {
      if (out.length > 0 && out[out.length - 1]!.trim() !== '') out.push('')
      out.push(...xs)
    }
    for (const g of kept) piece(g.excerpt.split('\n'))
    for (const s of sections) piece(linesOf(s))
    const text = `${out.join('\n')}\n`
    const back = readsBack(text, [...kept.map(expectedOf), ...wanted])
    if (back) return refusedReadBack(back, gates)
    const wrote = await writePlanVersion(ctx.p, chain.rootDir, text)
    const replaced = parsed.gates.filter(g => !chain.landed.has(g.id)).map(g => g.id)
    return store(
      ctx,
      input,
      { gates, continueOf, root: chain.rootRun, kept: kept.map(g => g.id), replaced, path: wrote.path, previous: wrote.previous },
      { path: wrote.path, previous: wrote.previous, kept: kept.map(g => g.id), replaced },
    )
  })
}

/** Text as compared for `before`: line ends folded, trailing whitespace dropped. */
const sameText = (a: string, b: string): boolean => a.replace(/\r\n?/g, '\n').trimEnd() === b.replace(/\r\n?/g, '\n').trimEnd()

/**
 * `gate.amend { run, gate, before?, after, reason }` (a GateAmendInput): the
 * chain root's plan.md, with `gate`'s section replaced by `after`, which must
 * read as exactly one section with that id and nothing around it. Refused
 * when `before` is given and isn't the section's current text, or when the
 * gate has landed in the chain. Stored in `run`'s ledger, with the path
 * written and the previous file, and with the change to the gate's Files:
 * `filesAdded` (in `after`'s order) and `filesRemoved` (in the old section's),
 * each only when there is one. The mod computes those from the two sections;
 * they aren't GateAmendInput fields, so a caller's own never reach the record.
 * An amend run of this gate carries `filesAdded` into its run.json
 * (lifecycle.ts, amendOf), and its summary.md names them (execsummary.ts).
 */
export const recordGateAmend: RecordHandler = async (ctx, input) => {
  if (typeof input.gate !== 'string' || !GATE_ID.test(input.gate)) return fail("litter: 'gate' must be the gate id being amended, like G2", 'gate')
  if (input.before !== undefined && typeof input.before !== 'string') return fail("litter: 'before' must be the gate's text before the amendment", 'before')
  const missing = needText(input, 'after', "the amended gate's text, in the plan's gate format") ?? needText(input, 'reason', 'why the gate is amended')
  if (missing) return missing
  const gate = input.gate
  const after = input.after as string
  const run = input.run as string

  const section = parseGates(after)
  if (!section.ok) return fail(`litter: 'after' doesn't parse as a gate section: ${section.error}`, 'after')
  if (section.gates.length !== 1 || section.gates[0]!.id !== gate) {
    return fail(
      `litter: 'after' must be exactly one section, '### ${gate}: <title>' with its Files, Checks and Done when lines; it reads as ${section.gates.map(g => g.id).join(', ') || 'no gate'}`,
      'after',
    )
  }
  const amended = section.gates[0]!
  const afterText = after.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd()
  if (amended.excerpt.replace(/\r/g, '').trimEnd() !== afterText) {
    return fail(`litter: 'after' holds text outside ${gate}'s section (before its heading, or after a heading that ends it); send the section alone`, 'after')
  }
  if (fenceLeftOpen(afterText)) return fail(`litter: 'after' opens a code fence it never closes, which would hide every gate after it`, 'after')

  const chain = await chainOf(ctx, run, 'run')
  if ('ok' in chain) return chain
  const commit = chain.landed.get(gate)
  if (commit !== undefined) {
    return fail(`litter: gate ${gate} has landed in run ${chain.rootRun}'s chain (${commit}), and a landed gate can't be amended; amend a gate that hasn't landed, or plan the change anew`, 'gate')
  }
  return serial(`plan:${chain.rootDir}`, async () => {
    const old = await readPlanText(ctx.p, chain.rootDir, chain.rootRun, 'run')
    if (typeof old !== 'string') return old
    const parsed = parseGates(old)
    if (!parsed.ok) return fail(`litter: run ${chain.rootRun}'s plan.md doesn't parse (${parsed.error}), so it can't be amended`, 'run')
    const g = parsed.gates.find(x => x.id === gate)
    if (!g) {
      const ids = parsed.gates.map(x => x.id)
      return fail(`litter: run ${chain.rootRun}'s plan has no gate ${gate}; its gates are ${ids.join(', ')}`, 'gate', ids)
    }
    if (input.before !== undefined && !sameText(input.before as string, g.excerpt)) {
      return fail(`litter: 'before' isn't ${gate}'s current text in plan.md; it changed since you read it, so read plan.md again and draft the amendment from it`, 'before')
    }
    const lines = linesOf(old)
    // The blank lines that separated the old section from the next one stay.
    const was = lines.slice(g.lines.start - 1, g.lines.end)
    let gap = 0
    while (gap < was.length - 1 && was[was.length - 1 - gap]!.trim() === '') gap++
    const next = [...lines.slice(0, g.lines.start - 1), ...afterText.split('\n'), ...Array<string>(gap).fill(''), ...lines.slice(g.lines.end)]
    const text = `${next.join('\n')}\n`
    const want = parsed.gates.map(x => (x.id === gate ? expectedOf(amended) : expectedOf(x)))
    const back = readsBack(text, want)
    if (back) return fail(`litter: the amended plan.md doesn't read back to the same gates${back.gate ? ` at gate ${back.gate}` : ''} (${back.why}); nothing was written`, 'after')
    const wrote = await writePlanVersion(ctx.p, chain.rootDir, text)
    const body: Record<string, unknown> = { gate, after, reason: input.reason, root: chain.rootRun, path: wrote.path, previous: wrote.previous }
    if (input.before !== undefined) body.before = input.before
    const filesAdded = amended.files.filter(f => !g.files.includes(f))
    const filesRemoved = g.files.filter(f => !amended.files.includes(f))
    if (filesAdded.length > 0) body.filesAdded = filesAdded
    if (filesRemoved.length > 0) body.filesRemoved = filesRemoved
    return store(ctx, input, body, { path: wrote.path, previous: wrote.previous })
  })
}

/** Runs `f` holding the plan locks of the chain root's folder and, when it's another, the run's own: root first, as everywhere. */
const withPlanLocks = <T>(rootDir: string, runDir: string, f: () => Promise<T>): Promise<T> =>
  rootDir === runDir ? serial(`plan:${rootDir}`, f) : serial(`plan:${rootDir}`, () => serial(`plan:${runDir}`, f))

/** Where a widening reaches the agents, as gate.widen's reply says it. */
const WIDEN_APPLIES =
  "The gate's next critic is told of the files in its verify's reply, in a running execute workflow too, and passes them on if it sends the attempt back. " +
  "An agent that reads the gate from plan.md (a plan-template swarm's) sees them from its next read, and the chain's next run has them in its gates."

/**
 * `gate.widen { run, gate, files, why }` (a GateWidenInput, WP-AO): the
 * lead's or the execute skill's request to add files to a gate's Files. The
 * mod asks you in its own dialog (widen.ts, askWiden), naming the files and
 * the why; only on your yes does it add them to the gate in the run's
 * plan.md and in the chain root's, each with the line saying you added them,
 * and record it with `by: 'you'`. Files the gate already covers are skipped,
 * and with none left nothing is asked or recorded. Refused when the gate has
 * landed in the chain, the run isn't an execute run, you keep the gate as
 * written, or no one could be asked.
 */
export const recordGateWiden: RecordHandler = async (ctx, input) => {
  const parsed = parseWidening({ gate: input.gate, files: input.files, why: input.why }, '')
  if (!parsed.ok) return parsed
  const w = parsed.value
  const run = input.run as string
  const runDir = runDirOf(ctx.litterDir!, run)
  const json = await readJson<RunJson>(ctx.p, runJsonPath(runDir)).catch(() => undefined)
  if (json?.workflow !== 'execute') {
    return fail(`litter: a gate is widened in the execute run working it, and run ${run} is ${json ? `a ${json.workflow} run` : 'unreadable'}`, 'run')
  }
  const chain = await chainOf(ctx, run, 'run')
  if ('ok' in chain) return chain
  const commit = chain.landed.get(w.gate)
  if (commit !== undefined) {
    return fail(`litter: gate ${w.gate} has landed in run ${chain.rootRun}'s chain (${commit}), so it takes no more files; plan the change anew`, 'gate')
  }
  const now = await readPlanText(ctx.p, runDir, run, 'run')
  if (typeof now !== 'string') return now
  const gates = parseGates(now)
  if (!gates.ok) return fail(`litter: run ${run}'s plan.md doesn't parse (${gates.error}), so it can't be widened`, 'run')
  const g = gates.gates.find(x => x.id === w.gate)
  if (!g) {
    const ids = gates.gates.map(x => x.id)
    return fail(`litter: run ${run}'s plan has no gate ${w.gate}; its gates are ${ids.join(', ')}`, 'gate', ids)
  }
  const date = dateOf(await ctx.p.now())
  const preview = applyWidening(now, w, date)
  if (!preview.ok) return fail(`litter: ${w.gate} can't be widened: ${preview.error}`, 'files')
  if (preview.added.length === 0) return { ok: true, kind: 'gate.widen', run, gate: w.gate, added: [], note: `${w.gate}'s Files already cover ${w.files.join(', ')}; nothing was asked or changed` }

  // Your answer, asked before the locks are taken, since it can take a while.
  const answer = await askWiden(ctx.p, { run, gate: w.gate, title: g.title, current: g.files, files: preview.added, why: w.why, at: 'run' })
  if (answer === 'unasked') {
    return fail(`litter: no one could be asked to widen ${w.gate} here (a session with no one at it, as under -p), and only your answer in litter's dialog widens a gate; nothing was changed`, 'gate')
  }
  if (answer === 'no') return fail(`litter: you kept ${w.gate} as written, so its Files are unchanged. Work within them, or ask the user how to go on`, 'files')

  return withPlanLocks(chain.rootDir, runDir, async () => {
    // Read again under the locks: an amend or a re-split may have written either meanwhile.
    const own = await readPlanText(ctx.p, runDir, run, 'run')
    if (typeof own !== 'string') return own
    const mine = applyWidening(own, { ...w, files: preview.added }, date)
    if (!mine.ok) return fail(`litter: ${w.gate} can't be widened: ${mine.error}; nothing was written`, 'files')
    let rootText: string | null = null
    if (chain.rootDir !== runDir) {
      const old = await readPlanText(ctx.p, chain.rootDir, chain.rootRun, 'run')
      if (typeof old !== 'string') return old
      const root = applyWidening(old, { ...w, files: preview.added }, date)
      if (!root.ok) return fail(`litter: ${w.gate} can't be widened in run ${chain.rootRun}'s plan, the chain's: ${root.error}; nothing was written`, 'gate')
      if (root.added.length > 0) rootText = root.text
    }
    if (mine.added.length === 0 && rootText === null) {
      return { ok: true, kind: 'gate.widen', run, gate: w.gate, added: [], note: `${w.gate}'s Files came to cover them meanwhile; nothing was changed` }
    }
    const plans: string[] = []
    if (mine.added.length > 0) plans.push((await writePlanVersion(ctx.p, runDir, mine.text)).path)
    if (rootText !== null) plans.push((await writePlanVersion(ctx.p, chain.rootDir, rootText)).path)
    const added = mine.added.length > 0 ? mine.added : preview.added
    const body: GateWidenBody = { gate: w.gate, files: added, why: w.why, by: 'you', at: 'run', plans }
    return store(ctx, input, body, { gate: w.gate, added, plans, applies: WIDEN_APPLIES })
  })
}
