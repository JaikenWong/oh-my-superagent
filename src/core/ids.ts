import { createHash } from 'node:crypto'

/** Id derived from its inputs: equal inputs give equal ids, which makes accepting a Trigger twice create one Ticket. */
export function key(prefix: string, ...parts: unknown[]): string {
  return `${prefix}-${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 12)}`
}

/** A short ASCII name for directories and branches; non-ASCII titles fall back to `fallback`. */
export function slug(text: string, fallback = 'ticket', max = 32): string {
  const value = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '')
  return value || fallback
}
