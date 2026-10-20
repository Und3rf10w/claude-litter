// The gate sections of plan.md, a contract (plan section 10, "Gate sections in
// plan.md are a contract"). Owner: phase 1b, work package D. The design author,
// the planner and the execute launcher all render to or parse this shape.
//
//   ### G2: Retry the token refresh once
//   Files: src/auth/refresh.py, tests/test_refresh.py
//   Checks: uv run pytest tests/test_refresh.py -q
//   Done when: test_refresh_retries_once passes inside the verify suite
//   Adversary: yes
//   Rollback: revert the commit; no data migration
//
//   What to change, in prose.
//
// The field lines are the block right under the heading, up to the first
// blank or other line. `Files` and `Checks` may instead leave the value empty
// and list one `- item` per line below; several checks are joined with "\n".
// Headings inside a code fence don't count.

export type Gate = {
  /** `G2`. */
  id: string
  title: string
  files: string[]
  /** One check per line. */
  checks: string
  doneWhen: string
  adversary: boolean
  rollback: string | null
  /** 1-based, inclusive: the heading line through the line before the next heading at the same or a higher level. */
  lines: { start: number; end: number }
  /** The section's text, verbatim. */
  excerpt: string
}

export type GateParse = { ok: true; gates: Gate[] } | { ok: false; error: string; gate: string | null; field: string | null }

const GATE_HEADING = /^###[ \t]+(G[0-9]+)[ \t]*:[ \t]*(.*?)[ \t]*$/
const HEADING = /^(#{1,6})[ \t]/
const FENCE = /^[ \t]{0,3}(```|~~~)/
const FIELD = /^(files|checks|done when|adversary|rollback)[ \t]*:[ \t]*(.*?)[ \t]*$/i
const ITEM = /^[ \t]*[-*][ \t]+(.*?)[ \t]*$/

type Field = 'Files' | 'Checks' | 'Done when' | 'Adversary' | 'Rollback'
const CANONICAL: Record<string, Field> = {
  files: 'Files',
  checks: 'Checks',
  'done when': 'Done when',
  adversary: 'Adversary',
  rollback: 'Rollback',
}

const unquote = (s: string): string => s.replace(/^`(.*)`$/, '$1').trim()

const bad = (error: string, gate: string | null, field: string | null): GateParse => ({ ok: false, error, gate, field })

export function parseGates(planText: string): GateParse {
  const raw = planText.split('\n')
  // A trailing newline isn't a line of its own.
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop()
  const text = raw.map(l => l.replace(/\r$/, ''))

  // Every heading outside a fence, with its level.
  const headings: { at: number; level: number }[] = []
  let fence: string | null = null
  for (let i = 0; i < text.length; i++) {
    const line = text[i]!
    const f = FENCE.exec(line)
    if (f) {
      if (fence === null) fence = f[1]!
      else if (fence === f[1]) fence = null
      continue
    }
    if (fence !== null) continue
    const h = HEADING.exec(line)
    if (h) headings.push({ at: i, level: h[1]!.length })
  }

  const gates: Gate[] = []
  const seen = new Set<string>()
  for (let k = 0; k < headings.length; k++) {
    const { at, level } = headings[k]!
    const m = level === 3 ? GATE_HEADING.exec(text[at]!) : null
    if (!m) continue
    const id = m[1]!
    const title = m[2]!
    if (title === '') return bad(`gate ${id} has no title: write it as '### ${id}: <title>'`, id, 'title')
    if (seen.has(id)) return bad(`gate ${id} appears twice; give each gate its own id`, id, 'id')
    seen.add(id)
    let end = text.length - 1
    for (let j = k + 1; j < headings.length; j++) {
      if (headings[j]!.level <= 3) {
        end = headings[j]!.at - 1
        break
      }
    }

    const fields = new Map<Field, string>()
    const lists = new Map<Field, string[]>()
    let i = at + 1
    while (i <= end && text[i]!.trim() === '') i++
    let open: Field | null = null
    for (; i <= end; i++) {
      const line = text[i]!
      if (line.trim() === '') break
      const f = FIELD.exec(line)
      if (f) {
        const name = CANONICAL[f[1]!.toLowerCase()]!
        if (fields.has(name)) return bad(`gate ${id} has two '${name}' lines; keep one`, id, name)
        fields.set(name, f[2]!)
        open = f[2] === '' && (name === 'Files' || name === 'Checks') ? name : null
        continue
      }
      const item = open ? ITEM.exec(line) : null
      if (item && open) {
        const list = lists.get(open) ?? []
        list.push(item[1]!)
        lists.set(open, list)
        continue
      }
      break
    }

    const value = (name: Field): string[] => {
      const listed = lists.get(name)
      if (listed && listed.length > 0) return listed.map(unquote).filter(x => x !== '')
      const v = fields.get(name) ?? ''
      if (v === '') return []
      return name === 'Files' ? v.split(',').map(unquote).filter(x => x !== '') : [unquote(v)]
    }
    const files = value('Files')
    if (files.length === 0) {
      return bad(`gate ${id} has no 'Files' line; add 'Files: <path>, <path>' under its heading`, id, 'Files')
    }
    const checks = value('Checks')
    if (checks.length === 0) {
      return bad(`gate ${id} has no 'Checks' line; add 'Checks: <how to check it>' under its heading`, id, 'Checks')
    }
    const doneWhen = (fields.get('Done when') ?? '').trim()
    if (doneWhen === '') {
      return bad(`gate ${id} has no 'Done when' line; add 'Done when: <what must hold>' under its heading`, id, 'Done when')
    }
    const rollback = (fields.get('Rollback') ?? '').trim()
    gates.push({
      id,
      title,
      files,
      checks: checks.join('\n'),
      doneWhen,
      adversary: /^(yes|true|on)$/i.test((fields.get('Adversary') ?? '').trim()),
      rollback: rollback === '' ? null : rollback,
      lines: { start: at + 1, end: end + 1 },
      excerpt: raw.slice(at, end + 1).join('\n'),
    })
  }
  return { ok: true, gates }
}
