// Tier 2 (phase 5b, WP-DB): Home's words and its row budget
// (hooks/ui/homeview.ts), pure: what homeOf makes of the facts, the live
// line's needs-you words, where an [Open] goes, and homePlan at 100 and 60
// columns (and below 60, two lines a row): needs you and running kept whole,
// ended and the other sections folded into "N more" lines first.

import { describe, expect, test } from 'bun:test'
import type { HomeRow, HomeView } from '../../types/index'
import { runMark, type BandLine } from '../../hooks/band/view'
import { NARROW_COLUMNS, QUIET, flowRows, homeOf, homePlan, homeTarget, moreText, needsWords, primaryOpen, quietRows, type HomeFacts } from '../../hooks/ui/homeview'

/** A band line as band/view.ts builds one; an open execute run unless told otherwise. */
const line = (over: Partial<BandLine>): BandLine => ({
  key: 'run:20261006-exec:1:open',
  kind: 'run',
  name: '20261006-exec',
  mark: runMark('running'),
  noun: 'execute',
  detail: [{ text: 'gate 1/3' }],
  time: '14m',
  needsYou: false,
  ...over,
})
const swarm = (name: string, needsYou = false): BandLine =>
  line({ key: `swarm:${name}:1`, kind: 'swarm', name, mark: { glyph: '▸', word: 'live', color: 'background' }, noun: 'swarm', detail: [{ text: '3 running', color: 'background' }], time: '22m', needsYou })
const ended = (n: number, status = 'done'): BandLine =>
  line({ key: `run:20261006-e${n}:1:${status}`, kind: 'ended', name: `20261006-e${n}`, mark: runMark(status), detail: status === 'done' ? [{ text: '3/3 landed' }] : [], time: `${n}m`, needsYou: status === 'halted' || status === 'needs_user' })
const facts = (over: Partial<HomeFacts> = {}): HomeFacts => ({ lines: [], questions: [], proposals: [], rules: null, tasks: null, agents: null, endedMinutes: 10, ...over })
const said = (r: HomeRow): string => `${r.mark.glyph} ${r.mark.word} | ${r.spans.map(s => s.text).join('')}`

/** One needs you, two running, three ended, three other sections. */
const BUSY: HomeView = homeOf(
  facts({
    lines: [line({}), swarm('review'), ended(1), ended(2), ended(3)],
    questions: [{ swarm: 'review', node: 'reviewer', text: 'tabs?' }],
    tasks: { open: 3, list: "this session's list" },
    agents: 2,
  }),
)

