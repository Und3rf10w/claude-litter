// Rules exported as Claude Code rule files (plan 16.7, phase 6): every rule
// in force with `export: true` is written where Claude Code loads rule files
// on its own, so a session that starts no litter run follows it too. User
// rules go to `<config dir>/rules/litter/`, project rules to the primary
// checkout's `.claude/rules/litter/` (yours to commit, with `.litter/`), and
// local rules to `.claude/rules/litter-local/`, which `info/exclude` keeps out.
//
// A file is the mod's while its bytes are the ones it last wrote there (each
// write is a `rule.export` record with the bytes' sha256, in the rule's own
// scope's ledger), or a render of a version of the rule it knows (a
// teammate's checkout, whose committed exports have no records here), or an
// edit you adopted and then accepted. Only the mod's files are rewritten or
// removed: a hand edit is left alone, and the pane shows it, so you can adopt
// it as the rule's next version or put litter's copy back.
//
// Claude Code loads a rule with `paths:` frontmatter only after a Read of a
// matching file (16.7, S2). A ban has to hold for writes, which no Read may
// come before, so a ban is exported without `paths:` and names its paths in
// its text. A rule whose `workflows` or `roles` narrow it to litter's runs
// isn't exported, since a session with no run has neither.

import type { Entry, Ports } from '../ports'
import type { Author } from '../records/core'
import type {
  LoadedRule,
  ProposalRef,
  RuleDoc,
  RuleExportBody,
  RuleExportState,
  RuleExportView,
  RuleLedgerStore,
  RuleProposeBody,
  RuleRef,
  RuleScope,
  RuleStatus,
} from '../records/rules'
import { localRuleExportDir, localRulesDir, projectRuleExportDir, projectRulesDir, ruleExportEditsDir, ruleHistoryDir, userRuleExportDir, userRulesDir } from '../layout'
import { atomicWrite, remove, sha256 } from '../fsx'
import { primaryOf } from '../lifecycle'
import { session } from '../session'
import { listWorktrees } from '../worktrees'
import { appendRuleRecord, readRuleLedger } from './ledger'
import { parseRule, renderRule } from './format'
import { expandBraceSets, isPathless } from './match'
import { addExclude, inRuleSteps, loadRules, proposalsOf } from './store'

const MOD: Author = { source: 'mod' }
const RULE_FILE = /^([UPL]-[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?)\.md$/
const HISTORY_FILE = /^([UPL]-[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?)@([1-9][0-9]*)\.md$/
const FOOTER = /^Managed by litter \(([UPL]-[a-z0-9-]+) v([1-9][0-9]*)\)\./
/** What `info/exclude` gets at the first local export. */
export const LOCAL_EXPORT_EXCLUDE = '/.claude/rules/litter-local/'
/** The worktrees a pane row names, at most. */
const STALE_LISTED = 20

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const storeOf = (scope: RuleScope): RuleLedgerStore => (scope === 'user' ? 'user' : 'repo')
const flat = (text: string): string => text.replace(/\s*\n\s*/g, ' ').trim()
const quoted = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

type Refusal = { ok: false; reason: string }
const no = (reason: string): Refusal => ({ ok: false, reason })

// ---------------------------------------------------------------------------
// The file

/** The footer every export ends with: its id and version, so `<rules>` can win over an older copy (16.7). */
export const exportFooter = (id: string, version: number): string =>
  `Managed by litter (${id} v${version}). Change it with /litter:rules or in the rules pane (/litter rules); an edit made here shows there, so you can adopt it.`

/**
 * The `paths:` list an export carries: the rule's patterns with their brace
 * sets expanded, as Claude Code reads them (match.ts). None for a ban, or for
 * a rule with no paths.
 */
export function exportPaths(doc: RuleDoc): string[] {
  if (doc.type === 'ban' || isPathless(doc.applies.paths)) return []
  const out: string[] = []
  for (const pattern of doc.applies.paths) {
    let parts: string[]
    try {
      parts = expandBraceSets(pattern)
    } catch {
      parts = [pattern]
    }
    for (const x of parts) if (x !== '' && !out.includes(x)) out.push(x)
  }
  return out
}

/** Claude Code loads it only once a Read touches a file its paths match (S2). */
export const bindsAfterRead = (doc: RuleDoc): boolean => exportPaths(doc).length > 0

/**
 * The rule file an export writes: `paths:` frontmatter when it has any, the
 * rule (`## Ban` for a ban) with when it applies, what a ban protects, and a
 * local override's user rule; its exceptions; its why on one line; and the
 * footer. How to check stays in `<rules>`: it's for litter's critics.
 */
export function renderExport(doc: RuleDoc, scope: RuleScope): string {
  const out: string[] = []
  const paths = exportPaths(doc)
  if (paths.length > 0) out.push('---', 'paths:', ...paths.map(x => `  - ${quoted(x)}`), '---', '')
  out.push(doc.type === 'ban' ? '## Ban' : '## Rule', doc.body.rule.trim())
  const notes: string[] = []
  if (flat(doc.applies.when) !== '') notes.push(`Applies when: ${flat(doc.applies.when)}`)
  if (doc.type === 'ban' && !isPathless(doc.applies.paths)) notes.push(`It protects: ${doc.applies.paths.join(', ')}`)
  if (scope === 'local' && doc.overrides) notes.push(`In this repository it replaces your user rule ${doc.overrides}.`)
  if (notes.length > 0) out.push('', ...notes)
  const exceptions = doc.body.exceptions.map(flat).filter(x => x !== '')
  if (exceptions.length > 0) out.push('', '## Exceptions', ...exceptions.map(x => `- ${x}`))
  if (flat(doc.body.why) !== '') out.push('', '## Why', flat(doc.body.why))
  out.push('', exportFooter(doc.id, doc.version), '')
  return out.join('\n')
}

/** A YAML scalar as an export's frontmatter may spell it: bare, double- or single-quoted. */
function unquote(raw: string): string {
  const s = raw.trim()
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\(.)/g, '$1')
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'")
  return s
}

/** Splits at commas outside braces and brackets, as Claude Code splits a `paths:` entry. */
function commas(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let part = ''
  for (const ch of text) {
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      out.push(part)
      part = ''
    } else part += ch
  }
  out.push(part)
  return out.map(s => s.trim()).filter(s => s !== '')
}

