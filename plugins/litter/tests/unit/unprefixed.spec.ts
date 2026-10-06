// Tier 2 (WP-CI): no line only the person reads starts with `litter: `. In
// 2.1.290 the engine puts the plugin's name before a toast, a command's reply,
// a $.ui.log line (`[litter] $.ui.log (to debug): …` for the debug log), a
// $.ui.status and a $.ui.notice (JXe), so a prefix of litter's own would show
// twice. What the model reads (a deny, a reason, a tool's error, a thrown
// Error) keeps its prefix, which says which plugin refused, and isn't checked.
//
// Three checks: `unprefixed`, the helper for a line the model reads too; a
// scan of hooks/**/*.ts{,x} through the TypeScript parser, for a string
// starting `litter: ` anywhere in the arguments of a toast, log, logOnce,
// status, notice or note call (p.note, the ask line's transcript row, WP-CK)
// or in a `text:` value (a ternary's branches and a call written over
// several lines included); and `/litter`'s replies, one per section and the
// usage line, and /clear's hold, which helpers and constants build where the
// scan can't follow them.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'
import { updateSession } from '../../hooks/session'
import { unprefixed } from '../../hooks/swarm/view'
import { CLEAR_HELD } from '../../hooks/clear'
import { doctorCommand, resetPanesForTests, swarmCommand } from '../../hooks/swarm/panes'
import { boardCommand, resetBoardPaneForTests } from '../../hooks/board/pane'
import { resetBoardForTests } from '../../hooks/board/view'
import { resetRulesPaneForTests, rulesCommand } from '../../hooks/rules/pane'
import { resetRulesViewForTests } from '../../hooks/rules/paneview'
import { resetTasksPaneForTests, tasksCommand } from '../../hooks/tasks/pane'
import { resetTasksViewForTests } from '../../hooks/tasks/view'
import { agentsCommand, resetAgentsPaneForTests } from '../../hooks/agents/pane'
import { resetAgentsNavForTests } from '../../hooks/agents/view'
import { litterCommand, resetHubForTests } from '../../hooks/ui/hub'
import { nodePorts, scratch } from './support/node-ports'

setDefaultTimeout(120_000)

const HOOKS = join(import.meta.dir, '..', '..', 'hooks')
const PREFIX = 'litter: '

// ---------------------------------------------------------------------------
// The scan

/** Calls whose arguments the person reads, under any receiver: `p.toast`, `p.log`, `$.ui.log`, the band's `logOnce`. */
const ANY_CALLEE = new Set(['toast', 'log', 'logOnce'])
/**
 * As a method only (`$.ui.status`, `$.ui.notice`, `p.notice`, and `p.note`, the
 * ask line's transcript row, WP-CK): the panes' own `notice(…)` is drawn in
 * the pane, which the engine doesn't label.
 */
const METHOD_CALLEE = new Set(['status', 'notice', 'note'])

type Hit = { line: number; text: string }

function shownCall(e: ts.CallExpression): boolean {
  const c = e.expression
  if (ts.isIdentifier(c)) return ANY_CALLEE.has(c.text)
  if (ts.isPropertyAccessExpression(c)) return ANY_CALLEE.has(c.name.text) || METHOD_CALLEE.has(c.name.text)
  return false
}

/** Every string under `node` that starts with the prefix: a quoted string, or a template literal's first part. */
function prefixed(node: ts.Node, sf: ts.SourceFile, out: Hit[]): void {
  const head = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : ts.isTemplateExpression(node) ? node.head.text : null
  if (head !== null && head.startsWith(PREFIX)) {
    out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: node.getText(sf).slice(0, 90) })
  }
  ts.forEachChild(node, c => prefixed(c, sf, out))
}

/** One file: how many calls and `text:` values it holds that the person reads, and each prefixed string in them. */
function scan(fileName: string, source: string): { calls: number; texts: number; hits: Hit[] } {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
  const hits: Hit[] = []
  let calls = 0
  let texts = 0
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && shownCall(n)) {
      calls++
      for (const a of n.arguments) prefixed(a, sf, hits)
    } else if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'text') {
      texts++
      prefixed(n.initializer, sf, hits)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return { calls, texts, hits }
}

const hookFiles = (): string[] =>
  (readdirSync(HOOKS, { recursive: true }) as string[]).filter(f => /\.tsx?$/.test(f) && !f.endsWith('.d.ts')).sort()

