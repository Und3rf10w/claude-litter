// Tier 2: tests/rulespanekeys.test.tsx imports fixtures/rules-import's
// deepwork state from tests/rulespanekeys-fixture.ts, since tier 1 reads no
// files. This holds that copy to the fixture rules.sh (T4-2) copies into its
// repo: every file, the same JSON, and no file of one missing from the other.
// rules.sh's Tab counts follow the guardrails' number and order.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { RULES_IMPORT_DEEPWORK } from '../rulespanekeys-fixture'

const DIR = join(import.meta.dir, '../headless/fixtures/rules-import/deepwork')

/** The fixture's files, by their path under deepwork/. */
function files(dir: string, at = ''): string[] {
  return readdirSync(join(dir, at)).flatMap(name => {
    const rel = at ? `${at}/${name}` : name
    return statSync(join(dir, rel)).isDirectory() ? files(dir, rel) : [rel]
  })
}

const parsed = (rel: string): unknown => {
  const text = readFileSync(join(DIR, rel), 'utf8')
  return rel.endsWith('.jsonl')
    ? text
        .split('\n')
        .filter(l => l.trim() !== '')
        .map(l => JSON.parse(l) as unknown)
    : (JSON.parse(text) as unknown)
}

describe("rulespanekeys.test.tsx's copy of the rules-import fixture", () => {
  test('names the same files', () => {
    expect(Object.keys(RULES_IMPORT_DEEPWORK).sort()).toEqual(files(DIR).sort())
  })

  test('holds the same JSON in each', () => {
    for (const rel of files(DIR)) expect({ [rel]: RULES_IMPORT_DEEPWORK[rel] }).toEqual({ [rel]: parsed(rel) })
  })
})
