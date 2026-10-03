// WP-J: the templates (15.5): the four built-ins as data, params and
// `repeat`, instantiating and validating, and saving yours or this project's.
//
// Stub (phase 2b-1, package C): the signatures are the contract; the bodies are J's.
// Where the brief left a parameter open, the doc comment says what C picked.

import type { Ports } from '../ports'
import type { SpecCheck, SwarmSpec, Template, TemplateListing } from './types'

const notBuilt = (name: string): Error => new Error(`litter: ${name} is not built yet (WP-J)`)

/** The built-ins: branch per orchestrator, research fan-out, review panel, pipeline. Empty until J builds them. */
export const BUILTIN_TEMPLATES: readonly Template[] = []

/** The built-ins, then yours (`p.configDir()`), then this project's. A project template is only read. */
export async function listTemplates(p: Ports, litterDir: string): Promise<TemplateListing[]> {
  throw notBuilt('listTemplates')
}

/**
 * Fills a template's params and `repeat`, then validates the result.
 * C's choice: `values` by param name (a string, or a list for a `list` param),
 * and the answer carries the spec, its briefs and the check.
 */
export async function instantiate(
  p: Ports,
  litterDir: string,
  template: Template,
  values: Readonly<Record<string, string | readonly string[]>>,
): Promise<{ spec: SwarmSpec; briefs: Record<string, string>; check: SpecCheck }> {
  throw notBuilt('instantiate')
}

/**
 * Writes `<config dir>/litter/swarm-templates/<name>.json` (scope `user`) or
 * `<litterDir>/swarm-templates/<name>.json` (scope `project`). C's choice: the
 * whole template, its `scope` saying where; it answers the file's path.
 */
export async function saveTemplate(p: Ports, litterDir: string, template: Template): Promise<string> {
  throw notBuilt('saveTemplate')
}
