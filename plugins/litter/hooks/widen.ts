// WP-AO: files added to a gate's Files for an execute run (plan section 9,
// "Widening a gate"). Who may add them is the run's `widen` setting:
//  - `ask`, the default: only you, in the mod's own dialog, before Launch
//    (run.start's `widenings`) or during the run (`gate.widen`, plan.ts). The
//    lead's or a node's yes never widens a gate.
//  - `critic`: you, as above, or the gate's critic, which may accept a file
//    the gate can't do without. The land records each one (land.ts), and
//    summary.md lists them for you.
//
// Your widening is recorded in the run's ledger and written into the run's
// copy of the plan: the files go on the gate's Files line, and a line at the
// end of the gate's section says you added them, and why. Every agent reads
// the gate from that copy, so nothing else has to carry it. A continuation
// or an amend applies the chain's widenings again to the plan it copies.

import type { Ports } from './ports'
import type { RecordError, StoredRecord } from './records/core'
import type { AddedFiles, GateWidenBody, WidenedFile } from './records/execute'
import type { RunJson, WideningInput } from './records/run'
import type { WidenMode } from './options'
import { fail } from './records/core'
import { parseGates } from './gates'
import { matches } from './rules/match'
import { SNAPSHOT_EXCLUDES } from './layout'

/** The run's widen setting; a run.json without one (written before WP-AO) is `ask`. */
export const widenOf = (json: Pick<RunJson, 'widen'> | null | undefined): WidenMode => (json?.widen === 'critic' ? 'critic' : 'ask')

const GLOB = /[*?[\]{}]/
const GATE_ID = /^G[0-9]{1,4}$/
/** At most this many files in one widening, and this many characters of its why. */
export const WIDEN_MAX_FILES = 20
export const WIDEN_WHY_MAX = 500

/**
 * Whether one of a gate's Files entries covers the repository-relative
 * `path`: the path itself, a folder above it (`lib/` or `lib`), or a glob
 * that matches it.
 */
