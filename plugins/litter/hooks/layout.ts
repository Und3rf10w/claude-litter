// Every path litter writes or reads, from litterDir down (plan section 10,
// "On disk"). All absolute: the mod never passes a relative path to $.fs,
// since EnterWorktree moves the session's working directory mid-session.
//
// Contract owner: phase 1a. The command hooks (lib.sh) mirror the hooks/ part.

export const SEP = '/'

const join = (...parts: string[]): string => parts.join(SEP)

/** `<primary checkout>/.claude/litter`, resolved once per session (litterdir.ts). */
export type LitterDir = string

// hooks/: shared with the command hooks (plan section 9, "Mod-to-hook state").
export const hooksDir = (litterDir: LitterDir) => join(litterDir, 'hooks')
/** Exists only while a run is active or a swarm is live. Every script's first test. */
export const activePath = (litterDir: LitterDir) => join(hooksDir(litterDir), 'active')
export const policyPath = (litterDir: LitterDir) => join(hooksDir(litterDir), 'policy.json')
export const worktreePolicyPath = (litterDir: LitterDir) => join(hooksDir(litterDir), 'worktree.json')
export const agentPolicyPath = (litterDir: LitterDir, agentId: string) => join(hooksDir(litterDir), 'agents', `${agentId}.json`)
export const outPath = (litterDir: LitterDir, agentId: string) => join(hooksDir(litterDir), 'out', `${agentId}.json`)
export const bindPath = (litterDir: LitterDir, agentId: string) => join(hooksDir(litterDir), 'bind', agentId)
export const modePath = (litterDir: LitterDir) => join(hooksDir(litterDir), 'mode')
export const spoolDir = (litterDir: LitterDir) => join(hooksDir(litterDir), 'spool')
export const spoolPath = (litterDir: LitterDir, sessionId: string) => join(spoolDir(litterDir), `${sessionId}.jsonl`)
/** Lines over 4 KiB go to a file here, named by the line's `file` field. */
export const spoolBlobDir = (litterDir: LitterDir) => join(spoolDir(litterDir), 'blobs')
/**
 * In a session started in a linked worktree, `$CLAUDE_PROJECT_DIR/.claude/litter/hooks/pointer`
 * holds the absolute path of the real hooks/ folder. lib.sh follows it.
 */
export const pointerPath = (projectDir: string) => join(projectDir, '.claude', 'litter', 'hooks', 'pointer')

// Runs.
export const runDir = (litterDir: LitterDir, run: string) => join(litterDir, run)
export const runJsonPath = (runDir: string) => join(runDir, 'run.json')
export const ledgerDir = (runDir: string) => join(runDir, 'ledger')
export const ledgerFileName = (seq: number, kind: string) => `${String(seq).padStart(6, '0')}-${kind}.json`
export const ledgerExportDir = (runDir: string) => join(runDir, 'ledger-export')
export const verifyLogDir = (runDir: string, verifyId: string) => join(runDir, 'verify', verifyId)
export const verifyLogPart = (runDir: string, verifyId: string, part: number) =>
  join(verifyLogDir(runDir, verifyId), `${String(part).padStart(4, '0')}.log`)
export const planPath = (runDir: string) => join(runDir, 'plan.md')
export const summaryPath = (runDir: string) => join(runDir, 'summary.md')
export const proposalPath = (runDir: string, version: string) => join(runDir, 'proposals', `${version}.md`)
export const verdictsDir = (runDir: string) => join(runDir, 'verdicts')

/** `<litterDir>/WIKI.md` (plan section 10, "On disk"). */
export const wikiPath = (litterDir: LitterDir) => join(litterDir, 'WIKI.md')

// Lock lease (plan section 9, "Launch preconditions", step 0).
export const leasePath = (litterDir: LitterDir, oid: string) => join(litterDir, `lock-lease-${oid}.json`)

/**
 * Paths the snapshot and the clean-tree check leave out (plan section 9, "Snapshot").
 * Relative to the checkout root, as git pathspecs.
 */
export const SNAPSHOT_EXCLUDES = [
  '.claude/litter',
  '.claude/worktrees',
  '.litter',
  '.litter.local',
  '.claude/rules/litter',
  '.claude/rules/litter-local',
] as const

/** A run id: `<yyyymmdd>-<slug>`. */
export const RUN_ID = /^[0-9]{8}-[a-z0-9][a-z0-9-]{0,62}$/
