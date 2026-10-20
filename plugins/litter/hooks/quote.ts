// An argv as one POSIX shell command line that means the same argv (plan
// section 10, "Agents get a shell command line that means the same argv").
// Owner: phase 1b, work package C. run.start (D) renders verifyCommand with it.

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/

/**
 * Words a shell reads as syntax in command position (POSIX, bash and zsh), so
 * a first argument spelled like one is quoted to stay a command name.
 */
const RESERVED = new Set([
  'case', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'if', 'in', 'then', 'until', 'while',
  'function', 'select', 'time', 'coproc', 'foreach', 'repeat', 'nocorrect', 'end',
])

/**
 * A bare word stays bare only when no shell gives it a meaning of its own:
 * zsh expands a word that starts with `=` to a command's path (EQUALS), and a
 * first word with `=` in it is a variable assignment, not the command.
 */
const bare = (a: string, first: boolean): boolean =>
  SAFE.test(a) && !a.startsWith('=') && !(first && (a.includes('=') || RESERVED.has(a)))

export function shellQuote(argv: readonly string[]): string {
  return argv
    .map((a, i) => (a === '' ? "''" : bare(a, i === 0) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
    .join(' ')
}
