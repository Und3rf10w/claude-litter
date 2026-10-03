// WP-J: the health check the builder, Launch and /litter-doctor share (15.7):
// one row per check, each value's process and settings sources apart, and the
// snippet for what falls short. It writes no file, and never settings: the
// snippet is for you to add.
//
// Owner: phase 2b-1, package J. The stub's signature is the contract.

import type { Ports, SettingsSourceName, SubagentLimitName } from '../ports'
import type { HealthInput, HealthReport, HealthRow, HealthValues, OwnerView, SwarmSpec } from './types'
import { getOptions, session } from '../session'
import { modeRefusal, primaryOf, repoOf } from '../lifecycle'
import { realOf } from '../worktrees'
import { liveSwarms } from './state'
import { readOwner } from './owner'
import {
  DEFAULT_CONCURRENT_SUBAGENTS,
  DEFAULT_SPAWN_DEPTH,
  LEAD_AGENTS,
  nodeDirectories,
  parseLimit,
  parseSpec,
  SpecPlaces,
  treeShape,
} from './spec'

const SOURCES: readonly SettingsSourceName[] = ['user', 'project', 'local', 'policy']
/** Which file's value applies when several set one, highest first. */
const PRECEDENCE: readonly SettingsSourceName[] = ['policy', 'local', 'project', 'user']
const DEFAULT_TOOL_CONCURRENCY = 10
/** For the fenced branch switch (section 9, step 0). */
const GIT_MIN: readonly [number, number] = [2, 46]
const SUMMARY_TEST_MS = 8_000

type Raw = Record<string, unknown>
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`)

/** Each settings file's `env`, as loaded (null for a file with nothing in it, or one that couldn't be read). */
async function readSources(p: Ports): Promise<Record<SettingsSourceName, Raw | null>> {
  const out = {} as Record<SettingsSourceName, Raw | null>
  for (const s of SOURCES) {
    try {
      const file = await p.settingsFrom(s)
      out[s] = file && isObj(file.env) ? file.env : null
    } catch (err) {
      p.log(`doctor: the ${s} settings couldn't be read: ${errText(err)}`)
      out[s] = null
    }
  }
  return out
}

type Limit = { name: SubagentLimitName; raw: string | undefined; value: number | null; sources: Partial<Record<SettingsSourceName, string>> }

function limitOf(name: SubagentLimitName, raw: string | undefined, files: Record<SettingsSourceName, Raw | null>): Limit {
  const sources: Partial<Record<SettingsSourceName, string>> = {}
  for (const s of SOURCES) {
    const v = files[s]?.[name]
    if (typeof v === 'string' || typeof v === 'number') sources[s] = String(v)
  }
  return { name, raw, value: parseLimit(raw), sources }
}

const valuesOf = (l: Limit, need?: number): HealthValues => ({
  ...(need !== undefined ? { need } : {}),
  ...(l.raw !== undefined ? { process: l.raw } : {}),
  sources: l.sources,
})

/** Where this process's value comes from, and whether a file's edit hasn't reached it yet (15.7, "Where the values come from"). */
function provenance(l: Limit, fallback: string): string {
  const parts: string[] = []
  if (l.raw !== undefined && l.value === null) parts.push(`'${l.raw}' isn't a whole number of at least 1, so the engine ignores it and ${fallback} applies`)
  const winner = PRECEDENCE.find(s => l.sources[s] !== undefined)
  if (l.sources.policy !== undefined) parts.push(`your organization's policy sets it to ${l.sources.policy}, so only your admin can change it: ask them`)
  if (winner !== undefined && l.sources[winner]!.trim() !== (l.raw ?? '').trim()) {
    parts.push(`your ${winner} settings set ${l.sources[winner]}, but this session has ${l.raw === undefined ? 'it unset' : l.raw}: the edit hasn't reached it yet; recheck in a moment`)
  } else if (winner !== undefined && winner !== 'policy') parts.push(`from your ${winner} settings`)
  else if (winner === undefined && l.raw !== undefined) parts.push("set in this session's environment, not in a settings file")
  else if (l.raw === undefined) parts.push(`unset, so ${fallback} applies`)
  return parts.join('; ')
}

const row = (id: string, severity: HealthRow['severity'], title: string, detail: string, values?: HealthValues): HealthRow => ({
  id,
  severity,
  title,
  detail,
  ...(values ? { values } : {}),
})

/** The concurrency headroom (15.7, "Fixing it"): the need times 1.5, up to a multiple of 10. */
const roomy = (need: number): number => Math.ceil((need * 1.5) / 10) * 10

