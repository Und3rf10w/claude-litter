// The `land` record: commit exactly the verified tree with commit-tree, move
// the run's branch with a compare-and-swap, keep your index with the two-tree
// merge, idempotent per verify_id, with crash recovery by trailer (plan
// sections 7 and 9). Owner: phase 1b, work package C.
//
// Every git argv here is built from run.json's checked facts, the ledger's
// trees and git's own answers. Nothing from the call becomes an argument: the
// gate and verify_id are matched against the plan and the ledger first, and
// reach git only as message text: the commit message on stdin, the reflog's
// `-m` (plan section 9, "Mod safety").

import type { Ports } from './ports'
import type { RecordCtx, RecordHandler, RecordReply, StoredRecord } from './records/core'
import type { RunJson } from './records/run'
import type {
  GateRef,
  LandAbandonedBody,
  LandBlockedBody,
  LandBody,
  LandIntentBody,
  LandReply,
} from './records/execute'
import { fail } from './records/core'
import { appendRecord, readLedger } from './ledgercore'
import { runJsonPath } from './layout'
import { readJson, serial } from './fsx'
import { snapshot } from './snapshot'
import {
  FIXED_GATES,
  MOD,
  OID,
  type RunFacts,
  agentOf,
  gateIds,
  isGreen,
  isPlanGate,
  loadRun,
  message,
  notGreen,
  observe,
  planGates,
  readRunFacts,
  runClosed,
  verifyBody,
} from './verify'

// ---------------------------------------------------------------------------
// git, as the land runs it: never rejects, so every step's failure is handled
// the same way.

type GitResult = { code: number; stdout: string; stderr: string }

function git(p: Ports, checkout: string, argv: readonly string[], stdin?: string): Promise<GitResult> {
  const init = stdin === undefined ? { timeoutMs: 120_000 } : { timeoutMs: 120_000, stdin }
  return p.run(['git', '-C', checkout, ...argv], init).then(
    r => ({ code: r.code, stdout: r.stdout, stderr: r.stderr }),
    err => ({ code: -1, stdout: '', stderr: message(err) }),
  )
}

/** The ref `HEAD` names, or null when it's detached (`symbolic-ref -q`). */
async function headRef(p: Ports, checkout: string): Promise<string | null> {
  const r = await git(p, checkout, ['symbolic-ref', '-q', 'HEAD'])
  return r.code === 0 ? r.stdout.trim() : null
}

/** The commit a ref points at, or null when it doesn't resolve. */
async function tipOf(p: Ports, checkout: string, ref: string): Promise<string | null> {
  const r = await git(p, checkout, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])
  const oid = r.stdout.trim()
  return r.code === 0 && OID.test(oid) ? oid : null
}

const firstLine = (s: string): string => s.trim().split('\n')[0] ?? ''

/** The paths a refused read-tree names (`Entry '<path>' …`, `<path>: needs merge`, tab-indented lists). */
export function gitPaths(stderr: string): string[] {
  const out = new Set<string>()
  for (const m of stderr.matchAll(/Entry '([^']+)'/g)) out.add(m[1]!)
  for (const m of stderr.matchAll(/^(.+): needs merge$/gm)) out.add(m[1]!)
  for (const m of stderr.matchAll(/^\t(.+)$/gm)) out.add(m[1]!)
  return [...out].sort()
}

/** What git said, with the paths it named. */
const refusal = (r: GitResult): string => {
  const paths = gitPaths(r.stderr)
  return `${firstLine(r.stderr) || `exit ${r.code}`}${paths.length > 0 ? ` (paths: ${paths.join(', ')})` : ''}`
}