describe('unprefixed', () => {
  test('drops one leading `litter: ` and leaves every other line as it is', () => {
    expect(unprefixed("litter: there's no live swarm named alpha")).toBe("there's no live swarm named alpha")
    expect(unprefixed('litter: litter: twice')).toBe('litter: twice')
    expect(unprefixed('the board shows run x')).toBe('the board shows run x')
    expect(unprefixed('swarm alpha: litter: in the middle')).toBe('swarm alpha: litter: in the middle')
    expect(unprefixed('litter:no space')).toBe('litter:no space')
    expect(unprefixed('')).toBe('')
  })
})

describe('the scan of hooks/', () => {
  test('finds a prefixed string in every form a shown line takes, and none in what the model reads', () => {
    const sample = [
      "p.toast('litter: one')",
      'p.toast(',
      '  `litter: two ${x}`,',
      ')',
      "p.toast(ok ? 'fine' : `litter: three`)",
      "$.ui.log(`litter: four`, { to: 'debug' })",
      '$.ui.status(`litter: five`)',
      "p.notice(id, 'litter: six')",
      "const r = { text: 'litter: seven' }",
      'logOnce(p, key, `litter: eight ${y}`)',
      "notice('error', 'litter: a pane notice')",
      "return { deny: 'litter: the model reads this' }",
      "throw new Error('litter: and this')",
      "p.toast(`swarm alpha: litter: in the middle`)",
      "p.note(`litter: nine ${z}`)",
    ].join('\n')
    expect(scan('sample.ts', sample).hits.map(h => h.line)).toEqual([1, 3, 5, 6, 7, 8, 9, 10, 15])
  })

  test('no toast, log line, status, notice or `text:` in hooks/ starts with `litter: `', () => {
    let calls = 0
    let texts = 0
    const found: string[] = []
    for (const f of hookFiles()) {
      const r = scan(f, readFileSync(join(HOOKS, f), 'utf8'))
      calls += r.calls
      texts += r.texts
      for (const h of r.hits) found.push(`hooks/${f}:${h.line} ${h.text}`)
    }
    expect(found).toEqual([])
    // A parser that saw nothing would pass: the hooks hold hundreds of each.
    expect(calls).toBeGreaterThan(300)
    expect(texts).toBeGreaterThan(100)
  })
})

// ---------------------------------------------------------------------------
// What helpers and constants build

const resets = (): void => {
  resetPanesForTests()
  resetBoardPaneForTests()
  resetBoardForTests()
  resetRulesPaneForTests()
  resetRulesViewForTests()
  resetTasksPaneForTests()
  resetTasksViewForTests()
  resetAgentsPaneForTests()
  resetAgentsNavForTests()
  resetHubForTests()
}

describe("the pane commands' replies and /clear's hold", () => {
  let cleanup: () => void = () => undefined

  beforeEach(() => {
    resets()
    updateSession({ litterDir: null, litterDirError: 'not a git checkout' })
  })
  afterEach(() => {
    resets()
    updateSession({ litterDir: null, litterDirError: null })
    cleanup()
  })

  test('each reply says what its pane shows, with no `litter: ` before it', async () => {
    const s = scratch()
    cleanup = s.cleanup
    const p = nodePorts({ sessionId: 's1', cwd: s.dir })
    p.configDirValue = s.dir
    const command = (args = '') => ({ command: 'litter', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }) as never
    const next = (async () => ({ text: 'passed on' })) as never
    const replies: unknown[] = []
    // `/litter`, through litterCommand, and each section's command as it hands them on.
    for (const r of [
      () => litterCommand(p, command(''), next),
      () => litterCommand(p, command('swarms'), next),
      () => swarmCommand(p, command('Not-A-Name'), next),
      () => doctorCommand(p, command(''), next),
      () => boardCommand(p, command(''), next),
      () => rulesCommand(p, command(''), next),
      () => tasksCommand(p, command(''), next),
      () => agentsCommand(p, command(''), next),
      () => litterCommand(p, command('nonsense'), next),
    ]) {
      replies.push(((await r()) as { text?: unknown }).text)
    }
    const lines = replies.map(t => (typeof t === 'string' ? t : `not a line: ${String(t)}`))
    expect(lines.filter(l => l.startsWith(PREFIX))).toEqual([])
    expect(lines.map(l => l.split(' ').slice(0, 2).join(' '))).toEqual([
      'Home shows',
      'Swarms shows',
      `"Not-A-Name" isn't`,
      'Doctor checks',
      'Runs has',
      'Rules has',
      'Tasks shows',
      'Agents shows',
      'usage: /litter',
    ])
  })

  test("/clear's hold is answered as the person reads it", () => {
    expect(CLEAR_HELD).toBe("/clear held; the swarm browser shows when they're idle")
  })
})
