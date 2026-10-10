// The rules store (plan 16.1-16.6): the three scopes' folders, what counts as
// accepted, proposals, and the steps that are yours alone. Owner: phase 3,
// package AD.
//
// acceptRule, dismissRule and retireRule are reached only from the rules
// pane's ui.press (AF's rules/pane.tsx): no path from the record tool, a
// spool line, a timer or a skill may call them (COMMON, "Only you accept").
//
// What counts as accepted is read per file at every load (16.4): a file
// whose bytes are the ones the latest rule.accept for its id recorded; for
// project scope, a file as committed at the primary checkout's HEAD by no
// swarm node's rule-commit; anything else is unverified, with the reason.
// Paths reach the file system and git only after RULE_FILE has passed them.

import type { Ports } from '../ports'
import type { Author, StoredRecord } from '../records/core'
import type {
  CriticProposal,
  LoadedRule,
  ProposalRef,
  RuleAcceptBody,
  RuleDismissBody,
  RuleDoc,
  RuleLedgerStore,
  RuleProposeBody,
  RuleRef,
  RuleRetireBody,
  RuleScope,
  RuleStatus,
  RuleType,
} from '../records/rules'
import type { Git } from '../lifecycle'
import { LedgerTampered } from '../ledgercore'
import { localRulesDir, projectRulesDir, ruleHistoryDir, swarmsDir, SWARM_NAME, userRulesDir } from '../layout'
import { atomicWrite, mkdirp, rename, serial, sha256 } from '../fsx'
import { gitAt, primaryOf } from '../lifecycle'
import { listLaunches, readLaunchLedger } from '../records/swarm'
import { session } from '../session'
import { appendRuleRecord, readRuleLedger, ruleLedgerDir } from './ledger'
import { bytes, foldText, parseRule, patternProblem, renderRule, RULE_MAX_BYTES } from './format'

const MOD: Author = { source: 'mod' }

