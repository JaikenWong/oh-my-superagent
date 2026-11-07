/**
 * GitHub: webhooks of one repository. Issues and pull requests are Threads (`issue:<n>`, `pull:<n>`); comments, reviews and
 * new Issues or pull requests are Triggers. Closing a pull request is a Thread close, which can end its Ticket.
 */
import { randomInt } from 'node:crypto'
import type { Trigger } from '../core/model.ts'
import type { OutgoingMessage } from '../core/ports.ts'
import { addressesAgent, DEFAULT_SIGNATURE, dryRunLog, hmacSha256, http, HttpError, pushBranch, safeEqual, secretFrom } from './common.ts'
import type { PullRequestProposal, PullRequestResult, SendResult, SimulateInput, SourceConfigBase, SourceKind, WebhookRequest, WebhookResult } from './kind.ts'

export interface GithubConfig extends SourceConfigBase {
  kind: 'github'
  /** `owner/name`. */
  repo: string
  /** The account the agent writes as, possibly the operator's own; its signed messages are dropped before the domain. */
  account: string
  command?: string
  apiUrl?: string
  gitUrl?: string
  tokenEnv?: string
  secretEnv?: string
  /** The line that begins every message. */
  signature?: string
}

interface GhUser { login: string; type?: string }
interface GhIssue { id: number; number: number; title: string; body?: string | null; html_url: string; user: GhUser; pull_request?: unknown; created_at: string }
interface GhPayload {
  action?: string
  repository?: { full_name: string }
  issue?: GhIssue
  comment?: { id: number; body: string; html_url: string; user: GhUser; created_at: string; in_reply_to_id?: number }
  pull_request?: GhIssue & { merged?: boolean; head: { ref: string }; base: { ref: string } }
  review?: { id: number; body?: string | null; state: string; html_url: string; user: GhUser; submitted_at: string }
  sender?: GhUser
}

export class GithubSource implements SourceKind {
  readonly id: string
  readonly kind = 'github' as const
  readonly enabled: boolean
  readonly receiveAll: boolean
  readonly dryRun: boolean
  readonly #config: GithubConfig

  constructor(id: string, config: GithubConfig) {
    this.id = id
    this.#config = config
    this.enabled = config.enabled ?? true
    this.receiveAll = config.receiveAll ?? false
    this.dryRun = config.dryRun ?? false
  }

  get #command() { return this.#config.command ?? '/agent' }
  get #api() { return this.#config.apiUrl ?? 'https://api.github.com' }
  get #token() { return secretFrom(this.#config.tokenEnv ?? 'GITHUB_TOKEN') }
  get #secret() { return secretFrom(this.#config.secretEnv ?? 'GITHUB_WEBHOOK_SECRET') }

  verify(request: WebhookRequest): boolean {
    const secret = this.#secret
    if (!secret) return this.dryRun
    const signature = request.headers['x-hub-signature-256'] ?? ''
    return safeEqual(signature, `sha256=${hmacSha256(secret, request.body)}`)
  }

