/**
 * The durable side-effect queue. A command enqueues inside its transaction; a handler runs only after commit. One row per
 * kind and key: enqueuing a waiting key again replaces its payload and makes it due, so repeated wakes coalesce.
 */
import type { Store } from './store.ts'

/** Thrown by a handler to defer work without counting a failure, such as when no worker slot is free. */
export class Later extends Error {
  readonly delayMs: number
  constructor(delayMs = 5000, reason = 'later') { super(reason); this.delayMs = delayMs }
}

export interface HandlerOptions {
  concurrency: number
  /** First retry delay; it doubles up to `maxMs`. */
  baseMs: number
  maxMs: number
  /** Held while processing is paused. */
  pausable?: boolean
}
type Handler = (key: string, payload: Record<string, unknown>) => Promise<void>
interface EffectRow { kind: string; key: string; payload: string; version: number; attempts: number; error: string | null; due: string }

export class Effects {
  readonly #store: Store
  readonly #paused: () => boolean
  readonly #handlers = new Map<string, { run: Handler; options: HandlerOptions }>()
  readonly #running = new Map<string, Promise<void>>()
  #timer?: NodeJS.Timeout
  #stopped = false

  constructor(store: Store, paused: () => boolean) {
    this.#store = store
    this.#paused = paused
  }

  enqueue(kind: string, key: string, payload: Record<string, unknown> = {}): void {
    const now = new Date().toISOString()
    const row = this.#store.one<{ version: number }>('SELECT version FROM effect WHERE kind = ? AND key = ?', kind, key)
    if (row) {
      this.#store.run('UPDATE effect SET payload = ?, version = ?, due = ? WHERE kind = ? AND key = ?', JSON.stringify(payload), row.version + 1, now, kind, key)
    } else {
      const seq = this.#store.count('SELECT coalesce(max(seq), 0) + 1 AS n FROM effect')
      this.#store.run('INSERT INTO effect (kind, key, payload, seq, version, due) VALUES (?, ?, ?, ?, 1, ?)', kind, key, JSON.stringify(payload), seq, now)
    }
    this.#store.afterCommit(() => this.poke())
  }

  handle(kind: string, run: Handler, options: HandlerOptions): void { this.#handlers.set(kind, { run, options }) }

  start(intervalMs = 1000): void {
    this.#stopped = false
    this.#timer = setInterval(() => this.tick(), intervalMs)
    this.tick()
  }

  /** Stops starting work and waits for running handlers; pending rows stay for the next start. */
  async drain(): Promise<void> {
    this.#stopped = true
    clearInterval(this.#timer)
    await Promise.allSettled([...this.#running.values()])
  }

  poke(): void { if (!this.#stopped) setImmediate(() => this.tick()) }

  /** Starts every due effect a free handler slot can take; does not wait for them. */
  tick(): void {
    if (this.#stopped) return
    const now = new Date().toISOString()
    for (const [kind, { options }] of this.#handlers) {
      if (options.pausable && this.#paused()) continue
      let free = options.concurrency - [...this.#running.keys()].filter(id => id.startsWith(`${kind}\0`)).length
      if (free <= 0) continue
      const rows = this.#store.all<EffectRow>('SELECT * FROM effect WHERE kind = ? AND due <= ? ORDER BY seq LIMIT 50', kind, now)
      for (const row of rows) {
        if (free <= 0) break
        const id = `${kind}\0${row.key}`
        if (this.#running.has(id)) continue
        free--
        const run = this.#run(row).finally(() => { this.#running.delete(id); this.poke() })
        this.#running.set(id, run)
      }
    }
  }

  /** Runs every due effect to completion, repeatedly, until none is due; for tests and scripts. */
  async settle(maxRounds = 50): Promise<void> {
    for (let round = 0; round < maxRounds; round++) {
      this.tick()
      if (!this.#running.size) return
      await Promise.allSettled([...this.#running.values()])
    }
  }

  async #run(row: EffectRow): Promise<void> {
    const handler = this.#handlers.get(row.kind)!
    try {
      await handler.run(row.key, JSON.parse(row.payload) as Record<string, unknown>)
      this.#store.run('DELETE FROM effect WHERE kind = ? AND key = ? AND version = ?', row.kind, row.key, row.version)
    } catch (error) {
      const at = Date.now()
      if (error instanceof Later) {
        this.#store.run('UPDATE effect SET due = ? WHERE kind = ? AND key = ? AND version = ?', new Date(at + error.delayMs).toISOString(), row.kind, row.key, row.version)
        return
      }
      const attempts = row.attempts + 1
      const delay = Math.min(handler.options.baseMs * 2 ** (attempts - 1), handler.options.maxMs)
      const message = error instanceof Error ? error.message : String(error)
      this.#store.run('UPDATE effect SET attempts = ?, error = ?, due = ? WHERE kind = ? AND key = ?',
        attempts, message.slice(0, 1000), new Date(at + delay).toISOString(), row.kind, row.key)
    }
  }

  /** Effects that failed three times in a row: the system problems the panel shows. */
  problems(): { kind: string; key: string; attempts: number; error: string | null; due: string }[] {
    return this.#store.all('SELECT kind, key, attempts, error, due FROM effect WHERE attempts >= 3 ORDER BY seq')
  }
  pending(): { kind: string; key: string; attempts: number; due: string }[] {
    return this.#store.all('SELECT kind, key, attempts, due FROM effect ORDER BY seq LIMIT 200')
  }
}
