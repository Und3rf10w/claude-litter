// The Stats section's view (phase 5b, WP-DH): what this session has spent,
// its context and its rate limits ($.session.usage), then each swarm owned
// here: its spend since launch (stats/spend.ts) and its tokens, the lead's
// turns while it was live and each node's (swarm/state.ts), uncached input,
// cache reads, cache writes and output apart, since cache reads are most of
// a long run's tokens and the cheapest. Every figure is put in words here.
//
// The engine prices no agent alone, so a swarm's spend is the session's
// whole spend while it was live: the lead's turns, and any other agent's
// (another live swarm's too), are in it. Its note says so.

import type { ListedAgent, SessionUsage } from '../ports'
import type { StatsBody, StatsLimit, StatsRow, StatsSwarm, StatsTokens } from '../../types/index'
import type { LiveSwarm, TokenCount } from '../swarm/types'
import { MARK, STYLE } from '../ui/style'
import { COLOR, fmtTokens, liveRows, oneLine, span } from '../swarm/view'
import { leadTokens, liveSwarms, spent, tokens } from '../swarm/state'
import { whenOf } from '../agents/view'

/** A swarm's table keeps this many rows, the lead's first. */
export const STATS_ROWS = 40

/** A spend counted from this soon after the launch is "since launch". */
const LAUNCH_SLACK_MS = 60_000

const plus = (a: TokenCount, b: TokenCount): TokenCount => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheCreation: a.cacheCreation + b.cacheCreation,
  turns: a.turns + b.turns,
})

/** A count in words, each figure `fmtTokens`'d. Pure. */
export const tokenWords = (t: TokenCount): StatsTokens => ({
  input: fmtTokens(t.input),
  cacheRead: fmtTokens(t.cacheRead),
  cacheWrite: fmtTokens(t.cacheCreation),
  output: fmtTokens(t.output),
  turns: t.turns,
})

/** US dollars, to the cent, grouped by thousands: `$1,234.56`. Pure. */
export function usd(n: number): string {
  const [whole, cents] = (Number.isFinite(n) ? Math.max(0, n) : 0).toFixed(2).split('.')
  return `$${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`
}

const LIMIT_LABEL: Record<string, string> = { five_hour: '5-hour', seven_day: '7-day', spend_limit: 'spend limit' }

/** A window's color by how full it is: the error's from 90%, the warning's from 70%. */
const limitColor = (percent: number): string => (percent >= 90 ? STYLE.failed : percent >= 70 ? STYLE.warning : STYLE.label)

/** The session's figures in words. Pure. */
export function sessionStats(usage: SessionUsage | null, now: number): StatsBody['session'] {
  if (!usage) return { spend: null, context: null, limits: [] }
  const c = usage.context
  const context = c.tokens === undefined ? null : `${fmtTokens(c.tokens)} of ${fmtTokens(c.window)} tokens${c.percent === undefined ? '' : ` · ${c.percent}%`}`
  const limits: StatsLimit[] = usage.rateLimits.map(l => ({
    label: LIMIT_LABEL[l.kind] ?? oneLine(l.kind.replace(/_/g, ' '), 24),
    used: `${l.percentUsed}%`,
    resets: l.resetsAt === undefined ? null : whenOf(l.resetsAt, now),
    color: limitColor(l.percentUsed),
  }))
  return { spend: usage.cost === undefined ? null : usd(usage.cost.usd), context, limits }
}

/** One swarm owned here: its state, its spend, its tokens, and its table (the lead's row, then the tree's). */
export function swarmStats(s: LiveSwarm, listed: Map<string, ListedAgent>, now: number, othersLive: number): StatsSwarm {
  const all: StatsRow[] = liveRows(s.name, listed, new Set()).map(r => ({
    key: r.key,
    name: `${'  '.repeat(Math.max(0, r.depth - 1))}${r.name}`,
    color: r.color,
    mark: { glyph: r.statusGlyph || (r.running ? MARK.running.glyph : MARK.idle.glyph), color: r.statusColor },
    tokens: tokenWords(r.agentId === null ? leadTokens(s.name) : tokens(r.agentId)),
  }))
  const total = plus(leadTokens(s.name), tokens(s.name))
  const sp = spent(s.name)
  // A swarm launched before litter counted is counted from its first reading.
  const from = sp === null || sp.since - s.startedAt <= LAUNCH_SLACK_MS ? 'since launch' : `since ${whenOf(new Date(sp.since).toISOString(), now)}`
  const shared = othersLive === 0 ? '' : `; ${othersLive === 1 ? 'the other live swarm counts' : `the ${othersLive} other live swarms count`} it too`
  return {
    name: s.name,
    state:
      s.state === 'stopping'
        ? { text: `${MARK.warning.glyph} stopping ${span(now - s.startedAt)}`, color: COLOR.waiting }
        : { text: `${MARK.running.glyph} live ${span(now - s.startedAt)}`, color: COLOR.running },
    spend: sp === null ? null : `${usd(sp.usd)} ${from}`,
    spendNote: sp === null ? 'not read yet: it shows once the session reports its cost' : `the session's whole spend ${from}, the lead's and every agent's${shared}`,
    tokens: tokenWords(total),
    rows: all.slice(0, STATS_ROWS),
    hiddenRows: Math.max(0, all.length - STATS_ROWS),
  }
}

/** The body: the session's figures, then each swarm owned here (one another session owns is counted there). Pure but for the state it reads. */
export function statsBody(usage: SessionUsage | null, listed: readonly ListedAgent[], now: number, problems: readonly string[]): StatsBody {
  const mine = liveSwarms().filter(s => !s.readOnly && !s.lost)
  const byId = new Map(listed.map(a => [a.id, a]))
  return {
    session: sessionStats(usage, now),
    swarms: mine.map(s => swarmStats(s, byId, now, mine.length - 1)),
    problems: [...problems],
  }
}
