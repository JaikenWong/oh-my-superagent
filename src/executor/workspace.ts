/** A Ticket's directory: a git worktree on its own branch, so no two workers ever write to the same checkout. */
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export async function git(directory: string, args: string[], timeout = 60_000): Promise<string> {
  const { stdout } = await run('git', ['-C', directory, ...args], { timeout, maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

/**
 * Creates the worktree once: on the Ticket's branch if it exists, else a new branch from `base`. Then runs the prepare
 * command, which has ten minutes, in the new directory. An existing directory is reused as it is.
 */
export async function prepareWorktree(repository: string, directory: string, branch: string, base: string, prepare: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (existsSync(directory)) return
  mkdirSync(dirname(directory), { recursive: true })
  const exists = await git(repository, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false)
  await git(repository, exists ? ['worktree', 'add', directory, branch] : ['worktree', 'add', '-b', branch, directory, base])
  if (prepare.trim()) await run('sh', ['-c', prepare], { cwd: directory, env, timeout: 600_000, maxBuffer: 8 * 1024 * 1024 })
}

/** Everything the branch changed against its base, committed or not, and the untracked files. */
export async function captureDiff(directory: string, base: string): Promise<{ diff: string; stat: string; untracked: string[] }> {
  const mergeBase = (await git(directory, ['merge-base', 'HEAD', base]).catch(() => base)).trim()
  const [diff, stat, untracked] = await Promise.all([
    git(directory, ['diff', mergeBase]),
    git(directory, ['diff', '--shortstat', mergeBase]),
    git(directory, ['ls-files', '--others', '--exclude-standard']),
  ])
  return { diff, stat: stat.trim(), untracked: untracked.split('\n').filter(Boolean) }
}

/** Commits what the worker left uncommitted; answers whether the branch is ahead of its base. */
export async function commitAll(directory: string, base: string, message: string, author: string): Promise<boolean> {
  await git(directory, ['add', '-A'])
  const staged = await git(directory, ['diff', '--cached', '--quiet']).then(() => false, () => true)
  if (staged) {
    const [name, email] = author.match(/^(.*)<(.*)>$/)?.slice(1).map(item => item.trim()) ?? ['superagent', 'superagent@localhost']
    await git(directory, ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-m', message])
  }
  return Number((await git(directory, ['rev-list', '--count', `${base}..HEAD`])).trim()) > 0
}

/**
 * Command shims for workers: blocked commands fail by name, and `git push` is refused because the host pushes after a
 * person approves. These are defaults, not a security boundary: a program run by absolute path bypasses them.
 */
export async function installShims(directory: string, blocked: string[]): Promise<string> {
  mkdirSync(directory, { recursive: true })
  const realGit = (await run('sh', ['-c', 'command -v git'])).stdout.trim()
  for (const name of blocked) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === 'git') continue
    write(join(directory, name), `#!/bin/sh\necho "superagent: '${name}' is not available to workers; report what you need instead." >&2\nexit 1\n`)
  }
  write(join(directory, 'git'), `#!/bin/sh\nfor arg in "$@"; do\n  case "$arg" in\n    push) echo "superagent: workers do not push; propose a pull request in your report and the host opens it once a person approves." >&2; exit 1;;\n  esac\ndone\nexec ${realGit} "$@"\n`)
  return directory
}
function write(path: string, content: string) {
  writeFileSync(path, content)
  chmodSync(path, 0o755)
}
