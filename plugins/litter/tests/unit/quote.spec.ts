// Tier 2: shellQuote round-trips through real shells (plan section 10, "Agents
// get a shell command line that means the same argv"; section 12).

import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { shellQuote } from '../../hooks/quote'
import { nodePorts } from './support/node-ports'

const p = nodePorts()

/** The shells to run each line through: sh always, the others when they're installed. */
const SHELLS = ['sh', 'dash', 'bash', 'zsh'].filter(sh => sh === 'sh' || ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'].some(d => existsSync(`${d}/${sh}`)))

/** The words a shell hands printf after reading `line`. */
async function wordsThrough(shell: string, line: string): Promise<string[]> {
  // A fixed first word keeps the format and the sentinel ours; the rest is the line under test.
  const r = await p.run([shell, '-c', `printf '%s\\0' sentinel ${line}`], { env: { HOME: '/nonexistent-litter-home' } })
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  const words = r.stdout.split('\0')
  expect(words.shift()).toBe('sentinel')
  expect(words.pop()).toBe('')
  return words
}

const CASES: Record<string, string[]> = {
  'the plan example': ['-k', 'not known_failure'],
  spaces: ['a b', '  lead', 'trail  ', '\ttab'],
  quotes: ["it's", '"double"', `mixed '" quotes`, "'", "''"],
  dollars: ['$HOME', '${HOME}', '$(echo pwned)', '$((1+1))', '$'],
  backticks: ['`echo pwned`', '`'],
  operators: [';', '|', '&&', '||', '&', 'a;b', 'a|b', '>', '<', '>>', '2>&1', '(', ')', '{', '}'],
  globs: ['*', '?', '[a-z]', '*.ts', 'src/**', '{a,b}'],
  newlines: ['line one\nline two', '\n', 'trailing\n'],
  'empty strings': ['', 'x', ''],
  'leading dashes': ['-', '--', '-n', '--flag=value', '-e'],
  'non-ASCII': ['héllo', '日本語', 'emoji 🎉', 'ünïcödé'],
  tilde: ['~', '~/x', '~root', 'a~b'],
  hashes: ['#', '#comment', 'a#b', ' #'],
  bangs: ['!', '!!', '!$', 'a!b', '!-1'],
  backslashes: ['\\', '\\n', 'a\\ b', '\\\\'],
  'equals signs': ['=ls', '=', 'a=b', 'FOO=bar', '==', '=x=y'],
  'zsh specials': ['^x', '%1', '%', '@', 'x:y', 'a,b', 'a+b', '-%-'],
  'reserved words': ['if', 'then', 'done', 'time', 'function', '!', '[[', ']]', '{', 'in'],
}

describe('shellQuote', () => {
  test('safe words stay bare, others are single-quoted, empty is a pair of quotes', () => {
    expect(shellQuote(['uv', 'run', 'pytest', '-k', 'not known_failure'])).toBe("uv run pytest -k 'not known_failure'")
    expect(shellQuote(['a', '', 'b'])).toBe("a '' b")
    expect(shellQuote(["it's"])).toBe(`'it'\\''s'`)
    expect(shellQuote(['tests/', '-q', 'a=b', 'x@y:z,1+2%'])).toBe('tests/ -q a=b x@y:z,1+2%')
  })

  test("a word starting with '=' is quoted (zsh would expand it to a command's path)", () => {
    expect(shellQuote(['echo', '=ls'])).toBe("echo '=ls'")
  })

  test("a first word that's an assignment or a reserved word is quoted, so it stays the command", () => {
    expect(shellQuote(['FOO=bar', 'x'])).toBe("'FOO=bar' x")
    expect(shellQuote(['if', 'x'])).toBe("'if' x")
    expect(shellQuote(['x', 'if', 'FOO=bar'])).toBe('x if FOO=bar')
  })

  for (const shell of SHELLS) {
    describe(`round trip through ${shell} -c`, () => {
      for (const [name, argv] of Object.entries(CASES)) {
        test(name, async () => {
          expect(await wordsThrough(shell, shellQuote(argv))).toEqual(argv)
        })
      }

      test('every case at once, as one command line', async () => {
        const all = Object.values(CASES).flat()
        expect(await wordsThrough(shell, shellQuote(all))).toEqual(all)
      })
    })
  }

  test('a first word spelled like an assignment or a reserved word is still looked up as a command', async () => {
    for (const shell of SHELLS) {
      for (const argv of [['FOO=bar', 'x'], ['if', 'x'], ['done', 'x']]) {
        const r = await p.run([shell, '-c', shellQuote(argv)], { env: { HOME: '/nonexistent-litter-home' } })
        expect(r.code).toBe(127)
        expect(r.stderr).toContain(argv[0]!)
        expect(r.stderr).toMatch(/not found/)
      }
    }
  })
})
