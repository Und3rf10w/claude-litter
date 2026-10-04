// fixtures/rules-import/deepwork as data, for tests/rulespanekeys.test.tsx,
// which can't read files (tier 1 has no fs). tests/unit/rulespanekeys.spec.ts
// checks it against the fixture's files, since rules.sh's Tab counts follow
// the guardrails' number and order: change the fixture and this together.

/** Each file under fixtures/rules-import/deepwork/, by its path there, as JSON values; incidents.jsonl one value a line. */
export const RULES_IMPORT_DEEPWORK: Record<string, unknown> = {
  'live1/state.json': {
    version: 1,
    mode: 'default',
    goal: 'Add report functions to parts a and b',
    instance_id: 'live1',
    started_at: '2026-09-30T10:00:00Z',
    last_updated: '2026-09-30T12:00:00Z',
    phase: 'scope',
    guardrails: [
      { rule: 'never call curl in a/', source: 'user', timestamp: '2026-09-30T10:05:00Z' },
      { rule: 'never write to a/out.txt', source: 'flag', timestamp: '2026-09-30T10:06:00Z' },
      { rule: 'never run the b/ tests twice in one gate', source: 'orchestrator', timestamp: '2026-09-30T11:00:00Z', incident_ref: 'inc-orch-1' },
      { rule: 'never touch files outside a/ and b/', source: 'scope-boundary', timestamp: '2026-09-30T11:30:00Z' },
    ],
  },
  'live1/incidents.jsonl': [{ rule: 'never run the b/ tests twice in one gate', source: 'orchestrator', timestamp: '2026-09-30T11:00:00Z', incident_ref: 'inc-orch-1' }],
  'old1/state.archived.json': {
    version: 1,
    mode: 'default',
    goal: 'An earlier pass over part b',
    instance_id: 'old1',
    started_at: '2026-08-01T09:00:00Z',
    last_updated: '2026-08-01T11:00:00Z',
    phase: 'done',
    guardrails: [{ rule: 'never delete a test in b/', source: 'flag', timestamp: '2026-08-01T09:30:00Z' }],
  },
}

/** A file's text as the fixture holds it: pretty JSON, or one compact JSON value a line for a .jsonl. */
export function fixtureText(path: string, value: unknown): string {
  if (path.endsWith('.jsonl')) return (value as unknown[]).map(v => `${JSON.stringify(v)}\n`).join('')
  return `${JSON.stringify(value, null, 2)}\n`
}