/** The `paths:` of a frontmatter block: a block list, an inline list, or a comma string; null when it has none. */
function frontmatterPaths(block: string): string[] | null {
  const lines = block.split('\n')
  const at = lines.findIndex(l => /^paths:/.test(l))
  if (at < 0) return null
  const value = lines[at]!.slice('paths:'.length).trim()
  const items: string[] = []
  if (value.startsWith('[') && value.endsWith(']')) items.push(...commas(value.slice(1, -1)).map(unquote))
  else if (value !== '') items.push(unquote(value))
  else {
    for (const l of lines.slice(at + 1)) {
      const m = /^\s+-\s*(.*)$/.exec(l)
      if (m) items.push(unquote(m[1]!))
      else if (/^\S/.test(l)) break
    }
  }
  return items.flatMap(commas).filter(x => x !== '')
}

/**
 * The rule an edited export stands for, `base` (the version in force) with
 * what the file says now: its type from the heading, its rule, when it
 * applies, its paths (a rule's frontmatter, a ban's "It protects"), its
 * exceptions and its why, and How to check when the edit added one. Other
 * sections join the rule's text. What litter keeps and the file never held
 * (its id, `extra`, `workflows`, `roles`, `overrides`, `export`) is the base's.
 */
export function parseExport(text: string, base: RuleDoc): RuleDoc {
  let body = text.replace(/\r\n/g, '\n')
  let paths: string[] | null = null
  const fm = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(body)
  if (fm) {
    paths = frontmatterPaths(fm[1]!)
    body = body.slice(fm[0].length)
  }
  const sections: { heading: string | null; lines: string[] }[] = [{ heading: null, lines: [] }]
  for (const line of body.split('\n')) {
    if (FOOTER.test(line.trim())) continue
    const h = /^##\s+(.+?)\s*$/.exec(line)
    if (h) sections.push({ heading: h[1]!, lines: [] })
    else sections[sections.length - 1]!.lines.push(line)
  }
  const named = (...names: string[]) => sections.find(s => s.heading !== null && names.includes(s.heading.toLowerCase()))
  const joined = (lines: readonly string[]) => lines.join('\n').trim()
  const items = (lines: readonly string[]): string[] => {
    const out: string[] = []
    for (const l of lines) {
      const m = /^\s*[-*]\s+(.*)$/.exec(l)
      if (m) out.push(m[1]!.trim())
      else if (l.trim() === '') continue
      else if (out.length > 0) out[out.length - 1] = `${out[out.length - 1]} ${l.trim()}`
      else out.push(l.trim())
    }
    return out
  }
  const head = named('rule', 'ban')
  const type = head ? (head.heading!.toLowerCase() === 'ban' ? 'ban' : 'rule') : base.type
  let when = ''
  let protects: string[] | null = null
  const ruleLines: string[] = []
  for (const l of head?.lines ?? []) {
    const t = l.trim()
    if (/^applies when:/i.test(t)) when = t.slice('applies when:'.length).trim()
    else if (/^it protects:/i.test(t)) protects = commas(t.slice('it protects:'.length))
    else if (/^in this repository it replaces your user rule /i.test(t)) continue
    else ruleLines.push(l)
  }
  // Sections the export never writes, kept as text in the rule.
  const known = new Set(['rule', 'ban', 'exceptions', 'why', 'how to check'])
  const others = sections.filter(s => s !== head && (s.heading === null ? joined(s.lines) !== '' : !known.has(s.heading.toLowerCase())))
  let rule = joined(ruleLines)
  for (const s of others) rule = [rule, s.heading === null ? joined(s.lines) : `${s.heading}: ${joined(s.lines)}`].filter(x => x !== '').join('\n\n')
  const exceptionsAt = named('exceptions')
  const whyAt = named('why')
  const checksAt = named('how to check')
  let applied = type === 'ban' ? (protects ?? []) : (paths ?? protects ?? [])
  // What reads as the export wrote it keeps the base's own spelling: brace sets, line breaks.
  const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])
  const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(x => b.includes(x))
  if (sameSet(applied, type === 'ban' ? base.applies.paths : exportPaths({ ...base, type }))) applied = base.applies.paths
  if (rule === '' || rule === base.body.rule.trim()) rule = base.body.rule
  if (when === flat(base.applies.when)) when = base.applies.when
  let why = whyAt ? joined(whyAt.lines) : ''
  if (why === flat(base.body.why)) why = base.body.why
  let exceptions = exceptionsAt ? items(exceptionsAt.lines) : []
  if (sameList(exceptions, base.body.exceptions.map(flat).filter(x => x !== ''))) exceptions = base.body.exceptions
  return {
    ...base,
    type,
    applies: { ...base.applies, paths: applied, when },
    body: { rule, why, exceptions, howToCheck: checksAt ? items(checksAt.lines) : base.body.howToCheck },
  }
}

