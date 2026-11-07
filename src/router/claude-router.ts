/**
 * Crude real Main Session: one or two `claude -p` turns, no coding tools.
 * Model returns a JSON `actions` list; the host runs orchestrator_* tools. On failure, falls back to mock.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { candidateCard, followupRelay, reportRelay } from '../app/notices.ts'
import { key } from '../core/ids.ts'
import type { Settings } from '../policy.ts'
import { type InboxItem, runMockRouterTurn } from './mock-router.ts'
import { listTools, runTool, type ToolHost } from './tools.ts'

const SYSTEM = readFileSync(new URL('../../prompts/router.md', import.meta.url), 'utf8')
const SESSION_KEY = 'router:claude-session'
const MAX_ROUNDS = 2
const TIMEOUT_MS = 180_000

interface Action { tool: string; args?: Record<string, unknown> }

export async function runClaudeRouterTurn(
  host: ToolHost,
  settings: Settings,
  items: InboxItem[],
  note: (line: string) => void,
): Promise<void> {
  try {
    const sessionId = sessionOf(host)
    let resume = host.store.kv<boolean>('router:claude-resumable') === true
    let followUp = ''
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const user = round === 0 ? buildUserMessage(host, settings, items) : followUp
      note(`claude round ${round + 1} (${items.length} inbox item(s))`)
      const text = await callClaude({ sessionId, resume, user, extraArgs: settings.executor.agentArgs })
      host.store.setKv('router:claude-resumable', true)
      resume = true
      const actions = parseActions(text)
      if (!actions.length) throw new Error('claude returned no actions JSON')
      const results: { tool: string; result: unknown }[] = []
      for (const action of actions) {
        const args = action.args ?? {}
        const result = runTool(host, action.tool, args)
        results.push({ tool: action.tool, result })
        note(`tool ${action.tool} → ${summarize(result)}`)
        // Ticket id is only known after accept; speak acknowledgement here so the model need not guess ids.
        if (action.tool === 'orchestrator_eval_decide' && args.kind === 'accept') {
          const ticketId = (result as { decision?: { ticketId?: string } }).decision?.ticketId
          const ack = typeof args.acknowledgement === 'string' ? args.acknowledgement.trim() : ''
          if (ticketId && ack) {
            const spoken = runTool(host, 'orchestrator_reply', {
              ticket_id: ticketId, purpose: 'acknowledgement', text: ack,
              reply_to: args.trigger_id, id: key('msg', ticketId, 'ack'),
            })
            results.push({ tool: 'orchestrator_reply', result: spoken })
            note(`tool orchestrator_reply (ack) → ${summarize(spoken)}`)
          }
        }
      }
      if (round + 1 >= MAX_ROUNDS || !needsAnotherRound(results)) return
      followUp = [
        'Tool results from your last actions. Call more tools if needed (e.g. orchestrator_reply with the new ticket_id), or return {"actions":[]} to stop.',
        '```json',
        JSON.stringify({ results }, null, 2).slice(0, 12_000),
        '```',
      ].join('\n')
    }
  } catch (error) {
    note(`claude router failed, fallback mock: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300))
    await runMockRouterTurn(host, settings, items)
  }
}

function sessionOf(host: ToolHost): string {
  const existing = host.store.kv<string>(SESSION_KEY)
  if (existing) return existing
  const id = randomUUID()
  host.store.setKv(SESSION_KEY, id)
  return id
}

function buildUserMessage(host: ToolHost, settings: Settings, items: InboxItem[]): string {
  const tools = listTools().map(tool => `- ${tool.name}: ${tool.description}`).join('\n')
  const cards = items.map(item => formatItem(host, item)).join('\n\n---\n\n')
  return [
    SYSTEM,
    '',
    `## Host policy`,
    `accept mode: ${settings.policy.mode}`,
    `outbound: ${settings.outbound}`,
    'In observe mode, inferred candidates must be ignored (you may set audit.would_accept true). Explicit requests still accept.',
    '',
    '## Tools (host executes these; you only name them)',
    tools,
    '',
    '## Output format (required)',
    'Reply with exactly one fenced json block, nothing else after it:',
    '```json',
    '{ "actions": [ { "tool": "orchestrator_eval_decide", "args": { ... } }, { "tool": "orchestrator_reply", "args": { ... } } ] }',
    '```',
    'Use real ids from the cards. After accept, include acknowledgement via orchestrator_reply in the same actions list.',
    'When a worker report has reply/question, speak it with orchestrator_reply (you may lightly edit).',
    'If nothing to do, return {"actions":[]}.',
    '',
    '## Inbox',
    cards || '(empty)',
  ].join('\n')
}

function formatItem(host: ToolHost, item: InboxItem): string {
  if (item.kind === 'candidate' && item.evalId) {
    const candidate = host.engine().candidate(item.evalId)
    return candidateCard(host.store, item.evalId, candidate ?? { missing: true, evalId: item.evalId })
  }
  if (item.kind === 'report' && item.ticketId && item.assignmentId) {
    return reportRelay(host.store, item.ticketId, item.assignmentId)
  }
  if (item.kind === 'followup' && item.triggerId) return followupRelay(host.store, item.triggerId)
  if (item.kind === 'watchdog') return `Watchdog notice:\n${item.text ?? ''}`
  return JSON.stringify(item)
}

function parseActions(text: string): Action[] {
  const block = [...text.matchAll(/```json\s*\n([\s\S]*?)\n\s*```/g)].at(-1)?.[1]
    ?? [...text.matchAll(/\{[\s\S]*"actions"[\s\S]*\}/g)].at(-1)?.[0]
  if (!block) return []
  const parsed = JSON.parse(block) as { actions?: Action[] }
  if (!Array.isArray(parsed.actions)) return []
  return parsed.actions.filter(item => item && typeof item.tool === 'string')
}

function needsAnotherRound(results: { result: unknown }[]): boolean {
  return results.some(item => {
    const result = item.result as Record<string, unknown>
    return result?.error || result?.refused
  })
}

function summarize(result: unknown): string {
  const text = JSON.stringify(result)
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

async function callClaude(input: {
  sessionId: string
  resume: boolean
  user: string
  extraArgs: string[]
}): Promise<string> {
  const args = [
    '-p', '--output-format', 'json',
    '--tools', '',
    ...input.resume ? ['--resume', input.sessionId] : ['--session-id', input.sessionId],
    ...input.extraArgs,
  ]
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('claude router timed out')) }, TIMEOUT_MS)
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`claude exited ${code}: ${err.slice(-500)}`))
      else resolve(out)
    })
    child.stdin.end(input.user)
  })
  try {
    const answer = JSON.parse(stdout) as { result?: string; is_error?: boolean }
    if (answer.is_error) throw new Error(String(answer.result ?? 'claude error').slice(0, 500))
    return answer.result ?? ''
  } catch (error) {
    if (error instanceof SyntaxError) return stdout
    throw error
  }
}