async function ownerRow(p: Ports, litterDir: string, name: string): Promise<HealthRow> {
  const id = `owner:${name}`
  const title = `Who owns ${name}`
  let o: OwnerView | null
  try {
    o = await readOwner(p, litterDir, name)
  } catch (err) {
    return row(id, 'warning', title, `its owner couldn't be read: ${errText(err)}`)
  }
  if (!o || o.oid === null) return row(id, 'warning', title, `its ownership ref ${o?.ref ?? `refs/litter-swarm/${name}`} is gone`)
  if (o.mine) return row(id, 'ok', title, 'this session')
  const who = o.blob ? `session ${o.blob.session} on ${o.blob.host}` : 'another session'
  const lease = o.leaseAgeMs === null ? 'no lease file' : `its lease beaten ${Math.round(o.leaseAgeMs / 1000)} s ago`
  if (o.canHandOver) return row(id, 'warning', title, `${who}, ${lease}: it looks stale, and you can take it over from the browser`)
  return row(id, 'info', title, `${who}, ${lease}: read-only here${o.why ? ` (${o.why})` : ''}`)
}

export async function checkHealth(p: Ports, input: HealthInput): Promise<HealthReport> {
  const rows: HealthRow[] = []
  const spec: SwarmSpec | null = input.spec ? parseSpec(input.spec).spec : null
  const shape = spec ? treeShape(spec) : null
  const litterDir = input.litterDir
  const limits = await p.limits()
  const files = await readSources(p)
  const snippet: Record<string, string> = {}

  // Nesting depth: an error, since the deepest spawns are refused.
  const depth = limitOf('CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH', limits.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, files)
  const depthAllowed = depth.value ?? DEFAULT_SPAWN_DEPTH
  const depthFrom = provenance(depth, `the default (${DEFAULT_SPAWN_DEPTH}, or a server-side value)`)
  if (shape && shape.maxDepth > 0) {
    const short = shape.maxDepth > depthAllowed
    if (short && depth.sources.policy === undefined) snippet[depth.name] = String(shape.maxDepth + 1)
    rows.push(
      row(
        'depth',
        short ? 'error' : 'ok',
        'Nesting depth',
        short
          ? `the deepest node is at depth ${shape.maxDepth}, but this session allows ${depthAllowed}, so its spawns are refused; ${depthFrom}`
          : `the deepest node is at depth ${shape.maxDepth}; this session allows ${depthAllowed}; ${depthFrom}`,
        valuesOf(depth, shape.maxDepth),
      ),
    )
  } else rows.push(row('depth', 'info', 'Nesting depth', `this session allows ${depthAllowed}; ${depthFrom}`, valuesOf(depth)))

  // Concurrent subagents: a warning, since a parent loses the workers past the cap.
  const conc = limitOf('CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS', limits.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, files)
  const concAllowed = conc.value ?? DEFAULT_CONCURRENT_SUBAGENTS
  const concFrom = provenance(conc, `the default (${DEFAULT_CONCURRENT_SUBAGENTS})`)
  if (shape && shape.peak > 0) {
    const need = shape.peak + LEAD_AGENTS
    const short = need > concAllowed
    if (short && conc.sources.policy === undefined) snippet[conc.name] = String(roomy(need))
    const cap =
      shape.uncapped > DEFAULT_CONCURRENT_SUBAGENTS && spec?.limits?.maxAgentsAtOnce === undefined
        ? '; the engine skips this cap in two cases litter can\'t see, so set limits.maxAgentsAtOnce too'
        : ''
    rows.push(
      row(
        'concurrency',
        short ? 'warning' : 'ok',
        'Concurrent subagents',
        `up to ${shape.peak} agents at once, plus ${LEAD_AGENTS} for the lead's own, need ${need}; this session allows ${concAllowed}` +
          (short ? ', so spawns past it are refused with "Do not retry" and a parent loses those workers' : '') +
          `${cap}; ${concFrom}`,
        valuesOf(conc, need),
      ),
    )
  } else rows.push(row('concurrency', 'info', 'Concurrent subagents', `this session allows ${concAllowed}; ${concFrom}`, valuesOf(conc)))

  // The two the swarm needs nothing of: shown for what they are.
  const tools = limitOf('CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY', limits.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY, files)
  const toolsAllowed = tools.value ?? DEFAULT_TOOL_CONCURRENCY
  const orchestrators = spec ? spec.nodes.filter(n => n.kind === 'orchestrator').length : 0
  rows.push(
    row(
      'tool-concurrency',
      'info',
      'Parallel tool calls',
      `up to ${toolsAllowed} tool calls run at once, so more spawns than that in one message run in batches` +
        (orchestrators > toolsAllowed ? `: the ${orchestrators} orchestrators start in batches of ${toolsAllowed}` : '') +
        `; ${provenance(tools, `the default (${DEFAULT_TOOL_CONCURRENCY})`)}`,
      valuesOf(tools),
    ),
  )
  const perSession = limitOf('CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION', limits.CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION, files)
  rows.push(
    row(
      'per-session',
      'info',
      'Subagents per session',
      `Claude Code lists CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION, but 2.1.288 doesn't enforce it; ${provenance(perSession, 'no limit')}`,
      valuesOf(perSession),
    ),
  )

  // The mod's tools, and jq for the command hooks.
  const s = session()
  const refused = s.toolsRefused ?? s.swarmToolsRefused
  if (refused) {
    rows.push(
      row(
        'tools',
        'error',
        "litter's tools",
        `the engine refused them (${refused}): a managed allowedMcpServers can refuse mcp__litter__*, and allowManagedModsOnly the whole plugin; ask your admin`,
      ),
    )
  } else if (!s.ready) rows.push(row('tools', 'warning', "litter's tools", "the session hasn't finished starting, so they aren't known yet; recheck in a moment"))
  else rows.push(row('tools', 'ok', "litter's tools", 'mcp__litter__record and the three swarm tools are registered'))
  const jq = await p.run(['sh', '-c', 'command -v jq']).catch(() => null)
  if (jq && jq.code === 0 && jq.stdout.trim() !== '') rows.push(row('jq', 'ok', 'jq', `on PATH at ${jq.stdout.trim()}`))
  else {
    rows.push(row('jq', 'error', 'jq', "jq isn't on PATH: litter's command hooks need it, and with a swarm live and no jq the guard denies every node's call; install jq"))
  }

  if (!litterDir) {
    rows.push(row('litter-dir', 'error', 'litter directory', `there's none for this session: ${s.litterDirError ?? "the session hasn't resolved one yet"}`))
  } else {
    // The session's mode, from the command hooks' own record.
    const { mode } = await modeRefusal(p, litterDir)
    if (mode === '') {
      rows.push(
        row(
          'mode',
          'error',
          'Session mode',
          "litter's command hooks haven't recorded this session's mode (no hooks/mode), so they may not be running: send any prompt, then recheck; if it stays, plugin hooks are off (disableAllHooks, or allowManagedHooksOnly)",
        ),
      )
    } else if (mode === 'bypassPermissions') {
      rows.push(row('mode', 'warning', 'Session mode', "bypassPermissions: the nodes would run without the classifier; and a switch to it mid-swarm holds them"))
    } else if (mode === 'acceptEdits') {
      rows.push(row('mode', 'warning', 'Session mode', "acceptEdits: a node's Bash may stop to ask you; and a switch to it mid-swarm holds them"))
    } else if (mode === 'dontAsk') {
      // The ask is an AskUserQuestion call, which asks even when a rule allows it, and dontAsk refuses every ask (2.1.288).
      rows.push(row('mode', 'error', 'Session mode', "dontAsk: this session can't show Launch's confirmation, even with AskUserQuestion allowed; switch modes (shift+tab), then recheck"))
    } else rows.push(row('mode', 'ok', 'Session mode', mode))

    const places = new SpecPlaces(p, repoOf(litterDir), litterDir)
    if (spec) rows.push(await worktreesRow(p, spec, places))
    rows.push(await sessionWorktreeRow(p, spec, places, litterDir))
  }
  rows.push(await gitRow(p))

  if (litterDir) for (const live of liveSwarms()) rows.push(await ownerRow(p, litterDir, live.name))

  if (input.testSummaryModel) rows.push(await summaryRow(p))

  return {
    rows,
    errors: rows.filter(r => r.severity === 'error').length,
    warnings: rows.filter(r => r.severity === 'warning').length,
    snippet: Object.keys(snippet).length > 0 ? { env: snippet } : null,
  }
}