describe('homeOf', () => {
  test('the groups, in order, each row with its mark, its words and an [Open] on its section and item', () => {
    expect(BUSY.needsYou.map(said)).toEqual(['⚑ needs you | reviewer asks: tabs?'])
    expect(BUSY.running.map(r => [r.open, said(r)])).toEqual([
      ['home:open:runs:20261006-exec', '▸ running | execute 20261006-exec · gate 1/3 · 14m'],
      ['home:open:swarms:review#2', '▸ live | swarm review · 3 running · 22m'],
    ])
    expect(BUSY.ended.map(r => r.open)).toEqual(['home:open:runs:20261006-e1', 'home:open:runs:20261006-e2', 'home:open:runs:20261006-e3'])
    expect(BUSY.others.map(o => `${o.label}: ${o.text}`)).toEqual(["Tasks: 3 open tasks in this session's list", 'Agents: 2 running in this session', "Doctor: what a swarm needs of this session's settings and limits"])
    // Each span in the style table's roles: the name, the time muted.
    expect(BUSY.running[0]!.spans).toEqual([{ text: 'execute ' }, { text: '20261006-exec', color: 'cyan_FOR_SUBAGENTS_ONLY' }, { text: ' · ' }, { text: 'gate 1/3' }, { text: ' · ' }, { text: '14m', color: 'inactive' }])
    expect(BUSY.needsYou[0]!.mark).toEqual({ glyph: '⚑', word: 'needs you', color: 'permission' })
  })

  test('what needs you, each thing that waits on its own row: each proposal by its number, the rules, a run halted or back for you, by its status word', () => {
    const home = homeOf(
      facts({
        proposals: [
          { swarm: 'alpha', n: 6 },
          { swarm: 'beta', n: 2 },
          { swarm: 'beta', n: 3 },
          { swarm: 'gamma', n: 0 },
        ],
        rules: { proposed: 1, inForce: 0 },
        lines: [ended(1, 'halted'), line({ ...ended(2, 'needs_user'), noun: 'design', detail: [{ text: 'v3 HOLDING' }] })],
      }),
    )
    // The proposal view's own words (swarm/panes.ts's describeNav), and a key that carries the number.
    expect(home.needsYou.map(r => [r.open, said(r)])).toEqual([
      ['home:open:swarms:alpha/6', "⚑ needs you | the lead's proposal 6 for alpha"],
      ['home:open:swarms:beta/2', "⚑ needs you | the lead's proposal 2 for beta"],
      ['home:open:swarms:beta/3', "⚑ needs you | the lead's proposal 3 for beta"],
      ['home:open:rules', '⚑ needs you | 1 rule proposed or unverified, for you to accept or dismiss'],
      ['home:open:runs:20261006-e1', '⚑ needs you | execute 20261006-e1 · halted · 1m'],
      ['home:open:runs:20261006-e2', '⚑ needs you | design 20261006-e2 · v3 HOLDING · 2m'],
    ])
    expect(home.needsYou[0]!.spans).toEqual([{ text: "the lead's proposal 6 for " }, { text: 'alpha', color: 'cyan_FOR_SUBAGENTS_ONLY' }])
    // A run that wants you is under needs you only, not also under ended.
    expect(home.ended).toEqual([])
    // The status word in its own color (board/view.ts's: halted is a warning).
    expect(home.needsYou[4]!.spans.find(s => s.text === 'halted')).toEqual({ text: 'halted', color: 'warning' })
  })

  test('two rows that open the same place get their own keys; a question is its first line, cut', () => {
    const home = homeOf(
      facts({
        questions: [
          { swarm: 'a', node: 'n1', text: '\nfirst line\nsecond line' },
          { swarm: 'a', node: 'n2', text: 'x'.repeat(300) },
        ],
      }),
    )
    expect(home.needsYou.map(r => r.open)).toEqual(['home:open:swarms:a', 'home:open:swarms:a#2'])
    expect(said(home.needsYou[0]!)).toBe('⚑ needs you | n1 asks: first line')
    expect(home.needsYou[0]!.spans[0]).toEqual({ text: 'n1', color: 'cyan_FOR_SUBAGENTS_ONLY' })
    const long = home.needsYou[1]!.spans.at(-1)!.text
    expect(long.endsWith('…')).toBe(true)
    expect(long.length).toBeLessThanOrEqual(' asks: '.length + 200)
  })

  test('a question names its swarm only when more than one swarm has something waiting', () => {
    const home = homeOf(
      facts({
        questions: [{ swarm: 'a', node: 'port', text: 'which port?' }],
        proposals: [{ swarm: 'b', n: 1 }],
      }),
    )
    expect(home.needsYou.map(said)).toEqual(['⚑ needs you | port in a asks: which port?', "⚑ needs you | the lead's proposal 1 for b"])
    expect(homeOf(facts({ questions: [{ swarm: 'a', node: 'port', text: 'which port?' }], proposals: [{ swarm: 'a', n: 1 }] })).needsYou.map(said)).toEqual([
      '⚑ needs you | port asks: which port?',
      "⚑ needs you | the lead's proposal 1 for a",
    ])
  })

  test("quiet: nothing needs you and nothing runs, so Swarms' line is there; a section with nothing to say is left out, not 0", () => {
    const home = homeOf(facts({ tasks: { open: 0, list: 'x' }, agents: 0, lines: [ended(1)] }))
    expect([home.needsYou, home.running]).toEqual([[], []])
    expect(home.ended).toHaveLength(1)
    expect(home.others.map(o => o.label)).toEqual(['Swarms', 'Doctor'])
    expect(home.others[0]).toEqual({ open: 'home:open:swarms', label: 'Swarms', text: 'none live: build one from a template, or ask the lead' })
    // Something runs: no Swarms line (the swarm's own row is there).
    expect(homeOf(facts({ lines: [swarm('alpha')] })).others.map(o => o.label)).toEqual(['Doctor'])
  })

  test("needsWords: the live line's words for what needs you, by what it is", () => {
    expect(needsWords(facts())).toEqual([])
    expect(
      needsWords(
        facts({
          questions: [{ swarm: 'a', node: 'n', text: 'q' }],
          proposals: [
            { swarm: 'a', n: 4 },
            { swarm: 'b', n: 1 },
            { swarm: 'b', n: 2 },
          ],
          rules: { proposed: 1, inForce: 3 },
          lines: [ended(1, 'halted'), ended(2, 'needs_user'), ended(3)],
        }),
      ),
    ).toEqual(['1 question', '3 proposals', '1 rule', '2 runs'])
  })
})

