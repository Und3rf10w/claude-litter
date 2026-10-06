// Tier 2 (phase 5b, WP-DA): every color litter paints is a theme key from
// hooks/ui/style.ts, so it follows the person's /theme, and nothing paints a
// background but a selected row's `selectionBg`.
//
// A scan of hooks/**/*.ts{,x} through the TypeScript parser. A color site is
// a JSX attribute or an object property named `color` or `…Color` (not
// `dimColor` or `borderDimColor`, which are booleans). Its value is followed
// to the strings it can be: a literal; a ternary's or a `??`/`||`'s branches;
// a const, in the file or through an import; a property of a const object
// (`STYLE.sha`, `MARK.running.color`), and an element of one (`TABLE[k]`,
// every entry when the key isn't a literal). A value read from data (a
// view's span, a function's parameter) isn't followed: its colors were
// written, and checked, where the data was built.
//
// Each string it reaches must be a theme key the engine's themes hold, never
// a raw color (`#…`, `rgb(…)`, `ansi256(…)`, `ansi:…`) or a bare ANSI name;
// it must be written in style.ts (a Client module, which imports types only,
// writes style.ts's values out, and only those); and a `backgroundColor` must be
// SELECTED_BG. A sample project proves each form is found.

import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import * as ts from 'typescript'
import { IDENTITY, MARK, NOTICE_STYLE, SELECTED_BG, STYLE } from '../../hooks/ui/style'

const HOOKS = join(import.meta.dir, '..', '..', 'hooks')
const STYLE_FILE = join(HOOKS, 'ui', 'style.ts')

/**
 * The keys Claude Code 2.1.291's themes hold (the dark theme's object,
 * cli_formatted_2.1.291.js:298990-299064; every built-in theme has the same
 * keys). A key outside this list draws as no color.
 */
const THEME_KEYS = new Set(
  (
    'autoAccept autoAcceptShimmer background bashBorder bashMessageBackgroundColor briefLabelClaude briefLabelYou chromeYellow claude ' +
    'claudeBlueShimmer_FOR_SYSTEM_SPINNER claudeBlue_FOR_SYSTEM_SPINNER claudeShimmer clawd_background clawd_body composerSidebarBackground ' +
    'diffAdded diffAddedDimmed diffAddedWord diffRemoved diffRemovedDimmed diffRemovedWord effortUltra error fastMode fastModeShimmer ide ' +
    'inactive inactiveShimmer inverseText memoryBackgroundColor merged permission permissionShimmer planMode professionalBlue promptBorder ' +
    'promptBorderShimmer rate_limit_empty rate_limit_fill remember selectionBg skill subtle success suggestion text userMessageBackground ' +
    'userMessageBackgroundHover warning warningShimmer ' +
    'blue_FOR_SUBAGENTS_ONLY cyan_FOR_SUBAGENTS_ONLY green_FOR_SUBAGENTS_ONLY orange_FOR_SUBAGENTS_ONLY pink_FOR_SUBAGENTS_ONLY ' +
    'purple_FOR_SUBAGENTS_ONLY red_FOR_SUBAGENTS_ONLY yellow_FOR_SUBAGENTS_ONLY'
  ).split(' '),
)

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray', 'grey']
const ANSI_NAMES = new Set([...ANSI, ...ANSI.map(n => `${n}Bright`)])

/** Why a color string is refused, or null. */
export function refusal(value: string): string | null {
  if (value.startsWith('#') || /^rgb\s*\(/i.test(value) || /^ansi256\s*\(/i.test(value) || value.startsWith('ansi:')) return 'a raw color'
  if (ANSI_NAMES.has(value)) return 'a bare ANSI name'
  if (!THEME_KEYS.has(value)) return 'not a theme key'
  return null
}

// ---------------------------------------------------------------------------
// The scan

type Reached = { value: string; file: string; line: number }
type Site = { file: string; line: number; prop: string; values: Reached[]; followed: boolean }
type Hit = { file: string; line: number; prop: string; value: string; why: string }

const isColorProp = (name: string): boolean => name === 'color' || (name.endsWith('Color') && name !== 'dimColor' && name !== 'borderDimColor')

/** The files of a project, parsed once each, through `read` (the disk, or a sample's map). */
class Project {
  private parsed = new Map<string, ts.SourceFile | null>()
  constructor(private read: (path: string) => string | null) {}

  file(path: string): ts.SourceFile | null {
    if (!this.parsed.has(path)) {
      const text = this.read(path)
      this.parsed.set(path, text === null ? null : ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS))
    }
    return this.parsed.get(path) ?? null
  }

  /** A relative import's file: `<spec>.ts`, `.tsx`, or `/index.ts`. */
  resolve(from: string, spec: string): string | null {
    if (!spec.startsWith('.')) return null
    const base = join(dirname(from), spec)
    for (const c of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) if (this.read(c) !== null) return c
    return null
  }
}

const unwrap = (e: ts.Expression): ts.Expression => {
  let x = e
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x) || ts.isNonNullExpression(x) || ts.isTypeAssertionExpression(x)) x = x.expression
  return x
}

