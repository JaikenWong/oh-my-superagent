/**
 * Host-side Capability Enforcement (design §10): Mandate → Execution Policy.
 * Prompt text is advisory; shims, CLI permission modes and Outbox are the real boundary.
 */
import type { Capability } from '../core/model.ts'

/** What the host allows a worker for each Mandate capability. */
export const CAPABILITY_MATRIX = {
  readFiles: { read: true, write: true },
  editFiles: { read: false, write: true },
  runTests: { read: true, write: true },
  gitCommit: { read: false, write: true },
  gitPush: { read: false, write: false },
  openPullRequest: { read: false, write: 'host' as const },
  speakToHumans: { read: false, write: 'host' as const },
  otherRepos: { read: false, write: false },
} as const

/** Extra command names blocked for a capability (on top of settings.executor.blockedCommands). */
export function blockedCommandsFor(capability: Capability, configured: string[]): string[] {
  const always = [...configured, 'gh', 'glab', 'lark-cli']
  return [...new Set(always)]
}

/** Git subcommands the shim must refuse for this capability. */
export function blockedGitSubcommands(capability: Capability): string[] {
  if (capability === 'read') return ['push', 'commit', 'am', 'rebase', 'merge', 'cherry-pick', 'reset', 'tag', 'branch', 'checkout', 'switch', 'stash', 'clean', 'add', 'rm', 'mv']
  return ['push']
}

/** DeepSeek Harness / Codex-style permission preset for one Mandate. */
export function permissionModeFor(capability: Capability, backend: 'dsh' | 'codex' | 'claude'): string {
  if (backend === 'dsh') return capability === 'write' ? 'workspace-write' : 'read-only'
  if (backend === 'codex') return capability === 'write' ? 'workspace-write' : 'read-only'
  return capability === 'write' ? 'acceptEdits' : 'default'
}

export function allowsFileWrite(capability: Capability): boolean {
  return capability === 'write'
}

export function allowsGitCommit(capability: Capability): boolean {
  return capability === 'write'
}
