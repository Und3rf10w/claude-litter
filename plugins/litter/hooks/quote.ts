// An argv as one POSIX shell command line that means the same argv (plan
// section 10, "Agents get a shell command line that means the same argv").
// Owner: phase 1b, work package C. run.start (D) renders verifyCommand with it.

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/

export function shellQuote(argv: readonly string[]): string {
  return argv.map(a => (a === '' ? "''" : SAFE.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ')
}