/** The spec's `existing` worktrees are there and registered; the `new` ones are what Launch makes. */
async function worktreesRow(p: Ports, spec: SwarmSpec, places: SpecPlaces): Promise<HealthRow> {
  const bad: string[] = []
  const there: string[] = []
  const made: string[] = []
  const list = await places.worktrees()
  for (const n of spec.nodes) {
    const wt = n.worktree
    if (typeof wt !== 'object') continue
    if ('existing' in wt) {
      const { abs, real } = await places.existing(wt.existing)
      if (!(await p.fs.exists(abs))) bad.push(`${n.id}'s ${wt.existing} doesn't exist`)
      else if (list && !list.some(w => w.real === real)) bad.push(`${n.id}'s ${wt.existing} isn't a worktree of this repository`)
      else there.push(wt.existing)
    } else made.push(`${await places.newPath(spec.name, n.id)} from ${wt.new.from} on ${wt.new.branch}`)
  }
  if (!list && there.length + bad.length > 0) bad.push(`git worktree list failed in ${places.repo}`)
  if (bad.length > 0) return row('worktrees', 'error', 'Worktrees', `${bad.join('; ')}; fix the path, or use { new: { from, branch } }`)
  if (there.length + made.length === 0) return row('worktrees', 'ok', 'Worktrees', "the nodes work in the session's directory, or in own worktrees made at each spawn")
  const parts = [there.length > 0 ? `there: ${there.join(', ')}` : null, made.length > 0 ? `Launch makes ${made.join('; ')}` : null].filter(Boolean)
  return row('worktrees', 'ok', 'Worktrees', parts.join('; '))
}