describe("[Open]'s key", () => {
  test('homeTarget: the section, and the item for Runs and Swarms (a proposal by its number), checked; anything else is no [Open]', () => {
    expect(homeTarget('home:open:runs')).toEqual({ section: 'runs' })
    expect(homeTarget('home:open:runs:20261006-exec')).toEqual({ section: 'runs', arg: '20261006-exec' })
    expect(homeTarget('home:open:swarms:review#2')).toEqual({ section: 'swarms', arg: 'review' })
    expect(homeTarget('home:open:swarms:review/6')).toEqual({ section: 'swarms', arg: 'review', proposal: 6 })
    expect(homeTarget('home:open:swarms:review/12#3')).toEqual({ section: 'swarms', arg: 'review', proposal: 12 })
    expect(homeTarget('home:open:tasks#3')).toEqual({ section: 'tasks' })
    expect(homeTarget('home:open:doctor')).toEqual({ section: 'doctor' })
    for (const k of [
      'home:open:home',
      'home:open:nowhere',
      'home:open:runs:bad',
      'home:open:runs:../x',
      'home:open:swarms:Bad',
      'home:open:rules:U-1',
      'home:open:',
      'board:select:G1',
      'home:open:runs:20261006-exec:more',
      'home:open:runs:20261006-exec/2',
      'home:open:swarms:review/0',
      'home:open:swarms:review/-1',
      'home:open:swarms:review/x',
      'home:open:swarms:review/',
      'home:open:swarms:review/2/3',
      'home:open:swarms:review/99999999999999999',
    ]) {
      expect(homeTarget(k)).toBeNull()
    }
  })
})

