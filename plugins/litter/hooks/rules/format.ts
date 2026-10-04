// A rule file, 16.2's format, read and written: a small YAML subset of
// frontmatter between `---` lines, then the body's `## Rule`, `## Why`,
// `## Exceptions` and `## How to check`. Owner: phase 3, package AD.
//
// The subset is what 16.2's example uses: scalars (bare, single- or
// double-quoted), inline and block lists, inline maps, and one level of
// nesting under `applies`. A key litter doesn't know is kept as its raw text,
// whatever it holds, so your own fields survive every render. renderRule
// writes the form 16.2's example has, so a file in that form renders back to
// the same bytes; any other spelling the parser takes renders in that form.

import type { RuleAccepted, RuleApplies, RuleDoc, RuleStatus, RuleType } from '../records/rules'
import { RULE_STATUSES, RULE_TYPES } from '../records/rules'
import { validPattern } from './match'

// AE's pattern check, through one table so tier 2 can stand in for it before
// the merge (COMMON, "Another package's module").
export const deps = {
  validPattern: (pattern: string) => validPattern(pattern),
}

/** A rule goes into prompts, so a file over this is refused (16.2). */
export const RULE_MAX_BYTES = 8 * 1024

/** A rule id (16.2): the scope letter, then a slug of `[a-z0-9-]`, with `-2`, `-3`… on a collision. */
export const RULE_ID = /^[UPL]-[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/

export const bytes = (text: string) => new TextEncoder().encode(text).length

/** Whitespace and case folded (16.3): how a dismissed text, an import's duplicates and an identical proposal are compared. */
export const foldText = (text: string): string => text.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()

/** Why a path pattern is refused (AE's validPattern), or null. */
export function patternProblem(pattern: string): string | null {
  return deps.validPattern(pattern)
}

type Parsed = { ok: true; doc: RuleDoc } | { ok: false; error: string }

class Refused extends Error {}
const refuse = (line: number, why: string): never => {
  throw new Refused(`line ${line}: ${why}`)
}

const KNOWN = ['id', 'version', 'status', 'type', 'applies', 'overrides', 'accepted', 'export'] as const
type Known = (typeof KNOWN)[number]
const APPLIES_KEYS = ['paths', 'workflows', 'roles', 'when'] as const
const ACCEPTED_KEYS = ['at', 'commit', 'via'] as const
const SECTIONS = { Rule: 'rule', Why: 'why', Exceptions: 'exceptions', 'How to check': 'howToCheck' } as const

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_.-]*):(.*)$/

/**
 * Reads one rule file. Unknown frontmatter keys go to `extra` as their raw
 * text, in order. Refused, naming the line or field: over 8 KiB, a `type`
 * other than rule or ban, an `applies.paths` pattern match.ts's validPattern
 * rejects, a missing `## Rule`, or YAML outside the subset.
 *
 * A draft (a proposal's file) may leave out `id`, `version` and `status`:
 * they read as `''`, 0 and `proposed`, and the store refuses a rule file
 * that lacks them. `type` reads as `rule` and `export` as true when absent.
 */
export function parseRule(text: string): Parsed {
  const size = bytes(text)
  if (size > RULE_MAX_BYTES) return { ok: false, error: `the rule is ${size} bytes, over the ${RULE_MAX_BYTES}-byte limit; a rule goes into prompts, so cut it down` }
  try {
    return { ok: true, doc: parse(text.replace(/\r\n/g, '\n')) }
  } catch (err) {
    if (err instanceof Refused) return { ok: false, error: err.message }
    throw err
  }
}

function parse(text: string): RuleDoc {
  const lines = text.split('\n')
  if (lines[0] !== '---') refuse(1, 'a rule file starts with a --- line, then its frontmatter')
  const end = lines.indexOf('---', 1)
  if (end < 0) refuse(1, 'the frontmatter has no closing --- line')
  const doc: RuleDoc = {
    id: '',
    version: 0,
    status: 'proposed',
    type: 'rule',
    applies: { paths: [], when: '' },
    export: true,
    extra: [],
    body: { rule: '', why: '', exceptions: [], howToCheck: [] },
  }
  frontmatter(lines, 1, end, doc)
  body(lines, end + 1, doc)
  return doc
}

// ---------------------------------------------------------------------------
// The frontmatter

