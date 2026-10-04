// The `land` record: commit exactly the verified tree with commit-tree, move
// the run's branch with a compare-and-swap, keep your index with the two-tree
// merge, idempotent per verify_id, with crash recovery by trailer (plan
// sections 7 and 9). Owner: phase 1b, work package C. A fanout's land (gate
// `fanout`), which moves the checkout's index and files to the integration
// tip, and its recovery by the intent's commit: phase 2b, package G. A repair
// swarm's land of the repaired integration tip, through the same tail: phase
// 2b-2, package Y.
//
// Every git argv here is built from run.json's checked facts, the ledger's
// trees and git's own answers. Nothing from the call becomes an argument: the
// gate and verify_id are matched against the plan and the ledger first, and
// reach git only as message text: the commit message on stdin, the reflog's
// `-m` (plan section 9, "Mod safety").

import type { Ports } from './ports'
import type { RecordCtx, RecordHandler, RecordReply, StoredRecord } from './records/core'
import type { RunJson, RunRepairBody } from './records/run'
import type { LiveSwarm, NodeBinding, RunLink } from './swarm/types'
import type {
  GateRef,
  LandAbandonedBody,
  LandBlockedBody,
  LandBody,
  LandIntentBody,
  LandReply,
} from './records/execute'
import type { IntegrateDoneBody } from './records/fanout'
import { fail } from './records/core'
import { FANOUT_GATE } from './records/fanout'
import { appendRecord, readLedger } from './ledgercore'
import { integrationBranch, runJsonPath } from './layout'
import { readJson, serial } from './fsx'
import { snapshot } from './snapshot'
import { attribution } from './options'
import { withInflight } from './inflight'
import { fanoutTasks, integrationWorktree, wholeResult } from './integrate'
import { bindings, liveSwarm, spawnsUsed } from './swarm/state'
import { nodeOf, writesFiles } from './swarm/admit'
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
/** The lands the ledger knows: landed verify_ids, intents with no land or abandon, the last block per verify_id. */
function landState(records: readonly StoredRecord[]): { landed: Set<string>; open: Map<string, LandIntentBody>; blocked: Map<string, LandBlockedBody> } {
  const landed = new Set<string>()
  const open = new Map<string, LandIntentBody>()
  const blocked = new Map<string, LandBlockedBody>()
  for (const rec of records) {
    const v = (rec.body as { verify_id?: unknown }).verify_id
    if (typeof v !== 'string') continue
    if (rec.kind === 'land.intent') open.set(v, rec.body as LandIntentBody)
    else if (rec.kind === 'land') {
      landed.add(v)
      open.delete(v)
    } else if (rec.kind === 'land.abandoned') open.delete(v)
    else if (rec.kind === 'land.blocked') blocked.set(v, rec.body as LandBlockedBody)
  }
  return { landed, open, blocked }
}

/** Records a block once per fact: the same reason and paths again add nothing. */
function blocker(p: Ports, f: RunFacts, blocked: Map<string, LandBlockedBody>, problems: string[]) {
  return async (body: LandBlockedBody): Promise<void> => {
    problems.push(body.reason)
    const last = blocked.get(body.verify_id)
    if (last && last.reason === body.reason && sameList(last.paths, body.paths)) return
    await appendRecord(p, f.runDir, { run: f.run, kind: 'land.blocked', by: MOD, body })
    blocked.set(body.verify_id, body)
  }
}

/** The checkout repair refused: what's in the files now, and where the integration's result still is. */
const checkoutRepairRefused = (why: string, ref: string): string =>
  `the checkout repair (git read-tree -m -u) was refused: ${why}. These files hold the integration's content with your changes since; ${branchOf(ref)}-integration still has the result. Decide what to keep; the repair is retried at the next reconcile`

/**
 * A fanout's lands, reconciled by each intent's `commit`, never by trailers:
 * the ref holds the integration tip, whose merges and task commits carry
 * whatever messages their writers gave them (plan section 7, fanout.js step 5).
 *  - the ref at the intent's `commit`: it landed (`land { recovered: true }`);
 *  - the ref still at the intent's `old` (base): the checkout is repaired with
 *    `read-tree -m -u <tree> HEAD` and the intent abandoned, or `land.blocked`
 *    with the paths when git refuses;
 *  - anything else is refused with the facts.
 */