/** The same rule but for its version and acceptance (store.ts's sameRule). */
const sameRule = (a: RuleDoc, b: RuleDoc): boolean =>
  renderRule({ ...a, version: 1, status: 'accepted', accepted: undefined }) === renderRule({ ...b, version: 1, status: 'accepted', accepted: undefined })

// ---------------------------------------------------------------------------
// What's on disk, and what the mod would do

type LastExport = RuleExportBody & { seq: number }
type Adoption = { ref: ProposalRef; status: RuleStatus; path: string; sha256: string }

type Ctx = {
  rules: LoadedRule[]
  host: 'claude-code' | 'codex'
  configDir: string | null
  configWhy: string | null
  primary: string | null
  /** The latest `rule.export` per path, per store; null for a ledger that can't be trusted, with why. */
  last: Record<RuleLedgerStore, Map<string, LastExport> | null>
  ledgerWhy: Record<RuleLedgerStore, string | null>
  adoptions: Adoption[]
  /** Each export folder's entries by name; an absent folder's map is empty. */
  entries: Map<string, Map<string, Entry>>
  problems: string[]
}

/** A rule in force, and what its export is. */
type Target = {
  rule: LoadedRule
  doc: RuleDoc
  scope: RuleScope
  path: string | null
  state: Exclude<RuleExportState, 'pending'>
  why?: string
  expected: string | null
  actual: string | null
  /** The file's sha256, when it's there. */
  actualSha: string | null
  /** What the sync does: write the expected bytes, record that they're there, or nothing. */
  act: 'write' | 'record' | 'none'
  adoption: Adoption | null
}

/** A rule file in an export folder that's no rule's export now: its rule was retired, replaced, or isn't exported. */
type Orphan = { scope: RuleScope; path: string; id: string; mine: boolean; version: number }

function exportDirOf(ctx: Ctx, scope: RuleScope): string | null {
  if (scope === 'user') return ctx.configDir === null ? null : userRuleExportDir(ctx.configDir)
  if (ctx.primary === null) return null
  return scope === 'project' ? projectRuleExportDir(ctx.primary) : localRuleExportDir(ctx.primary)
}