type At = { node: ts.Expression; sf: ts.SourceFile }

/** A name's const initializer: one declared in the file, else the import's export it names. */
function declared(project: Project, sf: ts.SourceFile, name: string, depth: number): At | null {
  if (depth > 12) return null
  let found: At | null = null
  const visit = (n: ts.Node): void => {
    if (found) return
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer && ts.getCombinedNodeFlags(n) & ts.NodeFlags.Const) {
      found = { node: n.initializer, sf }
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  if (found) return found
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue
    const named = st.importClause?.namedBindings
    if (!named || !ts.isNamedImports(named)) continue
    const el = named.elements.find(x => x.name.text === name)
    if (!el) continue
    const target = project.resolve(sf.fileName, st.moduleSpecifier.text)
    const tsf = target ? project.file(target) : null
    return tsf ? declared(project, tsf, (el.propertyName ?? el.name).text, depth + 1) : null
  }
  return null
}

/** The object or array literals an expression can be (a const, a property of one, an entry of one). */
function literals(project: Project, at: At, depth: number): At[] | null {
  if (depth > 12) return null
  const e = unwrap(at.node)
  if (ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e)) return [{ node: e, sf: at.sf }]
  if (ts.isIdentifier(e)) {
    const d = declared(project, at.sf, e.text, depth + 1)
    return d ? literals(project, d, depth + 1) : null
  }
  const members = memberValues(project, e, at.sf, depth + 1)
  if (members === null) return null
  const out: At[] = []
  for (const m of members) {
    const l = literals(project, m, depth + 1)
    if (l === null) return null
    out.push(...l)
  }
  return out
}

/** What `obj.name`, `obj['name']` or `obj[k]` can be: the property's initializer, or every entry's. */
function memberValues(project: Project, e: ts.Expression, sf: ts.SourceFile, depth: number): At[] | null {
  let objExpr: ts.Expression
  let key: string | null
  if (ts.isPropertyAccessExpression(e)) {
    objExpr = e.expression
    key = e.name.text
  } else if (ts.isElementAccessExpression(e)) {
    objExpr = e.expression
    const arg = unwrap(e.argumentExpression)
    key = ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) ? arg.text : ts.isNumericLiteral(arg) ? arg.text : null
  } else return null
  const objs = literals(project, { node: objExpr, sf }, depth + 1)
  if (objs === null) return null
  const out: At[] = []
  for (const o of objs) {
    if (ts.isArrayLiteralExpression(o.node)) {
      const els = o.node.elements.filter((x): x is ts.Expression => !ts.isSpreadElement(x) && !ts.isOmittedExpression(x))
      const picked = key !== null && /^\d+$/.test(key) ? els.slice(Number(key), Number(key) + 1) : els
      out.push(...picked.map(node => ({ node, sf: o.sf })))
      continue
    }
    if (!ts.isObjectLiteralExpression(o.node)) continue
    for (const prop of o.node.properties) {
      if (!ts.isPropertyAssignment(prop)) continue
      const name = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) || ts.isNumericLiteral(prop.name) ? prop.name.text : null
      if (key === null || name === key) out.push({ node: prop.initializer, sf: o.sf })
    }
  }
  return out
}

/** The strings a color value can be; null when it reads data the scan can't follow. */
function strings(project: Project, at: At, depth = 0): Reached[] | null {
  if (depth > 16) return null
  const e = unwrap(at.node)
  const here = (value: string): Reached => ({ value, file: at.sf.fileName, line: at.sf.getLineAndCharacterOfPosition(e.getStart(at.sf)).line + 1 })
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [here(e.text)]
  if (ts.isTemplateExpression(e)) return [here(e.head.text + '${…}')]
  if (e.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isIdentifier(e) && e.text === 'undefined')) return []
  if (e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return []
  if (ts.isConditionalExpression(e)) return both(strings(project, { node: e.whenTrue, sf: at.sf }, depth + 1), strings(project, { node: e.whenFalse, sf: at.sf }, depth + 1))
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) return both(strings(project, { node: e.left, sf: at.sf }, depth + 1), strings(project, { node: e.right, sf: at.sf }, depth + 1))
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return strings(project, { node: e.right, sf: at.sf }, depth + 1)
    return null
  }
  if (ts.isIdentifier(e)) {
    const d = declared(project, at.sf, e.text, depth + 1)
    return d ? strings(project, d, depth + 1) : null
  }
  const members = memberValues(project, e, at.sf, depth + 1)
  if (members === null) return null
  let out: Reached[] | null = []
  for (const m of members) out = both(out, strings(project, m, depth + 1))
  return out
}

