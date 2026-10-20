// File helpers the engine's $.fs doesn't have: rename, remove, atomic write,
// hashing. Built on Ports, so they run in the mod and under bun alike.
//
// Contract owner: phase 1a.

import type { Ports } from './ports'

const hex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('')

/** sha256 of the text's UTF-8 bytes, as lowercase hex. */
export async function sha256(text: string): Promise<string> {
  // The cast: bun's typings widen encode()'s buffer to ArrayBufferLike, which digest won't take.
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>))
}

/** A random id for temp files and tokens. */
export const randomId = (): string => crypto.randomUUID()

async function must(p: Ports, argv: string[], what: string): Promise<void> {
  const r = await p.run(argv)
  if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${r.stderr.trim()}`)
}

/** `mv -f -- from to`: atomic within one file system. */
export const rename = (p: Ports, from: string, to: string): Promise<void> =>
  must(p, ['mv', '-f', '--', from, to], `mv ${from}`)

/** `rm -rf -- path`. */
export const remove = (p: Ports, path: string): Promise<void> => must(p, ['rm', '-rf', '--', path], `rm ${path}`)

/** `mkdir -p -- path`. ($.fs.write makes parents itself; this is for empty folders.) */
export const mkdirp = (p: Ports, path: string): Promise<void> => must(p, ['mkdir', '-p', '--', path], `mkdir ${path}`)

/**
 * Writes beside the target, then renames over it, so a reader sees the old
 * file or the new one, never half of one.
 */
export async function atomicWrite(p: Ports, path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${randomId()}`
  await p.fs.write(tmp, text)
  try {
    await rename(p, tmp, path)
  } catch (err) {
    await remove(p, tmp).catch(() => {})
    throw err
  }
}

export const atomicWriteJson = (p: Ports, path: string, value: unknown): Promise<void> =>
  atomicWrite(p, path, `${JSON.stringify(value, null, 2)}\n`)

/** Reads JSON, or undefined when the file is missing. A file that doesn't parse rejects. */
export async function readJson<T>(p: Ports, path: string): Promise<T | undefined> {
  if (!(await p.fs.exists(path))) return undefined
  return JSON.parse(await p.fs.read(path)) as T
}

/**
 * Serialises async work per key inside this module instance: the record tool's
 * calls can interleave at every await, and two appends to one run's ledger
 * must not read the same head.
 */
const chains = new Map<string, Promise<unknown>>()
export function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  const next = prev.then(work, work)
  chains.set(key, next.catch(() => {}))
  return next
}
