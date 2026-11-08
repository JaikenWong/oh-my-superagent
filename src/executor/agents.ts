/**
 * Agent backends: how one worker turn runs as an external CLI agent. The host only orchestrates; the coding agent is
 * whichever CLI the deployment chose. Tool allowlists / permission modes follow the Mandate's capability (§10).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Capability } from '../core/model.ts'
import { permissionModeFor } from './capability.ts'

export interface TurnSpec {
  directory: string
  prompt: string
  /** Stable per Ticket, so later turns continue the same agent session where the backend can. */
  sessionId: string
  resume: boolean
  capability: Capability
  lastMessagePath: string
  extraArgs: string[]
  /** Absolute path to a deepseek-harness checkout when using the `dsh` backend. */
  dshRoot?: string
}
export interface AgentCommand { command: string; args: string[]; input: string }
export interface AgentBackend {
  id: 'mock' | 'claude' | 'codex' | 'dsh'
  /** Keeps its own history across turns; otherwise each prompt repeats the Ticket's history. */
  resumable: boolean
  command(spec: TurnSpec): AgentCommand
  /** The worker's final message, which ends with its report. */
  finalText(stdout: string, spec: TurnSpec): string
}

/** A `read` worker gets only these tools; in print mode any Bash call outside the allowed patterns is refused. */
const READ_AVAILABLE = ['Read', 'Grep', 'Glob', 'Bash']
const READ_ALLOWED = ['Read', 'Grep', 'Glob', 'Bash(git log *)', 'Bash(git show *)', 'Bash(git diff *)', 'Bash(git status *)', 'Bash(git grep *)',
  'Bash(ls *)', 'Bash(cat *)', 'Bash(rg *)', 'Bash(grep *)', 'Bash(find *)', 'Bash(wc *)', 'Bash(head *)']
const WRITE_ALLOWED = ['Read', 'Grep', 'Glob', 'Edit', 'MultiEdit', 'Write', 'Bash']

export const claude: AgentBackend = {
  id: 'claude',
  resumable: true,
  command: spec => ({
    command: 'claude',
    args: ['-p', '--output-format', 'json', ...spec.resume ? ['--resume', spec.sessionId] : ['--session-id', spec.sessionId],
      ...spec.capability === 'read' ? ['--tools', READ_AVAILABLE.join(',')] : [],
      '--allowedTools', (spec.capability === 'write' ? WRITE_ALLOWED : READ_ALLOWED).join(','),
      '--disallowedTools', ['Bash(git push *)', 'Bash(gh *)', 'Bash(glab *)', 'Bash(lark-cli *)'].join(','),
      ...spec.capability === 'write' ? ['--permission-mode', 'acceptEdits'] : [], ...spec.extraArgs],
    input: spec.prompt,
  }),
  finalText: stdout => {
    try {
      const answer = JSON.parse(stdout) as { result?: string; is_error?: boolean }
      if (answer.is_error) throw new Error(`claude reported an error: ${answer.result ?? ''}`.slice(0, 500))
      return answer.result ?? ''
    } catch (error) {
      if (error instanceof SyntaxError) return stdout
      throw error
    }
  },
}

export const codex: AgentBackend = {
  id: 'codex',
  resumable: false,
  command: spec => ({
    command: 'codex',
    args: ['exec', '--skip-git-repo-check', '-C', spec.directory, '-s', spec.capability === 'write' ? 'workspace-write' : 'read-only',
      '--output-last-message', spec.lastMessagePath, ...spec.extraArgs, '-'],
    input: spec.prompt,
  }),
  finalText: (stdout, spec) => existsSync(spec.lastMessagePath) ? readFileSync(spec.lastMessagePath, 'utf8') : stdout,
}

/** A deterministic stand-in, so the whole flow runs without a model; it reads the turn from `SUPERAGENT_TURN`. */
export const mock: AgentBackend = {
  id: 'mock',
  resumable: false,
  command: spec => ({ command: process.execPath, args: [fileURLToPath(new URL('./mock-agent.ts', import.meta.url))], input: spec.prompt }),
  finalText: stdout => stdout,
}

/**
 * DeepSeek Harness headless Worker. Resolves CLI via `DSH_BIN`, or `dshRoot`/`DSH_ROOT` + `apps/cli/src/bin.ts`, or `dsh` on PATH.
 * Capability → `--permission-mode read-only|workspace-write` (host-enforced sandbox policy in harness).
 * First version is non-resumable: each turn gets the full Ticket prompt (session resume can land later).
 */
export const dsh: AgentBackend = {
  id: 'dsh',
  resumable: false,
  command: spec => {
    const mode = permissionModeFor(spec.capability, 'dsh')
    const { command, prefix } = resolveDsh(spec.dshRoot)
    return {
      command,
      args: [
        ...prefix,
        '--profile', 'headless',
        '--permission-mode', mode,
        '--approval-policy', 'never',
        ...spec.extraArgs,
        '-',
      ],
      input: spec.prompt,
    }
  },
  finalText: stdout => {
    const trimmed = stdout.trim()
    if (!trimmed) return ''
    // Plain final message, or last NDJSON event that carries a message/result field.
    if (!trimmed.includes('\n') || !trimmed.startsWith('{')) return trimmed
    let last = trimmed
    for (const line of trimmed.split('\n')) {
      const row = line.trim()
      if (!row.startsWith('{')) continue
      try {
        const event = JSON.parse(row) as { type?: string; message?: string; result?: string; text?: string }
        const text = event.message ?? event.result ?? event.text
        if (typeof text === 'string' && text.trim()) last = text
      } catch { /* keep scanning */ }
    }
    return last
  },
}

function resolveDsh(dshRoot?: string): { command: string; prefix: string[] } {
  if (process.env.DSH_BIN?.trim()) return { command: process.env.DSH_BIN.trim(), prefix: [] }
  const root = dshRoot?.trim() || process.env.DSH_ROOT?.trim()
  if (root) {
    const bin = join(root, 'apps/cli/src/bin.ts')
    // Prefer harness-local tsx so Worker cwd (worktree) need not resolve the package.
    const tsx = join(root, 'node_modules/tsx/dist/esm/index.mjs')
    if (existsSync(bin) && existsSync(tsx)) return { command: process.execPath, prefix: ['--import', tsx, bin] }
    if (existsSync(bin)) return { command: process.execPath, prefix: ['--import', 'tsx/esm', bin] }
  }
  return { command: 'dsh', prefix: [] }
}

export const BACKENDS: Record<AgentBackend['id'], AgentBackend> = { claude, codex, mock, dsh }
