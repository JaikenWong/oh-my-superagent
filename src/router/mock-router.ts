/**
 * Deterministic Main Session for demos and tests: plays the Router's part with the same tools a model would call.
 * Explicit requests route by command; inferred candidates use the heuristic/claude assessor; worker reports are spoken.
 */
import { key } from '../core/ids.ts'
import type { Candidate } from '../core/ports.ts'
import { assessmentOutcome, type Settings } from '../policy.ts'
import { claudeAssessor, heuristicAssessor } from './assessors.ts'
import { acceptFromExplicit, pendingSpeech, runTool, type ToolHost } from './tools.ts'

export type InboxKind = 'candidate' | 'report' | 'followup' | 'watchdog'

export interface InboxItem {
  kind: InboxKind
  key: string
  evalId?: string
  ticketId?: string
  assignmentId?: string
  triggerId?: string
  text?: string
}

export async function runMockRouterTurn(host: ToolHost, settings: Settings, items: InboxItem[]): Promise<void> {
  for (const item of items) {
    if (item.kind === 'candidate' && item.evalId) await handleCandidate(host, settings, item.evalId)
    else if (item.kind === 'report' && item.ticketId && item.assignmentId) handleReport(host, item.ticketId, item.assignmentId)
    else if (item.kind === 'followup' && item.triggerId) handleFollowup(host, item.triggerId)
    else if (item.kind === 'watchdog') handleWatchdog(host, item.text ?? '')
  }
}

async function handleCandidate(host: ToolHost, settings: Settings, evalId: string): Promise<void> {
  const candidate = host.engine().candidate(evalId)
  if (!candidate) return
  if (candidate.strength === 'explicit') {
    await acceptExplicit(host, candidate)
    return
  }
  const assessor = settings.eval.assessor === 'claude' ? claudeAssessor : heuristicAssessor
  const outcome = assessmentOutcome(await assessor.assess(candidate, settings), settings)
  const primary = candidate.primary
  if (outcome.kind === 'accept') {
    const result = runTool(host, 'orchestrator_eval_decide', {
      trigger_id: primary, eval_id: evalId, kind: 'accept',
      title: outcome.title, scope: outcome.scope, capability: outcome.capability, reason: typeof outcome.reason === 'string' ? outcome.reason : 'accept',
      acknowledgement: outcome.acknowledgement, rules: outcome.rules, name: outcome.name, audit: outcome.audit,
    })
    const ticketId = (result.decision as { ticketId?: string } | undefined)?.ticketId
    if (ticketId && outcome.acknowledgement) {
      runTool(host, 'orchestrator_reply', {
        ticket_id: ticketId, purpose: 'acknowledgement', text: outcome.acknowledgement, reply_to: primary, id: key('msg', ticketId, 'ack'),
      })
    }
  } else if (outcome.kind === 'ignore' || outcome.kind === 'unavailable') {
    runTool(host, 'orchestrator_eval_decide', {
      trigger_id: primary, eval_id: evalId, kind: outcome.kind,
      reason: typeof outcome.reason === 'string' ? outcome.reason : outcome.kind, audit: outcome.audit,
    })
  } else if (outcome.kind === 'stop') {
    runTool(host, 'orchestrator_eval_decide', {
      trigger_id: primary, eval_id: evalId, kind: 'stop', reason: typeof outcome.reason === 'string' ? outcome.reason : 'stop',
      ...outcome.ticketId ? { ticket_id: outcome.ticketId } : {},
    })
  }
}

async function acceptExplicit(host: ToolHost, candidate: Candidate): Promise<void> {
  const primary = candidate.triggers.find(trigger => trigger.id === candidate.primary)!
  const command = acceptFromExplicit(primary.text, candidate.thread.meta.label ? String(candidate.thread.meta.label) : primary.text.slice(0, 60))
  // stop command
  if (/\/agent\s+stop\b|@\S+\s+stop\b/i.test(primary.text) || parseStop(primary.text)) {
    runTool(host, 'orchestrator_eval_decide', {
      trigger_id: primary.id, eval_id: candidate.evalId, kind: 'stop', reason: `${primary.actor.id} asked to stop`,
    })
    return
  }
  const result = runTool(host, 'orchestrator_eval_decide', {
    trigger_id: primary.id, eval_id: candidate.evalId, kind: 'accept',
    title: command.title, scope: command.scope, capability: command.capability,
    reason: 'explicit request', acknowledgement: command.acknowledgement, name: command.name,
  })
  const ticketId = (result.decision as { ticketId?: string } | undefined)?.ticketId
  if (ticketId) {
    runTool(host, 'orchestrator_reply', {
      ticket_id: ticketId, purpose: 'acknowledgement', text: command.acknowledgement, reply_to: primary.id, id: key('msg', ticketId, 'ack'),
    })
  }
}

function parseStop(text: string): boolean {
  return /(?:^|\n)\s*(?:\/agent|@\S+)\s+(?:stop|cancel|abort|停止|取消|停)\b/i.test(text)
}

function handleReport(host: ToolHost, ticketId: string, assignmentId: string): void {
  const speech = pendingSpeech(host.store, ticketId, assignmentId)
  if (!speech) return
  runTool(host, 'orchestrator_reply', {
    ticket_id: ticketId, purpose: speech.purpose, text: speech.text,
    ...speech.replyTo ? { reply_to: speech.replyTo } : {},
    id: key('msg', ticketId, assignmentId, speech.purpose),
  })
}

function handleFollowup(host: ToolHost, triggerId: string): void {
  const trigger = host.store.triggers.get(triggerId)
  if (!trigger?.addressed || !parseStop(trigger.text)) return
  runTool(host, 'orchestrator_eval_decide', {
    trigger_id: triggerId, kind: 'stop', reason: `${trigger.actor.id} asked to stop`,
  })
}

function handleWatchdog(_host: ToolHost, _text: string): void {
  // Watchdog already acted on the Engine; this inbox item only keeps the Main Session aware.
}