/** Lines `from` (inclusive) to `to` (exclusive), 0-based; a refusal names the 1-based line. */
function frontmatter(lines: string[], from: number, to: number, doc: RuleDoc): void {
  const seen = new Set<string>()
  let i = from
  while (i < to) {
    const line = lines[i]!
    const n = i + 1
    if (line.trim() === '') {
      i++
      continue
    }
    if (/^\s/.test(line)) refuse(n, 'an indented line outside applies; only applies holds keys of its own')
    if (line.startsWith('#')) refuse(n, "a comment; the rule format doesn't take them, so put your note in a field of your own")
    const m = KEY_LINE.exec(line)
    if (!m || (m[2] !== '' && !m[2]!.startsWith(' '))) refuse(n, 'expected a key, then a colon and a space, as in type: rule')
    const key = m![1]!
    const rest = m![2]!
    if (seen.has(key)) refuse(n, `${key} is given twice`)
    seen.add(key)
    if (!(KNOWN as readonly string[]).includes(key)) {
      // Kept as written: the rest of the line and every continuation line (indented, or a block list's `-`).
      let j = i + 1
      let last = i
      while (j < to && (lines[j]!.trim() === '' || /^[\s-]/.test(lines[j]!))) {
        if (lines[j]!.trim() !== '') last = j
        j++
      }
      doc.extra.push([key, [rest, ...lines.slice(i + 1, last + 1)].join('\n')])
      i = last + 1
      continue
    }
    i = known(lines, i, to, key as Known, rest.trim(), doc)
  }
}

/** One known key at line `i` (its value `v`, trimmed); answers the next line to read. */
function known(lines: string[], i: number, to: number, key: Known, v: string, doc: RuleDoc): number {
  const n = i + 1
  switch (key) {
    case 'id':
      doc.id = scalar(v, n, false)
      if (!RULE_ID.test(doc.id)) refuse(n, `id ${JSON.stringify(doc.id)} isn't a rule id: a scope letter (U, P or L), a dash, then lowercase letters, digits and dashes`)
      return i + 1
    case 'version':
      if (!/^[1-9][0-9]{0,8}$/.test(v)) refuse(n, 'version is a whole number from 1')
      doc.version = Number(v)
      return i + 1
    case 'status': {
      const s = scalar(v, n, false)
      if (!(RULE_STATUSES as readonly string[]).includes(s)) refuse(n, `status is one of ${RULE_STATUSES.join(', ')}, not ${JSON.stringify(s)}`)
      doc.status = s as RuleStatus
      return i + 1
    }
    case 'type': {
      const t = scalar(v, n, false)
      if (!(RULE_TYPES as readonly string[]).includes(t)) refuse(n, `type is rule or ban, not ${JSON.stringify(t)}`)
      doc.type = t as RuleType
      return i + 1
    }
    case 'overrides':
      doc.overrides = scalar(v, n, false)
      if (!RULE_ID.test(doc.overrides)) refuse(n, `overrides names a rule id, such as U-keep-tests-near, not ${JSON.stringify(doc.overrides)}`)
      return i + 1
    case 'export':
      if (v !== 'true' && v !== 'false') refuse(n, 'export is true or false')
      doc.export = v === 'true'
      return i + 1
    case 'accepted':
      doc.accepted = acceptedMap(v, n)
      return i + 1
    case 'applies':
      if (v !== '') refuse(n, 'applies holds its keys on the lines below it, indented: paths, workflows, roles and when')
      return applies(lines, i + 1, to, doc)
  }
}

function acceptedMap(v: string, n: number): RuleAccepted {
  if (!v.startsWith('{') || !v.endsWith('}')) refuse(n, 'accepted is an inline map, as in accepted: { at: 2026-10-01, via: ui }')
  const out: RuleAccepted = {}
  for (const part of splitFlow(v.slice(1, -1), n)) {
    const m = /^([A-Za-z_]+):\s+(.*)$/.exec(part)
    if (!m) refuse(n, `accepted's ${JSON.stringify(part)} isn't a key and a value`)
    const k = m![1]!
    if (!(ACCEPTED_KEYS as readonly string[]).includes(k)) refuse(n, `accepted takes at, commit and via, not ${k}`)
    if (out[k as keyof RuleAccepted] !== undefined) refuse(n, `accepted's ${k} is given twice`)
    out[k as keyof RuleAccepted] = scalar(m![2]!, n, true)
  }
  return out
}

