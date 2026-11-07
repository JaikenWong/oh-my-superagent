/**
 * What a worker reads each turn, by Inline & Spill: the Ticket card and short cards of its messages inline, with the
 * full text spilled to files the worker reads on demand; every object names its id so the worker can follow references.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ticket, TicketInput, Trigger } from '../core/model.ts'
import type { Receipt } from '../store/outbox.ts'

const ORIGIN_CHARS = 1500
const INPUT_CHARS = 600
const TEMPLATE = readFileSync(new URL('../../prompts/worker.md', import.meta.url), 'utf8')

export interface Card { id: string; kind: string; triggerId?: string; from?: string; human?: boolean; at: string; thread?: string; url?: string; text: string }
export interface TurnFile {
  ticket: { id: string; name: string; title: string; scope: string; capability: string; strength: string; requester: string; directory: string; branch: string; base: string; rules: { id: string; instruction: string }[] }
  first: boolean
  recovery?: string
  origin: Card[]
  inputs: Card[]
  history: Card[]
  contextDir: string
}

export interface TurnContext {
  ticket: Ticket
  inputs: TicketInput[]
  first: boolean
  /** The backend keeps no history, so the prompt repeats what earlier turns read. */
  repeatHistory: boolean
  trigger: (id: string) => Trigger | undefined
  threadTriggers: (key: string) => Trigger[]
  threadReplies: (key: string) => Receipt[]
  rules: { id: string; instruction: string }[]
  variables: Record<string, { value: string; description: string }>
  contextDir: string
}

export function triggerCard(trigger: Trigger): Card {
  return { id: trigger.id, kind: 'trigger', triggerId: trigger.id, from: trigger.actor.name ?? trigger.actor.id, human: trigger.human, at: trigger.at,
    thread: `${trigger.threads[0]!.source}:${trigger.threads[0]!.id}`, ...trigger.url ? { url: trigger.url } : {}, text: trigger.text }
}

export function inputCard(input: TicketInput, trigger: (id: string) => Trigger | undefined): Card {
  switch (input.kind) {
    case 'trigger': case 'resumed': {
      const found = trigger(input.triggerId)
      const card = found ? triggerCard(found) : { id: input.triggerId, kind: 'trigger', at: input.at, text: '(message not found)' }
      return { ...card, id: input.id, kind: input.kind === 'resumed' ? 'resumed' : 'message', triggerId: input.triggerId }
    }
    case 'text': return { id: input.id, kind: 'person', from: 'operator (panel)', human: true, at: input.at, text: input.text }
    case 'note': return { id: input.id, kind: 'note', at: input.at, text: input.text }
    case 'policy-changed': return { id: input.id, kind: 'policy-changed', at: input.at, text: `The Policy changed from ${input.from} to ${input.to}: ${JSON.stringify(input.effect)}. Stay within what still holds.` }
  }
}

