/**
 * Agent backends: how one worker turn runs as an external CLI agent. The host only orchestrates; the coding agent is
 * whichever CLI the deployment chose. Tool allowlists follow the Mandate's capability.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Capability } from '../core/model.ts'

export interface TurnSpec {
  directory: string
  prompt: string
  /** Stable per Ticket, so later turns continue the same agent session where the backend can. */
  sessionId: string
  resume: boolean
  capability: Capability
  lastMessagePath: string
  extraArgs: string[]
}
export interface AgentCommand { command: string; args: string[]; input: string }
export interface AgentBackend {
  id: 'mock' | 'claude' | 'codex'
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

export const BACKENDS: Record<AgentBackend['id'], AgentBackend> = { claude, codex, mock }