function ruleDirOf(ctx: Ctx, scope: RuleScope): string | null {
  if (scope === 'user') return ctx.configDir === null ? null : userRulesDir(ctx.configDir)
  if (ctx.primary === null) return null
  return scope === 'project' ? projectRulesDir(ctx.primary) : localRulesDir(ctx.primary)
}

async function readCtx(p: Ports, litterDir: string, loaded?: { rules: LoadedRule[] }): Promise<Ctx> {
  const problems: string[] = []
  let configDir: string | null = null
  let configWhy: string | null = null
  try {
    configDir = await p.configDir()
  } catch (err) {
    configWhy = errText(err)
  }
  const rules = loaded?.rules ?? (await loadRules(p, litterDir)).rules
  const last: Ctx['last'] = { repo: null, user: null }
  const ledgerWhy: Ctx['ledgerWhy'] = { repo: null, user: null }
  for (const store of ['repo', 'user'] as const) {
    if (store === 'user' && configDir === null) {
      ledgerWhy.user = `your config dir isn't known (${configWhy ?? 'no answer'})`
      continue
    }
    try {
      const read = await readRuleLedger(p, litterDir, store)
      if (read.tampered) {
        ledgerWhy[store] = `the ${store === 'repo' ? "repository's" : 'user'} rules ledger is tampered at record ${read.tampered.seq}, so no export is recorded in it`
        continue
      }
      const m = new Map<string, LastExport>()
      for (const r of read.records) {
        const b = r.body as Partial<RuleExportBody>
        if (r.kind === 'rule.export' && typeof b.path === 'string') m.set(b.path, { ...(b as RuleExportBody), seq: r.seq })
      }
      last[store] = m
    } catch (err) {
      ledgerWhy[store] = `the ${store === 'repo' ? "repository's" : 'user'} rules ledger can't be read (${errText(err)})`
    }
  }
  const adoptions: Adoption[] = []
  try {
    for (const v of await proposalsOf(p, litterDir, {})) {
      const f = v.body.fromExport
      if (v.body.source === 'export' && f && typeof f.path === 'string' && typeof f.sha256 === 'string') adoptions.push({ ref: v.ref, status: v.status, path: f.path, sha256: f.sha256 })
    }
  } catch (err) {
    problems.push(`the proposals couldn't be read, so no adopted edit counts: ${errText(err)}`)
  }
  const ctx: Ctx = { rules, host: session().host, configDir, configWhy, primary: primaryOf(litterDir), last, ledgerWhy, adoptions, entries: new Map(), problems }
  for (const scope of ['user', 'project', 'local'] as const) {
    const dir = exportDirOf(ctx, scope)
    if (dir === null) continue
    const m = new Map<string, Entry>()
    try {
      if (await p.fs.exists(dir)) for (const e of await p.fs.list(dir)) m.set(e.name, e)
    } catch (err) {
      problems.push(`${dir} can't be listed: ${errText(err)}`)
    }
    ctx.entries.set(dir, m)
  }
  return ctx
}

/** Whether `text` is a render of a version of rule `id` the mod knows: the one in force, or one in its folder's `.history`. */
async function knownRender(p: Ports, ctx: Ctx, scope: RuleScope, id: string, text: string): Promise<boolean> {
  for (const r of ctx.rules) if (r.scope === scope && r.delivered?.id === id && renderExport(r.delivered, scope) === text) return true
  const dir = ruleDirOf(ctx, scope)
  if (dir === null) return false
  const hist = ruleHistoryDir(dir)
  try {
    if (!(await p.fs.exists(hist))) return false
    for (const e of await p.fs.list(hist)) {
      const m = HISTORY_FILE.exec(e.name)
      if (!m || m[1] !== id || e.kind !== 'file' || e.isLink) continue
      const parsed = parseRule(await p.fs.read(`${hist}/${e.name}`))
      if (parsed.ok && renderExport(parsed.doc, scope) === text) return true
    }
  } catch {
    // An unreadable history knows nothing.
  }
  return false
}

const adoptionOf = (ctx: Ctx, path: string, sha: string | null): Adoption | null =>
  sha === null ? null : (ctx.adoptions.filter(a => a.path === path && a.sha256 === sha).pop() ?? null)

/** Whether the file's bytes are the mod's to rewrite or remove. */
async function isMine(p: Ports, ctx: Ctx, scope: RuleScope, id: string, path: string, text: string, sha: string): Promise<boolean> {
  if (ctx.last[storeOf(scope)]?.get(path)?.sha256 === sha) return true
  const adopted = adoptionOf(ctx, path, sha)
  if (adopted && (adopted.status === 'accepted' || adopted.status === 'retired')) return true
  return knownRender(p, ctx, scope, id, text)
}

