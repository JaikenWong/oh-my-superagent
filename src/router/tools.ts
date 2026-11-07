/**
 * Main Session (Router) tools. Every write goes through the Engine; the session never mutates domain state itself.
 */
import type { Engine } from '../core/engine.ts'
import { UserError } from '../core/errors.ts'
import { key } from '../core/ids.ts'
import { latestAssignment, latestReport } from '../core/model.ts'
import type { Capability } from '../core/model.ts'
import type { AssessmentOutcome } from '../core/ports.ts'
import { canRetry, stageLabel, ticketStage } from '../core/stage.ts'
import type { Store } from '../store/store.ts'
import { parseCommand, verbEnglish, verbLabel } from './command.ts'

export interface ToolHost {
  engine: () => Engine
  store: Store
}

export type ToolResult = Record<string, unknown>

const tools = {
  orchestrator_read: {
    description: 'Read Tickets, Threads, Triggers, Decisions or a worker report by id/key.',
    run(host: ToolHost, args: Record<string, unknown>): ToolResult {
      const store = host.store
      if (typeof args.ticket_id === 'string') {
        const ticket = store.tickets.get(args.ticket_id)
        if (!ticket) return { error: 'missing ticket' }
        return {
          ticket: {
            id: ticket.id, title: ticket.title, name: ticket.name, stage: stageLabel(ticketStage(ticket)),
            capability: ticket.mandate.capability, scope: ticket.mandate.scope, ended: ticket.ended,
            report: latestReport(ticket), attention: ticket.attention, channels: ticket.channels,
          },
        }
      }
      if (typeof args.eval_id === 'string') {
        const candidate = host.engine().candidate(args.eval_id)
        return candidate ? { candidate } : { error: 'eval finished' }
      }
      if (typeof args.trigger_id === 'string') {
        const trigger = store.triggers.get(args.trigger_id)
        return trigger ? { trigger } : { error: 'missing trigger' }
      }
      if (typeof args.thread_key === 'string') {
        const thread = store.threads.get(args.thread_key)
        return thread ? { thread } : { error: 'missing thread' }
      }
      return { open_tickets: store.tickets.open().map(ticket => ({
        id: ticket.id, title: ticket.title, stage: stageLabel(ticketStage(ticket)), capability: ticket.mandate.capability,
      })) }
    },
  },

  orchestrator_eval_decide: {
    description: 'Record accept | ignore | stop | unavailable on a Trigger held by an Eval (or a direct stop).',
    run(host: ToolHost, args: Record<string, unknown>): ToolResult {
      const triggerId = String(args.trigger_id ?? '')
      const kind = String(args.kind ?? '')
      const reason = String(args.reason ?? kind)
      const evalId = typeof args.eval_id === 'string' ? args.eval_id : undefined
      let outcome: AssessmentOutcome
      if (kind === 'accept') {
        outcome = {
          kind: 'accept',
          title: String(args.title ?? 'Work'),
          scope: String(args.scope ?? args.title ?? 'work'),
          capability: (args.capability === 'write' ? 'write' : 'read') as Capability,
          reason,
          ...typeof args.acknowledgement === 'string' ? { acknowledgement: args.acknowledgement } : {},
          ...Array.isArray(args.rules) ? { rules: args.rules.map(String) } : {},
          ...typeof args.name === 'string' ? { name: args.name } : {},
          ...args.audit && typeof args.audit === 'object' ? { audit: args.audit as Record<string, unknown> } : {},
        }
      } else if (kind === 'ignore' || kind === 'unavailable') {
        outcome = {
          kind,
          reason,
          ...args.audit && typeof args.audit === 'object' ? { audit: args.audit as Record<string, unknown> } : {},
        }
      } else if (kind === 'stop') {
        outcome = { kind: 'stop', reason, ...typeof args.ticket_id === 'string' ? { ticketId: args.ticket_id } : {} }
      } else {
        return { error: 'kind must be accept|ignore|stop|unavailable' }
      }
      try {
        const decision = host.engine().decide(triggerId, { ...outcome, ...evalId ? { evalId } : {} })
        return { decision: { id: decision.id, kind: decision.kind, ticketId: decision.ticketId, reason: decision.reason } }
      } catch (error) {
        if (error instanceof UserError) return { refused: error.code, values: error.values }
        throw error
      }
    },
  },

  orchestrator_reply: {
    description: 'Speak on a Ticket\'s channel: acknowledgement, answer, result or attention.',
    run(host: ToolHost, args: Record<string, unknown>): ToolResult {
      const ticketId = String(args.ticket_id ?? '')
      const purpose = String(args.purpose ?? 'result')
      if (!['acknowledgement', 'answer', 'result', 'attention'].includes(purpose)) return { error: 'bad purpose' }
      const text = String(args.text ?? '').trim()
      if (!text) return { error: 'empty text' }
      try {
        const id = typeof args.id === 'string' ? args.id : key('msg', ticketId, purpose, Date.now())
        host.engine().reply({
          id, ticketId, purpose: purpose as 'acknowledgement' | 'answer' | 'result' | 'attention', text,
          ...typeof args.reply_to === 'string' ? { replyTo: args.reply_to } : {},
        })
        return { sent: id, purpose }
      } catch (error) {
        if (error instanceof UserError) return { refused: error.code, values: error.values }
        throw error
      }
    },
  },

  orchestrator_ticket_note: {
    description: 'Give a Ticket\'s Worker a fact; grants no new Mandate.',
    run(host: ToolHost, args: Record<string, unknown>): ToolResult {
      try {
        host.engine().note(String(args.ticket_id ?? ''), String(args.text ?? ''))
        return { ok: true }
      } catch (error) {
        if (error instanceof UserError) return { refused: error.code }
        throw error
      }
    },
  },

  orchestrator_ticket_retry: {
    description: 'Retry a Ticket stalled after failed/blocked.',
    run(host: ToolHost, args: Record<string, unknown>): ToolResult {
      const ticketId = String(args.ticket_id ?? '')
      const ticket = host.store.tickets.get(ticketId)
      if (!ticket || !canRetry(ticket)) return { refused: 'cannotRetry' }
      try {
        host.engine().retryTicket(ticketId)
        return { ok: true }
      } catch (error) {
        if (error instanceof UserError) return { refused: error.code }
        throw error
      }
    },
  },

  orchestrator_ticket_request_status: {
    description: 'Ask a waiting Worker for status by waking it with a note.',
    run(host: ToolHost, args: Record<string, unknown>): ToolResult {
      const ticketId = String(args.ticket_id ?? '')
      try {
        host.engine().note(ticketId, 'The Main Session asks for a short status update on this Ticket.')
        return { asked: true }
      } catch (error) {
        if (error instanceof UserError) return { refused: error.code }
        throw error
      }
    },
  },

  orchestrator_trigger_requeue: {
    description: 'Re-queue a Trigger for a fresh Eval.',
    run(host: ToolHost, args: Record<string, unknown>): ToolResult {
      try {
        return { queued: host.engine().reevaluate(String(args.trigger_id ?? '')) }
      } catch (error) {
        if (error instanceof UserError) return { refused: error.code }
        throw error
      }
    },
  },
} as const

