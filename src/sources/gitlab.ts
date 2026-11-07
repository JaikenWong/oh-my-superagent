/**
 * GitLab: webhooks of one project. Issues and merge requests are Threads (`issue:<iid>`, `mr:<iid>`); notes and new Issues
 * or merge requests are Triggers. A merged or closed merge request is a Thread close.
 */
import { randomInt } from 'node:crypto'
import type { Trigger } from '../core/model.ts'
import type { OutgoingMessage } from '../core/ports.ts'
import { addressesAgent, dryRunLog, http, HttpError, pushBranch, safeEqual, secretFrom } from './common.ts'
import { DEFAULT_SIGNATURE } from './common.ts'
import type { PullRequestProposal, PullRequestResult, SendResult, SimulateInput, SourceConfigBase, SourceKind, WebhookRequest, WebhookResult } from './kind.ts'

export interface GitlabConfig extends SourceConfigBase {
  kind: 'gitlab'
  /** `group/project`. */
  project: string
  account: string
  command?: string
  /** Defaults to https://gitlab.com. */
  baseUrl?: string
  tokenEnv?: string
  secretEnv?: string
  signature?: string
}

interface GlUser { username: string; name?: string; bot?: boolean }
interface GlPayload {
  object_kind?: string
  user?: GlUser
  project?: { path_with_namespace: string }
  object_attributes?: {
    id: number; iid?: number; title?: string; description?: string | null; note?: string; noteable_type?: string; action?: string
    url: string; created_at: string; source_branch?: string; target_branch?: string; discussion_id?: string; state?: string
  }
  issue?: { iid: number; title: string; url?: string }
  merge_request?: { iid: number; title: string; url?: string; source_branch?: string }
}

export class GitlabSource implements SourceKind {
  readonly id: string
  readonly kind = 'gitlab' as const
  readonly enabled: boolean
  readonly receiveAll: boolean
  readonly dryRun: boolean
  readonly #config: GitlabConfig

  constructor(id: string, config: GitlabConfig) {
    this.id = id
    this.#config = config
    this.enabled = config.enabled ?? true
    this.receiveAll = config.receiveAll ?? false
    this.dryRun = config.dryRun ?? false
  }

  get #base() { return (this.#config.baseUrl ?? 'https://gitlab.com').replace(/\/$/, '') }
  get #api() { return `${this.#base}/api/v4/projects/${encodeURIComponent(this.#config.project)}` }
  get #token() { return secretFrom(this.#config.tokenEnv ?? 'GITLAB_TOKEN') }
  get #secret() { return secretFrom(this.#config.secretEnv ?? 'GITLAB_WEBHOOK_SECRET') }
  get #command() { return this.#config.command ?? '/agent' }
  get #signature() { return this.#config.signature ?? DEFAULT_SIGNATURE }

  verify(request: WebhookRequest): boolean {
    const secret = this.#secret
    if (!secret) return this.dryRun
    return safeEqual(request.headers['x-gitlab-token'] ?? '', secret)
  }

