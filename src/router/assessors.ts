/**
 * Assessors judge inferred candidates against the enabled rules: the slow path. `claude` asks a model with
 * prompts/assess.md; `heuristic` matches rule keywords, so the observe → auto workflow can be tried offline.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { Candidate } from '../core/ports.ts'
import type { Assessment, Settings } from '../policy.ts'

export interface Assessor { assess(candidate: Candidate, settings: Settings): Promise<Assessment> }

export const heuristicAssessor: Assessor = {
  async assess(candidate, settings) {
    const text = candidate.triggers.map(trigger => trigger.text).join('\n')
    const lower = text.toLowerCase()
    const enabled = settings.policy.rules.filter(rule => rule.enabled)
    const rule_assessments = enabled.map(rule => {
      const hit = rule.keywords?.find(word => lower.includes(word.toLowerCase()))
      return { rule_id: rule.id, matched: !!hit, reason: hit ? `The message mentions "${hit}".` : 'No keyword of this rule occurs.' }
    })
    const matched = rule_assessments.some(item => item.matched)
    const first = text.split('\n').find(line => line.trim())?.trim().slice(0, 80) ?? 'message'
    const quote = `"${text.slice(0, 160)}"`
    const duplicate = candidate.tickets.some(ticket => !ticket.stage.startsWith('ended'))
    return {
      decision: matched && !duplicate ? 'accept' : 'ignore',
      rule_assessments,
      direction: { implementation_requested: matched, target_basis: matched ? 'specified' : 'undetermined', requires_design_decision: false, evidence: matched ? quote : 'No rule keyword.' },
      title: `主动处理：${first}`,
      scope: `Proactive work under the matched rules on: ${first}`,
      reason: duplicate ? 'The Thread already has a live Ticket.' : matched ? 'A rule keyword matched (heuristic assessor).' : 'No rule matched.',
      ...matched ? { intent_evidence: quote, acknowledgement: `我来看一下：${first}` } : {},
    }
  },
}

const PROMPT = readFileSync(new URL('../../prompts/assess.md', import.meta.url), 'utf8')

export const claudeAssessor: Assessor = {
  async assess(candidate, settings) {
    const rules = settings.policy.rules.filter(rule => rule.enabled).map(rule => `- ${rule.id} (${rule.name}): ${rule.instruction}`).join('\n')
    const input = [
      PROMPT,
      `## Policy ${candidate.policyVersion}, mode ${settings.policy.mode}\n\nEnabled rules:\n${rules || '(none)'}`,
      `## Candidate\n\nThread ${candidate.thread.key} ${String(candidate.thread.meta.label ?? '')}\nExisting Tickets: ${JSON.stringify(candidate.tickets)}`,
      ...candidate.triggers.map(trigger => `### [${trigger.id}] ${trigger.actor.id}${trigger.human ? '' : ' (bot)'} at ${trigger.at}\n\n${trigger.text.slice(0, 4000)}`),
    ].join('\n\n')
    const stdout = await new Promise<string>((resolve, reject) => {
      // Assessment is read-only: the assessing model gets no tools at all.
      const child = spawn('claude', ['-p', '--output-format', 'json', '--tools', ''], { stdio: ['pipe', 'pipe', 'pipe'] })
      let out = '', err = ''
      const timer = setTimeout(() => child.kill('SIGTERM'), Math.max(10_000, settings.eval.timeoutSeconds * 1000 - 5000))
      child.stdout.on('data', chunk => { out += chunk })
      child.stderr.on('data', chunk => { err += chunk })
      child.on('error', reject)
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}: ${err.slice(-400)}`)) })
      child.stdin.end(input)
    })
    const result = (JSON.parse(stdout) as { result?: string }).result ?? ''
    const block = [...result.matchAll(/```json\s*\n([\s\S]*?)\n\s*```/g)].at(-1)?.[1]
    if (!block) throw new Error('The assessment has no JSON block')
    return JSON.parse(block) as Assessment
  },
}