describe('the row budget (fits)', () => {
  const shown = (needsYou: number, running: number, endedN: number, others: number) => ({ needsYou, running, ended: endedN, others })

  test('at 100 columns: whole while it fits; then the others fold, then the ended runs; then the headings go', () => {
    expect(homePlan(BUSY, 100, Number.POSITIVE_INFINITY)).toEqual({ narrow: false, headings: true, quiet: false, shown: shown(1, 2, 3, 3), height: 13 })
    expect(homePlan(BUSY, 100, 13)).toEqual({ narrow: false, headings: true, quiet: false, shown: shown(1, 2, 3, 3), height: 13 })
    expect(homePlan(BUSY, 100, 10)).toEqual({ narrow: false, headings: true, quiet: false, shown: shown(1, 2, 3, 0), height: 10 })
    expect(homePlan(BUSY, 100, 8)).toEqual({ narrow: false, headings: true, quiet: false, shown: shown(1, 2, 0, 0), height: 7 })
    expect(homePlan(BUSY, 100, 6)).toEqual({ narrow: false, headings: false, quiet: false, shown: shown(1, 2, 1, 0), height: 6 })
  })

  test('then the others and ended lines go, so needs you and running stay whole; only then does running fold, and last what needs you', () => {
    expect(homePlan(BUSY, 100, 4)).toEqual({ narrow: false, headings: false, quiet: false, shown: shown(1, 2, 0, -1), height: 4 })
    expect(homePlan(BUSY, 100, 3)).toEqual({ narrow: false, headings: false, quiet: false, shown: shown(1, 2, -1, -1), height: 3 })
    expect(homePlan(BUSY, 100, 2)).toEqual({ narrow: false, headings: false, quiet: false, shown: shown(1, 0, -1, -1), height: 2 })
    // Too short for anything: the fewest rows there are (the hub clips the body).
    expect(homePlan(BUSY, 100, 1)).toEqual({ narrow: false, headings: false, quiet: false, shown: shown(0, 0, -1, -1), height: 2 })
  })

  test('below 60 columns each row is two lines, so the folds come sooner', () => {
    expect(NARROW_COLUMNS).toBe(60)
    expect(homePlan(BUSY, 60, 13).narrow).toBe(false)
    expect(homePlan(BUSY, 59, Number.POSITIVE_INFINITY)).toEqual({ narrow: true, headings: true, quiet: false, shown: shown(1, 2, 3, 3), height: 22 })
    expect(homePlan(BUSY, 59, 14)).toEqual({ narrow: true, headings: true, quiet: false, shown: shown(1, 2, 1, 0), height: 13 })
  })

  test('quiet: the line that says so and the next step come first, at their wrapped height', () => {
    expect(QUIET.next.command).toBe('/litter:execute <plan.md | goal>')
    expect([quietRows(100), quietRows(60), quietRows(40)]).toEqual([2, 2, 3])
    const quiet = homeOf(facts({ lines: [ended(1)], tasks: { open: 2, list: 'team-a' } }))
    expect(homePlan(quiet, 100, Number.POSITIVE_INFINITY)).toEqual({ narrow: false, headings: true, quiet: true, shown: shown(0, 0, 1, 3), height: 8 })
    expect(homePlan(quiet, 100, 5)).toEqual({ narrow: false, headings: true, quiet: true, shown: shown(0, 0, 1, 0), height: 5 })
  })

  test('flowRows: Texts in a row, each whole on a row while it fits', () => {
    expect(flowRows(['ab', 'cd'], 4)).toBe(1)
    expect(flowRows(['ab', 'cde'], 4)).toBe(2)
    expect(flowRows(['ab', 'cd'], Number.POSITIVE_INFINITY)).toBe(1)
  })

  test("the folded groups' lines: `+N more` after rows drawn, the count and what it is with none", () => {
    expect(moreText(BUSY, 'ended', 1)).toBe('+2 more ended')
    expect(moreText(BUSY, 'ended', 0)).toBe('3 ended in the last 10 minutes')
    expect(moreText({ ...BUSY, endedMinutes: 1 }, 'ended', 0)).toBe('3 ended in the last minute')
    expect(moreText(BUSY, 'running', 1)).toBe('+1 more running')
    expect(moreText(BUSY, 'running', 0)).toBe('2 running')
    expect(moreText(BUSY, 'needsYou', 0)).toBe('1 needs you')
    expect(moreText({ ...BUSY, needsYou: [...BUSY.needsYou, ...BUSY.needsYou, ...BUSY.needsYou] }, 'needsYou', 1)).toBe('+2 more need you')
    expect(moreText(BUSY, 'others', 1)).toBe('+2 more: Agents, Doctor')
    expect(moreText(BUSY, 'others', 0)).toBe('Tasks, Agents, Doctor')
  })

  test("the one primary: the first needs-you row's [Open], else the first running row's, and none when it isn't drawn", () => {
    expect(primaryOpen(BUSY, homePlan(BUSY, 100, 40))).toBe('home:open:swarms:review')
    expect(primaryOpen(BUSY, homePlan(BUSY, 100, 1))).toBeNull()
    const running = homeOf(facts({ lines: [line({})] }))
    expect(primaryOpen(running, homePlan(running, 100, 40))).toBe('home:open:runs:20261006-exec')
    const quiet = homeOf(facts())
    expect(primaryOpen(quiet, homePlan(quiet, 100, 40))).toBeNull()
  })
})