/** `applies`' keys, from line `i` while they're indented; answers the first line after them. */
function applies(lines: string[], i: number, to: number, doc: RuleDoc): number {
  const out: RuleApplies = { paths: [], when: '' }
  const seen = new Set<string>()
  let indent = -1
  while (i < to) {
    const line = lines[i]!
    const n = i + 1
    if (line.trim() === '') {
      i++
      continue
    }
    const lead = line.length - line.trimStart().length
    if (lead === 0) break
    if (line.slice(0, lead).includes('\t')) refuse(n, 'a tab in the indentation; indent with spaces')
    if (indent < 0) indent = lead
    if (lead !== indent) refuse(n, `applies' keys are indented ${indent} spaces, and this line ${lead}`)
    const m = KEY_LINE.exec(line.slice(lead))
    if (!m || (m[2] !== '' && !m[2]!.startsWith(' '))) refuse(n, 'expected one of applies\' keys, then a colon: paths, workflows, roles or when')
    const key = m![1]!
    if (!(APPLIES_KEYS as readonly string[]).includes(key)) refuse(n, `applies takes paths, workflows, roles and when, not ${key}`)
    if (seen.has(key)) refuse(n, `applies.${key} is given twice`)
    seen.add(key)
    const v = m![2]!.trim()
    if (key === 'when') {
      out.when = scalar(v, n, false)
      i++
      continue
    }
    let items: [string, number][]
    if (v !== '') {
      if (!v.startsWith('[') || !v.endsWith(']')) refuse(n, `applies.${key} is a list: [a, b] on its line, or one "- item" per line below it`)
      items = splitFlow(v.slice(1, -1), n).map(s => [scalar(s, n, true), n])
      i++
    } else {
      // A block list: `- item` lines, indented at least as far as the key.
      items = []
      i++
      while (i < to) {
        const l = lines[i]!
        if (l.trim() === '') {
          i++
          continue
        }
        const ld = l.length - l.trimStart().length
        const item = /^-(?: (.*))?$/.exec(l.trimStart())
        if (ld < indent || !item) break
        items.push([scalar((item[1] ?? '').trim(), i + 1, false), i + 1])
        i++
      }
    }
    for (const [s, line] of items) if (s === '') refuse(line, `applies.${key} has an empty entry`)
    const list = items.map(([s]) => s)
    if (key === 'paths') {
      for (const [pattern, line] of items) {
        const why = patternProblem(pattern)
        if (why !== null) refuse(line, `applies.paths has ${JSON.stringify(pattern)}, which isn't a path pattern litter takes: ${why}`)
      }
      out.paths = list
    } else out[key as 'workflows' | 'roles'] = list
  }
  doc.applies = out
  return i
}

/** The entries of an inline list's or map's inside, split at commas outside quotes. */
function splitFlow(inner: string, n: number): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (let k = 0; k < inner.length; k++) {
    const c = inner[k]!
    if (quote === '"') {
      cur += c
      if (c === '\\') cur += inner[++k] ?? ''
      else if (c === '"') quote = null
    } else if (quote === "'") {
      cur += c
      if (c === "'") {
        if (inner[k + 1] === "'") cur += inner[++k]
        else quote = null
      }
    } else if (c === ',') {
      out.push(cur.trim())
      cur = ''
    } else {
      if ((c === '"' || c === "'") && cur.trim() === '') quote = c
      cur += c
    }
  }
  if (quote) refuse(n, 'a quoted value with no closing quote')
  if (cur.trim() !== '' || out.length > 0) out.push(cur.trim())
  return out
}

/**
 * One scalar: bare, 'single' (with '' for a quote) or "double" (with JSON's
 * escapes). A bare one YAML would read as something else is refused, so
 * the file means the same to every YAML reader.
 */
function scalar(v: string, n: number, flow: boolean): string {
  if (v.startsWith('"')) {
    if (v.length < 2 || !v.endsWith('"')) refuse(n, 'a double-quoted value with no closing quote')
    try {
      const s: unknown = JSON.parse(v)
      if (typeof s === 'string') return s
    } catch {}
    return refuse(n, 'a double-quoted value litter can\'t read; escape only with \\" \\\\ \\n \\t or \\uXXXX')
  }
  if (v.startsWith("'")) {
    if (v.length < 2 || !v.endsWith("'") || v.slice(1, -1).replace(/''/g, '').includes("'")) refuse(n, "a single-quoted value must end with ' and write a quote inside it as ''")
    return v.slice(1, -1).replace(/''/g, "'")
  }
  if (/^[[\]{}&*!|>%@`#]/.test(v) || /^[-?:](\s|$)/.test(v)) refuse(n, `${JSON.stringify(v)} must be quoted: YAML reads its first character as syntax`)
  if (/\s#/.test(v) || /:(\s|$)/.test(v)) refuse(n, `${JSON.stringify(v)} must be quoted: YAML reads ': ' and ' #' in it as syntax`)
  if (flow && /[[\]{},]/.test(v)) refuse(n, `${JSON.stringify(v)} must be quoted inside [ ] or { }`)
  return v
}

// ---------------------------------------------------------------------------
// The body

/** The four sections, from line `from` (0-based). Text outside them is refused. */
function body(lines: string[], from: number, doc: RuleDoc): void {
  const found = new Map<string, { at: number; text: string[] }>()
  let cur: string[] | null = null
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]!
    const h = /^## (.*)$/.exec(line)
    if (h) {
      const title = h[1]!.trim()
      if (!(title in SECTIONS)) refuse(i + 1, `## ${title} isn't one of a rule's sections: ## Rule, ## Why, ## Exceptions, ## How to check`)
      if (found.has(title)) refuse(i + 1, `## ${title} is given twice`)
      cur = []
      found.set(title, { at: i + 1, text: cur })
      continue
    }
    if (cur) cur.push(line)
    else if (line.trim() !== '') refuse(i + 1, 'text before ## Rule; the body is the sections ## Rule, ## Why, ## Exceptions and ## How to check')
  }
  const text = (title: string) => trimBlank(found.get(title)?.text ?? [])
  doc.body.rule = text('Rule').join('\n')
  if (doc.body.rule.trim() === '') refuse(found.get('Rule')?.at ?? from + 1, 'a rule file needs a ## Rule section that says the rule')
  doc.body.why = text('Why').join('\n')
  doc.body.exceptions = items(text('Exceptions'))
  doc.body.howToCheck = items(text('How to check'))
}