/** Writes the turn's files under `contextDir` and returns the prompt and the turn file's path. */
export function renderTurn(context: TurnContext): { prompt: string; turnPath: string; turn: TurnFile } {
  const { ticket, contextDir } = context
  mkdirSync(join(contextDir, 'messages'), { recursive: true })
  const origin = ticket.origin.triggerIds.flatMap(id => { const found = context.trigger(id); return found ? [triggerCard(found)] : [] })
  const inputs = context.inputs.map(input => inputCard(input, context.trigger))
  const taken = new Set(context.inputs.map(input => input.id))
  const history = context.repeatHistory ? ticket.inputs.filter(input => !taken.has(input.id) && !ticket.undelivered.includes(input.id)).map(input => inputCard(input, context.trigger)) : []
  // Each followed Thread as a transcript: the messages the host has, with what the agent sent there, oldest first.
  const threads = new Set(ticket.origin.triggerIds.flatMap(id => context.trigger(id)?.threads.map(ref => `${ref.source}:${ref.id}`) ?? []))
  for (const follow of ticket.follows) threads.add(follow.thread)
  for (const thread of threads) {
    const lines = [
      ...context.threadTriggers(thread).map(item => ({ at: item.at, line: `- [${item.id}] ${item.at} ${item.actor.id}${item.human ? '' : ' (bot)'}: ${item.text.replaceAll('\n', '\n  ')}` })),
      ...context.threadReplies(thread).filter(item => item.status === 'sent').map(item => ({ at: item.sentAt ?? item.createdAt, line: `- [agent ${item.purpose}] ${item.sentAt ?? ''}: ${item.text.replaceAll('\n', '\n  ')}` })),
    ].sort((a, b) => a.at.localeCompare(b.at)).map(item => item.line)
    writeFileSync(join(contextDir, `thread-${thread.replace(/[^a-zA-Z0-9_-]+/g, '_')}.md`), `# Thread ${thread}\n\n${lines.join('\n')}\n`)
  }
  const execution = ticket.execution!
  const turn: TurnFile = {
    ticket: { id: ticket.id, name: ticket.name, title: ticket.title, scope: ticket.mandate.scope, capability: ticket.mandate.capability, strength: ticket.mandate.strength,
      requester: `${ticket.mandate.actor.source}:${ticket.mandate.actor.id}`, directory: execution.directory, branch: execution.branch, base: execution.base, rules: context.rules },
    first: context.first, ...latestRecovery(ticket) ? { recovery: latestRecovery(ticket)! } : {}, origin, inputs, history, contextDir,
  }
  const turnPath = join(contextDir, 'turn.json')
  writeFileSync(turnPath, JSON.stringify(turn, null, 2))

  const spill = (card: Card, max: number) => {
    if (card.text.length <= max) return card.text
    const path = join(contextDir, 'messages', `${card.id.replace(/[^a-zA-Z0-9_-]+/g, '_')}.md`)
    writeFileSync(path, card.text)
    return `${card.text.slice(0, max)}\n… (${card.text.length} chars; read the rest in ${path})`
  }
  const show = (card: Card, max: number) => [`### [${card.triggerId ?? card.id}] ${card.kind}${card.from ? ` from ${card.from}${card.human ? '' : ' (bot)'}` : ''} at ${card.at}${card.url ? ` — ${card.url}` : ''}`, '', spill(card, max)].join('\n')

  const sections: string[] = []
  const recovery = latestRecovery(ticket)
  if (recovery && context.first) sections.push(`**Recovery note:** ${recovery}`)
  if (context.first || context.repeatHistory) {
    sections.push(context.first ? 'Original request:' : 'Original request (handled in earlier turns; do not answer it again):', ...origin.map(card => show(card, ORIGIN_CHARS)))
  }
  if (history.length) sections.push('Earlier messages on this Ticket (already handled in earlier turns):', ...history.slice(-10).map(card => show(card, 300)))
  sections.push(inputs.length ? 'New since your last turn:' : 'Nothing new arrived; continue the work.', ...inputs.map(card => show(card, INPUT_CHARS)))

  const variables = Object.entries(context.variables).map(([name, item]) => `- \`${name}\` = \`${item.value}\`: ${item.description}`).join('\n')
  const rules = context.rules.length ? `\n- Proactive Ticket: you may only do what these matched rules allow:\n${context.rules.map(rule => `  - ${rule.id}: ${rule.instruction}`).join('\n')}` : ''
  const ticketText = [
    `- id \`${ticket.id}\`, name \`${ticket.name}\`: ${ticket.title}`,
    `- capability: **${ticket.mandate.capability}**; strength: ${ticket.mandate.strength}; requested by ${turn.ticket.requester}`,
    `- scope (the Mandate, which bounds the work): ${ticket.mandate.scope}`,
    `- directory \`${execution.directory}\` on branch \`${execution.branch}\` from \`${execution.base}\`${rules}`,
    '', 'Execution variables:', variables,
  ].join('\n')
  const prompt = TEMPLATE
    .replace('{ticket}', ticketText)
    .replace('{contextHint}', `the Threads' transcripts are in \`${contextDir}/thread-*.md\`, and this turn as JSON is in \`${turnPath}\`.`)
    .replace('{inputs}', sections.join('\n\n'))
  writeFileSync(join(contextDir, 'prompt.md'), prompt)
  return { prompt, turnPath, turn }
}

function latestRecovery(ticket: Ticket): string | undefined {
  return ticket.assignments.at(-1)?.recovery
}
