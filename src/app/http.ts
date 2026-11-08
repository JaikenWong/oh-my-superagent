/**
 * HTTP: the Sources' webhooks, the panel and its management API. The API answers only same-origin requests; refusals
 * a person can cause are 400 (404 for `missing`), each with its code.
 */
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { UserError } from '../core/errors.ts'
import type { SimulateInput } from '../sources/kind.ts'
import type { Runtime } from './runtime.ts'
import * as views from './views.ts'

const BODY_LIMIT = 2 * 1024 * 1024
const PANEL = new URL('../panel/index.html', import.meta.url)

type Handler = (runtime: Runtime, params: Record<string, string>, body: unknown, query: URLSearchParams) => unknown | Promise<unknown>
interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }
const routes: Route[] = []
function route(method: string, path: string, handler: Handler) {
  const keys: string[] = []
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, name: string) => { keys.push(name); return '([^/]+)' })}$`)
  routes.push({ method, pattern, keys, handler })
}
const text = (value: unknown) => typeof value === 'string' ? value : undefined
const field = (body: unknown, name: string) => text((body as Record<string, unknown> | undefined)?.[name])

route('GET', '/api/overview', runtime => views.overview(runtime))
route('GET', '/api/tickets', (runtime, _, __, query) => views.tickets(runtime, query.get('filter') ?? 'open'))
route('GET', '/api/tickets/:id', (runtime, { id }) => views.ticketDetail(runtime, id!) ?? missing('ticket'))
route('POST', '/api/tickets/:id/stop', (runtime, { id }, body) => { runtime.engine.stopTicket(id!, field(body, 'reason')); return { ok: true } })
route('POST', '/api/tickets/:id/retry', (runtime, { id }) => {
  runtime.engine.retryTicket(id!, runtime.settings.executor.maxRetries)
  return { ok: true }
})
route('POST', '/api/tickets/:id/input', (runtime, { id }, body) => {
  const value = field(body, 'text')?.trim()
  if (!value) throw new UserError('emptyText')
  runtime.engine.sendText(id!, value)
  return { ok: true }
})
route('GET', '/api/threads', (runtime, _, __, query) => views.threads(runtime, query.get('filter') ?? 'all'))
route('GET', '/api/threads/:key', (runtime, { key }) => views.threadDetail(runtime, key!) ?? missing('thread'))
route('GET', '/api/decisions', (runtime, _, __, query) => views.decisions(runtime, query.get('filter') ?? ''))
route('POST', '/api/decisions/:id/dismiss', (runtime, { id }) => { runtime.engine.dismiss(id!); return { ok: true } })
route('POST', '/api/triggers/:id/reevaluate', (runtime, { id }) => ({ queued: runtime.engine.reevaluate(id!) }))
route('GET', '/api/outbox', (runtime, _, __, query) => runtime.outbox.list((query.get('status') || undefined) as never))
route('POST', '/api/outbox/:id/approve', (runtime, { id }, body) => runtime.outbox.approve(id!, field(body, 'text')))
route('POST', '/api/outbox/:id/reject', (runtime, { id }) => {
  const receipt = runtime.outbox.reject(id!)
  if (receipt.purpose === 'pull_request' && receipt.ticketId) runtime.engine.proposalDeclined(receipt.ticketId)
  return receipt
})
route('GET', '/api/events', (runtime, _, __, query) => runtime.store.recentEvents(200, Number(query.get('after') ?? 0)))
route('GET', '/api/effects', runtime => runtime.effects.pending())
route('GET', '/api/artifact', (runtime, _, __, query) => views.artifact(runtime, query.get('path') ?? '') ?? missing('artifact'))
route('GET', '/api/settings', runtime => ({ value: runtime.settings, version: runtime.policyVersion, history: runtime.settingsHistory() }))
route('PUT', '/api/settings', (runtime, _, body) => {
  try { return runtime.saveSettings(body, 'panel') } catch (error) { throw new UserError('invalidSettings', { message: (error as Error).message }) }
})
route('POST', '/api/policy/allow', (runtime, _, body) => {
  const source = field(body, 'source'), id = field(body, 'id')
  if (!source || !id) throw new UserError('missingField')
  runtime.allow(source, id, field(body, 'name'))
  return { ok: true }
})
route('POST', '/api/pause', (runtime, _, body) => { runtime.pause((body as { paused?: boolean })?.paused === true); return { paused: runtime.settings.paused } })
route('POST', '/api/watchdog/tick', async runtime => ({ actions: await runtime.watchdog.tick() }))
route('GET', '/api/watchdog', runtime => ({ actions: runtime.watchdog.actions.slice(-40).reverse() }))
route('GET', '/api/router', runtime => ({ log: runtime.router.session.recentLog, inbox: runtime.store.kv('router:inbox') ?? [] }))
route('POST', '/api/simulate/:source', (runtime, { source }, body) => runtime.simulate(source!, body as SimulateInput))

function missing(what: string): never { throw new UserError('missing', { what }) }

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_LIMIT) { reject(new UserError('bodyTooLarge')); request.destroy() } else chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function send(response: ServerResponse, status: number, body: unknown, type = 'application/json') {
  response.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' })
  response.end(type === 'application/json' ? JSON.stringify(body) : String(body))
}

/** A browser on another site must not drive the API: writes need a same-origin request. */
function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  return !origin || origin === `http://${request.headers.host}`
}

