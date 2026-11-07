/** What the Sources share: detecting that a message addresses the agent, HTTP calls, and pushing a branch. */
import { execFile } from 'node:child_process'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** The line that begins every message the agent writes on a code host; it also marks the agent's own messages. */
export const DEFAULT_SIGNATURE = '> 由自动化 agent 发出，非人工。'

/** A message addresses the agent when it mentions the agent account or a line starts with the command prefix. */
export function addressesAgent(text: string, mention: string | undefined, command: string): boolean {
  if (mention && new RegExp(`(^|\\s)@${escape(mention)}\\b`, 'i').test(text)) return true
  return text.split('\n').some(line => line.trim().toLowerCase().startsWith(command.toLowerCase()))
}
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function hmacSha256(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export class HttpError extends Error {
  readonly status: number
  readonly body: string
  constructor(status: number, body: string, what: string) {
    super(`${what} answered HTTP ${status}: ${body.slice(0, 300)}`)
    this.status = status
    this.body = body
  }
}

export async function http<T = unknown>(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown }, what: string): Promise<T> {
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...init.headers },
    ...init.body === undefined ? {} : { body: JSON.stringify(init.body) },
    signal: AbortSignal.timeout(20_000),
  })
  const text = await response.text()
  if (!response.ok) throw new HttpError(response.status, text, what)
  return (text ? JSON.parse(text) : {}) as T
}

/** Pushes the worktree's HEAD to `branch` with a credential that never enters the worker's environment or the remote URL. */
export async function pushBranch(directory: string, remote: string, branch: string, basicAuth: string): Promise<void> {
  const header = `AUTHORIZATION: basic ${Buffer.from(basicAuth).toString('base64')}`
  await run('git', ['-C', directory, '-c', `http.extraheader=${header}`, 'push', '--force-with-lease', remote, `HEAD:refs/heads/${branch}`], { timeout: 120_000 })
}

export function secretFrom(env: string | undefined): string {
  return env ? process.env[env] ?? '' : ''
}

export const dryRunLog = (source: string, what: string, detail: unknown) =>
  console.log(`[dry-run ${source}] ${what} ${JSON.stringify(detail).slice(0, 400)}`)
