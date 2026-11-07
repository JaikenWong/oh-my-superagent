/**
 * The Source protocol. A Source kind translates its native events into Triggers and Threads, drops the agent's own
 * messages, and writes to its Channels. It keeps its own words (comment, note, message) internally.
 */
import type { ThreadRef, Trigger } from '../core/model.ts'
import type { OutgoingMessage } from '../core/ports.ts'

export interface WebhookRequest { headers: Record<string, string | undefined>; body: string }
export interface WebhookResult {
  /** An answer the platform expects, such as Feishu's URL challenge. */
  response?: { status: number; body: unknown }
  triggers: Trigger[]
  threads?: { ref: ThreadRef; meta: Record<string, unknown> }[]
  /** Pull or merge requests opened from a branch, which the host binds to the Ticket whose branch it is. */
  opened?: { ref: ThreadRef; branch: string; url: string }[]
  closed?: { ref: ThreadRef; outcome: 'merged' | 'closed' }[]
}
/** `gone`: the conversation can never receive it, such as a deleted Issue or a recalled message. */
export interface SendResult { status: 'sent' | 'gone'; url?: string }
export interface PullRequestResult { ref: ThreadRef; url: string; number: number }
export type PullRequestProposal = NonNullable<OutgoingMessage['pullRequest']>

export interface SimulateInput {
  event: 'comment' | 'issue' | 'pr_merged' | 'pr_closed'
  number?: number
  user: string
  text?: string
  title?: string
  /** Feishu: the chat, the topic root and a direct message. */
  chat?: string
  root?: string
  direct?: boolean
  bot?: boolean
}

export interface ExecutionVariable { value: string; description: string }

export interface SourceKind {
  readonly id: string
  readonly kind: 'github' | 'gitlab' | 'feishu'
  readonly enabled: boolean
  /** Receives every message in its scope, not only those addressed to the agent. */
  readonly receiveAll: boolean
  /** Messages are logged instead of sent, and pull requests are not pushed. */
  readonly dryRun: boolean
  /** Reads what the Source needs from its platform before it receives, such as its own identity. */
  start?(): Promise<void>
  verify(request: WebhookRequest): boolean
  parse(request: WebhookRequest): WebhookResult
  send(message: OutgoingMessage): Promise<SendResult>
  openPullRequest?(proposal: PullRequestProposal): Promise<PullRequestResult>
  /** A signed native webhook request, so the panel's simulator takes the same path as the platform. */
  simulate(input: SimulateInput): WebhookRequest
  /** Execution variables for workers. None contains a credential. */
  environment(): Record<string, ExecutionVariable>
  /** Facts for the panel, without secrets. */
  facts(): Record<string, unknown>
}

export interface SourceConfigBase {
  kind: SourceKind['kind']
  enabled?: boolean
  receiveAll?: boolean
  dryRun?: boolean
}