async function reconcileFanout(p: Ports, f: RunFacts, records: readonly StoredRecord[]): Promise<ReconcileResult> {
  const { run, runDir, json } = f
  const { open, blocked } = landState(records)
  const problems: string[] = []
  const refuseWith = blocker(p, f, blocked, problems)
  const append = <B>(kind: string, body: B) => appendRecord(p, runDir, { run, kind, by: MOD, body })
  const tip = open.size > 0 ? await tipOf(p, json.checkout, json.ref) : null
  for (const [v, intent] of open) {
    if (typeof intent.commit === 'string' && OID.test(intent.commit) && tip === intent.commit) {
      const body: LandBody = { gate: intent.gate, verify_id: v, commit: intent.commit, tree: intent.tree, old: intent.old, ref: json.ref, recovered: true }
      // After the swap the repair is a no-op, and re-syncs a checkout that moved since.
      const r = await repair(p, json.checkout, intent)
      if (!r.ok) body.note = `recovered; the checkout repair left these alone: ${r.why}`
      await append('land', body)
      continue
    }
    if (tip === null || tip !== intent.old) {
      await refuseWith({
        gate: intent.gate,
        verify_id: v,
        reason: `the land of ${intent.gate} (verify ${v}) stopped part way, and ${branchOf(json.ref)} is at ${tip ?? 'nothing'}, neither ${intent.old} where it started nor ${intent.commit ?? 'the commit it was moving to'}; litter won't repair or retry it, so check the branch and the checkout yourself`,
      })
      continue
    }
    const r = await repair(p, json.checkout, intent)
    if (r.ok) {
      await append('land.abandoned', {
        gate: intent.gate,
        verify_id: v,
        reason: 'the land stopped before the ref moved; reconcile put the checkout back to HEAD, and a retried land starts over',
      } satisfies LandAbandonedBody)
      continue
    }
    const body: LandBlockedBody = { gate: intent.gate, verify_id: v, reason: checkoutRepairRefused(r.why, json.ref) }
    if (r.paths.length > 0) body.paths = r.paths
    await refuseWith(body)
  }
  for (const problem of problems) p.log(`reconcile ${run}: ${problem}`)
  return { problems }
}

async function reconcileIn(p: Ports, f: RunFacts): Promise<ReconcileResult> {
  const { run, runDir, json } = f
  const ledger = await readLedger(p, runDir, run)
  if (ledger.tampered) {
    return { problems: [`the run's ledger is tampered at record ${ledger.tampered.seq} (${ledger.tampered.reason})`] }
  }
  if (json.workflow === 'fanout') return reconcileFanout(p, f, ledger.records)
  const listed = await listLanded(p, json)
  if (!listed.ok) {
    // A run that never began a land has nothing on its ref to account for (its branch may be gone since).
    if (!ledger.records.some(r => r.kind.startsWith('land'))) return { problems: [] }
    p.log(`reconcile ${run}: ${listed.error}`)
    return { problems: [listed.error] }
  }

  const { landed, open, blocked } = landState(ledger.records)
  const problems: string[] = []
  const append = <B>(kind: string, body: B) => appendRecord(p, runDir, { run, kind, by: MOD, body })
  const refuseWith = blocker(p, f, blocked, problems)

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
          ? checkoutRepairRefused(r.why, json.ref)
          : `the index repair (git read-tree -m -i) was refused: ${r.why}. Nothing changed; it's retried at the next reconcile`,
    }
    if (r.paths.length > 0) body.paths = r.paths
    await refuseWith(body)
  }

  for (const problem of problems) p.log(`reconcile ${run}: ${problem}`)
  return { problems }
}

/**
 * At session.start (through reconcileRuns) and before every land: finds lands
 * the ledger missed (by their trailers, or a fanout's by its intent's commit),
 * abandons stale intents.
 */
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