async function readEntry(p: Ports, path: string, entry: Entry | undefined): Promise<{ text: string | null; why?: string }> {
  if (!entry) return { text: null }
  if (entry.kind !== 'file' || entry.isLink) return { text: null, why: `${path} isn't a plain file (a folder or a link), so litter leaves it` }
  try {
    return { text: await p.fs.read(path) }
  } catch (err) {
    return { text: null, why: `${path} can't be read (${errText(err)}), so litter leaves it` }
  }
}

async function targetOf(p: Ports, ctx: Ctx, r: LoadedRule): Promise<Target> {
  const doc = r.delivered!
  const scope = r.scope
  const base = { rule: r, doc, scope, path: null, expected: null, actual: null, actualSha: null, act: 'none' as const, adoption: null }
  if (ctx.host === 'codex') return { ...base, state: 'none', why: 'litter on Codex writes no Claude Code rule files' }
  if (!doc.export) return { ...base, state: 'off' }
  if ((doc.applies.workflows?.length ?? 0) > 0 || (doc.applies.roles?.length ?? 0) > 0) return { ...base, state: 'litter-only' }
  const dir = exportDirOf(ctx, scope)
  if (dir === null) {
    return { ...base, state: 'none', why: scope === 'user' ? `your config dir isn't known (${ctx.configWhy ?? 'no answer'})` : 'a bare repository has no checkout to export into' }
  }
  const lastOf = ctx.last[storeOf(scope)]
  if (lastOf === null) return { ...base, state: 'none', why: ctx.ledgerWhy[storeOf(scope)] ?? 'its rules ledger can\'t be read' }
  const name = `${doc.id}.md`
  const path = `${dir}/${name}`
  const expected = renderExport(doc, scope)
  const expectedSha = await sha256(expected)
  const last = lastOf.get(path)
  const entry = ctx.entries.get(dir)?.get(name)
  const read = await readEntry(p, path, entry)
  const at = { ...base, path, expected }
  if (read.why) return { ...at, state: 'edited', why: read.why }
  const actual = read.text
  if (actual === null) {
    // Gone: written again for a new version, or after the mod removed it; one you deleted stays deleted.
    if (!last || last.sha256 === null || last.version !== doc.version) return { ...at, state: 'exported', act: 'write' }
    return { ...at, state: 'deleted' }
  }
  const actualSha = await sha256(actual)
  const adoption = adoptionOf(ctx, path, actualSha)
  if (actual === expected) {
    const recorded = last?.sha256 === expectedSha && last.version === doc.version
    return { ...at, actual, actualSha, adoption, state: 'exported', act: recorded ? 'none' : 'record' }
  }
  if (await isMine(p, ctx, scope, doc.id, path, actual, actualSha)) return { ...at, actual, actualSha, adoption, state: 'exported', act: 'write' }
  return { ...at, actual, actualSha, adoption, state: 'edited', why: 'its bytes are none litter wrote (a hand edit, or a Write)' }
}

type Planned = { targets: Target[]; orphans: Orphan[]; ctx: Ctx }

/** Every rule in force's export, and the files in the export folders that are no rule's now. Writes nothing. */
async function plan(p: Ports, litterDir: string, loaded?: { rules: LoadedRule[] }): Promise<Planned> {
  const ctx = await readCtx(p, litterDir, loaded)
  const targets: Target[] = []
  for (const r of ctx.rules) if (r.delivered) targets.push(await targetOf(p, ctx, r))
  const taken = new Set(targets.flatMap(t => (t.path !== null ? [t.path] : [])))
  const orphans: Orphan[] = []
  if (ctx.host !== 'codex') {
    for (const scope of ['user', 'project', 'local'] as const) {
      const dir = exportDirOf(ctx, scope)
      if (dir === null) continue
      for (const [name, entry] of ctx.entries.get(dir) ?? []) {
        if (!name.endsWith('.md')) continue
        const path = `${dir}/${name}`
        const m = RULE_FILE.exec(name)
        if (!m) {
          ctx.problems.push(`${path}: not a litter rule file's name (<id>.md), so litter leaves it; Claude Code loads it as a rule all the same`)
          continue
        }
        if (taken.has(path)) continue
        const read = await readEntry(p, path, entry)
        if (read.text === null) {
          if (read.why) ctx.problems.push(read.why)
          continue
        }
        const sha = await sha256(read.text)
        const last = ctx.last[storeOf(scope)]
        const footer = FOOTER.exec(read.text.trim().split('\n').pop()?.trim() ?? '')
        const version = last?.get(path)?.version ?? (footer ? Number(footer[2]) : 0)
        // A ledger that can't be trusted proves nothing, so nothing is removed on its word.
        const mine = last !== null && (await isMine(p, ctx, scope, m[1]!, path, read.text, sha))
        orphans.push({ scope, path, id: m[1]!, mine, version })
      }
    }
  }
  return { targets, orphans, ctx }
}