/** Two branches' strings; a branch that reads data adds none (its data was checked where it was built). */
const both = (a: Reached[] | null, b: Reached[] | null): Reached[] | null => (a === null && b === null ? null : [...(a ?? []), ...(b ?? [])])

/** Every color site in a file, with the strings each can be. */
function sitesOf(project: Project, path: string): Site[] {
  const sf = project.file(path)
  if (!sf) return []
  const out: Site[] = []
  const add = (prop: string, node: ts.Node, value: ts.Expression) => {
    const values = strings(project, { node: value, sf })
    out.push({ file: path, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, prop, values: values ?? [], followed: values !== null })
  }
  const visit = (n: ts.Node): void => {
    if (ts.isJsxAttribute(n) && ts.isIdentifier(n.name) && isColorProp(n.name.text) && n.initializer) {
      if (ts.isStringLiteral(n.initializer)) add(n.name.text, n, n.initializer)
      else if (ts.isJsxExpression(n.initializer) && n.initializer.expression) add(n.name.text, n, n.initializer.expression)
    } else if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && isColorProp(n.name.text)) {
      add(n.name.text, n, n.initializer)
    } else if (ts.isShorthandPropertyAssignment(n) && isColorProp(n.name.text)) {
      add(n.name.text, n, n.name)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** Whether a file is a Client module: it runs on the drawing thread, so it imports types only, ClientModule among them. */
function clientModule(sf: ts.SourceFile): boolean {
  const imports = sf.statements.filter(ts.isImportDeclaration)
  const names = imports.flatMap(st => {
    const b = st.importClause?.namedBindings
    return b && ts.isNamedImports(b) ? b.elements.map(x => x.name.text) : []
  })
  return imports.every(st => st.importClause?.isTypeOnly === true) && names.includes('ClientModule')
}

/** The color sites of every file, and what's wrong with each string they reach. */
export function scanProject(read: (path: string) => string | null, files: readonly string[], styleFile: string, styleValues: ReadonlySet<string>): { sites: Site[]; hits: Hit[] } {
  const project = new Project(read)
  const sites: Site[] = []
  const hits: Hit[] = []
  for (const f of files) {
    const fileSites = sitesOf(project, f)
    sites.push(...fileSites)
    const sf = project.file(f)
    const client = sf !== null && clientModule(sf)
    for (const s of fileSites) {
      for (const v of s.values) {
        const at = { file: f, line: s.line, prop: s.prop, value: v.value }
        const bad = refusal(v.value)
        if (bad) hits.push({ ...at, why: bad })
        else if (v.file !== styleFile && !(client && v.file === f && styleValues.has(v.value))) hits.push({ ...at, why: `written in ${relative(dirname(styleFile), v.file)}:${v.line}, not taken from style.ts` })
        if (s.prop === 'backgroundColor' && v.value !== SELECTED_BG) hits.push({ ...at, why: `a background other than ${SELECTED_BG}` })
      }
    }
  }
  return { sites, hits }
}

function hookFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...hookFiles(p))
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out.sort()
}

const readDisk = (path: string): string | null => (existsSync(path) ? readFileSync(path, 'utf8') : null)
const STYLE_VALUES = new Set<string>([...Object.values(STYLE), SELECTED_BG, ...IDENTITY])

// ---------------------------------------------------------------------------