  parse(request: WebhookRequest): WebhookResult {
    const payload = JSON.parse(request.body) as GlPayload
    if (payload.project?.path_with_namespace.toLowerCase() !== this.#config.project.toLowerCase()) return { triggers: [] }
    const attrs = payload.object_attributes
    const user = payload.user
    if (!attrs || !user) return { triggers: [] }
    const result: WebhookResult = { triggers: [], threads: [] }
    const thread = (kind: 'issue' | 'mr', iid: number, title: string, url?: string) => {
      const ref = { source: this.id, id: `${kind}:${iid}` }
      result.threads!.push({ ref, meta: { label: `${kind === 'mr' ? '!' : '#'}${iid} ${title}`, ...url ? { url } : {}, iid, kind } })
      return ref
    }
    const push = (id: string, ref: { source: string; id: string }, text: string, address: Record<string, string>, meta: Record<string, unknown>) => {
      // The agent's own messages carry its signature; the account may also be the operator's own.
      const signed = text.split('\n').some(line => line.trim() === this.#signature.trim())
      if (signed && user.username.toLowerCase() === this.#config.account.toLowerCase()) return
      result.triggers.push(this.#trigger(id, ref, user, text, attrs.created_at, attrs.url, address, meta))
    }
    if (payload.object_kind === 'issue' && attrs.action === 'open' && attrs.iid) {
      const ref = thread('issue', attrs.iid, attrs.title ?? '', attrs.url)
      push(`gitlab:issue:${attrs.id}`, ref, `${attrs.title ?? ''}\n\n${attrs.description ?? ''}`.trim(), { kind: 'issue', iid: String(attrs.iid) }, { kind: 'issue' })
    } else if (payload.object_kind === 'note' && attrs.note !== undefined) {
      const onMr = attrs.noteable_type === 'MergeRequest'
      const target = onMr ? payload.merge_request : payload.issue
      if (!target || !['Issue', 'MergeRequest'].includes(attrs.noteable_type ?? '')) return result
      const ref = thread(onMr ? 'mr' : 'issue', target.iid, target.title, target.url)
      push(`gitlab:note:${attrs.id}`, ref, attrs.note, { kind: onMr ? 'mr' : 'issue', iid: String(target.iid), ...attrs.discussion_id ? { discussion: attrs.discussion_id } : {} }, { kind: 'note' })
    } else if (payload.object_kind === 'merge_request' && attrs.iid) {
      const ref = thread('mr', attrs.iid, attrs.title ?? '', attrs.url)
      if (attrs.action === 'open') {
        result.opened = [{ ref, branch: attrs.source_branch ?? '', url: attrs.url }]
        push(`gitlab:mr:${attrs.id}`, ref, `${attrs.title ?? ''}\n\n${attrs.description ?? ''}`.trim(), { kind: 'mr', iid: String(attrs.iid) }, { kind: 'merge_request' })
      } else if (attrs.action === 'merge') result.closed = [{ ref, outcome: 'merged' }]
      else if (attrs.action === 'close') result.closed = [{ ref, outcome: 'closed' }]
    }
    return result
  }

  #trigger(id: string, ref: { source: string; id: string }, user: GlUser, text: string, at: string, url: string, address: Record<string, string>, meta: Record<string, unknown>): Trigger {
    // GitLab project and group access tokens act as users named `project_<id>_bot…` or `group_<id>_bot…`.
    const human = !user.bot && !/^(project|group)_\d+_bot/.test(user.username) && user.username !== 'ghost'
    const addressed = addressesAgent(text, this.#config.account, this.#command)
    return {
      id, source: this.id, threads: [ref], actor: { source: this.id, id: user.username, ...user.name ? { name: user.name } : {} }, human,
      ...addressed ? { addressed: 'mention' as const } : {}, at, text, url, channel: { source: this.id, thread: ref.id, address }, meta,
    }
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    const body = `${this.#signature}\n\n${message.text}`
    const { kind, iid, discussion } = message.channel.address
    if (this.dryRun) {
      dryRunLog(this.id, `note ${kind} ${iid}`, body)
      return { status: 'sent', url: `dry-run://gitlab/${this.#config.project}/${kind}/${iid}` }
    }
    const collection = kind === 'mr' ? 'merge_requests' : 'issues'
    const url = discussion ? `${this.#api}/${collection}/${iid}/discussions/${discussion}/notes` : `${this.#api}/${collection}/${iid}/notes`
    try {
      await http(url, { method: 'POST', headers: { 'private-token': this.#token }, body: { body } }, 'GitLab')
      return { status: 'sent' }
    } catch (error) {
      if (error instanceof HttpError && (error.status === 404 || error.status === 410) && /not found|gone/i.test(error.body)) return { status: 'gone' }
      throw error
    }
  }

  async openPullRequest(proposal: PullRequestProposal): Promise<PullRequestResult> {
    if (this.dryRun) {
      const iid = randomInt(100, 999)
      dryRunLog(this.id, `merge request ${proposal.branch} -> ${proposal.base}`, proposal.title)
      return { ref: { source: this.id, id: `mr:${iid}` }, number: iid, url: `dry-run://gitlab/${this.#config.project}/-/merge_requests/${iid}` }
    }
    await pushBranch(proposal.directory, `${this.#base}/${this.#config.project}.git`, proposal.branch, `oauth2:${this.#token}`)
    const mr = await http<{ iid: number; web_url: string }>(`${this.#api}/merge_requests`, {
      method: 'POST', headers: { 'private-token': this.#token },
      body: { source_branch: proposal.branch, target_branch: proposal.base, title: `Draft: ${proposal.title}`, description: `${this.#signature}\n\n${proposal.body}` },
    }, 'GitLab')
    return { ref: { source: this.id, id: `mr:${mr.iid}` }, number: mr.iid, url: mr.web_url }
  }

  simulate(input: SimulateInput): WebhookRequest {
    const iid = input.number ?? 1
    const id = randomInt(1, 2 ** 31)
    const at = new Date().toISOString()
    const project = { path_with_namespace: this.#config.project }
    const user = { username: input.user, ...input.bot ? { bot: true } : {} }
    const url = `${this.#base}/${this.#config.project}/-/issues/${iid}`
    let payload: GlPayload
    if (input.event === 'issue') {
      payload = { object_kind: 'issue', user, project, object_attributes: { id: iid * 1000 + 7, iid, title: input.title ?? `Issue ${iid}`, description: input.text ?? '', action: 'open', url, created_at: at } }
    } else if (input.event === 'comment') {
      payload = { object_kind: 'note', user, project, issue: { iid, title: input.title ?? `Issue ${iid}`, url },
        object_attributes: { id, note: input.text ?? '', noteable_type: 'Issue', url: `${url}#note_${id}`, created_at: at } }
    } else {
      payload = { object_kind: 'merge_request', user, project,
        object_attributes: { id, iid, title: input.title ?? '', action: input.event === 'pr_merged' ? 'merge' : 'close', url: `${this.#base}/${this.#config.project}/-/merge_requests/${iid}`, created_at: at } }
    }
    const secret = this.#secret
    return { headers: { 'x-gitlab-event': `${payload.object_kind} hook`, ...secret ? { 'x-gitlab-token': secret } : {} }, body: JSON.stringify(payload) }
  }

  environment() {
    return {
      SUPERAGENT_GITLAB_PROJECT: { value: this.#config.project, description: 'The GitLab project the Source watches, group/project' },
      SUPERAGENT_GITLAB_ACCOUNT: { value: this.#config.account, description: 'The agent account on GitLab' },
    }
  }

  facts() {
    return { project: this.#config.project, account: this.#config.account, baseUrl: this.#base, dryRun: this.dryRun, receiveAll: this.receiveAll,
      token: this.#token ? 'set' : 'missing', webhookSecret: this.#secret ? 'set' : 'missing' }
  }
}