/** The verdict dimensions a land needs passed (plan section 7: PA and RA, and the rules verdict when it has one), and no plan gap or rule clash named. */
function verdictFails(body: Record<string, unknown>): string[] {
  const pass = (d: unknown): boolean => d !== null && typeof d === 'object' && (d as { pass?: unknown }).pass === true
  const out: string[] = []
  if (!pass(body.plan_adherence)) out.push('plan_adherence')
  if (!pass(body.no_regressions)) out.push('no_regressions')
  if (body.rules !== undefined && !pass(body.rules)) out.push('rules')
  if (typeof body.plan_gap === 'string' && body.plan_gap.trim() !== '') out.push('plan_gap (it names one)')
  // A verdict recorded before rule_clash has none (WP-AH).
  if (typeof body.rule_clash === 'string' && body.rule_clash.trim() !== '') out.push('rule_clash (it names one)')
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
  const gate = input.gate
  // A fanout lands once, with gate `fanout`, and an execute run never does (plan section 7, fanout.js step 5).
  if (facts.json.workflow === 'fanout') {
    if (gate !== FANOUT_GATE) return fail(`litter: a fanout run lands with gate '${FANOUT_GATE}', citing the verifier's verify for gate integration`, 'gate', [FANOUT_GATE])
    const verifyId = input.verify_id
    if (typeof verifyId !== 'string' || verifyId === '') {
      return fail("litter: 'verify_id' must be the verify_id the verifier's result cites, as your instruction gives it", 'verify_id')
    }
    return serial(landKey(facts.runDir), () => landFanout(ctx, facts, verifyId))
  }
  const ids = gateIds(facts.json)
  if (gate === FANOUT_GATE) return fail(`litter: gate '${FANOUT_GATE}' lands only in a fanout run; run ${facts.run} is a ${facts.json.workflow} run, so name its plan gate`, 'gate', ids)
  if (typeof gate !== 'string' || gate === '') return fail("litter: 'gate' must name the plan gate to land, as your instruction gives it", 'gate', ids)
  if (FIXED_GATES.includes(gate)) {
    return fail(`litter: gate '${gate}' isn't landed by a land record; name the plan gate your instruction gives`, 'gate', ids)
  }
  if (!isPlanGate(facts.json, gate)) return fail(`litter: run ${facts.run} has no gate '${gate}'`, 'gate', ids)
  const verifyId = input.verify_id
  if (typeof verifyId !== 'string' || verifyId === '') {
    return fail("litter: 'verify_id' must be the verify_id the critic's verdict cites, as your instruction gives it", 'verify_id')
  }
  // The in-flight flag reads `land` for the land's duration (AB's inflight.ts, decision 24).
  return deps.withInflight(ctx.p, ctx.litterDir!, facts.run, 'land', () => landGate(ctx, facts, gate, verifyId))
}

// The other packages' functions reached from here, through one table so tier 2
// can stand in for them (COMMON, "Another package's module").
export const deps = {
  withInflight: <T>(...a: Parameters<typeof withInflight<T>>) => withInflight<T>(...a),
}

/**
 * An execute land of plan gate `gate` from the verify `verifyId`, serialized
 * per run with every other land: the six steps of plan section 9. Exported
 * for the plan template's land (AC, swarm/gate.ts), which passes
 * `observe: false`, since a node's land answers through the tool and has no
 * out file to write. The caller has checked the gate is a plan gate and the
 * verify id a string.
 */
export function landGate(ctx: RecordCtx, f: RunFacts, gate: GateRef, verifyId: string, opts?: { observe?: boolean }): Promise<RecordReply> {
  return serial(landKey(f.runDir), () => land(ctx, f, gate, verifyId, opts))
}