export type ToolName = keyof typeof tools

export function runTool(host: ToolHost, name: string, args: Record<string, unknown> = {}): ToolResult {
  const tool = tools[name as ToolName]
  if (!tool) return { error: `unknown tool ${name}` }
  return tool.run(host, args)
}

export function listTools(): { name: string; description: string }[] {
  return Object.entries(tools).map(([name, tool]) => ({ name, description: tool.description }))
}

/** Deterministic accept fields from an explicit command (hint for mock / prompts; not authority by itself). */
export function acceptFromExplicit(text: string, fallbackTitle: string): {
  title: string; scope: string; capability: Capability; acknowledgement: string; name: string
} {
  const command = parseCommand(text)
  const verb = command?.verb ?? 'ask'
  const rest = command?.rest || text.replace(/^\/agent\b|@\S+/gi, '').trim() || fallbackTitle
  const capability: Capability = command?.kind === 'write' ? 'write' : 'read'
  const label = verbLabel(verb)
  return {
    title: `${label}：${rest.slice(0, 80)}`,
    scope: rest.slice(0, 500) || fallbackTitle,
    capability,
    acknowledgement: capability === 'write' ? `好的，我来${label}。` : `收到，我来${label}。`,
    name: verbEnglish(verb),
  }
}

export function pendingSpeech(store: Store, ticketId: string, assignmentId: string): {
  purpose: 'answer' | 'result' | 'attention'
  text: string
  replyTo?: string
} | undefined {
  const ticket = store.tickets.get(ticketId)
  const assignment = ticket?.assignments.find(item => item.id === assignmentId) ?? latestAssignment(ticket!)
  const report = assignment?.report
  if (!ticket || !report || report.spoken) return
  if (report.question) {
    return { purpose: 'attention', text: report.question, ...report.questionTo ? { replyTo: report.questionTo } : {} }
  }
  if (report.reply) {
    return {
      purpose: report.replyTo ? 'answer' : 'result',
      text: report.reply,
      ...report.replyTo ? { replyTo: report.replyTo } : {},
    }
  }
}
