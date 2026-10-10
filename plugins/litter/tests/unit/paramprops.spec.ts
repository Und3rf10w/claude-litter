// Tier 2: no constructor parameter property (`readonly`, `private`, `public`
// or `protected` on a constructor's parameter) under hooks/, because the Codex
// host loads these files with node's type stripping, which can't run one: it
// isn't only a type. A class declares the field and sets it in the
// constructor instead. Read through the TypeScript parser, so a constructor
// written over several lines is checked too.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'

const HOOKS = join(import.meta.dir, '..', '..', 'hooks')
const PROPERTY = new Set([ts.SyntaxKind.ReadonlyKeyword, ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.ProtectedKeyword])

/** Each parameter property in `source`, as `<file>:<line> <name>`. */
function parameterProperties(fileName: string, source: string): string[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
  const hits: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isConstructorDeclaration(node)) {
      for (const param of node.parameters) {
        if ((ts.getModifiers(param) ?? []).some(m => PROPERTY.has(m.kind))) {
          hits.push(`${fileName}:${sf.getLineAndCharacterOfPosition(param.getStart(sf)).line + 1} ${param.name.getText(sf)}`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return hits
}

const files = (): string[] =>
  (readdirSync(HOOKS, { recursive: true }) as string[]).filter(f => /\.tsx?$/.test(f) && !f.endsWith('.d.ts')).sort()

describe('constructor parameter properties', () => {
  test('the check finds one on one line or several, and passes a plain parameter', () => {
    expect(parameterProperties('a.ts', 'class A { constructor(readonly x: number, private y = f(1)) {} }')).toEqual(['a.ts:1 x', 'a.ts:1 y'])
    expect(parameterProperties('b.ts', 'class B {\n  constructor(\n    a: string,\n    protected b: string,\n  ) {}\n}')).toEqual(['b.ts:4 b'])
    expect(parameterProperties('c.ts', 'class C { readonly x: number; constructor(x: number) { this.x = x } }')).toEqual([])
  })

  test("none under hooks/: the Codex host loads these files with node's type stripping", () => {
    const all = files()
    expect(all.length).toBeGreaterThan(50)
    expect(all.flatMap(f => parameterProperties(f, readFileSync(join(HOOKS, f), 'utf8')))).toEqual([])
  })
})
