/**
 * Feishu (Lark) IM: event subscription v2 `im.message.receive_v1`. A topic is a Thread (`chat:<chat>:<root>`); replies go
 * under the message they answer, in its topic. Chat messages are short by rule: the Source enforces a hard length limit.
 */
import { randomUUID } from 'node:crypto'
import type { Trigger } from '../core/model.ts'
import type { OutgoingMessage } from '../core/ports.ts'
import { addressesAgent, dryRunLog, http, HttpError, safeEqual, secretFrom } from './common.ts'
import type { SendResult, SimulateInput, SourceConfigBase, SourceKind, WebhookRequest, WebhookResult } from './kind.ts'

export interface FeishuConfig extends SourceConfigBase {
  kind: 'feishu'
  /** The bot's open_id, which mentions of the agent carry; read from the bot's info at start when omitted. */
  botOpenId?: string
  command?: string
  /** Chats the Source listens to; empty listens to every chat the bot is in. */
  chats?: string[]
  baseUrl?: string
  appIdEnv?: string
  appSecretEnv?: string
  verificationTokenEnv?: string
  /** Hard limit of a chat message, in characters. */
  maxChars?: number
}

interface FeishuEvent {
  type?: string
  challenge?: string
  token?: string
  encrypt?: string
  schema?: string
  header?: { event_id: string; event_type: string; token: string; create_time: string }
  event?: {
    sender: { sender_id: { open_id: string }; sender_type: string }
    message: {
      message_id: string; root_id?: string; parent_id?: string; chat_id: string; chat_type: 'p2p' | 'group'; message_type: string; content: string
      mentions?: { key: string; id: { open_id: string }; name: string }[]
    }
  }
}

/** Feishu error codes for a message that was recalled or no longer exists. */
const GONE_CODES = new Set([230011, 231003, 230002])

export class FeishuSource implements SourceKind {
  readonly id: string
  readonly kind = 'feishu' as const
  readonly enabled: boolean
  readonly receiveAll: boolean
  readonly dryRun: boolean
  readonly #config: FeishuConfig
  #token?: { value: string; until: number }
  #bot: string

  constructor(id: string, config: FeishuConfig) {
    this.id = id
    this.#config = config
    this.#bot = config.botOpenId ?? (config.dryRun ? 'ou_bot' : '')
    this.enabled = config.enabled ?? true
    this.receiveAll = config.receiveAll ?? false
    this.dryRun = config.dryRun ?? false
  }

  get #base() { return this.#config.baseUrl ?? 'https://open.feishu.cn' }
  get #verification() { return secretFrom(this.#config.verificationTokenEnv ?? 'FEISHU_VERIFICATION_TOKEN') }

  verify(request: WebhookRequest): boolean {
    const payload = JSON.parse(request.body) as FeishuEvent
    const expected = this.#verification
    if (!expected) return this.dryRun
    return safeEqual(payload.header?.token ?? payload.token ?? '', expected)
  }