// ---------------------------------------------------------------------------
// The views

/** A pattern from `claudeMdExcludes`, matched as Claude Code's picomatch does (`dot: true`) against an absolute path; null when it can't be read. */
export function excludeMatcher(glob: string): RegExp | null {
  const g = glob.replace(/\\/g, '/')
  const convert = (s: string): string => {
    let re = ''
    for (let i = 0; i < s.length; i++) {
      const c = s[i]!
      if (c === '*') {
        if (s[i + 1] === '*' && (i === 0 || s[i - 1] === '/') && (i + 2 === s.length || s[i + 2] === '/')) {
          if (i + 2 === s.length) re += '.*'
          else re += '(?:.*/)?'
          i += i + 2 === s.length ? 1 : 2
          continue
        }
        while (s[i + 1] === '*') i++
        re += '[^/]*'
      } else if (c === '?') re += '[^/]'
      else if (c === '[') {
        const close = s.indexOf(']', i + 1)
        if (close < 0) re += '\\['
        else {
          const body = s.slice(i + 1, close).replace(/\\/g, '\\\\')
          re += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`
          i = close
        }
      } else if (c === '{') {
        let depth = 0
        let close = -1
        for (let j = i; j < s.length; j++) {
          if (s[j] === '{') depth++
          else if (s[j] === '}' && --depth === 0) {
            close = j
            break
          }
        }
        if (close < 0) re += '\\{'
        else {
          re += `(?:${commas(s.slice(i + 1, close)).map(convert).join('|')})`
          i = close
        }
      } else re += c.replace(/[.+^$()|\\\]}]/g, '\\$&')
    }
    return re
  }
  try {
    return new RegExp(`^${convert(g)}$`)
  } catch {
    return null
  }
}

/** The first `claudeMdExcludes` pattern of your settings that matches `path`, or null. */
async function excludedBy(p: Ports, path: string): Promise<string | null> {
  let raw: unknown
  try {
    raw = (await p.settings()).claudeMdExcludes
  } catch {
    return null
  }
  if (!Array.isArray(raw)) return null
  for (const x of raw) if (typeof x === 'string' && x !== '' && excludeMatcher(x)?.test(path)) return x
  return null
}

/** The linked worktrees under `<primary>/.claude/worktrees/`, by folder name, whose copy of a project export isn't `expected`. */
async function staleWorktrees(p: Ports, primary: string, id: string, expected: string): Promise<string[]> {
  const list = await listWorktrees(p, primary).catch(() => null)
  if (!list) return []
  let root = `${primary}/.claude/worktrees/`
  try {
    const real = (await p.fs.stat(primary, { resolve: true })).realPath
    if (real) root = `${real}/.claude/worktrees/`
  } catch {
    // The path as litter has it.
  }
  const out: string[] = []
  for (const w of list) {
    if (!w.path.startsWith(root)) continue
    const copy = `${w.path}/.claude/rules/litter/${id}.md`
    const text = await p.fs.read(copy).catch(() => null)
    if (text !== expected) out.push(w.path.slice(root.length))
  }
  return out.sort()
}

function viewOf(t: Target): RuleExportView {
  const view: RuleExportView = {
    id: t.doc.id,
    version: t.doc.version,
    scope: t.scope,
    path: t.path,
    state: t.act === 'write' ? 'pending' : t.state,
    bindsAfterRead: bindsAfterRead(t.doc),
    expected: t.expected,
    actual: t.actual,
    staleIn: [],
  }
  if (t.why) view.why = t.why
  if (t.adoption) view.adoption = { proposal: t.adoption.ref, status: t.adoption.status }
  return view
}

/**
 * Where each rule in force stands as a Claude Code rule file (the pane, and
 * `rule.find { id }`), and what's wrong in the export folders: an edited
 * file whose rule is no longer exported, a file that isn't a rule's. With
 * `worktrees`, a project export lists the worktrees whose copy differs; with
 * `settings`, the `claudeMdExcludes` pattern that drops it. Writes nothing.
 */
export async function exportsOf(
  p: Ports,
  litterDir: string,
  opts: { id?: string; worktrees?: boolean; settings?: boolean; loaded?: { rules: LoadedRule[] } } = {},
): Promise<{ views: RuleExportView[]; problems: string[] }> {
  const { targets, orphans, ctx } = await plan(p, litterDir, opts.loaded)
  const views: RuleExportView[] = []
  for (const t of targets) {
    if (opts.id !== undefined && t.doc.id !== opts.id) continue
    const view = viewOf(t)
    if (opts.worktrees && t.scope === 'project' && ctx.primary !== null && t.expected !== null) {
      const stale = await staleWorktrees(p, ctx.primary, t.doc.id, t.expected)
      view.staleIn = stale.length > STALE_LISTED ? [...stale.slice(0, STALE_LISTED), `${stale.length - STALE_LISTED} more`] : stale
    }
    if (opts.settings && t.path !== null) {
      const by = await excludedBy(p, t.path)
      if (by !== null) view.excludedBy = by
    }
    views.push(view)
  }
  const problems = [...ctx.problems]
  for (const o of orphans) {
    if (opts.id !== undefined && o.id !== opts.id) continue
    if (o.mine) problems.push(`${o.path}: litter's copy of ${o.id}, which isn't exported now (retired, replaced, or not exported); the next sync removes it`)
    else problems.push(`${o.path}: a rule file for ${o.id} that litter didn't write (a hand edit), and ${o.id} isn't exported now; litter leaves it, so delete it if it's stale`)
  }
  return { views, problems }
}

// ---------------------------------------------------------------------------
// The sync, and the pane's two steps

async function recordExport(p: Ports, litterDir: string, scope: RuleScope, body: Omit<RuleExportBody, 'scope' | 'via'>): Promise<void> {
  const full: RuleExportBody = { id: body.id, version: body.version, scope, path: body.path, sha256: body.sha256, via: 'mod' }
  await appendRuleRecord(p, litterDir, storeOf(scope), 'rule.export', MOD, full)
}

async function writeExport(p: Ports, litterDir: string, ctx: Ctx, t: Target): Promise<void> {
  if (t.scope === 'local' && ctx.primary !== null) await addExclude(p, ctx.primary, LOCAL_EXPORT_EXCLUDE)
  await atomicWrite(p, t.path!, t.expected!)
  await recordExport(p, litterDir, t.scope, { id: t.doc.id, version: t.doc.version, path: t.path!, sha256: await sha256(t.expected!) })
}

export type SyncResult = { written: string[]; removed: string[]; recorded: number; problems: string[] }

/**
 * Brings every export in line (16.7): writes a rule in force's file that's
 * missing (unless you deleted that version's) or holds bytes the mod may
 * rewrite; records a file that's already right; removes the mod's file of a
 * rule that isn't exported now. Edited files are left alone. Runs in the
 * rules' steps line, so an accept never lands halfway through it: at
 * session.start, and after the pane's accept, retire, restore and adopt.
 */
export function syncExports(p: Ports, litterDir: string): Promise<SyncResult> {
  return inRuleSteps(litterDir, () => syncNow(p, litterDir))
}

async function syncNow(p: Ports, litterDir: string): Promise<SyncResult> {
  const out: SyncResult = { written: [], removed: [], recorded: 0, problems: [] }
  if (session().host === 'codex') return out
  const { targets, orphans, ctx } = await plan(p, litterDir)
  for (const t of targets) {
    try {
      if (t.act === 'write') {
        await writeExport(p, litterDir, ctx, t)
        out.written.push(t.path!)
      } else if (t.act === 'record') {
        await recordExport(p, litterDir, t.scope, { id: t.doc.id, version: t.doc.version, path: t.path!, sha256: t.actualSha! })
        out.recorded++
      }
    } catch (err) {
      out.problems.push(`${t.path}: not exported (${errText(err)})`)
    }
  }
  for (const o of orphans) {
    if (!o.mine) continue
    try {
      await remove(p, o.path)
      await recordExport(p, litterDir, o.scope, { id: o.id, version: o.version, path: o.path, sha256: null })
      out.removed.push(o.path)
    } catch (err) {
      out.problems.push(`${o.path}: not removed (${errText(err)})`)
    }
  }
  for (const x of out.problems) p.log(`rule export: ${x}`)
  return out
}

/** The sync on a timer, never waited for: session.start's step. A failure is logged. */
export function scheduleSync(p: Ports, litterDir: string): void {
  p.after(0, () => {
    void syncExports(p, litterDir).then(
      () => undefined,
      err => p.log(`rule export failed: ${errText(err)}`),
    )
  })
}

/** The export of `rule` in force, as the pane's press names it. */
async function targetFor(p: Ports, litterDir: string, rule: RuleRef): Promise<{ ok: true; t: Target; ctx: Ctx } | Refusal> {
  if (!rule || typeof rule.id !== 'string' || !Number.isInteger(rule.version)) return no('a rule is { id, version }')
  const { targets, ctx } = await plan(p, litterDir)
  const t = targets.find(x => x.doc.id === rule.id && x.doc.version === rule.version)
  if (!t) return no(`${rule.id}@${rule.version} isn't a rule in force`)
  return { ok: true, t, ctx }
}

/**
 * [Restore file] and [Confirm restore], from the rules pane's ui.press only:
 * writes litter's copy of `rule`'s export over a hand edit, or where you
 * deleted it. An edit is kept first under the rules ledger's folder
 * (ruleExportEditsDir), and `kept` names it.
 */
export function restoreExport(p: Ports, litterDir: string, rule: RuleRef): Promise<{ ok: true; path: string; kept: string | null } | Refusal> {
  return inRuleSteps(litterDir, async () => {
    try {
      const found = await targetFor(p, litterDir, rule)
      if (!found.ok) return found
      const { t, ctx } = found
      if (t.path === null || t.expected === null) return no(`${rule.id} isn't exported${t.why ? `: ${t.why}` : ` (${t.state})`}`)
      if (t.state === 'exported' && t.act === 'none') return no(`${t.path} is litter's copy already`)
      if (t.state === 'edited' && t.actual === null) return no(t.why ?? `${t.path} can't be read, so litter leaves it`)
      let kept: string | null = null
      if (t.state === 'edited' && t.actual !== null) {
        const stamp = new Date(await p.now()).toISOString().replace(/[:.]/g, '-')
        kept = `${ruleExportEditsDir(litterDir)}/${rule.id}@${rule.version}-${stamp}.md`
        await atomicWrite(p, kept, t.actual)
      }
      await writeExport(p, litterDir, ctx, t)
      return { ok: true, path: t.path, kept }
    } catch (err) {
      return no(`the rule file wasn't restored: ${errText(err)}`)
    }
  })
}

/**
 * [Adopt edit], from the rules pane's ui.press only: proposes a hand edit of
 * `rule`'s export as its next version (`rule.propose` with `edits`, source
 * `export` and `fromExport`), for you to accept on the Proposed tab. Once
 * accepted, the next sync writes the new version's file over the edit.
 */
export function adoptExport(p: Ports, litterDir: string, rule: RuleRef): Promise<{ ok: true; proposal: ProposalRef } | Refusal> {
  return inRuleSteps(litterDir, async () => {
    try {
      const found = await targetFor(p, litterDir, rule)
      if (!found.ok) return found
      const { t, ctx } = found
      if (t.state !== 'edited' || t.actual === null || t.actualSha === null || t.path === null) return no(`${t.path ?? rule.id} has no hand edit to adopt`)
      const pending = ctx.adoptions.find(a => a.path === t.path && a.sha256 === t.actualSha && a.status === 'proposed')
      if (pending) return no(`this edit is proposed already (${pending.ref.store}:${pending.ref.seq}): it's on the Proposed tab`)
      const draft = parseExport(t.actual, t.doc)
      if (sameRule(draft, t.doc)) return no(`the edit changes nothing ${rule.id}@${rule.version} holds (only the file's layout); Restore file puts litter's copy back`)
      const doc: RuleDoc = { ...draft, status: 'proposed', accepted: undefined }
      const body: RuleProposeBody = {
        rule: doc.body.rule,
        doc,
        source: 'export',
        scope: t.scope,
        edits: `${rule.id}@${rule.version}`,
        type: doc.type,
        paths: doc.applies.paths,
        when: doc.applies.when,
        fromExport: { path: t.path, sha256: t.actualSha },
      }
      const rec = await appendRuleRecord(p, litterDir, 'repo', 'rule.propose', MOD, body)
      return { ok: true, proposal: { store: 'repo', seq: rec.seq } }
    } catch (err) {
      return no(`the edit wasn't proposed: ${errText(err)}`)
    }
  })
}