/**
 * A session working in a linked worktree while a node works elsewhere under
 * the main checkout: the engine refuses that node's Bash, Write and Edit
 * (15.4, Launch step 1; spike 1). A worktree outside the repository folder
 * isn't affected.
 */
async function sessionWorktreeRow(p: Ports, spec: SwarmSpec | null, places: SpecPlaces, litterDir: string): Promise<HealthRow> {
  const title = "The session's worktree"
  const cwd = await p.cwd()
  const dirs = await p.run(['git', 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { cwd }).catch(() => null)
  const lines = dirs && dirs.code === 0 ? dirs.stdout.split('\n').filter(l => l !== '') : []
  if (lines.length < 2) return row('session-worktree', 'info', title, `the session's directory ${cwd} isn't in a git repository`)
  const [gitDir, common] = await Promise.all([realOf(p, lines[0]!), realOf(p, lines[1]!)])
  if (gitDir === common) return row('session-worktree', 'ok', title, 'the session works in the main checkout')
  const top = (await places.sessionTop()) ?? cwd
  const primary = primaryOf(litterDir)
  if (!spec || !primary) {
    return row('session-worktree', 'info', title, `the session is working in the linked worktree ${top}: a swarm whose nodes work elsewhere in the repository can't launch from here`)
  }
  const main = await realOf(p, primary)
  const elsewhere = (await nodeDirectories(p, spec, places)).filter(d => d.dir !== null && inside(d.dir, main) && !inside(d.dir, top))
  if (elsewhere.length === 0) return row('session-worktree', 'ok', title, `the session is in the linked worktree ${top}, and every node works there or outside the repository folder`)
  const who = [...new Set(elsewhere.map(d => `${d.node} (${d.what})`))]
  return row(
    'session-worktree',
    'error',
    title,
    `the session is working in the linked worktree ${top}, and ${who.join(', ')} ${who.length === 1 ? 'works' : 'work'} elsewhere in the repository, where the engine would refuse their Bash, Write and Edit; start the swarm from the main checkout, or ExitWorktree first`,
  )
}

async function gitRow(p: Ports): Promise<HealthRow> {
  const r = await p.run(['git', '--version']).catch(() => null)
  const m = r && r.code === 0 ? /(\d+)\.(\d+)(\.\d+)?/.exec(r.stdout) : null
  if (!m) return row('git', 'warning', 'git', `git --version didn't answer${r ? `: ${r.stderr.trim()}` : ''}`)
  const [major, minor] = [Number(m[1]), Number(m[2])]
  const version = m[0]
  if (major > GIT_MIN[0] || (major === GIT_MIN[0] && minor >= GIT_MIN[1])) return row('git', 'ok', 'git', version)
  return row('git', 'warning', 'git', `${version} is older than ${GIT_MIN.join('.')}, which litter's fenced branch switch needs: runs still launch, with the small window the run card describes`)
}

/** The doctor's [Test]: one completion to summaryModel. */
async function summaryRow(p: Ports): Promise<HealthRow> {
  const title = 'Summary model'
  const model = getOptions().summaryModel
  if (!model) return row('summary-model', 'info', title, 'summaries are off (the summaryModel option)')
  try {
    const r = await p.complete({ model, prompt: 'Reply with the single word: ok', maxTokens: 16, timeoutMs: SUMMARY_TEST_MS })
    if (r.isAnswered) return row('summary-model', 'ok', title, `${model} answered`)
    const why = r.reason === 'api-error' ? `an API error (${r.error}${r.status !== null ? `, ${r.status}` : ''})` : r.reason === 'empty-reply' ? 'an empty reply' : 'no reply in time'
    return row('summary-model', 'warning', title, `${model} didn't answer: ${why}; the browser shows no summary until it does`)
  } catch (err) {
    return row('summary-model', 'warning', title, `the engine won't send a request to ${model}: ${errText(err)}`)
  }
}