  parse(request: WebhookRequest): WebhookResult {
    const event = request.headers['x-github-event']
    const payload = JSON.parse(request.body) as GhPayload
    if (event === 'ping') return { response: { status: 200, body: { ok: true } }, triggers: [] }
    if (payload.repository?.full_name.toLowerCase() !== this.#config.repo.toLowerCase()) return { triggers: [] }
    const result: WebhookResult = { triggers: [], threads: [] }
    const issueThread = (issue: GhIssue, pull = !!issue.pull_request) => {
      const ref = { source: this.id, id: `${pull ? 'pull' : 'issue'}:${issue.number}` }
      result.threads!.push({ ref, meta: { label: `#${issue.number} ${issue.title}`, url: issue.html_url, number: issue.number, pull } })
      return ref
    }
    const trigger = (id: string, ref: { source: string; id: string }, user: GhUser, text: string, at: string, url: string, address: Record<string, string>, meta: Record<string, unknown>) => {
      if (this.#own(user, text)) return
      result.triggers.push(this.#trigger(id, ref, user, text, at, url, address, meta))
    }
    if (event === 'issues' && payload.action === 'opened' && payload.issue) {
      const { issue } = payload
      const ref = issueThread(issue)
      trigger(`github:issue:${issue.id}`, ref, issue.user, `${issue.title}\n\n${issue.body ?? ''}`.trim(), issue.created_at, issue.html_url,
        { number: String(issue.number) }, { kind: 'issue', number: issue.number })
    } else if (event === 'issue_comment' && payload.action === 'created' && payload.issue && payload.comment) {
      const { issue, comment } = payload
      const ref = issueThread(issue)
      trigger(`github:comment:${comment.id}`, ref, comment.user, comment.body, comment.created_at, comment.html_url,
        { number: String(issue.number) }, { kind: 'comment', number: issue.number })
    } else if (event === 'pull_request' && payload.pull_request) {
      const pull = payload.pull_request
      const ref = issueThread(pull, true)
      if (payload.action === 'opened') {
        result.opened = [{ ref, branch: pull.head.ref, url: pull.html_url }]
        trigger(`github:pull:${pull.id}`, ref, pull.user, `${pull.title}\n\n${pull.body ?? ''}`.trim(), pull.created_at, pull.html_url,
          { number: String(pull.number) }, { kind: 'pull_request', number: pull.number, head: pull.head.ref })
      } else if (payload.action === 'closed') result.closed = [{ ref, outcome: pull.merged ? 'merged' : 'closed' }]
    } else if (event === 'pull_request_review_comment' && payload.action === 'created' && payload.pull_request && payload.comment) {
      const { pull_request: pull, comment } = payload
      const ref = issueThread(pull, true)
      trigger(`github:review-comment:${comment.id}`, ref, comment.user, comment.body, comment.created_at, comment.html_url,
        { number: String(pull.number), reviewComment: String(comment.in_reply_to_id ?? comment.id) }, { kind: 'review_comment', number: pull.number })
    } else if (event === 'pull_request_review' && payload.action === 'submitted' && payload.pull_request && payload.review) {
      const { pull_request: pull, review } = payload
      const ref = issueThread(pull, true)
      // A review without a body, such as an approval, still wakes a worker waiting for review.
      trigger(`github:review:${review.id}`, ref, review.user, `[review: ${review.state}] ${review.body ?? ''}`.trim(), review.submitted_at, review.html_url,
        { number: String(pull.number) }, { kind: 'review', number: pull.number, state: review.state })
    }
    return result
  }

  get #signature() { return this.#config.signature ?? DEFAULT_SIGNATURE }

  /**
   * The agent's own messages: written as its account and carrying its signature line. The account may be a person's own,
   * so that person's unsigned messages stay theirs.
   */
  #own(user: GhUser, text: string): boolean {
    return user.login.toLowerCase() === this.#config.account.toLowerCase() && text.split('\n').some(line => line.trim() === this.#signature.trim())
  }

  #trigger(id: string, ref: { source: string; id: string }, user: GhUser, text: string, at: string, url: string, address: Record<string, string>, meta: Record<string, unknown>): Trigger {
    const human = user.type !== 'Bot' && !user.login.endsWith('[bot]')
    const addressed = addressesAgent(text, this.#config.account, this.#command)
    return {
      id, source: this.id, threads: [ref], actor: { source: this.id, id: user.login }, human, ...addressed ? { addressed: 'mention' as const } : {},
      at, text, url, channel: { source: this.id, thread: ref.id, address }, meta,
    }
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    const body = `${this.#signature}\n\n${message.text}`
    const { number, reviewComment } = message.channel.address
    if (this.dryRun) {
      dryRunLog(this.id, `comment #${number}`, body)
      return { status: 'sent', url: `dry-run://github/${this.#config.repo}/${number}` }
    }
    const [owner, name] = this.#config.repo.split('/')
    const url = reviewComment
      ? `${this.#api}/repos/${owner}/${name}/pulls/${number}/comments/${reviewComment}/replies`
      : `${this.#api}/repos/${owner}/${name}/issues/${number}/comments`
    try {
      const created = await http<{ html_url: string }>(url, { method: 'POST', headers: this.#headers(), body: { body } }, 'GitHub')
      return { status: 'sent', url: created.html_url }
    } catch (error) {
      // A deleted Issue answers 410 and a locked conversation 403 with a lock message: it can never receive the message.
      if (error instanceof HttpError && (error.status === 410 || (error.status === 403 && /lock/i.test(error.body)))) return { status: 'gone' }
      throw error
    }
  }

  async openPullRequest(proposal: PullRequestProposal): Promise<PullRequestResult> {
    const [owner, name] = this.#config.repo.split('/')
    if (this.dryRun) {
      const number = randomInt(1000, 9999)
      dryRunLog(this.id, `pull request ${proposal.branch} -> ${proposal.base}`, proposal.title)
      return { ref: { source: this.id, id: `pull:${number}` }, number, url: `dry-run://github/${this.#config.repo}/pull/${number}` }
    }
    const remote = this.#config.gitUrl ?? `https://github.com/${owner}/${name}.git`
    await pushBranch(proposal.directory, remote, proposal.branch, `x-access-token:${this.#token}`)
    const create = (draft: boolean) => http<{ number: number; html_url: string }>(`${this.#api}/repos/${owner}/${name}/pulls`, {
      method: 'POST', headers: this.#headers(),
      body: { title: proposal.title, head: proposal.branch, base: proposal.base, body: `${this.#signature}\n\n${proposal.body}`, draft },
    }, 'GitHub')
    // Private repositories on free plans refuse draft pull requests; the pull request then opens as ready for review.
    const pull = await create(true).catch(error => {
      if (error instanceof HttpError && error.status === 422 && /draft/i.test(error.body)) return create(false)
      throw error
    })
    return { ref: { source: this.id, id: `pull:${pull.number}` }, number: pull.number, url: pull.html_url }
  }

  #headers(): Record<string, string> {
    return { authorization: `Bearer ${this.#token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'oh-my-superagent' }
  }

  simulate(input: SimulateInput): WebhookRequest {
    const number = input.number ?? 1
    const user = { login: input.user, type: input.bot ? 'Bot' : 'User' }
    const at = new Date().toISOString()
    const id = randomInt(1, 2 ** 31)
    const repository = { full_name: this.#config.repo }
    const issue = { id: number * 1000 + 7, number, title: input.title ?? `Issue ${number}`, body: input.text ?? '', html_url: `https://github.com/${this.#config.repo}/issues/${number}`, user, created_at: at }
    let event: string, payload: GhPayload
    if (input.event === 'issue') [event, payload] = ['issues', { action: 'opened', repository, issue }]
    else if (input.event === 'comment') {
      [event, payload] = ['issue_comment', { action: 'created', repository, issue: { ...issue, body: '' },
        comment: { id, body: input.text ?? '', html_url: `${issue.html_url}#issuecomment-${id}`, user, created_at: at } }]
    } else {
      [event, payload] = ['pull_request', { action: 'closed', repository,
        pull_request: { ...issue, html_url: `https://github.com/${this.#config.repo}/pull/${number}`, merged: input.event === 'pr_merged', head: { ref: 'x' }, base: { ref: 'main' } } }]
    }
    const body = JSON.stringify(payload)
    const secret = this.#secret
    return { headers: { 'x-github-event': event, 'x-github-delivery': String(id), ...secret ? { 'x-hub-signature-256': `sha256=${hmacSha256(secret, body)}` } : {} }, body }
  }

  environment() {
    return {
      SUPERAGENT_GITHUB_REPOSITORY: { value: this.#config.repo, description: 'The GitHub repository the Source watches, owner/name' },
      SUPERAGENT_GITHUB_ACCOUNT: { value: this.#config.account, description: 'The agent account on GitHub' },
    }
  }

  facts() {
    return { repo: this.#config.repo, account: this.#config.account, command: this.#command, dryRun: this.dryRun, receiveAll: this.receiveAll,
      token: this.#token ? 'set' : 'missing', webhookSecret: this.#secret ? 'set' : 'missing' }
  }
}