function trimBlank(lines: string[]): string[] {
  let a = 0
  let b = lines.length
  while (a < b && lines[a]!.trim() === '') a++
  while (b > a && lines[b - 1]!.trim() === '') b--
  return lines.slice(a, b)
}

/** A section's list: each `- ` or `* ` starts an entry, and the lines under it continue it (two spaces of indent dropped). */
function items(lines: string[]): string[] {
  const out: string[][] = []
  for (const line of lines) {
    const m = /^[-*] (.*)$/.exec(line)
    if (m) out.push([m[1]!])
    else if (line.trim() === '') continue
    else if (out.length === 0) out.push([line])
    else out.at(-1)!.push(line.replace(/^ {1,2}/, ''))
  }
  return out.map(l => l.join('\n'))
}

// ---------------------------------------------------------------------------
// Rendering

const RESERVED = /^(true|false|yes|no|on|off|y|n|null|~)$/i
const NUMERIC = /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$|^0x[0-9a-fA-F]+$|^0o[0-7]+$|^[-+]?\.inf$|^\.nan$/i

/** A scalar as YAML reads it back: bare when that's safe, else double-quoted with JSON's escapes. */
function quote(s: string, flow: boolean): string {
  const bare =
    s !== '' &&
    s === s.trim() &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(s) &&
    !/\s#|:(\s|$)/.test(s) &&
    !/[\u0000-\u001f\u007f\u2028\u2029]/.test(s) &&
    !RESERVED.test(s) &&
    !NUMERIC.test(s) &&
    !(flow && /[,[\]{}]/.test(s))
  return bare ? s : JSON.stringify(s)
}

const list = (xs: string[]) => `[${xs.map(x => quote(x, true)).join(', ')}]`

const bullets = (xs: string[]) => xs.map(x => `- ${x.split('\n').join('\n  ')}`).join('\n')

/**
 * Writes a rule file: the known fields in 16.2's order, then `extra`, then
 * the body. A parsed file renders back to the same bytes when nothing changed.
 * A draft's empty `id` and version 0 are left out.
 */
export function renderRule(doc: RuleDoc): string {
  const fm: string[] = []
  if (doc.id !== '') fm.push(`id: ${quote(doc.id, false)}`)
  if (doc.version > 0) fm.push(`version: ${doc.version}`)
  fm.push(`status: ${doc.status}`, `type: ${doc.type}`, 'applies:', `  paths: ${list(doc.applies.paths)}`)
  if (doc.applies.workflows) fm.push(`  workflows: ${list(doc.applies.workflows)}`)
  if (doc.applies.roles) fm.push(`  roles: ${list(doc.applies.roles)}`)
  fm.push(`  when: ${quote(doc.applies.when, false)}`)
  if (doc.overrides !== undefined) fm.push(`overrides: ${quote(doc.overrides, false)}`)
  if (doc.accepted) {
    const parts = ACCEPTED_KEYS.filter(k => doc.accepted![k] !== undefined).map(k => `${k}: ${quote(doc.accepted![k]!, true)}`)
    fm.push(`accepted: ${parts.length ? `{ ${parts.join(', ')} }` : '{}'}`)
  }
  fm.push(`export: ${doc.export}`)
  for (const [key, raw] of doc.extra) fm.push(`${key}:${raw}`)
  const parts = [`---\n${fm.join('\n')}\n---\n`, `## Rule\n${doc.body.rule}\n`]
  if (doc.body.why !== '') parts.push(`## Why\n${doc.body.why}\n`)
  if (doc.body.exceptions.length > 0) parts.push(`## Exceptions\n${bullets(doc.body.exceptions)}\n`)
  if (doc.body.howToCheck.length > 0) parts.push(`## How to check\n${bullets(doc.body.howToCheck)}\n`)
  return parts.join('\n')
}
