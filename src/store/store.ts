/**
 * One SQLite file. Aggregates are stored as JSON with indexed columns for the working sets a pass reads; the event log is
 * append-only. Effects and Outbox receipts live in the same database, so a command and the work it queues commit together.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { Decision, Disposition, Thread, Ticket, Trigger } from '../core/model.ts'
import type { Repositories } from '../core/ports.ts'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trigger (id TEXT PRIMARY KEY, at TEXT NOT NULL, json TEXT NOT NULL, disposition TEXT);
CREATE TABLE IF NOT EXISTS trigger_thread (thread TEXT NOT NULL, at TEXT NOT NULL, trigger_id TEXT NOT NULL, PRIMARY KEY (thread, trigger_id));
CREATE INDEX IF NOT EXISTS trigger_thread_at ON trigger_thread (thread, at);
CREATE TABLE IF NOT EXISTS thread (key TEXT PRIMARY KEY, json TEXT NOT NULL, active INTEGER NOT NULL, last_at TEXT);
CREATE INDEX IF NOT EXISTS thread_active ON thread (active) WHERE active = 1;
CREATE TABLE IF NOT EXISTS ticket (id TEXT PRIMARY KEY, json TEXT NOT NULL, open INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ticket_open ON ticket (open) WHERE open = 1;
CREATE TABLE IF NOT EXISTS decision (id TEXT PRIMARY KEY, thread TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS decision_thread ON decision (thread);
CREATE TABLE IF NOT EXISTS event (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT NOT NULL, ticket TEXT, thread TEXT, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS event_ticket ON event (ticket);
CREATE TABLE IF NOT EXISTS effect (kind TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, seq INTEGER NOT NULL, version INTEGER NOT NULL,
  due TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, PRIMARY KEY (kind, key));
CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, ticket TEXT, conversation TEXT NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS outbox_status ON outbox (status);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, json TEXT NOT NULL);
`

type Row = Record<string, SQLInputValue>
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T

export class Store implements Repositories {
  readonly db: DatabaseSync
  #depth = 0
  #after: (() => void)[] = []

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA)
  }

  close(): void { this.db.close() }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...params) as T[] }
  one<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined { return this.db.prepare(sql).get(...params) as T | undefined }
  run(sql: string, ...params: SQLInputValue[]): void { this.db.prepare(sql).run(...params) }

  atomic<T>(fn: () => T): T {
    const outer = this.#depth === 0
    const savepoint = `sp${this.#depth}`
    const mark = this.#after.length
    this.db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
    this.#depth++
    let result: T
    try {
      result = fn()
    } catch (error) {
      this.#depth--
      this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`)
      this.#after.length = mark
      throw error
    }
    this.#depth--
    this.db.exec(outer ? 'COMMIT' : `RELEASE ${savepoint}`)
    if (outer) {
      const after = this.#after
      this.#after = []
      for (const fn of after) {
        try { fn() } catch (error) { console.error('afterCommit failed', error) }
      }
    }
    return result
  }

  afterCommit(fn: () => void): void {
    if (this.#depth === 0) fn()
    else this.#after.push(fn)
  }

  readonly triggers: Repositories['triggers'] = {
    get: id => { const row = this.one('SELECT json FROM trigger WHERE id = ?', id); return row ? parse<Trigger>(row.json) : undefined },
    save: trigger => {
      this.run('INSERT INTO trigger (id, at, json) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json', trigger.id, trigger.at, JSON.stringify(trigger))
      for (const ref of trigger.threads) {
        this.run('INSERT OR IGNORE INTO trigger_thread (thread, at, trigger_id) VALUES (?, ?, ?)', `${ref.source}:${ref.id}`, trigger.at, trigger.id)
      }
    },
    disposition: id => { const row = this.one('SELECT disposition FROM trigger WHERE id = ?', id); return row?.disposition ? parse<Disposition>(row.disposition) : undefined },
    saveDisposition: (id, disposition) => this.run('UPDATE trigger SET disposition = ? WHERE id = ?', JSON.stringify(disposition), id),
    onThread: (key, limit = 200) => this.all<{ json: string }>(
      'SELECT t.json FROM trigger_thread tt JOIN trigger t ON t.id = tt.trigger_id WHERE tt.thread = ? ORDER BY tt.at, tt.trigger_id LIMIT ?', key, limit,
    ).map(row => parse<Trigger>(row.json)),
  }

  readonly threads: Repositories['threads'] = {
    get: key => { const row = this.one('SELECT json FROM thread WHERE key = ?', key); return row ? parse<Thread>(row.json) : undefined },
    save: thread => this.run(
      'INSERT INTO thread (key, json, active, last_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET json = excluded.json, active = excluded.active, last_at = excluded.last_at',
      thread.key, JSON.stringify(thread), thread.pending.length || thread.evaluating ? 1 : 0, thread.lastAt ?? null,
    ),
    active: () => this.all<{ json: string }>('SELECT json FROM thread WHERE active = 1 ORDER BY key').map(row => parse<Thread>(row.json)),
  }

  readonly tickets: Repositories['tickets'] = {
    get: id => { const row = this.one('SELECT json FROM ticket WHERE id = ?', id); return row ? parse<Ticket>(row.json) : undefined },
    save: ticket => this.run(
      'INSERT INTO ticket (id, json, open, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json, open = excluded.open, updated_at = excluded.updated_at',
      ticket.id, JSON.stringify(ticket), ticket.ended ? 0 : 1, ticket.createdAt, ticket.updatedAt,
    ),
    open: () => this.all<{ json: string }>('SELECT json FROM ticket WHERE open = 1 ORDER BY created_at').map(row => parse<Ticket>(row.json)),
  }

  readonly decisions: Repositories['decisions'] = {
    get: id => { const row = this.one('SELECT json FROM decision WHERE id = ?', id); return row ? parse<Decision>(row.json) : undefined },
    save: decision => this.run(
      'INSERT INTO decision (id, thread, at, kind, json) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json',
      decision.id, decision.threadKey, decision.at, decision.kind, JSON.stringify(decision),
    ),
    onThread: key => this.all<{ json: string }>('SELECT json FROM decision WHERE thread = ? ORDER BY at', key).map(row => parse<Decision>(row.json)),
  }

  readonly events: Repositories['events'] = {
    append: (type, data) => {
      const ticket = typeof data.ticketId === 'string' ? data.ticketId : null
      const thread = typeof data.threadKey === 'string' ? data.threadKey : null
      this.run('INSERT INTO event (at, type, ticket, thread, json) VALUES (?, ?, ?, ?, ?)', new Date().toISOString(), type, ticket, thread, JSON.stringify(data))
    },
  }

  kv<T>(key: string): T | undefined { const row = this.one('SELECT json FROM kv WHERE key = ?', key); return row ? parse<T>(row.json) : undefined }
  setKv(key: string, value: unknown): void {
    this.run('INSERT INTO kv (key, json) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET json = excluded.json', key, JSON.stringify(value))
  }

  // Read queries for views; they never write.
  allTickets(limit = 200): Ticket[] {
    return this.all<{ json: string }>('SELECT json FROM ticket ORDER BY open DESC, updated_at DESC LIMIT ?', limit).map(row => parse<Ticket>(row.json))
  }
  recentThreads(limit = 100): Thread[] {
    return this.all<{ json: string }>('SELECT json FROM thread ORDER BY last_at DESC LIMIT ?', limit).map(row => parse<Thread>(row.json))
  }
  recentDecisions(limit = 100, since?: string): Decision[] {
    return (since
      ? this.all<{ json: string }>('SELECT json FROM decision WHERE at >= ? ORDER BY at DESC LIMIT ?', since, limit)
      : this.all<{ json: string }>('SELECT json FROM decision ORDER BY at DESC LIMIT ?', limit)).map(row => parse<Decision>(row.json))
  }
  eventsFor(column: 'ticket' | 'thread', value: string, limit = 200): { seq: number; at: string; type: string; data: Record<string, unknown> }[] {
    return this.all<{ seq: number; at: string; type: string; json: string }>(
      `SELECT seq, at, type, json FROM event WHERE ${column} = ? ORDER BY seq DESC LIMIT ?`, value, limit,
    ).map(row => ({ seq: row.seq, at: row.at, type: row.type, data: parse(row.json) }))
  }
  recentEvents(limit = 200, after = 0): { seq: number; at: string; type: string; data: Record<string, unknown> }[] {
    return this.all<{ seq: number; at: string; type: string; json: string }>(
      'SELECT seq, at, type, json FROM event WHERE seq > ? ORDER BY seq DESC LIMIT ?', after, limit,
    ).map(row => ({ seq: row.seq, at: row.at, type: row.type, data: parse(row.json) }))
  }
  count(sql: string, ...params: SQLInputValue[]): number { return Number(this.one<{ n: number }>(sql, ...params)?.n ?? 0) }
}