export function covers(entries: readonly string[], path: string): boolean {
  const p = path.replace(/^\.\//, '')
  return entries.some(raw => {
    const e = raw.trim().replace(/^\.\//, '')
    if (e === '') return false
    if (GLOB.test(e)) return matches(e, p)
    const bare = e.replace(/\/+$/, '')
    return p === bare || p.startsWith(`${bare}/`)
  })
}

/** Why `path` can't be added to a gate's Files, or null. */
export function widenPathError(path: string): string | null {
  if (path === '' || path.trim() !== path) return 'is empty or has spaces around it'
  if (path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:/.test(path)) return 'is absolute; give it relative to the repository'
  if (path.includes('\\')) return 'has a backslash'
  if (/[\r\n,`]/.test(path)) return "has a comma, a backtick or a line break, which a Files line can't hold"
  if (path.split('/').some(s => s === '..' || s === '.')) return "contains '.' or '..'"
  if (GLOB.test(path)) return 'has a glob; list paths, with a trailing / for a folder'
  const bare = path.replace(/\/+$/, '')
  for (const ex of SNAPSHOT_EXCLUDES) {
    if (bare === ex || bare.startsWith(`${ex}/`) || ex.startsWith(`${bare}/`)) return `lies under litter's own ${ex}/, which no gate changes`
  }
  return null
}

/** The why, as the plan's line holds it: one line, no backticks, at most WIDEN_WHY_MAX characters. */
export const whyLine = (why: string): string => {
  const flat = why.replace(/`/g, "'").replace(/\s+/g, ' ').trim()
  return flat.length > WIDEN_WHY_MAX ? `${flat.slice(0, WIDEN_WHY_MAX - 1)}…` : flat
}

/** One widening, from run.start's `widenings` or gate.widen's fields; `field` prefixes the field each refusal names. */
export function parseWidening(v: unknown, field: string): { ok: true; value: WideningInput } | RecordError {
  const at = (f: string) => (field === '' ? f : `${field}.${f}`)
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return fail(`litter: '${field}' must be { gate, files, why }`, field)
  const { gate, files, why } = v as Record<string, unknown>
  if (typeof gate !== 'string' || !GATE_ID.test(gate)) return fail(`litter: '${at('gate')}' must be the gate's id, like G2`, at('gate'))
  if (!Array.isArray(files) || files.length === 0 || !files.every(f => typeof f === 'string')) {
    return fail(`litter: '${at('files')}' must list the paths to add, relative to the repository, with a trailing / for a folder`, at('files'))
  }
  if (files.length > WIDEN_MAX_FILES) return fail(`litter: '${at('files')}' lists ${files.length} paths; add at most ${WIDEN_MAX_FILES} at once`, at('files'))
  for (const [i, f] of (files as string[]).entries()) {
    const why = widenPathError(f)
    if (why) return fail(`litter: '${at(`files[${i}]`)}' ${JSON.stringify(f)} ${why}`, at(`files[${i}]`))
  }
  if (typeof why !== 'string' || whyLine(why) === '') {
    return fail(`litter: '${at('why')}' must say why the gate needs these files, in the user's words`, at('why'))
  }
  return { ok: true, value: { gate, files: [...new Set(files as string[])], why: whyLine(why) } }
}

/**
 * The critic's `widened` (a plan-template critic's, through the tool): a
 * list of { file, why }, [] or left out when it accepts none.
 */
export function parseWidened(v: unknown): { ok: true; value: WidenedFile[] } | RecordError {
  if (v === undefined || v === null) return { ok: true, value: [] }
  if (!Array.isArray(v)) return fail("litter: 'widened' must be a list of { file, why }, or [] when you accept no file outside the gate's Files", 'widened')
  const out: WidenedFile[] = []
  for (const [i, x] of v.entries()) {
    const { file, why } = (x ?? {}) as Record<string, unknown>
    if (typeof file !== 'string' || widenPathError(file) !== null) {
      return fail(`litter: 'widened[${i}].file' must be one repository-relative path outside the gate's Files${typeof file === 'string' ? `; ${JSON.stringify(file)} ${widenPathError(file)}` : ''}`, `widened[${i}].file`)
    }
    if (typeof why !== 'string' || whyLine(why) === '') return fail(`litter: 'widened[${i}].why' must say why the gate can't do without ${file}`, `widened[${i}].why`)
    out.push({ file, why: whyLine(why) })
  }
  return { ok: true, value: out }
}

/** A verdict body's `widened`, as recorded: [] when absent or malformed. */
export function widenedOf(body: Record<string, unknown>): WidenedFile[] {
  const w = body.widened
  if (!Array.isArray(w)) return []
  return w.filter((x): x is WidenedFile => x !== null && typeof x === 'object' && typeof x.file === 'string' && typeof x.why === 'string')
}

/** Your widenings in a run's ledger, launch and run, in order. */
export function yourWidenings(records: readonly StoredRecord[]): GateWidenBody[] {
  return records.filter(r => r.kind === 'gate.widen' && r.body.by === 'you').map(r => r.body as unknown as GateWidenBody)
}

/**
 * Gate `gate`'s Files as the run has them now: its args' (with your
 * widenings before Launch, and the chain's earlier ones, which its plan
 * carried), then your widenings during the run.
 */
export function runGateFiles(json: Pick<RunJson, 'args'>, records: readonly StoredRecord[], gate: string): string[] {
  const gates = Array.isArray(json.args?.gates) ? (json.args.gates as unknown[]) : []
  const g = gates.find(x => x !== null && typeof x === 'object' && (x as { id?: unknown }).id === gate) as { files?: unknown } | undefined
  const files = Array.isArray(g?.files) ? g.files.filter((f): f is string => typeof f === 'string') : []
  for (const w of yourWidenings(records)) if (w.gate === gate && Array.isArray(w.files)) files.push(...w.files)
  return files
}

/**
 * The files you added to gate `gate` after its run launched (gate.widen at
 * 'run'), with why, in order. The run's args don't carry them, so the
 * gate's critic is told of them in its verify reply (WP-AP).
 */
export function addedAfterLaunch(records: readonly StoredRecord[], gate: string): AddedFiles[] {
  return yourWidenings(records)
    .filter(w => w.gate === gate && w.at === 'run' && Array.isArray(w.files))
    .map(w => ({ files: [...w.files], why: w.why }))
}

/** What a verify reply's `added` means, for the critic that reads it (WP-AP). */
export const ADDED_NOTE =
  "The user added these files to this gate's Files after the run launched, so they're part of its expected files, even where the gate text you were given doesn't list them. " +
  'If you reject the attempt and its fix needs one of them, say in a gap that the executor may change it.'

/** At most this many paths outside a gate's Files go into a land's body. */
export const OUTSIDE_MAX = 200

/** The changed paths `entries` doesn't cover, litter's own left out, sorted, at most OUTSIDE_MAX. */
export function outsideOf(entries: readonly string[], changed: readonly string[]): string[] {
  const own = (p: string) => SNAPSHOT_EXCLUDES.some(ex => p === ex || p.startsWith(`${ex}/`))
  return [...new Set(changed)].filter(p => p !== '' && !own(p) && !covers(entries, p)).sort().slice(0, OUTSIDE_MAX)
}

/** The line a widening adds at the end of the gate's section. */
export const widenNote = (files: readonly string[], why: string, date: string): string =>
  `Added to Files for this run by you, through litter (${date}): ${files.join(', ')}. Why: ${whyLine(why)}`

const FILES_FIELD = /^files[ \t]*:[ \t]*(.*?)[ \t]*$/i
const ITEM = /^([ \t]*[-*][ \t]+)\S/

export type Applied = { ok: true; text: string; added: string[] } | { ok: false; error: string }

/**
 * `text` (a plan) with `files` added to gate `gate`'s Files line, and a line
 * at the end of its section saying you added them and why (widenNote). Files
 * the gate already covers are skipped; with none left, `text` comes back as
 * it was and `added` is empty. The result must parse to the same gates, the
 * one gate's Files longer by exactly `added`, or nothing is changed.
 */
export function applyWidening(text: string, w: { gate: string; files: readonly string[]; why: string }, date: string): Applied {
  const before = parseGates(text)
  if (!before.ok) return { ok: false, error: `the plan doesn't parse (${before.error})` }
  const g = before.gates.find(x => x.id === w.gate)
  if (!g) return { ok: false, error: `the plan has no gate ${w.gate}; its gates are ${before.gates.map(x => x.id).join(', ')}` }
  const added = [...new Set(w.files)].filter(f => !covers(g.files, f))
  if (added.length === 0) return { ok: true, text, added }

  const trailing = text.endsWith('\n')
  const lines = (trailing ? text.slice(0, -1) : text).split('\n')
  const cr = (i: number) => (lines[i]!.endsWith('\r') ? '\r' : '')
  const bare = (i: number) => lines[i]!.replace(/\r$/, '')
  const first = g.lines.start - 1
  const last = g.lines.end - 1
  // The Files line: the first in the field block right under the heading.
  let at = -1
  for (let i = first + 1; i <= last; i++) {
    if (FILES_FIELD.test(bare(i))) {
      at = i
      break
    }
  }
  if (at < 0) return { ok: false, error: `gate ${w.gate}'s Files line wasn't found` }
  const value = FILES_FIELD.exec(bare(at))![1]!
  const insert: { after: number; lines: string[] }[] = []
  if (value !== '') {
    lines[at] = `${bare(at).replace(/[ \t]+$/, '')}, ${added.join(', ')}${cr(at)}`
  } else {
    let lastItem = -1
    for (let i = at + 1; i <= last && ITEM.test(bare(i)); i++) lastItem = i
    if (lastItem < 0) return { ok: false, error: `gate ${w.gate}'s Files list has no items` }
    const prefix = ITEM.exec(bare(lastItem))![1]!
    insert.push({ after: lastItem, lines: added.map(f => `${prefix}${f}${cr(lastItem)}`) })
  }
  // The note: after the section's last line that isn't blank, set apart by a blank line.
  let end = last
  while (end > first && bare(end).trim() === '') end--
  insert.push({ after: end, lines: [cr(end), `${widenNote(added, w.why, date)}${cr(end)}`] })
  for (const ins of insert.sort((a, b) => b.after - a.after)) lines.splice(ins.after + 1, 0, ...ins.lines)
  const out = `${lines.join('\n')}${trailing ? '\n' : ''}`

  const after = parseGates(out)
  const same = (a: typeof g, b: typeof g) => a.id === b.id && a.title === b.title && a.checks === b.checks && a.doneWhen === b.doneWhen && a.adversary === b.adversary
  const readsBack =
    after.ok &&
    after.gates.length === before.gates.length &&
    after.gates.every((x, i) => {
      const y = before.gates[i]!
      if (!same(x, y)) return false
      const want = y.id === w.gate ? [...y.files, ...added] : y.files
      return x.files.length === want.length && x.files.every((f, j) => f === want[j])
    })
  if (!readsBack) return { ok: false, error: `the plan with ${w.gate} widened doesn't read back to the same gates` }
  return { ok: true, text: out, added }
}

/**
 * Asks you to add `files` to gate `gate`, in the mod's own dialog: what the
 * gate covers now, what would be added and why, and from when they apply
 * (`at`: a launch's run has them throughout; during a run, the gate's critic
 * is told at its next verify, WP-AP). `yes` only on your answer;
 * `unasked` when no one could be asked here (as under -p).
 */
export async function askWiden(
  p: Ports,
  o: { run: string | null; gate: string; title: string; current: readonly string[]; files: readonly string[]; why: string; at: 'launch' | 'run' },
): Promise<'yes' | 'no' | 'unasked'> {
  const keep = `Keep ${o.gate} as written`
  const add = 'Add them'
  const whose = o.run ? ` of run ${o.run}` : ''
  const when =
    o.at === 'launch'
      ? 'in this run and any continuation of it'
      : "from its critic's next verify, where litter tells the critic of them (it passes them on if it sends the attempt back), and in any continuation of the run"
  const question = [
    `Gate ${o.gate}${o.title ? ` ("${o.title}")` : ''}${whose} covers these files: ${o.current.join(', ')}.`,
    '',
    `Add these to its Files?`,
    '',
    ...o.files.map(f => `  ${f}`),
    '',
    `Why, as the request puts it: ${whyLine(o.why)}`,
    '',
    `With them, ${o.gate}'s executor may change them, and its critic judges them as part of ${o.gate}, ${when}. Your plan file isn't changed; the run's copy of it is. Only your answer here adds them: a yes from the lead or an agent doesn't.`,
    '',
    `Add them to ${o.gate}?`,
  ].join('\n')
  try {
    const answer = await p.ask(question, { options: [keep, add], header: `Widen ${o.gate}` })
    return answer === add ? 'yes' : 'no'
  } catch {
    return 'unasked'
  }
}

/** Today's date, as a widening's note gives it. */
export const dateOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
