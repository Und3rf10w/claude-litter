// The three swarm tools the lead calls (plan 15.4, "The swarm tools"): their
// specs, their input decoding, and their registration at session.start. Each
// is answered in its own tool.call hook (register.tsx), never through next(e):
// J's swarmProposeTool, K's swarmReadTool, L's swarmSendTool.
//
// Contract owner: phase 2b-1, package C.

import type { ToolSpec } from 'claude-code'
import type { Ports } from '../ports'

/** The tools' served names, `mcp__litter__<name>`. */
export const SWARM_PROPOSE = 'mcp__litter__swarm_propose'
export const SWARM_READ = 'mcp__litter__swarm_read'
export const SWARM_SEND = 'mcp__litter__swarm_send'
export type SwarmToolName = typeof SWARM_PROPOSE | typeof SWARM_READ | typeof SWARM_SEND

type FieldType = 'object' | 'objects' | 'boolean' | 'integer'

/**
 * Each tool's fields whose value isn't a string. A field the schema doesn't
 * declare arrives as a string (tier 4, live), and a model can send a declared
 * one JSON-encoded too, so each is decoded as the record tool's STRUCTURED is.
 */
const STRUCTURED: Readonly<Record<SwarmToolName, Readonly<Record<string, FieldType>>>> = {
  [SWARM_PROPOSE]: { baseRevision: 'integer', spec: 'object', briefs: 'object', changes: 'objects' },
  [SWARM_READ]: { draft: 'boolean' },
  [SWARM_SEND]: {},
}

const SWARM_NAME_FIELD = { type: 'string', description: 'The swarm name, as the builder or /litter:swarm names it.' }

/** Registered at session.start, served as `mcp__litter__swarm_propose`, `…_read` and `…_send`. */
export const SWARM_TOOLS: readonly ToolSpec[] = [
  {
    name: 'swarm_propose',
    description:
      'litter: propose a swarm, or a change to one, for the user to accept in the litter swarm builder. ' +
      'The lead only, from the litter swarm skill. Nothing is saved or started: the reply lists every error with its field, ' +
      'or the staged proposal number.',
    inputSchema: {
      type: 'object',
      properties: {
        swarm: SWARM_NAME_FIELD,
        baseRevision: {
          type: 'integer',
          description: 'The revision this proposal starts from: the draft revision the builder named, or 0 for a new swarm.',
        },
        spec: { type: 'object', description: 'The whole swarm spec, as the skill describes it: name, goal, nodes, limits.' },
        briefs: {
          type: 'object',
          description: 'Node id to brief text (Markdown), for each brief you add or change. Briefs you leave out stay as they are.',
          additionalProperties: { type: 'string' },
        },
        changes: {
          type: 'array',
          description: 'One entry per change, each with the field path it changes and the reason, for the user to accept or reject.',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, reason: { type: 'string' } },
            required: ['path', 'reason'],
          },
        },
      },
      required: ['swarm', 'baseRevision', 'spec', 'changes'],
    },
  },
  {
    name: 'swarm_read',
    description:
      'litter: read a litter swarm. The lead only, from the litter swarm skill. With draft, the builder\'s draft and its revision; ' +
      'otherwise the live launch: the authority, each orchestrator to spawn, and each node\'s instances. With node and for, ' +
      'the text to resume or re-spawn that node with. It changes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        swarm: SWARM_NAME_FIELD,
        draft: { type: 'boolean', description: 'True to read the draft (or the saved spec) rather than the live launch.' },
        node: { type: 'string', description: 'A node id, with for.' },
        for: { type: 'string', enum: ['resume', 'respawn'], description: 'With node: the continuation text to resume or re-spawn it with.' },
      },
      required: ['swarm'],
    },
  },
  {
    name: 'swarm_send',
    description:
      'litter: send a message to a node of a live litter swarm. The lead only. It goes now: a running node reads it at its ' +
      'next step, and one between turns is resumed with it. ' +
      'The reply says whether it was delivered, readdressed to the parent or refused, and why.',
    inputSchema: {
      type: 'object',
      properties: {
        swarm: { type: 'string', description: 'The swarm name. Needed only when more than one swarm is live.' },
        node: { type: 'string', description: 'The node id, or <node>#<n> for one instance of a template with several live.' },
        text: { type: 'string', description: 'The message.' },
      },
    },
  },
]

const hasType = (v: unknown, t: FieldType): boolean =>
  t === 'objects'
    ? Array.isArray(v)
    : t === 'object'
      ? typeof v === 'object' && v !== null && !Array.isArray(v)
      : t === 'boolean'
        ? typeof v === 'boolean'
        : Number.isInteger(v)

/** tool.call's own keys beside the tool's arguments (d.ts ToolCallReserved): never part of an input. */
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'consent'])

/**
 * The tool's input from a tool.call event: the reserved keys dropped, and each
 * structured field sent as a string of its JSON decoded. A value that doesn't
 * decode to its type is left as it came, for the handler's schema check to name.
 */
export function decodeSwarmInput(tool: SwarmToolName, raw: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const types = STRUCTURED[tool]
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (RESERVED.has(k)) continue
    const t = types[k]
    if (t === undefined || typeof v !== 'string') {
      out[k] = v
      continue
    }
    try {
      const parsed: unknown = JSON.parse(v)
      out[k] = hasType(parsed, t) ? parsed : v
    } catch {
      out[k] = v
    }
  }
  return out
}

/**
 * Registers the three tools. Resolves null, or the refusal's text when the
 * engine refused one (managed allowedMcpServers: plan section 9, "Fail
 * closed"); session.ts keeps it as `swarmToolsRefused`, and J and K refuse to
 * propose and launch while it's set. Runs don't depend on it.
 */
export async function registerSwarmTools(p: Ports): Promise<string | null> {
  try {
    for (const spec of SWARM_TOOLS) await p.registerTool(spec)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}
