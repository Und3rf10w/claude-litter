// Import from deepwork (16.8; COMMON decision 3): every live and archived
// instance's guardrails, merged with its incidents as deepwork's
// render_guardrails merges them. Owner: phase 3, package AD.
//
// Everything here is read as text: a deepwork state file is the
// repository's content, so nothing in it becomes a path, a command or an
// acceptance.

import type { Ports } from '../ports'
import type { ImportBatch, ImportGuardrail, ImportInstance } from '../records/rules'

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** An instance folder's name: no separator, not `.` or `..`. */
const INSTANCE = /^(?!\.\.?$)[^/\0]{1,200}$/

type Entry = Record<string, unknown>

/**
 * render_guardrails' merge (plugins/deepwork/scripts/profile-lib.sh:115-157, at the legacy-3.8 tag)
 * when an incidents.jsonl exists: state's guardrails, then the incidents,
 * the first of each `incident_ref` kept, and every entry without one.
 */
function merged(state: Entry[], incidents: Entry[]): Entry[] {
  const out: Entry[] = []
  const refs = new Set<string>()
  for (const r of [...state, ...incidents]) {
    const ref = r.incident_ref
    if (ref === undefined || ref === null || ref === false || ref === '') {
      out.push(r)
      continue
    }
    const key = JSON.stringify(ref)
    if (refs.has(key)) continue
    refs.add(key)
    out.push(r)
  }
  return out
}

const isEntry = (v: unknown): v is Entry => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Reads `<primary>/.claude/deepwork/<instance>/state.json` (else
 * `state.archived.json`) and the `incidents.jsonl` beside it, for every
 * instance. Nothing here is proposed or accepted: records.ts's
 * recordRuleImport proposes what it returns.
 */
export async function readDeepwork(p: Ports, primary: string): Promise<ImportBatch> {
  const root = `${primary}/.claude/deepwork`
  const batch: ImportBatch = { instances: [], guardrails: [], problems: [] }
  if (!(await p.fs.exists(root))) return batch
  const names = (await p.fs.list(root)).filter(e => e.kind === 'dir' && !e.isLink && INSTANCE.test(e.name)).map(e => e.name).sort()
  for (const id of names) {
    const dir = `${root}/${id}`
    const live = `${dir}/state.json`
    const archived = !(await p.fs.exists(live))
    const path = archived ? `${dir}/state.archived.json` : live
    if (!(await p.fs.exists(path))) continue
    let state: unknown
    try {
      state = JSON.parse(await p.fs.read(path))
    } catch (err) {
      batch.problems.push(`${path} couldn't be read: ${errText(err)}`)
      continue
    }
    if (!isEntry(state)) {
      batch.problems.push(`${path} isn't a deepwork state object`)
      continue
    }
    const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null)
    const instance: ImportInstance = { id, goal: text(state.goal) ?? '', date: text(state.started_at) ?? text(state.last_updated), archived }
    batch.instances.push(instance)
    // incidents.jsonl: one JSON object a line; a line that doesn't parse is skipped, as render_guardrails' `fromjson?` does.
    const incidents: Entry[] = []
    const incPath = `${dir}/incidents.jsonl`
    const hasIncidents = await p.fs.exists(incPath)
    if (hasIncidents) {
      try {
        for (const line of (await p.fs.read(incPath)).split('\n')) {
          if (line.trim() === '') continue
          try {
            const v: unknown = JSON.parse(line)
            if (isEntry(v)) incidents.push(v)
          } catch {}
        }
      } catch (err) {
        batch.problems.push(`${incPath} couldn't be read: ${errText(err)}`)
      }
    }
    const fromState = Array.isArray(state.guardrails) ? state.guardrails.filter(isEntry) : []
    let skipped = 0
    // Without an incidents.jsonl, render_guardrails lists state's guardrails as they are.
    for (const r of hasIncidents ? merged(fromState, incidents) : fromState) {
      if (typeof r.rule !== 'string' || r.rule.trim() === '') {
        skipped++
        continue
      }
      const ref = r.incident_ref
      const g: ImportGuardrail = {
        instance: id,
        text: r.rule,
        source: typeof r.source === 'string' && r.source !== '' ? r.source : 'unknown',
        incident_ref: ref === undefined || ref === null || ref === false || ref === '' ? null : typeof ref === 'string' ? ref : JSON.stringify(ref),
        archived,
      }
      batch.guardrails.push(g)
    }
    if (skipped > 0) batch.problems.push(`instance ${id}: ${skipped} guardrail${skipped === 1 ? '' : 's'} with no rule text left out`)
  }
  return batch
}