const branchOf = (ref: string): string => ref.replace(/^refs\/heads\//, '')

// ---------------------------------------------------------------------------
// The commit message (plan section 9, "Commit message").

const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()

/** The plan path for `Refs:`, from `.claude/litter/` down when it's under one (absolute paths stay out of commits). */
function planRef(json: RunJson): string | null {
  const path = json.args?.planPath
  if (typeof path !== 'string' || path === '') return null
  const at = path.indexOf('/.claude/litter/')
  return oneLine(at >= 0 ? path.slice(at + 1) : path)
}

/** Attribution lines the session requires, as run.start stored them (`trailers`), one `Key: value` each. */
function attribution(json: RunJson): string[] {
  const t = (json as RunJson & { trailers?: unknown }).trailers
  if (!Array.isArray(t)) return []
  return t.filter((x): x is string => typeof x === 'string' && /^[A-Za-z][A-Za-z0-9-]*: \S[^\r\n]*$/.test(x) && !/^litter-run:/i.test(x))
}

/** The subject from the gate's title, then one trailer paragraph: Refs, Litter-Run, attribution. */
export function commitMessage(f: RunFacts, gate: GateRef, verifyId: string): string {
  const g = planGates(f.json)?.find(x => x.id === gate)
  const title = g?.title ? oneLine(g.title).slice(0, 200) : ''
  const subject = title ? `${gate}: ${title}` : `litter ${f.run}: land ${gate}`
  const trailers: string[] = []
  const plan = planRef(f.json)
  if (plan && g?.lines) trailers.push(`Refs: ${plan}:${g.lines}`)
  trailers.push(`Litter-Run: ${f.run} ${gate} ${verifyId}`)
  trailers.push(...attribution(f.json))
  return `${subject}\n\n${trailers.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// The commits on the ref, by trailer (plan section 7, "Crash recovery").

type Trailer = { run: string; gate: string; verifyId: string }
type Listed = { commit: string; parent: string; tree: string; trailers: Trailer[]; unreadable: string[] }

/** `git log <base>..<ref>`, oldest first, with each commit's Litter-Run trailers. */
async function listLanded(p: Ports, json: RunJson): Promise<{ ok: true; commits: Listed[] } | { ok: false; error: string }> {
  const r = await git(p, json.checkout, [
    'log', '-z', '--reverse', '--no-show-signature',
    '--format=%H%x1f%P%x1f%T%x1f%(trailers:key=Litter-Run,valueonly,separator=%x1d)',
    `${json.base}..${json.ref}`, '--',
  ])
  if (r.code !== 0) return { ok: false, error: `the commits on ${branchOf(json.ref)} can't be listed: ${refusal(r)}` }
  const commits: Listed[] = []
  for (const entry of r.stdout.split('\0')) {
    if (entry.trim() === '') continue
    const [commit = '', parents = '', tree = '', values = ''] = entry.replace(/^\n+/, '').split('\x1f')
    const listed: Listed = { commit, parent: parents.split(' ')[0] ?? '', tree, trailers: [], unreadable: [] }
    for (const raw of values.split('\x1d').map(v => v.trim())) {
      if (raw === '') continue
      const m = /^(\S+) (\S+) (\S+)$/.exec(raw)
      if (m) listed.trailers.push({ run: m[1]!, gate: m[2]!, verifyId: m[3]! })
      else listed.unreadable.push(raw)
    }
    commits.push(listed)
  }
  return { ok: true, commits }
}

// ---------------------------------------------------------------------------
// Reconcile.

export type ReconcileResult = {
  /** What reconcile couldn't settle, with the facts. While any remain, every land of the run is refused. */
  problems: string[]
}

const landKey = (runDir: string): string => `land:${runDir}`

const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean =>
  (a ?? []).join('\0') === (b ?? []).join('\0')

/**
 * The index repair a crashed land needs, by its mode, never a replay (plan
 * section 7, "Index repair uses step 5's rule"): `read-tree -m -i <T> HEAD`
 * for execute's index-only land, `-m -u` for fanout's, which moved files too.
 */
async function repair(p: Ports, checkout: string, intent: LandIntentBody): Promise<{ ok: true } | { ok: false; why: string; paths: string[] }> {
  if (!OID.test(intent.tree)) return { ok: false, why: `its intent names no tree (${intent.tree})`, paths: [] }
  // `-u` checks each file against its index entry's stat data, so a file whose
  // content is back where it was would still read as changed: refresh first,
  // as git's own merge scripts do. It rewrites stat data, never content.
  if (intent.mode === 'checkout') await git(p, checkout, ['update-index', '-q', '--refresh'])
  const r = await git(p, checkout, ['read-tree', '-m', intent.mode === 'checkout' ? '-u' : '-i', intent.tree, 'HEAD'])
  return r.code === 0 ? { ok: true } : { ok: false, why: refusal(r), paths: gitPaths(r.stderr) }
}

/**
 * Reconciles the ledger against the commits on the run's ref:
 *  - a trailer with no `land` record gets a recovered `land`;
 *  - an intent with no commit whose `old` is still the tip is repaired and abandoned,
 *    or `land.blocked` with the paths when git refuses the repair;
 *  - anything else is refused with the facts (a `land.blocked`, once per fact).
 */
async function reconcileIn(p: Ports, f: RunFacts): Promise<ReconcileResult> {
  const { run, runDir, json } = f
  const ledger = await readLedger(p, runDir, run)
  if (ledger.tampered) {
    return { problems: [`the run's ledger is tampered at record ${ledger.tampered.seq} (${ledger.tampered.reason})`] }
  }
  const listed = await listLanded(p, json)
  if (!listed.ok) {
    // A run that never began a land has nothing on its ref to account for (its branch may be gone since).
    if (!ledger.records.some(r => r.kind.startsWith('land'))) return { problems: [] }
    p.log(`reconcile ${run}: ${listed.error}`)
    return { problems: [listed.error] }
  }

  const landed = new Set<string>()
  const open = new Map<string, LandIntentBody>()
  const blocked = new Map<string, LandBlockedBody>()
  for (const rec of ledger.records) {
    const v = (rec.body as { verify_id?: unknown }).verify_id
    if (typeof v !== 'string') continue
    if (rec.kind === 'land.intent') open.set(v, rec.body as LandIntentBody)
    else if (rec.kind === 'land') {
      landed.add(v)
      open.delete(v)
    } else if (rec.kind === 'land.abandoned') open.delete(v)
    else if (rec.kind === 'land.blocked') blocked.set(v, rec.body as LandBlockedBody)
  }

  const problems: string[] = []
  const append = <B>(kind: string, body: B) => appendRecord(p, runDir, { run, kind, by: MOD, body })
  const refuseWith = async (body: LandBlockedBody): Promise<void> => {
    problems.push(body.reason)
    const last = blocked.get(body.verify_id)
    if (last && last.reason === body.reason && sameList(last.paths, body.paths)) return
    await append('land.blocked', body)
    blocked.set(body.verify_id, body)
  }

  // The commits are the record of what landed.
  const onRef = new Set<string>()
  for (const c of listed.commits) {
    for (const raw of c.unreadable) {
      problems.push(`commit ${c.commit} on ${branchOf(json.ref)} has a Litter-Run trailer litter can't read: ${raw}`)
    }
    for (const t of c.trailers) {
      if (t.run !== run) {
        await refuseWith({
          gate: t.gate,
          verify_id: t.verifyId,
          reason: `commit ${c.commit} on ${branchOf(json.ref)} carries the trailer of another run (${t.run} ${t.gate} ${t.verifyId}); litter doesn't land on a branch whose history it can't account for`,
        })
        continue
      }
      onRef.add(t.verifyId)
      if (landed.has(t.verifyId)) continue
      const intent = open.get(t.verifyId)
      open.delete(t.verifyId)
      const body: LandBody = {
        gate: t.gate,
        verify_id: t.verifyId,
        commit: c.commit,
        tree: c.tree,
        old: c.parent,
        ref: json.ref,
        recovered: true,
      }
      if (intent) {
        // After the swap the repair is a no-op on the run's branch, and re-syncs a checkout that moved since.
        const r = await repair(p, json.checkout, intent)
        if (!r.ok) body.note = `recovered; the index repair left these alone: ${r.why}`
      }
      await append('land', body)
      landed.add(t.verifyId)
    }
  }

  // Intents with no commit on the ref.
  const tip = await tipOf(p, json.checkout, json.ref)
  for (const [v, intent] of open) {
    if (onRef.has(v)) continue
    if (tip === null || tip !== intent.old) {
      await refuseWith({
        gate: intent.gate,
        verify_id: v,
        reason: `the land of ${intent.gate} (verify ${v}) stopped before its commit, and ${branchOf(json.ref)} has moved from ${intent.old} to ${tip ?? 'nowhere'} since; litter won't repair or retry it, so check the branch and the index yourself`,
      })
      continue
    }
    const r = await repair(p, json.checkout, intent)
    if (r.ok) {
      const body: LandAbandonedBody = {
        gate: intent.gate,
        verify_id: v,
        reason: 'the land stopped before its commit reached the branch; reconcile re-synced the index to HEAD, and a retried land starts over',
      }
      await append('land.abandoned', body)
      continue
    }
    const body: LandBlockedBody = {
      gate: intent.gate,
      verify_id: v,
      reason:
        intent.mode === 'checkout'
          ? `the checkout repair (git read-tree -m -u) was refused: ${r.why}. These files hold the integration's content with your changes since; ${branchOf(json.ref)}-integration still has the result. Decide what to keep; the repair is retried at the next reconcile`
          : `the index repair (git read-tree -m -i) was refused: ${r.why}. Nothing changed; it's retried at the next reconcile`,
    }
    if (r.paths.length > 0) body.paths = r.paths
    await refuseWith(body)
  }

  for (const problem of problems) p.log(`reconcile ${run}: ${problem}`)
  return { problems }
}

/** At session.start (through reconcileRuns) and before every land: finds lands the ledger missed by their trailers, abandons stale intents. */
export function reconcileLands(p: Ports, runDir: string, run: string): Promise<ReconcileResult> {
  return serial(landKey(runDir), async () => {
    // Only execute and fanout land; a design or plan run has no branch to account for.
    const stored = await readJson<RunJson>(p, runJsonPath(runDir)).catch(() => undefined)
    if (stored?.workflow === 'design' || stored?.workflow === 'plan') return { problems: [] }
    const facts = await readRunFacts(p, runDir, run)
    if ('ok' in facts) {
      p.log(`reconcile ${run}: ${facts.error}`)
      return { problems: [facts.error] }
    }
    return reconcileIn(p, facts)
  })
}

// ---------------------------------------------------------------------------
// The land.

/** The verdict dimensions a land needs passed (plan section 7: PA and RA, and the rules verdict when it has one). */
function verdictFails(body: Record<string, unknown>): string[] {
  const pass = (d: unknown): boolean => d !== null && typeof d === 'object' && (d as { pass?: unknown }).pass === true
  const out: string[] = []
  if (!pass(body.plan_adherence)) out.push('plan_adherence')
  if (!pass(body.no_regressions)) out.push('no_regressions')
  if (body.rules !== undefined && !pass(body.rules)) out.push('rules')
  if (typeof body.plan_gap === 'string' && body.plan_gap.trim() !== '') out.push('plan_gap (it names one)')
  return out
}

/** The relay's observed fields: the reply in LANDED's shape (plan section 7), without the record tool's `ok`. */
export function landFields(reply: LandReply): Record<string, unknown> {
  const { ok: _ok, ...fields } = reply
  return fields
}

const lastLand = (records: readonly StoredRecord[]): LandBody | null => {
  for (let i = records.length - 1; i >= 0; i--) if (records[i]!.kind === 'land') return records[i]!.body as LandBody
  return null
}

function findLast(records: readonly StoredRecord[], test: (r: StoredRecord) => boolean): StoredRecord | undefined {
  for (let i = records.length - 1; i >= 0; i--) if (test(records[i]!)) return records[i]
  return undefined
}

/** `mcp__litter__record({ kind: 'land', run, gate, verify_id })`. */
export const recordLand: RecordHandler = async (ctx, input) => {
  const facts = await loadRun(ctx, input)
  if ('ok' in facts) return facts
  const ids = gateIds(facts.json)
  const gate = input.gate
  if (typeof gate !== 'string' || gate === '') return fail("litter: 'gate' must name the plan gate to land, as your instruction gives it", 'gate', ids)
  if (FIXED_GATES.includes(gate)) {
    return fail(`litter: gate '${gate}' isn't landed by a land record; name the plan gate your instruction gives`, 'gate', ids)
  }
  if (!isPlanGate(facts.json, gate)) return fail(`litter: run ${facts.run} has no gate '${gate}'`, 'gate', ids)
  const verifyId = input.verify_id
  if (typeof verifyId !== 'string' || verifyId === '') {
    return fail("litter: 'verify_id' must be the verify_id the critic's verdict cites, as your instruction gives it", 'verify_id')
  }
  return serial(landKey(facts.runDir), () => land(ctx, facts, gate, verifyId))
}

async function land(ctx: RecordCtx, f: RunFacts, gate: GateRef, verifyId: string): Promise<RecordReply> {
  const { p } = ctx
  const { run, runDir, json } = f
  const branch = branchOf(json.ref)

  const answer = async (reply: LandReply): Promise<LandReply> => {
    await observe(ctx, { land_of: verifyId }, landFields(reply))
    return reply
  }
  const refuse = (reason: string, retry: boolean) => answer({ ok: true, landed: false, reason, retry })
  const landed = (commit: string, note?: string) =>
    answer(note ? { ok: true, landed: true, commit, retry: false, reason: note } : { ok: true, landed: true, commit, retry: false })

  const reconciled = await reconcileIn(p, f)
  const ledger = await readLedger(p, runDir, run)
  if (ledger.tampered) {
    return refuse(`the run's ledger is tampered at record ${ledger.tampered.seq} (${ledger.tampered.reason}), so nothing more lands`, false)
  }
  const records = ledger.records

  // Idempotent per verify_id: the first answer, and nothing committed (plan section 7).
  const prior = findLast(records, r => r.kind === 'land' && r.body.verify_id === verifyId)
  if (prior) {
    const b = prior.body as LandBody
    if (b.gate !== gate) return refuse(`verify ${verifyId} already landed gate ${b.gate}, not ${gate}`, false)
    return landed(b.commit, b.note)
  }
  if (reconciled.problems.length > 0) return refuse(`reconcile found what it can't settle: ${reconciled.problems.join('; ')}`, false)
  const closed = runClosed(records)
  if (closed) return refuse(`run ${run} ${closed}, so nothing more lands`, false)

  // The preconditions (plan section 7, "Landing is the mod's"), each refused on its own.
  // 1. A green verify on T, cited by the agent that recorded it, and its latest for that gate and attempt.
  const vRec = records.find(r => verifyBody(r)?.verify_id === verifyId)
  const v = vRec ? verifyBody(vRec) : null
  if (!vRec || !v) return refuse(`run ${run} has no verify ${verifyId}`, false)
  if (v.gate !== gate) return refuse(`verify ${verifyId} is for gate ${v.gate}, not ${gate}`, false)
  if (!isGreen(v)) return refuse(`verify ${verifyId} isn't green (${notGreen(v)})`, false)
  const recorder = vRec.by.source === 'agent' ? vRec.by.agentId : null
  if (recorder === null) return refuse(`verify ${verifyId} wasn't recorded by an agent, so no verdict can cite it`, false)
  const latest = findLast(records, r => {
    const b = verifyBody(r)
    return b !== null && r.by.source === 'agent' && r.by.agentId === recorder && b.gate === v.gate && b.attempt === v.attempt
  })
  const latestId = latest ? verifyBody(latest)?.verify_id : undefined
  if (latestId !== verifyId) {
    return refuse(`verify ${verifyId} isn't the latest its recorder made for ${gate} attempt ${v.attempt} (that's ${latestId}), so it can't be cited`, false)
  }
  // 2. The critic's verdict on that verify_id, from the same agent, passing.
  const verdict = findLast(records, r => r.kind === 'verdict' && r.body.verify_id === verifyId)
  if (!verdict) return refuse(`no verdict cites verify ${verifyId}`, false)
  if (agentOf(verdict) !== recorder) return refuse(`the verdict citing verify ${verifyId} isn't from the agent that recorded it`, false)
  const failed = verdictFails(verdict.body)
  if (failed.length > 0) return refuse(`the verdict on verify ${verifyId} doesn't pass ${failed.join(', ')}`, false)
  // 3. The checkout is on the run's branch.
  const head = await headRef(p, json.checkout)
  if (head !== json.ref) {
    return refuse(`the checkout is on ${head ? branchOf(head) : 'a detached HEAD'}, not ${branch}; switch back (git switch ${branch}) and resume the run`, false)
  }
  // 4. The ref is where the run left it: the last land's commit, or base.
  const old = lastLand(records)?.commit ?? json.base
  const tip = await tipOf(p, json.checkout, json.ref)
  if (tip !== old) return refuse(`${branch} is at ${tip ?? 'nothing'}, not ${old} where the run left it; something else moved it`, false)
  // 5. The checkout still snapshots to T.
  let now: Awaited<ReturnType<typeof snapshot>>
  try {
    now = await snapshot(p, json.checkout)
  } catch (err) {
    return refuse(`the snapshot before the land failed: ${message(err)}`, false)
  }
  if (now.dirty_submodules.length > 0) {
    return refuse(`submodules have uncommitted changes (${now.dirty_submodules.join(', ')}); commit, stash or discard inside them, then resume`, false)
  }
  const T = v.tree_after
  if (now.tree !== T) {
    return refuse(`the tree changed after verify ${verifyId} ran, so it isn't the tree the critic judged; judge the tree as it is now, with a new verify`, true)
  }

  // The six steps, in order.
  const intent: LandIntentBody = { gate, verify_id: verifyId, tree: T, old, ref: json.ref, mode: 'index' }
  try {
    await appendRecord(p, runDir, { run, kind: 'land.intent', by: MOD, body: intent })
  } catch (err) {
    return refuse(`the land's intent couldn't be recorded (${message(err)}), so nothing was done`, false)
  }
  const abandon = async (reason: string): Promise<LandReply> => {
    try {
      await appendRecord(p, runDir, { run, kind: 'land.abandoned', by: MOD, body: { gate, verify_id: verifyId, reason } satisfies LandAbandonedBody })
    } catch (err) {
      p.log(`land ${run} ${gate}: land.abandoned not recorded (${message(err)}); reconcile settles it`)
    }
    return refuse(reason, false)
  }

  // Step 2: the commit, its message on stdin. commit-tree runs no repo hooks.
  const made = await git(p, json.checkout, ['commit-tree', T, '-p', old, '-F', '-'], commitMessage(f, gate, verifyId))
  const commit = made.stdout.trim()
  if (made.code !== 0 || !OID.test(commit)) return abandon(`git commit-tree failed: ${refusal(made)}; nothing moved`)

  // Step 3: the index, by git's two-tree merge under its own lock.
  const moved = await git(p, json.checkout, ['read-tree', '-m', '-i', old, commit])
  if (moved.code !== 0) {
    return abandon(`git refused to move the index, so nothing moved: ${refusal(moved)}. Something staged on the gate's paths, a held index.lock or unmerged entries stop it; resolve that, then resume`)
  }

  // Step 4: compare-and-swap on the run's ref, never HEAD.
  const swap = await git(p, json.checkout, ['update-ref', '-m', `litter: land ${gate} of ${run}`, json.ref, commit, old])

  // Step 5: re-sync the index to whatever HEAD is now, whatever step 4 did.
  const notes: string[] = []
  const resync = await git(p, json.checkout, ['read-tree', '-m', '-i', commit, 'HEAD'])
  const headNow = await headRef(p, json.checkout)
  if (headNow !== json.ref) notes.push(`the checkout moved to ${headNow ? branchOf(headNow) : 'a detached HEAD'} during the land, and its index was re-synced to it`)
  if (resync.code !== 0) notes.push(`the re-sync to HEAD left the index alone: ${refusal(resync)}`)
  if (swap.code !== 0) {
    const tipNow = await tipOf(p, json.checkout, json.ref)
    return abandon([`${branch} moved during the land (it's at ${tipNow ?? 'nothing'}), so nothing landed`, ...notes].join('; '))
  }

  // Step 6: the land record.
  const note = notes.length > 0 ? notes.join('; ') : undefined
  const body: LandBody = { gate, verify_id: verifyId, commit, tree: T, old, ref: json.ref }
  if (note) body.note = note
  try {
    await appendRecord(p, runDir, { run, kind: 'land', by: MOD, body })
  } catch (err) {
    p.log(`land ${run} ${gate}: the land record failed (${message(err)}); reconcile recovers it from the commit's trailer`)
  }
  return landed(commit, note)
}