async function land(ctx: RecordCtx, f: RunFacts, gate: GateRef, verifyId: string, opts?: { observe?: boolean }): Promise<RecordReply> {
  const { p } = ctx
  const { run, runDir, json } = f
  const branch = branchOf(json.ref)

  const answer = async (reply: LandReply): Promise<LandReply> => {
    if (opts?.observe !== false) await observe(ctx, { land_of: verifyId }, landFields(reply))
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

// ---------------------------------------------------------------------------
// The fanout land (plan section 7, fanout.js step 5).

/**
 * Moves the checkout's index and files from base to the verified integration
 * tip with git's two-tree merge (`read-tree -m -u`), then fast-forwards the
 * run's ref to the tip itself with a compare-and-swap. The tip was made
 * before the verify, so it carries no trailer: the intent records it as
 * `commit`, and reconcile matches the ref against that.
 */
async function landFanout(ctx: RecordCtx, f: RunFacts, verifyId: string): Promise<RecordReply> {
  const { p } = ctx
  const { run, runDir, json } = f
  const gate = FANOUT_GATE
  const branch = branchOf(json.ref)
  const base = json.base

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

  // Idempotent per verify_id: the first answer, and nothing moved.
  const prior = findLast(records, r => r.kind === 'land' && r.body.verify_id === verifyId)
  if (prior) {
    const b = prior.body as LandBody
    if (b.gate !== gate) return refuse(`verify ${verifyId} already landed gate ${b.gate}, not ${gate}`, false)
    return landed(b.commit, b.note)
  }
  if (reconciled.problems.length > 0) return refuse(`reconcile found what it can't settle: ${reconciled.problems.join('; ')}`, false)
  const closed = runClosed(records)
  if (closed) return refuse(`run ${run} ${closed}, so nothing more lands`, false)
  const earlier = lastLand(records)
  if (earlier) return refuse(`run ${run} already landed ${earlier.commit} with verify ${earlier.verify_id}; a fanout lands once`, false)

  // 1. A green verify for gate integration, cited by the agent that recorded it, and its latest for that gate and attempt.
  const vRec = records.find(r => verifyBody(r)?.verify_id === verifyId)
  const v = vRec ? verifyBody(vRec) : null
  if (!vRec || !v) return refuse(`run ${run} has no verify ${verifyId}`, false)
  if (v.gate !== 'integration') return refuse(`verify ${verifyId} is for gate ${v.gate}; a fanout lands on the verifier's verify for gate integration`, false)
  if (!isGreen(v)) return refuse(`verify ${verifyId} isn't green (${notGreen(v)})`, false)
  const recorder = vRec.by.source === 'agent' ? vRec.by.agentId : null
  if (recorder === null) return refuse(`verify ${verifyId} wasn't recorded by an agent, so no verdict can cite it`, false)
  const latest = findLast(records, r => {
    const b = verifyBody(r)
    return b !== null && r.by.source === 'agent' && r.by.agentId === recorder && b.gate === v.gate && b.attempt === v.attempt
  })
  const latestId = latest ? verifyBody(latest)?.verify_id : undefined
  if (latestId !== verifyId) {
    return refuse(`verify ${verifyId} isn't the latest its recorder made for integration attempt ${v.attempt} (that's ${latestId}), so it can't be cited`, false)
  }

  // 2. It ran on the integration's tree: integrate.done's, the integration tip's, and the integration worktree's still.
  const doneRec = findLast(records, r => r.kind === 'integrate.done')
  if (!doneRec) return refuse(`run ${run}'s integration hasn't finished (there's no integrate.done), so there's nothing to land`, false)
  const done = doneRec.body as IntegrateDoneBody
  if (v.tree_after !== done.tree) return refuse(`verify ${verifyId} ran on tree ${v.tree_after}, not the integration's ${done.tree}`, false)
  const ib = integrationBranch(run)
  const ibTip = await tipOf(p, json.checkout, `refs/heads/${ib}`)
  if (ibTip !== done.tip) return refuse(`${ib} is at ${ibTip ?? 'nothing'}, not the integration tip ${done.tip} the integration recorded`, false)
  const tipTree = (await git(p, json.checkout, ['rev-parse', '--verify', '-q', `${done.tip}^{tree}`])).stdout.trim()
  if (tipTree !== done.tree) return refuse(`the integration tip ${done.tip} has tree ${tipTree || 'none'}, not ${done.tree}`, false)
  // The ref only ever fast-forwards: the tip descends from base.
  const descends = await git(p, json.checkout, ['merge-base', '--is-ancestor', base, done.tip])
  if (descends.code !== 0) return refuse(`the integration tip ${done.tip} doesn't descend from the run's base ${base}`, false)
  const wt = integrationWorktree(records, run)
  if (!wt) return refuse(`run ${run} has no integration worktree recorded`, false)
  let there: Awaited<ReturnType<typeof snapshot>>
  try {
    there = await snapshot(p, wt.path)
  } catch (err) {
    return refuse(`the integration worktree ${wt.path} can't be snapshotted: ${message(err)}`, false)
  }
  if (there.tree !== done.tree || there.dirty_submodules.length > 0) {
    return refuse(`the integration worktree ${wt.path} changed after the integration, so it isn't the tree verify ${verifyId} judged`, false)
  }

  // 3. Everything merged: nothing blocked, nothing skipped, every writer merged.
  if (done.blocked.length > 0) return refuse(`the integration was refused: ${done.blocked.join('; ')}`, false)
  const skipped = records.filter(r => r.kind === 'integrate.skip').map(r => String(r.body.task))
  if (skipped.length > 0) return refuse(`a fanout lands all or nothing, and these tasks weren't merged: ${skipped.join(', ')}`, false)
  const tasks = fanoutTasks(json)
  const merged = new Set(records.filter(r => r.kind === 'integrate.merge').map(r => r.body.task))
  const unmerged = tasks.filter(t => t.writes && !merged.has(t.id)).map(t => t.id)
  if (unmerged.length > 0) return refuse(`these writing tasks have no merge: ${unmerged.join(', ')}`, false)

  // 4. The verifier's verdict on that verify_id, from the same agent, passing every task of the run.
  const verdict = findLast(records, r => r.kind === 'verdict' && r.body.verify_id === verifyId)
  if (!verdict) return refuse(`no verdict cites verify ${verifyId}`, false)
  if (agentOf(verdict) !== recorder) return refuse(`the verdict citing verify ${verifyId} isn't from the agent that recorded it`, false)
  const judged = Array.isArray(verdict.body.tasks) ? (verdict.body.tasks as { id?: unknown; pass?: unknown }[]) : []
  const notPassed = tasks.filter(t => !judged.some(j => j !== null && typeof j === 'object' && j.id === t.id && j.pass === true)).map(t => t.id)
  if (notPassed.length > 0) return refuse(`the verdict on verify ${verifyId} doesn't pass every task: ${notPassed.join(', ')}`, false)

  // 5. The whole-result check, again, on the tip being landed.
  const whole = await wholeResult(p, f, records, done.tip)
  if (whole.blocked.length > 0) return refuse(`the combined change fails the ownership check: ${whole.blocked.join('; ')}`, false)

  // 6. The destination: on the run's branch, at base, and unchanged since the launch (section 7, fanout.js step 5).
  const head = await headRef(p, json.checkout)
  if (head !== json.ref) {
    return refuse(`the checkout is on ${head ? branchOf(head) : 'a detached HEAD'}, not ${branch}; switch back (git switch ${branch}) and land again`, false)
  }
  const at = await tipOf(p, json.checkout, json.ref)
  if (at !== base) return refuse(`${branch} is at ${at ?? 'nothing'}, not the run's base ${base}; something else moved it`, false)
  let now: Awaited<ReturnType<typeof snapshot>>
  try {
    now = await snapshot(p, json.checkout)
  } catch (err) {
    return refuse(`the snapshot before the land failed: ${message(err)}`, false)
  }
  if (now.dirty_submodules.length > 0) {
    return refuse(`submodules have uncommitted changes (${now.dirty_submodules.join(', ')}); commit, stash or discard inside them, then land again`, false)
  }
  const baseTree = (await git(p, json.checkout, ['rev-parse', '--verify', '-q', `${base}^{tree}`])).stdout.trim()
  if (now.tree !== baseTree) {
    return refuse(
      `the checkout changed after the launch (it no longer snapshots to base ${base}), so moving the integration's files in would overwrite or mix in those changes; commit, stash or discard them, then land again`,
      true,
    )
  }

  // The steps, in order.
  return landTip(p, f, verifyId, done.tip, done.tree, { refuse, landed })
}

/** How a checkout land answers: landFanout's writes the relay's out file first; a repair node's answers as it is. */
type Answers = {
  refuse: (reason: string, retry: boolean) => Promise<LandReply>
  landed: (commit: string, note?: string) => Promise<LandReply>
}

/**
 * The checkout land's steps once every check passed, landFanout's and
 * landRepaired's (plan section 7, fanout.js step 5): the intent naming `tip`,
 * the checkout's index and files moved from base to the tip by git's two-tree
 * merge, the compare-and-swap of the run's ref from base to the tip, the
 * re-sync to HEAD, and the land record, all with gate `fanout`. A crash after
 * the intent is reconcileFanout's, by the intent's `commit`.
 */
async function landTip(p: Ports, f: RunFacts, verifyId: string, tip: string, tree: string, { refuse, landed }: Answers): Promise<LandReply> {
  const { run, runDir, json } = f
  const gate = FANOUT_GATE
  const branch = branchOf(json.ref)
  const base = json.base
  const intent: LandIntentBody = { gate, verify_id: verifyId, tree, old: base, ref: json.ref, mode: 'checkout', commit: tip }
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

  // The checkout's index and files, by git's two-tree merge under its own lock. A
  // refresh first, so a file whose content is unchanged doesn't read as modified.
  await git(p, json.checkout, ['update-index', '-q', '--refresh'])
  const moved = await git(p, json.checkout, ['read-tree', '-m', '-u', base, tip])
  if (moved.code !== 0) {
    return abandon(
      `git refused to move the checkout to the integration, so nothing moved: ${refusal(moved)}. A file you changed or staged on the integration's paths, an untracked file in the way, a held index.lock or unmerged entries stop it; resolve that, then land again`,
    )
  }

  // Compare-and-swap on the run's ref, never HEAD.
  const swap = await git(p, json.checkout, ['update-ref', '-m', `litter: land ${gate} of ${run}`, json.ref, tip, base])

  // Re-sync the checkout to whatever HEAD is now, whatever the swap did.
  const notes: string[] = []
  const resync = await git(p, json.checkout, ['read-tree', '-m', '-u', tip, 'HEAD'])
  const headNow = await headRef(p, json.checkout)
  if (headNow !== json.ref) notes.push(`the checkout moved to ${headNow ? branchOf(headNow) : 'a detached HEAD'} during the land, and its files were re-synced to it`)
  if (resync.code !== 0) notes.push(`the re-sync to HEAD left these alone: ${refusal(resync)}`)
  if (swap.code !== 0) {
    const tipNow = await tipOf(p, json.checkout, json.ref)
    return abandon([`${branch} moved during the land (it's at ${tipNow ?? 'nothing'}), so nothing landed`, ...notes].join('; '))
  }

  const note = notes.length > 0 ? notes.join('; ') : undefined
  const body: LandBody = { gate, verify_id: verifyId, commit: tip, tree, old: base, ref: json.ref }
  if (note) body.note = note
  try {
    await appendRecord(p, runDir, { run, kind: 'land', by: MOD, body })
  } catch (err) {
    p.log(`land ${run} ${gate}: the land record failed (${message(err)}); reconcile recovers it from the intent's commit`)
  }
  return landed(tip, note)
}

// ---------------------------------------------------------------------------
// A repair swarm's land (plan 15.10, 15.11; phase 2b-2, package Y).

/** What a repair land acts on: the verify the node's land cites, and the swarm and node that asked. */
export type RepairedLand = { verifyId: string; swarm: string; agentId: string }

/**
 * Lands a repair swarm's committed integration tip (COMMON 2b-2, step 5): every
 * check before the intent (an approving verdict within the budget citing a
 * green verify of that tip, no writer as the verdict's agent, every changed
 * path owned by a task of the run, the checkout at base), then landFanout's
 * intent, two-tree merge and compare-and-swap tail, with gate `fanout` in the
 * run's ledger; a crash after the intent is reconciled as landFanout's is.
 * The reply is execute's LandReply, with no out file: a node's land has no
 * StructuredOutput for one to fill.
 */
export async function landRepaired(ctx: RecordCtx, f: RunFacts, land: RepairedLand): Promise<RecordReply> {
  return serial(landKey(f.runDir), () => repairedLand(ctx.p, f, land))
}

/** A repair swarm node's verify gate (swarm/gate.ts): never one a record call can name (FIXED_GATES and plan gates). */
export const REPAIR_GATE = 'repair'

/**
 * The `run.repair` that opened `link`'s generation, while it's the run's open
 * one: the latest lifecycle record is that run.repair (verify.ts, runClosed).
 * Else why not, completing "run <id> …".
 */
export function repairGeneration(
  records: readonly StoredRecord[],
  link: RunLink,
): { ok: true; rec: StoredRecord<RunRepairBody> } | { ok: false; why: string } {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!
    if (r.kind === 'run.repair') {
      const g = (r.body as Partial<RunRepairBody>).generation
      return g === link.generation
        ? { ok: true, rec: r as StoredRecord<RunRepairBody> }
        : { ok: false, why: `is open for repair generation ${String(g)}, not ${link.generation}` }
    }
    if (r.kind === 'run.end') return { ok: false, why: `has ended${records.slice(0, i).some(x => x.kind === 'run.repair') ? ' its repair generation' : ''}` }
    if (r.kind === 'run.stopping') return { ok: false, why: 'is stopping' }
    if (r.kind === 'run.launch' || r.kind === 'run.resume') return { ok: false, why: 'is running its workflow, not a repair' }
  }
  return { ok: false, why: 'has no repair generation open' }
}

/** The budget case's ending for a refusal a node reads (plan 15.11, "It asks you only when it can't proceed itself"). */
const ASK_FOR_BUDGET = 'report blocked to your parent, saying what more you need and for what; the lead can ask the user for it with repair.budget'

/**
 * The checks of COMMON 2b-2 step 5's land, each refused on its own, then
 * landTip. Under the land's key: reconcile, idempotency per verify_id and the
 * ledger are read as landFanout reads them.
 */
async function repairedLand(p: Ports, f: RunFacts, { verifyId, swarm }: RepairedLand): Promise<LandReply> {
  const { run, runDir, json } = f
  const branch = branchOf(json.ref)
  const base = json.base
  const refuse = async (reason: string, retry: boolean): Promise<LandReply> => ({ ok: true, landed: false, reason, retry })
  const landed = async (commit: string, note?: string): Promise<LandReply> =>
    note ? { ok: true, landed: true, commit, retry: false, reason: note } : { ok: true, landed: true, commit, retry: false }

  const s = liveSwarm(swarm)
  const link = s?.run
  if (!s || !link || link.run !== run || link.runDir !== runDir) return refuse(`swarm ${swarm} isn't a live repair swarm of run ${run}`, false)
  if (!s.budget) return refuse(`repair swarm ${swarm} has no repair budget, so nothing it made lands`, false)
  if (json.workflow !== 'fanout') return refuse(`run ${run} is a ${json.workflow} run; a repair swarm lands only a fanout's integration`, false)

  const reconciled = await reconcileIn(p, f)
  const ledger = await readLedger(p, runDir, run)
  if (ledger.tampered) {
    return refuse(`the run's ledger is tampered at record ${ledger.tampered.seq} (${ledger.tampered.reason}), so nothing more lands`, false)
  }
  const records = ledger.records
  const prior = findLast(records, r => r.kind === 'land' && r.body.verify_id === verifyId)
  if (prior) {
    const b = prior.body as LandBody
    if (b.gate !== FANOUT_GATE) return refuse(`verify ${verifyId} already landed gate ${b.gate}, not ${FANOUT_GATE}`, false)
    return landed(b.commit, b.note)
  }
  if (reconciled.problems.length > 0) return refuse(`reconcile found what it can't settle: ${reconciled.problems.join('; ')}`, false)
  const closed = runClosed(records)
  if (closed) return refuse(`run ${run} ${closed}, so nothing more lands`, false)
  const gen = repairGeneration(records, link)
  if (!gen.ok) return refuse(`run ${run} ${gen.why}, so nothing more lands`, false)
  const since = gen.rec.seq
  const earlier = lastLand(records)
  if (earlier) return refuse(`run ${run} already landed ${earlier.commit} with verify ${earlier.verify_id}; a fanout lands once`, false)

  // 1. A green verify of this generation, as the gate ran it: gate repair, recorded by an agent.
  const vRec = records.find(r => verifyBody(r)?.verify_id === verifyId)
  const v = vRec ? verifyBody(vRec) : null
  if (!vRec || !v) return refuse(`run ${run} has no verify ${verifyId}`, false)
  if (vRec.seq < since) return refuse(`verify ${verifyId} is from before this repair (generation ${link.generation}); verify the repaired tree and have it judged`, false)
  if (v.gate !== REPAIR_GATE) return refuse(`verify ${verifyId} is for gate ${v.gate}, not a repair swarm's verify`, false)
  if (!isGreen(v)) return refuse(`verify ${verifyId} isn't green (${notGreen(v)})`, false)
  const recorder = vRec.by.source === 'agent' ? vRec.by.agentId : null
  if (recorder === null) return refuse(`verify ${verifyId} wasn't recorded by an agent, so no verdict can cite it`, false)

  // 2. The critic's verdict on it: this generation's latest, from that agent, of a verdicts type, passing every task.
  const verdicts = records.filter(r => r.seq > since && r.kind === 'verdict')
  const verdict = findLast(verdicts, r => r.body.verify_id === verifyId)
  if (!verdict) return refuse(`no verdict cites verify ${verifyId}; the critic records its own verify of the committed tree, then a verdict citing it`, false)
  const latest = verdicts.at(-1)!
  if (latest !== verdict) {
    return refuse(`the verdict on verify ${verifyId} isn't this repair's latest: round ${String(latest.body.round)} on verify ${String(latest.body.verify_id)} came after it, and the critic's latest judgment is the one a land follows`, false)
  }
  if (agentOf(verdict) !== recorder) return refuse(`the verdict citing verify ${verifyId} isn't from the agent that recorded it`, false)
  const type = verdict.by.source === 'agent' ? verdict.by.agentType : null
  const judge = Object.entries(s.types).find(([, t]) => t === type)?.[0]
  const judgeNode = judge === undefined ? null : nodeOf(s, judge)
  if (!judgeNode || judgeNode.verdicts !== true) return refuse(`the verdict on verify ${verifyId} isn't from a node of swarm ${swarm} whose type has verdicts: true`, false)
  const tasks = fanoutTasks(json)
  const judged = Array.isArray(verdict.body.tasks) ? (verdict.body.tasks as { id?: unknown; pass?: unknown }[]) : []
  const notPassed = tasks.filter(t => !judged.some(j => j !== null && typeof j === 'object' && j.id === t.id && j.pass === true)).map(t => t.id)
  if (notPassed.length > 0) return refuse(`the verdict on verify ${verifyId} doesn't approve every task: ${notPassed.join(', ')} didn't pass`, false)

  // 3. Within the budget (15.11: past it, the swarm can't land, and has to ask).
  const round = verdict.body.round
  if (typeof round !== 'number' || !(round <= s.budget.rounds)) {
    return refuse(`the verdict on verify ${verifyId} is round ${String(round)}, past the repair budget's ${s.budget.rounds}; ${ASK_FOR_BUDGET}`, false)
  }
  if (spawnsUsed(swarm) > s.budget.agents) {
    return refuse(`repair swarm ${swarm} started ${spawnsUsed(swarm)} agents, past its budget of ${s.budget.agents}; ${ASK_FOR_BUDGET}`, false)
  }

  // 4. No writer judged its own change: the verdict's agent is no writing binding in the verified directory.
  const wt = integrationWorktree(records, run)
  if (!wt) return refuse(`run ${run} has no integration worktree recorded`, false)
  const writesThere = bindings(swarm).filter(b => b.cwd === wt.path && writes(s, b))
  if (writesFiles(judgeNode) || writesThere.some(b => b.agentId === recorder)) {
    return refuse(`the verdict on verify ${verifyId} is from an agent that may write in ${wt.path}, so it could be judging its own change`, false)
  }

  // 5. The verified tree is the integration branch's committed tip, and the integration worktree's snapshot.
  const ib = integrationBranch(run)
  const tip = await tipOf(p, json.checkout, `refs/heads/${ib}`)
  if (tip === null) return refuse(`${ib} doesn't resolve to a commit`, false)
  const tipTree = (await git(p, json.checkout, ['rev-parse', '--verify', '-q', `${tip}^{tree}`])).stdout.trim()
  if (tipTree !== v.tree_after) {
    return refuse(`verify ${verifyId} ran on tree ${v.tree_after}, but ${ib}'s tip ${tip} has tree ${tipTree || 'none'}: what lands is the committed tip, so verify and judge it as it is now`, true)
  }
  const wtHead = await headRef(p, wt.path)
  if (wtHead !== `refs/heads/${ib}`) {
    return refuse(`the integration worktree ${wt.path} is on ${wtHead ? branchOf(wtHead) : 'a detached HEAD'}, not ${ib}; the repair commits on ${ib}`, false)
  }
  let there: Awaited<ReturnType<typeof snapshot>>
  try {
    there = await snapshot(p, wt.path)
  } catch (err) {
    return refuse(`the integration worktree ${wt.path} can't be snapshotted: ${message(err)}`, false)
  }
  if (there.dirty_submodules.length > 0) {
    return refuse(`submodules in the integration worktree have uncommitted changes (${there.dirty_submodules.join(', ')}); commit or discard them, then verify and judge again`, true)
  }
  if (there.tree !== tipTree) {
    return refuse(`the integration worktree ${wt.path} has uncommitted changes on top of ${ib}'s tip; commit them on ${ib} or discard them, then verify and judge the tip`, true)
  }

  // 6. The tip adds to the integration's outcome: integrate.done's tip, or base when it stopped at a conflict.
  const doneRec = findLast(records, r => r.kind === 'integrate.done')
  const conflict = records.some(r => r.kind === 'integrate.conflict')
  const from = doneRec ? (doneRec.body as IntegrateDoneBody).tip : conflict ? base : null
  if (from === null) return refuse(`run ${run}'s integration never finished, so there's no integration result to repair`, false)
  for (const anchor of new Set([base, from])) {
    const descends = await git(p, json.checkout, ['merge-base', '--is-ancestor', anchor, tip])
    if (descends.code !== 0) {
      const what = anchor === base ? `the run's base ${base}` : `the integration's tip ${anchor}`
      return refuse(`${ib}'s tip ${tip} doesn't descend from ${what}; a repair adds commits on ${ib}, it doesn't rewrite them`, false)
    }
  }

  // 7. Every changed path against base is a task's: an unowned one changes what was asked (the scope case).
  const whole = await wholeResult(p, f, records, tip, { owners: 'all' })
  if (whole.blocked.length > 0) {
    return refuse(
      `the repaired change fails the ownership check: ${whole.blocked.join('; ')}. Changing a path no task of the run owns changes what was asked: that's the scope case, so report blocked to your parent with the paths and why`,
      false,
    )
  }

  // 8. The destination: on the run's branch, at base, and unchanged since the launch (as landFanout's step 6).
  const head = await headRef(p, json.checkout)
  if (head !== json.ref) {
    return refuse(`the checkout is on ${head ? branchOf(head) : 'a detached HEAD'}, not ${branch}; switch back (git switch ${branch}) and land again`, false)
  }
  const at = await tipOf(p, json.checkout, json.ref)
  if (at !== base) return refuse(`${branch} is at ${at ?? 'nothing'}, not the run's base ${base}; something else moved it`, false)
  let now: Awaited<ReturnType<typeof snapshot>>
  try {
    now = await snapshot(p, json.checkout)
  } catch (err) {
    return refuse(`the snapshot before the land failed: ${message(err)}`, false)
  }
  if (now.dirty_submodules.length > 0) {
    return refuse(`submodules have uncommitted changes (${now.dirty_submodules.join(', ')}); commit, stash or discard inside them, then land again`, false)
  }
  const baseTree = (await git(p, json.checkout, ['rev-parse', '--verify', '-q', `${base}^{tree}`])).stdout.trim()
  if (now.tree !== baseTree) {
    return refuse(
      `the checkout changed after the launch (it no longer snapshots to base ${base}), so moving the repaired files in would overwrite or mix in those changes; commit, stash or discard them, then land again`,
      true,
    )
  }

  return landTip(p, f, verifyId, tip, tipTree, { refuse, landed })
}

/** A binding writes when its node does (a child, as its node). */
const writes = (s: LiveSwarm, b: NodeBinding): boolean => {
  const node = nodeOf(s, b.node)
  return node === null || writesFiles(node)
}
