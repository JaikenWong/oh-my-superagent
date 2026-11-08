/**
 * The Outbox: the only path for external writes. A message's receipt is stored with its `reply` effect in the caller's
 * transaction. In `review` mode a message starts as a draft that a person approves, edits or rejects in the panel.
 * A Ticket's messages to one conversation go out in the order they were queued.
 *
 * Status machine (design §11): draft → pending → sending → sent | failed | unknown; dropped terminal.
 */
import { UserError } from '../core/errors.ts'
import type { Outbox, OutgoingMessage } from '../core/ports.ts'
import type { Effects } from './effects.ts'
import type { Store } from './store.ts'

export type ReceiptStatus = 'draft' | 'pending' | 'sending' | 'sent' | 'failed' | 'unknown' | 'dropped'
export interface Receipt extends OutgoingMessage {
  status: ReceiptStatus
  attempts: number
  createdAt: string
  idempotencyKey: string
  edited?: true
  sentAt?: string
  /** What the Source answered, such as the comment or pull request it created. */
  result?: { url?: string; number?: number }
  dropped?: { at: string; reason: string }
  error?: string
}

const conversation = (message: OutgoingMessage) => `${message.channel.source}:${message.channel.thread}`

export class OutboxStore implements Outbox {
  readonly #store: Store
  readonly #effects: Effects
  readonly #review: () => boolean

  constructor(store: Store, effects: Effects, review: () => boolean) {
    this.#store = store
    this.#effects = effects
    this.#review = review
  }

  /**
   * Stores a message once by its id; a repeated id queues nothing. `approved` marks a message that follows from an action
   * a person already approved, such as the link to the pull request they let open.
   */
  send(message: OutgoingMessage, approved = false): void {
    if (this.get(message.id)) return
    const idempotencyKey = message.idempotencyKey ?? message.id
    const receipt: Receipt = {
      ...message, idempotencyKey,
      status: this.#review() && !approved ? 'draft' : 'pending',
      attempts: 0, createdAt: new Date().toISOString(),
    }
    const seq = this.#store.count('SELECT coalesce(max(seq), 0) + 1 AS n FROM outbox')
    this.#store.run('INSERT INTO outbox (id, seq, ticket, conversation, status, json) VALUES (?, ?, ?, ?, ?, ?)',
      receipt.id, seq, receipt.ticketId ?? null, conversation(receipt), receipt.status, JSON.stringify(receipt))
    this.#store.events.append(receipt.status === 'draft' ? 'outbox.drafted' : 'outbox.queued',
      { messageId: receipt.id, ticketId: receipt.ticketId, purpose: receipt.purpose, threadKey: conversation(receipt), idempotencyKey })
    if (receipt.status === 'pending') this.#effects.enqueue('reply', receipt.id)
  }

  get(id: string): Receipt | undefined {
    const row = this.#store.one<{ json: string }>('SELECT json FROM outbox WHERE id = ?', id)
    return row ? JSON.parse(row.json) as Receipt : undefined
  }
  list(status?: ReceiptStatus, ticketId?: string): Receipt[] {
    const where = [status ? 'status = ?' : '', ticketId ? 'ticket = ?' : ''].filter(Boolean)
    const params = [status, ticketId].filter((value): value is string => !!value)
    return this.#store.all<{ json: string }>(`SELECT json FROM outbox ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT 200`, ...params)
      .map(row => JSON.parse(row.json) as Receipt)
  }
  forConversation(key: string): Receipt[] {
    return this.#store.all<{ json: string }>('SELECT json FROM outbox WHERE conversation = ? ORDER BY seq', key).map(row => JSON.parse(row.json) as Receipt)
  }
  save(receipt: Receipt): void {
    this.#store.run('UPDATE outbox SET status = ?, attempts = ?, json = ? WHERE id = ?', receipt.status, receipt.attempts, JSON.stringify(receipt), receipt.id)
  }

  /** Marks in-flight delivery; crash while sending becomes `unknown` on recover. */
  markSending(id: string): Receipt | undefined {
    const receipt = this.get(id)
    if (!receipt || receipt.status !== 'pending') return undefined
    receipt.status = 'sending'
    this.save(receipt)
    this.#store.events.append('outbox.sending', { messageId: id, ticketId: receipt.ticketId, idempotencyKey: receipt.idempotencyKey })
    return receipt
  }

  /** Host restart found a message mid-flight: external outcome may already exist. */
  markUnknown(receipt: Receipt, reason: string): void {
    receipt.status = 'unknown'
    receipt.error = reason.slice(0, 500)
    this.save(receipt)
    this.#store.events.append('outbox.unknown', { messageId: receipt.id, ticketId: receipt.ticketId, reason: receipt.error })
  }

  /** Startup: any `sending` row becomes `unknown` (INV: do not blind-retry side effects). */
  recoverInFlight(): number {
    let n = 0
    for (const receipt of this.list('sending')) {
      this.markUnknown(receipt, 'host restarted while sending; confirm on Source before retry')
      n++
    }
    return n
  }

  /** A person approves a draft, optionally with their edit; it is then sent as stored work. */
  approve(id: string, text?: string): Receipt {
    return this.#store.atomic(() => {
      const receipt = this.get(id)
      if (!receipt) throw new UserError('missing', { message: id })
      if (receipt.status !== 'draft') throw new UserError('notDraft', { message: id })
      if (text !== undefined && text.trim() && text !== receipt.text) { receipt.text = text; receipt.edited = true }
      receipt.status = 'pending'
      this.save(receipt)
      this.#store.events.append('outbox.approved', { messageId: id, ticketId: receipt.ticketId, edited: !!receipt.edited })
      this.#effects.enqueue('reply', id)
      return receipt
    })
  }

  /** A person rejects a draft: it is dropped and never queued again. */
  reject(id: string, reason = 'rejected'): Receipt {
    return this.#store.atomic(() => {
      const receipt = this.get(id)
      if (!receipt) throw new UserError('missing', { message: id })
      if (receipt.status !== 'draft') throw new UserError('notDraft', { message: id })
      this.drop(receipt, reason)
      return receipt
    })
  }

  withdrawDrafts(ticketId: string, reason: string): void {
    for (const receipt of this.list('draft', ticketId)) this.drop(receipt, reason)
  }

  drop(receipt: Receipt, reason: string): void {
    receipt.status = 'dropped'
    receipt.dropped = { at: new Date().toISOString(), reason }
    this.save(receipt)
    this.#store.events.append('outbox.dropped', { messageId: receipt.id, ticketId: receipt.ticketId, reason })
  }

  /**
   * An earlier message of the same Ticket to the same conversation has not finished (draft/pending/sending)
   * and has not failed three times.
   */
  behind(receipt: Receipt): boolean {
    if (!receipt.ticketId) return false
    return this.#store.count(
      "SELECT count(*) AS n FROM outbox WHERE ticket = ? AND conversation = ? AND seq < (SELECT seq FROM outbox WHERE id = ?) AND status IN ('draft', 'pending', 'sending') AND attempts < 3",
      receipt.ticketId, conversation(receipt), receipt.id,
    ) > 0
  }
}