/** Each scope's id letter (16.2). */
export const SCOPE_LETTER: Readonly<Record<RuleScope, string>> = { user: 'U', project: 'P', local: 'L' }
/** A rule file's name, `<id>.md`; the id is format.ts's RULE_ID. */
const RULE_FILE = /^([UPL]-[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?)\.md$/
/** An earlier or retired version, `.history/<id>@<v>.md`. */
const HISTORY_FILE = /^([UPL]-[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?)@([1-9][0-9]*)\.md$/
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/
/** The project folder, relative to the primary checkout: git's pathspec for it. */
const PROJECT_REL = '.litter/rules'

/** User rules' records are in your ledger; project and local rules' in the repository's (decision 17). */
const storeOf = (scope: RuleScope): RuleLedgerStore => (scope === 'user' ? 'user' : 'repo')
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const short = (oid: string) => oid.slice(0, 7)
const norm = (text: string) => text.replace(/\r\n/g, '\n')
/** The accept, dismiss and retire steps run one at a time per repository. */
const stepsKey = (litterDir: string) => `rules-steps:${litterDir}`

type Refusal = { ok: false; reason: string }
const no = (reason: string): Refusal => ({ ok: false, reason })

// ---------------------------------------------------------------------------
// Where the rules are, and the two ledgers

type Folder = { scope: RuleScope; dir: string }
type Ledger = { records: StoredRecord[]; tampered: string | null }
type Ctx = { primary: string | null; folders: Folder[]; ledgers: Record<RuleLedgerStore, Ledger>; userMissing: string | null; problems: string[] }

async function readStore(p: Ports, litterDir: string, store: RuleLedgerStore): Promise<Ledger> {
  const { records, tampered } = await readRuleLedger(p, litterDir, store)
  return { records, tampered: tampered ? `at record ${tampered.seq}: ${tampered.reason}` : null }
}

/** Both ledgers; yours is empty when the config dir can't be found, with the reason. */
async function readLedgers(
  p: Ports,
  litterDir: string,
): Promise<{ ledgers: Record<RuleLedgerStore, Ledger>; configDir: string | null; userMissing: string | null }> {
  let configDir: string | null = null
  let userMissing: string | null = null
  try {
    configDir = await p.configDir()
  } catch (err) {
    userMissing = errText(err)
  }
  const user = configDir !== null ? await readStore(p, litterDir, 'user') : { records: [], tampered: null }
  return { ledgers: { repo: await readStore(p, litterDir, 'repo'), user }, configDir, userMissing }
}

/**
 * The folders that exist for this repository (a bare repository has no
 * project or local scope, plan 10:1291) and the two ledgers.
 */
async function context(p: Ports, litterDir: string): Promise<Ctx> {
  const problems: string[] = []
  const folders: Folder[] = []
  const { ledgers, configDir, userMissing } = await readLedgers(p, litterDir)
  if (configDir !== null) folders.push({ scope: 'user', dir: userRulesDir(configDir) })
  else problems.push(`your user rules aren't read: ${userMissing}`)
  const primary = primaryOf(litterDir)
  if (primary) folders.push({ scope: 'project', dir: projectRulesDir(primary) }, { scope: 'local', dir: localRulesDir(primary) })
  for (const store of ['repo', 'user'] as const) {
    const t = ledgers[store].tampered
    if (t) problems.push(`the ${store === 'repo' ? "repository's" : 'user'} rules ledger is tampered ${t}: no acceptance in it counts, and nothing more is recorded in it`)
  }
  return { primary, folders, ledgers, userMissing, problems }
}

/** An id's latest step in one ledger: an accept of exact bytes, or a retire. */
type IdStep = { kind: 'accept'; body: RuleAcceptBody } | { kind: 'retire'; version: number }

function idSteps(l: Ledger): Map<string, IdStep> {
  const out = new Map<string, IdStep>()
  if (l.tampered) return out
  for (const r of l.records) {
    const b = r.body as Record<string, unknown>
    if (typeof b.id !== 'string' || typeof b.version !== 'number') continue
    if (r.kind === 'rule.accept') out.set(b.id, { kind: 'accept', body: b as unknown as RuleAcceptBody })
    else if (r.kind === 'rule.retire') out.set(b.id, { kind: 'retire', version: b.version })
  }
  return out
}

/** Null when the ledger's latest step for the id accepted exactly these bytes, in this scope; else why not. */
function ledgerWhy(l: Ledger, step: IdStep | undefined, scope: RuleScope, version: number, sha: string): string | null {
  if (l.tampered) return `the rules ledger is tampered ${l.tampered}, so no acceptance in it counts`
  if (!step) return 'not accepted in the rules pane (a hand edit, a Write, or a copied file)'
  if (step.kind === 'retire') {
    return step.version >= version ? `retired in the rules pane (version ${step.version})` : 'not accepted in the rules pane (a hand edit, a Write, or a copied file)'
  }
  if (step.body.scope !== scope) return `accepted in the rules pane as a ${step.body.scope} rule, not a ${scope} one`
  if (step.body.version !== version) return `version ${step.body.version} is the one accepted, and this file is version ${version}`
  if (step.body.sha256 !== sha) return 'edited since it was accepted (a hand edit or a Write); accept the edit in the rules pane, or restore the file'
  return null
}

/** Why a parsed file can't be one in force where it is, or null. */
function fileProblem(doc: RuleDoc, scope: RuleScope, id: string): string | null {
  if (doc.id !== id) return doc.id === '' ? `its frontmatter has no id (the file is ${id}.md)` : `its id is ${doc.id}, and the file is ${id}.md`
  if (doc.id[0] !== SCOPE_LETTER[scope]) return `${doc.id} is in the ${scope} folder, whose ids start with ${SCOPE_LETTER[scope]}-`
  if (doc.version < 1) return 'its frontmatter has no version'
  if (doc.status !== 'accepted') return `its status is ${doc.status}`
  return null
}

type FileEntry = { name: string; id: string; path: string }

/** The `<id>.md` files directly in a rule folder; anything else there that ends in `.md` is a problem. `.history/` is never read. */
async function ruleFiles(p: Ports, dir: string, problems: string[]): Promise<FileEntry[]> {
  if (!(await p.fs.exists(dir))) return []
  const out: FileEntry[] = []
  for (const e of await p.fs.list(dir)) {
    if (!e.name.endsWith('.md')) continue
    const m = RULE_FILE.exec(e.name)
    if (e.kind !== 'file' || e.isLink) problems.push(`${dir}/${e.name}: not a plain file, so it isn't read as a rule`)
    else if (!m) problems.push(`${dir}/${e.name}: not a rule file's name (<id>.md, with an id like P-keep-tests-near), so it isn't read`)
    else out.push({ name: e.name, id: m[1]!, path: `${dir}/${e.name}` })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

async function readText(p: Ports, path: string, problems: string[]): Promise<string | null> {
  try {
    return await p.fs.read(path)
  } catch (err) {
    problems.push(`${path}: unreadable (${errText(err)})`)
    return null
  }
}

// ---------------------------------------------------------------------------
// loadRules

/**
 * Every rule file in the three scopes, each with its standing (16.4: read per
 * file at every load) and the version in force; and what's wrong (a file
 * that doesn't parse, one id in two scopes, an `overrides` refused).
 */
export async function loadRules(p: Ports, litterDir: string): Promise<{ rules: LoadedRule[]; problems: string[] }> {
  const ctx = await context(p, litterDir)
  return { rules: await loadWith(p, litterDir, ctx), problems: ctx.problems }
}

async function loadWith(p: Ports, litterDir: string, ctx: Ctx): Promise<LoadedRule[]> {
  const rules: LoadedRule[] = []
  let commits: Promise<RuleCommits> | null = null
  const nodeCommits = () => (commits ??= ruleCommits(p, litterDir))
  for (const f of ctx.folders) {
    try {
      if (f.scope === 'project') await loadProject(p, ctx, f, rules, nodeCommits)
      else await loadPlain(p, ctx, f, rules)
    } catch (err) {
      ctx.problems.push(`the ${f.scope} rules in ${f.dir} couldn't all be read: ${errText(err)}`)
    }
  }
  overlaps(rules, ctx.problems)
  return rules
}

/** User and local rules: accepted only by the ledger. An edited file has nothing in force. */
async function loadPlain(p: Ports, ctx: Ctx, f: Folder, out: LoadedRule[]): Promise<void> {
  const ledger = ctx.ledgers[storeOf(f.scope)]
  const steps = idSteps(ledger)
  for (const e of await ruleFiles(p, f.dir, ctx.problems)) {
    const text = await readText(p, e.path, ctx.problems)
    if (text === null) continue
    const parsed = parseRule(text)
    if (!parsed.ok) {
      ctx.problems.push(`${e.path}: ${parsed.error}`)
      continue
    }
    const doc = parsed.doc
    const sha = await sha256(text)
    const why = fileProblem(doc, f.scope, e.id) ?? ledgerWhy(ledger, steps.get(doc.id), f.scope, doc.version, sha)
    out.push({ doc, scope: f.scope, path: e.path, sha256: sha, standing: why === null ? 'accepted' : 'unverified', ...(why === null ? {} : { why }), delivered: why === null ? doc : null })
  }
}

/** The project rule files at HEAD, by name, with their blob ids; none before the first commit. */
async function headRules(git: Git, problems: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if ((await git(['rev-parse', '-q', '--verify', 'HEAD^{commit}'])).code !== 0) return out
  const r = await git(['ls-tree', '-z', 'HEAD', '--', `${PROJECT_REL}/`])
  if (r.code !== 0) {
    problems.push(`the project rules at HEAD couldn't be listed (git ls-tree: ${r.stderr.trim()}), so none counts as committed`)
    return out
  }
  for (const entry of r.stdout.split('\0')) {
    const m = /^([0-7]{6}) blob ([0-9a-f]+)\t([\s\S]*)$/.exec(entry)
    if (!m || m[1] === '120000' || !m[3]!.startsWith(`${PROJECT_REL}/`)) continue
    const name = m[3]!.slice(PROJECT_REL.length + 1)
    if (RULE_FILE.test(name) && OID.test(m[2]!)) out.set(name, m[2]!)
  }
  return out
}

/**
 * Project rules (16.4): accepted by the ledger as user and local rules are;
 * otherwise `accepted (committed)` when the file is HEAD's and no node
 * committed it. An edited or deleted committed rule leaves HEAD's version in
 * force while that version counts as committed. The rules at HEAD are listed
 * with git ls-tree, so a deletion is seen.
 */
async function loadProject(p: Ports, ctx: Ctx, f: Folder, out: LoadedRule[], nodeCommits: () => Promise<RuleCommits>): Promise<void> {
  const git = gitAt(p, ctx.primary!)
  const ledger = ctx.ledgers.repo
  const steps = idSteps(ledger)
  const working = new Map((await ruleFiles(p, f.dir, ctx.problems)).map(e => [e.name, e]))
  const head = await headRules(git, ctx.problems)
  for (const name of [...new Set([...working.keys(), ...head.keys()])].sort()) {
    const id = RULE_FILE.exec(name)![1]!
    const path = `${f.dir}/${name}`
    const rel = `${PROJECT_REL}/${name}`
    const text = working.has(name) ? await readText(p, path, ctx.problems) : null
    if (working.has(name) && text === null) continue
    const oid = head.get(name)
    let headText: string | null = null
    if (oid) {
      const b = await git(['cat-file', 'blob', oid])
      if (b.code === 0) headText = b.stdout
      else ctx.problems.push(`${rel} at HEAD couldn't be read (git cat-file: ${b.stderr.trim()})`)
    }
    const headParsed = headText === null ? null : parseRule(headText)
    if (headParsed && !headParsed.ok) ctx.problems.push(`${rel} at HEAD: ${headParsed.error}`)
    const headDoc = headParsed?.ok ? headParsed.doc : null
    // Whether HEAD's version counts as committed by you: null when it does, else why not.
    let committed: Promise<string | null> | null = null
    const headWhy = () =>
      (committed ??= (async () => {
        if (!headDoc) return "HEAD's version doesn't parse"
        const bad = fileProblem(headDoc, 'project', id)
        if (bad) return `HEAD's version is refused: ${bad}`
        const step = steps.get(id)
        if (step?.kind === 'retire' && step.version >= headDoc.version) return `retired in the rules pane (version ${step.version}); commit the file's deletion`
        return nodeCommit(git, rel, nodeCommits)
      })())

    if (text === null) {
      // Deleted from the working tree: HEAD's version stays in force until the deletion is committed.
      if (!headDoc || headText === null) continue
      const hw = await headWhy()
      out.push({
        doc: headDoc,
        scope: 'project',
        path,
        sha256: await sha256(headText),
        standing: 'unverified',
        why: hw === null ? "deleted from the working tree; HEAD's version stays in force until the deletion is committed" : `deleted from the working tree, and ${hw}`,
        delivered: hw === null ? headDoc : null,
      })
      continue
    }
    const sha = await sha256(text)
    const parsed = parseRule(text)
    if (!parsed.ok) {
      ctx.problems.push(`${path}: ${parsed.error}`)
      if (headDoc && (await headWhy()) === null) {
        out.push({ doc: headDoc, scope: 'project', path, sha256: sha, standing: 'unverified', why: `the file doesn't parse (${parsed.error}); HEAD's version stays in force`, delivered: headDoc })
      }
      continue
    }
    const doc = parsed.doc
    const bad = fileProblem(doc, 'project', id)
    const byLedger = bad ?? ledgerWhy(ledger, steps.get(id), 'project', doc.version, sha)
    if (byLedger === null) {
      out.push({ doc, scope: 'project', path, sha256: sha, standing: 'accepted', delivered: doc })
      continue
    }
    if (headText !== null && norm(text) === norm(headText)) {
      const hw = await headWhy()
      out.push({ doc, scope: 'project', path, sha256: sha, standing: hw === null ? 'accepted (committed)' : 'unverified', ...(hw === null ? {} : { why: hw }), delivered: hw === null ? doc : null })
      continue
    }
    if (headText !== null) {
      const hw = await headWhy()
      const edit = bad ? `edited since HEAD, and ${bad}` : 'edited since HEAD (a hand edit or a Write)'
      out.push({
        doc,
        scope: 'project',
        path,
        sha256: sha,
        standing: 'unverified',
        why: hw === null ? `${edit}; HEAD's version stays in force until the edit is accepted or committed` : `${edit}; and HEAD's version isn't in force: ${hw}`,
        delivered: hw === null ? headDoc : null,
      })
      continue
    }
    const why = bad ?? (steps.has(id) ? byLedger : "not committed, and not accepted in the rules pane (a teammate's uncommitted file, a Write, or a hand edit)")
    out.push({ doc, scope: 'project', path, sha256: sha, standing: 'unverified', why, delivered: null })
  }
}

type RuleCommits = { events: { node: string; from: string; to: string }[]; unsure: string | null }

/** Every rule-commit event in the swarms' launch ledgers (15.4; swarm/observe.ts). A ledger that can't be trusted makes the check unsure. */
async function ruleCommits(p: Ports, litterDir: string): Promise<RuleCommits> {
  const out: RuleCommits = { events: [], unsure: null }
  const root = swarmsDir(litterDir)
  if (!(await p.fs.exists(root))) return out
  for (const e of await p.fs.list(root)) {
    if (e.kind !== 'dir' || e.isLink || !SWARM_NAME.test(e.name)) continue
    for (const launch of await listLaunches(p, litterDir, e.name)) {
      const { records, tampered } = await readLaunchLedger(p, litterDir, e.name, launch)
      if (tampered) out.unsure ??= `swarm ${e.name}'s launch ${launch} has a tampered ledger at record ${tampered.seq}`
      for (const r of records) {
        const b = r.body as Record<string, unknown>
        if (r.kind !== 'swarm.event' || b.kind !== 'rule-commit') continue
        if (typeof b.from === 'string' && OID.test(b.from) && typeof b.to === 'string' && OID.test(b.to)) {
          out.events.push({ node: typeof b.node === 'string' ? b.node : 'unknown', from: b.from, to: b.to })
        } else out.unsure ??= `a rule-commit event in swarm ${e.name}'s launch ${launch} has no commit range`
      }
    }
  }
  return out
}

async function ancestor(git: Git, a: string, b: string): Promise<boolean | null> {
  const r = await git(['merge-base', '--is-ancestor', a, b])
  return r.code === 0 ? true : r.code === 1 ? false : null
}

/**
 * Null when the commit that last changed `rel` falls in no node's
 * rule-commit range (15.4, 16.4); else why the file reads as unverified.
 * A commit git can't place in a range counts against it.
 */
async function nodeCommit(git: Git, rel: string, nodeCommits: () => Promise<RuleCommits>): Promise<string | null> {
  const r = await git(['log', '-1', '--format=%H', 'HEAD', '--', rel])
  const last = r.stdout.trim()
  if (r.code !== 0 || !OID.test(last)) return `the commit that last changed it can't be found (git log: ${r.stderr.trim() || 'no commit'})`
  const c = await nodeCommits()
  if (c.unsure) return `${c.unsure}, so a node's commit of it can't be ruled out`
  for (const ev of c.events) {
    const inTo = await ancestor(git, last, ev.to)
    if (inTo === false) continue
    const inFrom = inTo === null ? null : await ancestor(git, last, ev.from)
    if (inTo === true && inFrom === true) continue
    if (inTo === true && inFrom === false) return `committed by node ${ev.node} in ${short(last)}`
    return `last changed in ${short(last)}, which git can't place against node ${ev.node}'s commits ${short(ev.from)}..${short(ev.to)}`
  }
  return null
}

/**
 * 16.6: one id in two scopes; an `overrides` from any scope but local, or
 * naming a project rule, is refused and dropped from what's delivered. A
 * local override of a user rule is kept, for AE and AF to show.
 */
function overlaps(rules: LoadedRule[], problems: string[]): void {
  const scopes = new Map<string, Set<RuleScope>>()
  for (const r of rules) {
    const s = scopes.get(r.doc.id) ?? new Set<RuleScope>()
    s.add(r.scope)
    scopes.set(r.doc.id, s)
  }
  for (const [id, s] of scopes) if (s.size > 1) problems.push(`one id in two scopes: ${id} is in ${[...s].join(' and ')}`)
  const users = new Set(rules.filter(r => r.scope === 'user' && r.delivered).map(r => r.doc.id))
  for (const r of rules) {
    // An unverified file's is reported too, since accepting it as it is would be refused.
    const o = r.delivered?.overrides ?? r.doc.overrides
    if (o === undefined) continue
    const refused =
      r.scope !== 'local'
        ? `${r.doc.id} is a ${r.scope} rule, and only a local rule may override one; its override of ${o} is ignored`
        : o.startsWith('P-')
          ? `${r.doc.id} names project rule ${o} in overrides; a local or user override of a project rule is refused, so it's ignored`
          : !o.startsWith('U-')
            ? `${r.doc.id} names ${o} in overrides; a local rule may override only a user rule, so it's ignored`
            : null
    if (refused) {
      problems.push(refused)
      if (r.delivered?.overrides !== undefined) {
        const { overrides: _dropped, ...rest } = r.delivered
        r.delivered = rest
      }
    } else if (r.delivered && !users.has(o)) problems.push(`${r.doc.id} overrides ${o}, which isn't a user rule in force`)
  }
}

// ---------------------------------------------------------------------------
// Ids

/** A slug from the first words of a rule (16.2): `[a-z0-9-]`, at most 40 characters. */
export function slugOf(text: string): string {
  const words = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w !== '')
  let slug = ''
  for (const w of words) {
    const next = slug === '' ? w : `${slug}-${w}`
    if (next.length > 40) break
    slug = next
  }
  if (slug === '' && words[0]) slug = words[0].slice(0, 40)
  return slug === '' ? 'rule' : slug
}

/** The scope letter and the slug, with `-2`, `-3`… when that id is taken anywhere. */
export function assignId(scope: RuleScope, slug: string, taken: ReadonlySet<string>): string {
  const base = `${SCOPE_LETTER[scope]}-${slug}`
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

/** Every id in use: in any scope's folder or `.history`, at HEAD, or accepted in either ledger. */
async function takenIds(p: Ports, ctx: Ctx, loaded: LoadedRule[]): Promise<Set<string>> {
  const ids = new Set(loaded.map(r => r.doc.id))
  for (const f of ctx.folders) {
    for (const [dir, re] of [[f.dir, RULE_FILE], [ruleHistoryDir(f.dir), HISTORY_FILE]] as const) {
      if (!(await p.fs.exists(dir))) continue
      for (const e of await p.fs.list(dir)) {
        const m = re.exec(e.name)
        if (m) ids.add(m[1]!)
      }
    }
  }
  for (const l of Object.values(ctx.ledgers)) for (const r of l.records) if (r.kind === 'rule.accept' && typeof r.body.id === 'string') ids.add(r.body.id)
  return ids
}

/** The highest version of `id` the scope has seen: its ledger's accepts, its `.history`, and the loaded files. */
async function knownVersion(p: Ports, ctx: Ctx, loaded: LoadedRule[], folder: Folder, id: string): Promise<number> {
  let max = 0
  const l = ctx.ledgers[storeOf(folder.scope)]
  for (const r of l.records) if (r.kind === 'rule.accept' && r.body.id === id && typeof r.body.version === 'number') max = Math.max(max, r.body.version)
  const hist = ruleHistoryDir(folder.dir)
  if (await p.fs.exists(hist)) {
    for (const e of await p.fs.list(hist)) {
      const m = HISTORY_FILE.exec(e.name)
      if (m && m[1] === id) max = Math.max(max, Number(m[2]))
    }
  }
  for (const r of loaded) if (r.scope === folder.scope && r.doc.id === id) max = Math.max(max, r.delivered?.version ?? 0, r.doc.version)
  return max
}

// ---------------------------------------------------------------------------
// Proposals

/** The text a proposal is compared by (16.3): its Rule, from its file when it was one. */
export function proposalText(body: RuleProposeBody): string {
  const fromDoc = body.doc?.body?.rule
  return typeof fromDoc === 'string' ? fromDoc : body.rule
}

/** sha256 of the folded text, as `rule.dismiss` records it. */
export const foldedSha = (text: string) => sha256(foldText(text))

type ProposalView = { ref: ProposalRef; body: RuleProposeBody; status: RuleStatus; folded: string }
const refKey = (r: ProposalRef) => `${r.store}:${r.seq}`

/**
 * Every proposal in both ledgers with its status. A step in your ledger
 * that cites the repository's proposal counts only when it names this
 * litterDir, since your ledger is shared by every repository. A tampered
 * ledger contributes nothing.
 */
async function foldProposals(litterDir: string, ledgers: Record<RuleLedgerStore, Ledger>): Promise<ProposalView[]> {
  const accepted = new Map<string, { store: RuleLedgerStore; seq: number; id: string; version: number }>()
  const dismissed = new Set<string>()
  const dismissedText = new Set<string>()
  const retires: { store: RuleLedgerStore; seq: number; id: string; version: number }[] = []
  for (const store of ['repo', 'user'] as const) {
    const l = ledgers[store]
    if (l.tampered) continue
    for (const r of l.records) {
      const b = r.body as Record<string, unknown> & { proposal?: ProposalRef; litterDir?: string }
      const cites = b.proposal && (b.proposal.store === store || (store === 'user' && b.litterDir === litterDir)) ? refKey(b.proposal) : null
      if (r.kind === 'rule.accept' && cites) accepted.set(cites, { store, seq: r.seq, id: String(b.id), version: Number(b.version) })
      else if (r.kind === 'rule.dismiss' && cites) {
        dismissed.add(cites)
        if (typeof b.folded === 'string') dismissedText.add(b.folded)
      } else if (r.kind === 'rule.retire' && typeof b.id === 'string' && typeof b.version === 'number') retires.push({ store, seq: r.seq, id: b.id, version: b.version })
    }
  }
  const out: ProposalView[] = []
  for (const store of ['repo', 'user'] as const) {
    const l = ledgers[store]
    if (l.tampered) continue
    for (const r of l.records) {
      if (r.kind !== 'rule.propose') continue
      const body = r.body as RuleProposeBody
      const ref: ProposalRef = { store, seq: r.seq }
      const folded = await foldedSha(proposalText(body))
      const acc = accepted.get(refKey(ref))
      const status: RuleStatus = acc
        ? retires.some(x => x.store === acc.store && x.seq > acc.seq && x.id === acc.id && x.version >= acc.version)
          ? 'retired'
          : 'accepted'
        : dismissed.has(refKey(ref)) || dismissedText.has(folded)
          ? 'dismissed'
          : 'proposed'
      out.push({ ref, body, status, folded })
    }
  }
  return out
}

/**
 * One of a gate critic's `proposed_rules` (output.ts; swarm/gate.ts): AD
 * makes it a `rule.propose` in the repo rules ledger with `source: 'critic'`
 * and whatever it has of run, gate, swarm, verify_id, tool_use_id and index,
 * once per tool_use_id and index (once per verify_id and index for a
 * swarm's). A throw is logged by the caller. On Codex, where the rules
 * ledger isn't written (ledgerowner.ts), it stays in the critic's verdict
 * record, and the run's summary.md lists it (execsummary.ts).
 */
export async function proposeFromCritic(p: Ports, litterDir: string, input: CriticProposal): Promise<void> {
  if (session().host === 'codex') return
  if (bytes(input.rule) > RULE_MAX_BYTES) throw new Error(`a proposed rule over ${RULE_MAX_BYTES} bytes isn't recorded (index ${input.index})`)
  const dir = await ruleLedgerDir(p, litterDir, 'repo')
  await serial(`rules-propose:${dir}`, async () => {
    const { records, tampered } = await readRuleLedger(p, litterDir, 'repo')
    if (tampered) throw new LedgerTampered(tampered.seq, tampered.reason)
    const swarm = input.swarm !== undefined
    const keyed = swarm ? input.verify_id !== undefined : input.tool_use_id !== undefined
    const same = (b: RuleProposeBody) =>
      b.source === 'critic' &&
      b.run === input.run &&
      b.index === input.index &&
      (swarm ? b.swarm === input.swarm && b.verify_id === input.verify_id : b.swarm === undefined && b.tool_use_id === input.tool_use_id)
    if (keyed && records.some(r => r.kind === 'rule.propose' && same(r.body as RuleProposeBody))) return
    const body: RuleProposeBody = { rule: input.rule, source: 'critic', run: input.run, index: input.index }
    for (const k of ['gate', 'swarm', 'verify_id', 'tool_use_id'] as const) if (input[k] !== undefined) body[k] = input[k]
    if (input.round !== undefined) body.round = input.round
    await appendRuleRecord(p, litterDir, 'repo', 'rule.propose', input.by, body)
  })
}

/**
 * The proposals in both rules ledgers that fit `filter` (all of them when
 * it's empty), oldest first, each with its status: `proposed` until a
 * rule.accept or rule.dismiss cites it, and `dismissed` from the start when
 * its folded text matches a dismissed one's (16.3).
 */
export async function proposalsOf(
  p: Ports,
  litterDir: string,
  filter: { run?: string; swarm?: string; status?: RuleStatus[] },
): Promise<{ ref: ProposalRef; body: RuleProposeBody; status: RuleStatus }[]> {
  const { ledgers } = await readLedgers(p, litterDir)
  for (const store of ['repo', 'user'] as const) if (ledgers[store].tampered) p.log(`rules: the ${store} rules ledger is tampered ${ledgers[store].tampered}; its proposals aren't listed`)
  return (await foldProposals(litterDir, ledgers))
    .filter(v => (filter.run === undefined || v.body.run === filter.run) && (filter.swarm === undefined || v.body.swarm === filter.swarm))
    .filter(v => !filter.status || filter.status.length === 0 || filter.status.includes(v.status))
    .map(({ ref, body, status }) => ({ ref, body, status }))
}

// ---------------------------------------------------------------------------
// Accept, dismiss, retire: from the rules pane's buttons only

/** What [Accept] accepts: a proposal, or an unverified rule file (absolute) as it is. */
export type AcceptWhat = { proposal: ProposalRef } | { file: string }
/**
 * What the pane holds until [Accept]: the scope it asked for, and the paths
 * and type [Edit…] set (`paths` already through narrowPaths).
 */
export type AcceptOpts = { scope?: RuleScope; paths?: string[]; type?: RuleType }

type Plan = {
  path: string
  text: string
  store: RuleLedgerStore
  accept: RuleAcceptBody
  /** An edit's old version, moved to `.history` first. */
  history: { from: string; to: string } | null
  /** The primary checkout, when this write makes `.litter.local/` for the first time. */
  excludeIn: string | null
}

const validRef = (r: unknown): r is ProposalRef =>
  typeof r === 'object' && r !== null && ((r as ProposalRef).store === 'repo' || (r as ProposalRef).store === 'user') && Number.isInteger((r as ProposalRef).seq) && (r as ProposalRef).seq >= 1

/** The same rule but for its version and acceptance: an edit that changes nothing. */
const sameRule = (a: RuleDoc, b: RuleDoc) =>
  renderRule({ ...a, version: 1, status: 'accepted', accepted: undefined }) === renderRule({ ...b, version: 1, status: 'accepted', accepted: undefined })

/** Extra keys: the version in force's, each replaced by the draft's of the same key, then the draft's new ones. */
function mergeExtra(base: [string, string][], draft: [string, string][]): [string, string][] {
  const out = base.map(([k, v]): [string, string] => [k, draft.find(([d]) => d === k)?.[1] ?? v])
  for (const [k, v] of draft) if (!out.some(([o]) => o === k)) out.push([k, v])
  return out
}

/** Everything [Accept] would do, decided before anything is written. */
async function planAccept(p: Ports, litterDir: string, what: AcceptWhat, opts: AcceptOpts): Promise<{ ok: true; plan: Plan } | Refusal> {
  const ctx = await context(p, litterDir)
  const loaded = await loadWith(p, litterDir, ctx)
  const today = new Date(await p.now()).toISOString().slice(0, 10)
  const folderOf = (scope: RuleScope): Folder | Refusal =>
    ctx.folders.find(f => f.scope === scope) ??
    no(scope === 'user' ? `there's no user scope: ${ctx.userMissing ?? 'the config dir is unknown'}` : 'a bare repository has no project or local scope')
  if (opts.scope !== undefined && !(['user', 'project', 'local'] as const).includes(opts.scope)) return no('the scope is user, project or local')
  if (opts.type !== undefined && opts.type !== 'rule' && opts.type !== 'ban') return no('the type is rule or ban')
  if (opts.paths !== undefined) {
    const n = narrowPaths(opts.paths)
    if (!n.ok) return n
  }

  let doc: RuleDoc
  let folder: Folder
  let base: RuleDoc | null = null
  let history: Plan['history'] = null
  let proposal: ProposalRef | null = null
  if ('proposal' in what) {
    const ref = what.proposal
    if (!validRef(ref)) return no('a proposal is { store: repo or user, seq }, as the pane lists it')
    const l = ctx.ledgers[ref.store]
    if (l.tampered) return no(`the ${ref.store} rules ledger is tampered ${l.tampered}; nothing more is recorded in it`)
    const v = (await foldProposals(litterDir, ctx.ledgers)).find(x => x.ref.store === ref.store && x.ref.seq === ref.seq)
    if (!v) return no(`there's no proposal ${refKey(ref)}`)
    if (v.status !== 'proposed') return no(`proposal ${refKey(ref)} is ${v.status} already`)
    proposal = { store: ref.store, seq: ref.seq }
    const b = v.body
    const draft = b.doc && typeof b.doc === 'object' && b.doc.body ? b.doc : null
    let target: LoadedRule | null = null
    let from = 0
    if (typeof b.edits === 'string') {
      const m = /^(.+)@([1-9][0-9]*)$/.exec(b.edits)
      target = (m && loaded.find(r => r.doc.id === m[1] && r.delivered !== null)) || null
      if (!m || !target) return no(`${m?.[1] ?? b.edits}, which this proposal edits, isn't a rule in force`)
      from = Number(m[2])
      if (target.delivered!.version !== from) return no(`the edit is of ${b.edits}, and ${m[1]} is at version ${target.delivered!.version} now; propose the edit again against that version`)
      if (target.standing === 'unverified' && (await p.fs.exists(target.path))) {
        return no(`${m[1]}'s file has a change that isn't accepted (${target.why}); accept or restore that file first`)
      }
      if (opts.scope !== undefined && opts.scope !== target.scope) return no(`an edit stays in ${m[1]}'s scope, ${target.scope}`)
      base = target.delivered
    }
    const scope = target?.scope ?? opts.scope ?? b.scope
    if (!scope) return no('choose a scope: user, project or local')
    const f = folderOf(scope)
    if ('ok' in f) return f
    folder = f
    const rule = (draft ? draft.body.rule : b.rule).trim()
    const workflows = draft?.applies.workflows ?? base?.applies.workflows
    const roles = draft?.applies.roles ?? base?.applies.roles
    const overrides = draft?.overrides ?? base?.overrides
    doc = {
      id: target ? target.doc.id : assignId(scope, b.slug ?? slugOf(rule), await takenIds(p, ctx, loaded)),
      version: target ? from + 1 : 1,
      status: 'accepted',
      type: opts.type ?? b.type ?? draft?.type ?? base?.type ?? 'rule',
      applies: {
        paths: opts.paths ?? b.paths ?? draft?.applies.paths ?? base?.applies.paths ?? [],
        ...(workflows ? { workflows } : {}),
        ...(roles ? { roles } : {}),
        when: b.when ?? draft?.applies.when ?? base?.applies.when ?? '',
      },
      ...(overrides ? { overrides } : {}),
      accepted: { at: today, via: 'ui' },
      export: draft?.export ?? base?.export ?? true,
      extra: mergeExtra(base?.extra ?? [], draft?.extra ?? []),
      body: draft ? { ...draft.body, rule } : base ? { ...base.body, rule } : { rule, why: '', exceptions: [], howToCheck: [] },
    }
    const path = `${folder.dir}/${doc.id}.md`
    if (target && target.path === path && (await p.fs.exists(path))) {
      const to = `${ruleHistoryDir(folder.dir)}/${doc.id}@${from}.md`
      if (await p.fs.exists(to)) return no(`${to} is there already, so version ${from} can't move to it`)
      history = { from: path, to }
    } else if (await p.fs.exists(path)) return no(`${path} is there already`)
  } else {
    const path = what.file
    if (typeof path !== 'string' || !path.startsWith('/')) return no('a file to accept is named by its absolute path')
    const dir = path.slice(0, path.lastIndexOf('/'))
    const name = path.slice(path.lastIndexOf('/') + 1)
    const f = ctx.folders.find(x => x.dir === dir)
    const m = RULE_FILE.exec(name)
    if (!f) return no(`${path} isn't in a rule folder (${ctx.folders.map(x => x.dir).join(', ')})`)
    if (!m) return no(`${name} isn't a rule file's name, <id>.md`)
    folder = f
    if (!(await p.fs.exists(path))) return no(`${path} isn't there`)
    const here = loaded.find(r => r.path === path)
    if (here && here.standing !== 'unverified') return no(`${path} is ${here.standing} already`)
    const parsed = parseRule(await p.fs.read(path))
    if (!parsed.ok) return no(`${path} doesn't parse: ${parsed.error}`)
    const src = parsed.doc
    if (src.id !== '' && src.id !== m[1]) return no(`its id is ${src.id}, and the file is ${name}`)
    if (m[1]![0] !== SCOPE_LETTER[f.scope]) return no(`${m[1]} is in the ${f.scope} folder, whose ids start with ${SCOPE_LETTER[f.scope]}-`)
    // An unverified file accepted as it is: the next version of its id.
    const known = await knownVersion(p, ctx, loaded, f, m[1]!)
    doc = { ...src, id: m[1]!, version: known > 0 ? known + 1 : Math.max(src.version, 1), status: 'accepted', accepted: { at: today, via: 'ui' } }
    if (opts.paths) doc.applies = { ...doc.applies, paths: opts.paths }
    if (opts.type) doc.type = opts.type
  }

  // The refusals every accept shares (16.6).
  if (doc.overrides !== undefined) {
    if (doc.overrides.startsWith('P-')) return no(`it overrides project rule ${doc.overrides}; a local or user override of a project rule is refused, so change the project rule instead`)
    if (folder.scope !== 'local' || !doc.overrides.startsWith('U-')) return no(`only a local rule may name a user rule in overrides, and this ${folder.scope} rule names ${doc.overrides}`)
  }
  for (const pattern of doc.applies.paths) {
    const why = patternProblem(pattern)
    if (why !== null) return no(`applies.paths has ${JSON.stringify(pattern)}: ${why}`)
  }
  const folded = foldText(doc.body.rule)
  const same = loaded.find(r => r.delivered && r.delivered.id !== doc.id && foldText(r.delivered.body.rule) === folded)
  if (same) return no(`it's identical to ${same.delivered!.id}@${same.delivered!.version}, which is in force`)
  if (base && sameRule(base, doc)) return no(`the edit changes nothing in ${base.id}@${base.version}`)
  const text = renderRule(doc)
  const size = bytes(text)
  if (size > RULE_MAX_BYTES) return no(`the rule file would be ${size} bytes, over the ${RULE_MAX_BYTES}-byte limit; a rule goes into prompts, so cut it down`)
  const back = parseRule(text)
  if (!back.ok) return no(`the rule file wouldn't read back (${back.error}); edit the proposal`)

  const path = `${folder.dir}/${doc.id}.md`
  const accept: RuleAcceptBody = { ...(proposal ? { proposal } : {}), id: doc.id, version: doc.version, scope: folder.scope, path, sha256: await sha256(text), via: 'ui' }
  // A user-scope accept of the repository's proposal names the repository, since your ledger is every repository's.
  if (proposal?.store === 'repo' && folder.scope === 'user') accept.litterDir = litterDir
  const excludeIn = folder.scope === 'local' && ctx.primary && !(await p.fs.exists(`${ctx.primary}/.litter.local`)) ? ctx.primary : null
  return { ok: true, plan: { path, text, store: storeOf(folder.scope), accept, history, excludeIn } }
}

/** The first `.litter.local/` the mod makes: `/.litter.local/` goes into `<common dir>/info/exclude`, once (16.1). */
async function excludeLocal(p: Ports, primary: string): Promise<void> {
  const r = await gitAt(p, primary)(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (r.code !== 0) throw new Error(`git couldn't name the common dir, so /.litter.local/ isn't excluded: ${r.stderr.trim()}`)
  const path = `${r.stdout.trim()}/info/exclude`
  const text = (await p.fs.exists(path)) ? await p.fs.read(path) : ''
  if (text.split('\n').some(l => l.trim() === '/.litter.local/')) return
  await atomicWrite(p, path, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}/.litter.local/\n`)
}

/**
 * Accepts, from the rules pane's ui.press only: resolves the scope and id,
 * writes the file atomically (an edit moves the old version to `.history`),
 * then records `rule.accept { …, via: 'ui' }`. `path` is the file written.
 */
export async function acceptRule(p: Ports, litterDir: string, what: AcceptWhat, opts: AcceptOpts = {}): Promise<{ ok: true; path?: string } | { ok: false; reason: string }> {
  return serial(stepsKey(litterDir), async () => {
    let planned: Awaited<ReturnType<typeof planAccept>>
    try {
      planned = await planAccept(p, litterDir, what, opts)
    } catch (err) {
      return no(`the accept couldn't be checked: ${errText(err)}`)
    }
    if (!planned.ok) return planned
    const plan = planned.plan
    let moved = false
    try {
      if (plan.excludeIn) await excludeLocal(p, plan.excludeIn)
      if (plan.history) {
        await mkdirp(p, plan.history.to.slice(0, plan.history.to.lastIndexOf('/')))
        await rename(p, plan.history.from, plan.history.to)
        moved = true
      }
      await atomicWrite(p, plan.path, plan.text)
    } catch (err) {
      if (moved && plan.history) await rename(p, plan.history.to, plan.history.from).catch(() => {})
      return no(`the rule file wasn't written: ${errText(err)}`)
    }
    try {
      await appendRuleRecord(p, litterDir, plan.store, 'rule.accept', MOD, plan.accept)
    } catch (err) {
      return no(`${plan.path} was written, but its acceptance wasn't recorded (${errText(err)}), so it reads as unverified`)
    }
    return { ok: true, path: plan.path }
  })
}

/** Dismisses a proposal, from the rules pane's ui.press only: `rule.dismiss { proposal, folded, via: 'ui' }`. */
export async function dismissRule(p: Ports, litterDir: string, proposal: ProposalRef): Promise<{ ok: true; path?: string } | { ok: false; reason: string }> {
  return serial(stepsKey(litterDir), async () => {
    try {
      if (!validRef(proposal)) return no('a proposal is { store: repo or user, seq }, as the pane lists it')
      const { ledgers } = await readLedgers(p, litterDir)
      const t = ledgers[proposal.store].tampered
      if (t) return no(`the ${proposal.store} rules ledger is tampered ${t}; nothing more is recorded in it`)
      const v = (await foldProposals(litterDir, ledgers)).find(x => x.ref.store === proposal.store && x.ref.seq === proposal.seq)
      if (!v) return no(`there's no proposal ${refKey(proposal)}`)
      if (v.status !== 'proposed') return no(`proposal ${refKey(proposal)} is ${v.status} already`)
      const body: RuleDismissBody = { proposal: { store: proposal.store, seq: proposal.seq }, folded: v.folded, via: 'ui' }
      await appendRuleRecord(p, litterDir, proposal.store, 'rule.dismiss', MOD, body)
      return { ok: true }
    } catch (err) {
      return no(`the dismiss wasn't recorded: ${errText(err)}`)
    }
  })
}

/**
 * Retires an accepted rule, from the rules pane's ui.press only: its file to
 * `.history`, then `rule.retire { id, version, via: 'ui' }`. `path` is the
 * file removed: for a project rule, its deletion is yours to commit.
 */
export async function retireRule(p: Ports, litterDir: string, rule: RuleRef): Promise<{ ok: true; path?: string } | { ok: false; reason: string }> {
  return serial(stepsKey(litterDir), async () => {
    try {
      if (!rule || typeof rule.id !== 'string' || !Number.isInteger(rule.version)) return no('a rule is { id, version }')
      const ctx = await context(p, litterDir)
      const target = (await loadWith(p, litterDir, ctx)).find(r => r.doc.id === rule.id && r.delivered?.version === rule.version)
      if (!target) return no(`${rule.id}@${rule.version} isn't a rule in force`)
      const store = storeOf(target.scope)
      const t = ctx.ledgers[store].tampered
      if (t) return no(`the ${store} rules ledger is tampered ${t}; nothing more is recorded in it`)
      const there = await p.fs.exists(target.path)
      if (target.standing === 'unverified' && there) return no(`${rule.id}'s file has a change that isn't accepted (${target.why}); accept or restore it first, then retire`)
      if (there) {
        const hist = ruleHistoryDir(target.path.slice(0, target.path.lastIndexOf('/')))
        const to = `${hist}/${rule.id}@${rule.version}.md`
        if (await p.fs.exists(to)) return no(`${to} is there already`)
        await mkdirp(p, hist)
        await rename(p, target.path, to)
      }
      const body: RuleRetireBody = { id: rule.id, version: rule.version, via: 'ui' }
      await appendRuleRecord(p, litterDir, store, 'rule.retire', MOD, body)
      return { ok: true, path: target.path }
    } catch (err) {
      return no(`the retire wasn't recorded: ${errText(err)}`)
    }
  })
}

/** The exact file acceptRule would write for `what` and `opts`, and its absolute path; writes nothing. */
export async function previewAccept(p: Ports, litterDir: string, what: AcceptWhat, opts: AcceptOpts = {}): Promise<{ ok: true; path: string; text: string } | { ok: false; reason: string }> {
  try {
    const planned = await planAccept(p, litterDir, what, opts)
    return planned.ok ? { ok: true, path: planned.plan.path, text: planned.plan.text } : planned
  } catch (err) {
    return no(`the accept couldn't be checked: ${errText(err)}`)
  }
}

/** Paths for a proposal, as [Edit…] takes them: each validated by match.ts's validPattern, sorted, without duplicates. Stores nothing. */
export function narrowPaths(paths: string[]): { ok: true; paths: string[] } | { ok: false; reason: string } {
  if (!Array.isArray(paths)) return no('paths are a list of patterns')
  const out = new Set<string>()
  for (const raw of paths) {
    if (typeof raw !== 'string') return no('each path is a pattern, as text')
    const pattern = raw.normalize('NFC')
    const why = patternProblem(pattern)
    if (why !== null) return no(`${JSON.stringify(pattern)} isn't a path pattern litter takes: ${why}`)
    out.add(pattern)
  }
  return { ok: true, paths: [...out].sort() }
}