  parse(request: WebhookRequest): WebhookResult {
    const payload = JSON.parse(request.body) as FeishuEvent
    if (payload.encrypt) return { response: { status: 400, body: { error: 'Encrypted events are not supported; clear the Encrypt Key in the Feishu console.' } }, triggers: [] }
    if (payload.type === 'url_verification') return { response: { status: 200, body: { challenge: payload.challenge } }, triggers: [] }
    if (payload.header?.event_type !== 'im.message.receive_v1' || !payload.event) return { triggers: [] }
    const { sender, message } = payload.event
    // The bot's own messages never enter the domain.
    if (sender.sender_id.open_id === this.#bot) return { triggers: [] }
    if (this.#config.chats?.length && message.chat_type === 'group' && !this.#config.chats.includes(message.chat_id)) return { triggers: [] }
    const text = this.#text(message)
    const mentioned = message.mentions?.some(item => item.id.open_id === this.#bot) ?? false
    const addressed = message.chat_type === 'p2p' ? 'direct' as const
      : mentioned || addressesAgent(text, undefined, this.#config.command ?? '/agent') ? 'mention' as const : undefined
    const root = message.root_id || message.message_id
    const ref = { source: this.id, id: `chat:${message.chat_id}:${root}` }
    const trigger: Trigger = {
      id: `feishu:${message.message_id}`, source: this.id, threads: [ref], actor: { source: this.id, id: sender.sender_id.open_id },
      human: sender.sender_type === 'user', ...addressed ? { addressed } : {}, at: new Date(Number(payload.header.create_time)).toISOString(), text,
      channel: { source: this.id, thread: ref.id, address: { message_id: message.message_id, chat_id: message.chat_id } },
      meta: { chat: message.chat_id, chatType: message.chat_type, messageType: message.message_type, ...message.parent_id ? { parent: message.parent_id } : {} },
    }
    return { triggers: [trigger], threads: [{ ref, meta: { label: `${message.chat_type === 'p2p' ? '私聊' : '话题'} ${text.slice(0, 40)}`, chat: message.chat_id } }] }
  }

  #text(message: NonNullable<FeishuEvent['event']>['message']): string {
    let text: string
    try {
      const content = JSON.parse(message.content) as { text?: string; title?: string }
      text = content.text ?? content.title ?? `[${message.message_type}]`
    } catch { text = `[${message.message_type}]` }
    for (const mention of message.mentions ?? []) {
      text = text.replaceAll(mention.key, mention.id.open_id === this.#bot ? '@agent' : `@${mention.name}`)
    }
    return text.trim()
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    const max = this.#config.maxChars ?? 300
    const text = message.text.length > max ? `${message.text.slice(0, max - 12)}…（详情见面板）` : message.text
    const target = message.channel.address.message_id
    if (this.dryRun) {
      dryRunLog(this.id, `reply ${target}`, text)
      return { status: 'sent' }
    }
    const answer = await http<{ code: number; msg: string; data?: { message_id: string } }>(`${this.#base}/open-apis/im/v1/messages/${target}/reply`, {
      method: 'POST', headers: { authorization: `Bearer ${await this.#tenantToken()}` },
      body: { msg_type: 'text', content: JSON.stringify({ text }), reply_in_thread: true, uuid: message.id.slice(0, 50) },
    }, 'Feishu').catch((error: unknown) => {
      if (error instanceof HttpError) {
        try { return JSON.parse(error.body) as { code: number; msg: string } } catch { /* not JSON */ }
      }
      throw error
    })
    if (answer.code === 0) return { status: 'sent' }
    if (GONE_CODES.has(answer.code)) return { status: 'gone' }
    throw new Error(`Feishu answered code ${answer.code}: ${answer.msg}`)
  }

  /** Reads the bot's open_id, without which mentions of the agent cannot be recognized. */
  async start(): Promise<void> {
    if (this.#bot || this.dryRun) return
    const answer = await http<{ code: number; msg: string; bot?: { open_id: string; app_name?: string } }>(`${this.#base}/open-apis/bot/v3/info`, {
      headers: { authorization: `Bearer ${await this.#tenantToken()}` },
    }, 'Feishu')
    if (answer.code !== 0 || !answer.bot?.open_id) throw new Error(`Feishu bot info: ${answer.msg}; is the bot capability enabled?`)
    this.#bot = answer.bot.open_id
    console.log(`feishu: bot ${answer.bot.app_name ?? ''} is ${this.#bot}`)
  }

  async #tenantToken(): Promise<string> {
    if (this.#token && this.#token.until > Date.now()) return this.#token.value
    const answer = await http<{ code: number; msg: string; tenant_access_token: string; expire: number }>(`${this.#base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST', body: { app_id: secretFrom(this.#config.appIdEnv ?? 'FEISHU_APP_ID'), app_secret: secretFrom(this.#config.appSecretEnv ?? 'FEISHU_APP_SECRET') },
    }, 'Feishu')
    if (answer.code !== 0) throw new Error(`Feishu token: ${answer.msg}`)
    this.#token = { value: answer.tenant_access_token, until: Date.now() + (answer.expire - 120) * 1000 }
    return this.#token.value
  }

  simulate(input: SimulateInput): WebhookRequest {
    const messageId = `om_${randomUUID().replaceAll('-', '').slice(0, 24)}`
    const mentions = /@agent\b/.test(input.text ?? '') ? [{ key: '@_user_1', id: { open_id: this.#bot }, name: 'agent' }] : []
    const text = (input.text ?? '').replace(/@agent\b/, '@_user_1')
    const payload: FeishuEvent = {
      schema: '2.0',
      header: { event_id: randomUUID(), event_type: 'im.message.receive_v1', token: this.#verification, create_time: String(Date.now()) },
      event: {
        sender: { sender_id: { open_id: input.user }, sender_type: input.bot ? 'app' : 'user' },
        message: { message_id: messageId, ...input.root ? { root_id: input.root } : {}, chat_id: input.chat ?? 'oc_demo', chat_type: input.direct ? 'p2p' : 'group',
          message_type: 'text', content: JSON.stringify({ text }), mentions },
      },
    }
    return { headers: {}, body: JSON.stringify(payload) }
  }

  environment() {
    return { SUPERAGENT_FEISHU_BOT: { value: this.#bot, description: 'The Feishu bot open_id' } }
  }

  facts() {
    return { botOpenId: this.#bot || 'missing', chats: this.#config.chats ?? [], dryRun: this.dryRun, receiveAll: this.receiveAll,
      app: secretFrom(this.#config.appIdEnv ?? 'FEISHU_APP_ID') ? 'set' : 'missing', verificationToken: this.#verification ? 'set' : 'missing' }
  }
}