/** Answers a Source's webhook; false when the request is not one. */
async function webhook(runtime: Runtime, request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
  const match = pathname.match(/^\/webhooks\/([a-z][a-z0-9-]*)$/)
  if (!match || request.method !== 'POST') return false
  const body = await readBody(request)
  const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, Array.isArray(value) ? value[0] : value]))
  const result = runtime.ingest(match[1]!, { headers, body })
  send(response, result.status, result.body)
  return true
}

/** A server that answers only webhooks: the one port a tunnel or reverse proxy may expose. */
export function createWebhookHttp(runtime: Runtime): Server {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://local')
    try {
      if (await webhook(runtime, request, response, url.pathname)) return
      send(response, url.pathname === '/healthz' ? 200 : 404, url.pathname === '/healthz' ? { ok: true } : { error: 'not found' })
    } catch (error) {
      if (error instanceof UserError) return send(response, 400, { error: error.code })
      console.error(error)
      send(response, 500, { error: 'internal' })
    }
  })
}

export function createHttp(runtime: Runtime): Server {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://local')
    try {
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(response, 200, readFileSync(PANEL, 'utf8'), 'text/html')
      if (await webhook(runtime, request, response, url.pathname)) return
      if (!url.pathname.startsWith('/api/')) return send(response, 404, { error: 'not found' })
      if (request.method !== 'GET' && !sameOrigin(request)) return send(response, 403, { error: 'cross-origin request refused' })
      for (const item of routes) {
        if (item.method !== request.method) continue
        const match = url.pathname.match(item.pattern)
        if (!match) continue
        const params = Object.fromEntries(item.keys.map((name, index) => [name, decodeURIComponent(match[index + 1]!)]))
        const raw = request.method === 'GET' ? '' : await readBody(request)
        const body = raw ? JSON.parse(raw) : undefined
        const result = await item.handler(runtime, params, body, url.searchParams)
        if (typeof result === 'string') return send(response, 200, result, 'text/plain')
        return send(response, 200, result ?? { ok: true })
      }
      send(response, 404, { error: 'not found' })
    } catch (error) {
      if (error instanceof UserError) return send(response, error.code === 'missing' ? 404 : 400, { error: error.code, values: error.values })
      if (error instanceof SyntaxError) return send(response, 400, { error: 'invalidJson' })
      console.error(error)
      send(response, 500, { error: 'internal', message: error instanceof Error ? error.message : String(error) })
    }
  })
}