describe('the color guard', () => {
  test('a sample project: each form of a raw, ANSI or unshared color is found, and style.ts keys pass', () => {
    const files: Record<string, string> = {
      '/v/hooks/ui/style.ts': "export const STYLE = { ok: 'success', sel: 'selectionBg', odd: 'yellow' } as const\nexport const TABLE = { a: STYLE.ok }\n",
      '/v/hooks/a.tsx': [
        "import { STYLE, TABLE } from './ui/style'",
        "const LOCAL = { x: 'blue', y: STYLE.ok }",
        "const K = 'cyan'",
        "const NESTED: Record<string, { color: string }> = { one: { color: STYLE.ok } }",
        'export const f = (c: boolean, k: string, span: { color?: string }) => [',
        '  <Text color="red" />,',
        "  <Text color={c ? STYLE.ok : '#fff'} />,",
        '  { color: LOCAL.x },',
        '  { color: LOCAL[k] },',
        '  { color: K },',
        '  <Box backgroundColor={STYLE.ok} />,',
        '  <Box backgroundColor={STYLE.sel} />,',
        '  { color: STYLE.ok, borderColor: TABLE.a },',
        "  { borderColor: 'rgb(1,2,3)' },",
        "  { markColor: span.color ?? 'ansi:red' },",
        '  { color: NESTED[k].color },',
        '  <Text color={STYLE.odd} dimColor />,',
        '  <Text color={span.color} />,',
        ']',
      ].join('\n'),
      '/v/hooks/client.tsx': "import type { ClientModule } from 'claude-code'\nconst COLORS = { accent: 'success', bad: 'claude' } as const\nexport const g = () => [<Text color={COLORS.accent} />, <Text color={COLORS.bad} />]\n",
    }
    const read = (p: string) => files[p] ?? null
    const { sites, hits } = scanProject(read, ['/v/hooks/a.tsx', '/v/hooks/client.tsx'], '/v/hooks/ui/style.ts', new Set(['success', 'selectionBg', 'yellow']))
    const at = (line: number) => hits.filter(h => h.file === '/v/hooks/a.tsx' && h.line === line).map(h => `${h.value}: ${h.why}`)
    // Line numbers are the sample's, 1-based.
    expect(at(6)).toEqual(['red: a bare ANSI name'])
    expect(at(7)).toEqual(['#fff: a raw color'])
    expect(at(8)).toEqual(['blue: a bare ANSI name'])
    // LOCAL[k]: every entry, the shared one passing.
    expect(at(9)).toEqual(['blue: a bare ANSI name'])
    expect(at(10)).toEqual(['cyan: a bare ANSI name'])
    expect(at(11)).toEqual(['success: a background other than selectionBg'])
    expect(at(12)).toEqual([])
    expect(at(13)).toEqual([])
    expect(at(14)).toEqual(['rgb(1,2,3): a raw color'])
    expect(at(15)).toEqual(['ansi:red: a raw color'])
    expect(at(16)).toEqual([])
    expect(at(17)).toEqual(['yellow: a bare ANSI name'])
    expect(at(18)).toEqual([])
    // A key written in a file of its own, not taken from style.ts.
    const unshared = files['/v/hooks/a.tsx']!.replace("const K = 'cyan'", "const K = 'warning'")
    const again = scanProject(p => (p === '/v/hooks/a.tsx' ? unshared : read(p)), ['/v/hooks/a.tsx'], '/v/hooks/ui/style.ts', new Set(['success']))
    expect(again.hits.filter(h => h.line === 10).map(h => h.why)).toEqual(['written in ../a.tsx:3, not taken from style.ts'])
    // A Client module writes style.ts's values out; one that isn't style.ts's is refused.
    expect(hits.filter(h => h.file === '/v/hooks/client.tsx').map(h => h.value)).toEqual(['claude'])
    // span.color reads data: a site, not followed.
    expect(sites.filter(s => s.file === '/v/hooks/a.tsx' && !s.followed).map(s => s.line)).toEqual([18])
  })

  test('hooks/ paints theme keys from style.ts only, and no background but a selected row', () => {
    const files = hookFiles(HOOKS)
    const { sites, hits } = scanProject(readDisk, files, STYLE_FILE, STYLE_VALUES)
    expect(hits.map(h => `${relative(HOOKS, h.file)}:${h.line} ${h.prop}=${h.value}: ${h.why}`)).toEqual([])
    // Floors, so a scan that silently finds nothing fails: the renderers and the view builders.
    expect(files.length).toBeGreaterThan(100)
    expect(sites.length).toBeGreaterThan(150)
    expect(sites.filter(s => s.followed && s.values.length > 0).length).toBeGreaterThan(120)
  })
})

describe('style.ts', () => {
  test('every value is a theme key, never raw or ANSI', () => {
    for (const v of [...Object.values(STYLE), SELECTED_BG, ...IDENTITY, ...Object.values(MARK).map(m => m.color), ...Object.values(NOTICE_STYLE).map(n => n.color)]) expect(refusal(v)).toBeNull()
  })

  test('every state carries a glyph and a word, and every notice level a glyph', () => {
    for (const [name, m] of Object.entries(MARK)) {
      expect(m.glyph.trim(), name).not.toBe('')
      expect(m.word.trim(), name).not.toBe('')
    }
    for (const n of Object.values(NOTICE_STYLE)) expect(n.glyph.trim()).not.toBe('')
  })

  test('secondary text is inactive, and subtle is kept for separators', () => {
    // inactive reads at about 5.3:1 on the dock grey in dark and light; subtle at about 2:1 (style.ts).
    expect(STYLE.muted).toBe('inactive')
    expect(STYLE.faint).toBe('subtle')
    expect(Object.entries(STYLE).filter(([, v]) => v === 'subtle').map(([k]) => k)).toEqual(['faint'])
    expect(SELECTED_BG).toBe('selectionBg')
  })
})
