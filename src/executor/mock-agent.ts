/**
 * A deterministic stand-in for a coding agent, run as a real child process so the host's isolation, timeouts and report
 * parsing are exercised without a model. It follows the worker protocol literally and never pretends to be more.
 *
 * - `read` Tickets: finds files the request mentions or shares words with, and answers with an analysis.
 * - `write` Tickets: applies a request of the form `"A" -> "B"` (or `把 "A" 改成 "B"`) in the named file, commits, and
 *   proposes a pull request; without such a target it asks one question.
 * - A person's follow-up asking for a code change on a `read` Ticket is handed back.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import type { Card, TurnFile } from './prompt.ts'

const turn = JSON.parse(readFileSync(process.env.SUPERAGENT_TURN!, 'utf8')) as TurnFile
const directory = turn.ticket.directory
const WRITE = /(^|\s)(\/agent|@\S+)\s+(fix|implement|change|修复|实现|修改)\b/i

function files(): string[] {
  return execFileSync('git', ['-C', directory, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean)
}
function words(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) ?? []).filter(word => !['agent', 'summarize', 'please', 'this', 'that', 'with', 'from'].includes(word)))]
}
function related(text: string): string[] {
  const all = files()
  const named = all.filter(file => text.includes(file) || text.includes(file.split('/').at(-1)!))
  if (named.length) return named.slice(0, 5)
  const keys = words(text)
  return all.map(file => {
    let content = ''
    try { content = readFileSync(`${directory}/${file}`, 'utf8').toLowerCase() } catch { /* binary or gone */ }
    return { file, score: keys.filter(word => content.includes(word) || file.toLowerCase().includes(word)).length }
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 5).map(item => item.file)
}
function replacement(text: string): { from: string; to: string } | undefined {
  const match = text.match(/["“'`]([^"”'`]+)["”'`]\s*(?:->|→|改成|改为|to|with)\s*["“'`]([^"”'`]+)["”'`]/)
  return match ? { from: match[1]!, to: match[2]! } : undefined
}
function finish(report: Record<string, unknown>, log: string[]): never {
  process.stdout.write(`${log.join('\n')}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`)
  process.exit(0)
}

const log: string[] = [`mock agent: ticket ${turn.ticket.id} (${turn.ticket.capability}), ${turn.inputs.length} new input(s)`]
const origin = turn.origin.map(card => card.text).join('\n\n')
const people = turn.inputs.filter((card: Card) => card.human && (card.kind === 'message' || card.kind === 'person'))
const handbacks = turn.ticket.capability === 'read'
  ? people.filter(card => card.triggerId && WRITE.test(card.text)).map(card => ({ trigger_id: card.triggerId, reason: 'It asks for a code change; this Ticket is a read-only analysis.' }))
  : []
const handed = new Set(handbacks.map(item => item.trigger_id))
const followups = people.filter(card => !handed.has(card.triggerId))

if (!turn.first && !followups.length) {
  finish({ state: handbacks.length ? 'waiting' : 'waiting', summary: handbacks.length ? 'Handed back a request beyond this Ticket.' : 'Nothing new to act on.', handbacks }, log)
}

const request = turn.first ? origin : followups.map(card => card.text).join('\n\n')
const acked = followups.flatMap(card => card.triggerId ? [card.triggerId] : [])

if (turn.ticket.capability === 'read') {
  if (request.replace(/\/agent\s+\S+/g, '').trim().length < 12) {
    finish({ state: 'waiting', summary: 'The request has too little to analyse; asked for reproduction steps.', question: '能补充一下复现步骤和期望行为吗？', ...acked[0] ? { question_to: acked[0] } : {}, handbacks, acked }, log)
  }
  const hits = related(request)
  log.push(`related files: ${hits.join(', ') || 'none'}`)
  const first = request.split('\n').find(line => line.trim() && !line.trim().startsWith('/agent'))?.trim() ?? turn.ticket.title
  const reply = [
    '**分析（mock agent，未调用模型）**', '',
    `- 问题：${first.slice(0, 200)}`,
    `- 可能相关的文件：${hits.length ? hits.map(file => `\`${file}\``).join('、') : '未在仓库中找到直接相关的文件'}`,
    `- 建议：${hits.length ? `先检查 \`${hits[0]}\`，补一个能复现问题的测试。` : '请补充报错信息或涉及的模块。'}`,
  ].join('\n')
  finish({ state: 'ready', summary: `Analysed the request; ${hits.length} related file(s).`, reply, ...!turn.first && acked[0] ? { reply_to: acked[0] } : {}, handbacks, acked }, log)
}

const change = replacement(request)
const target = related(request)[0]
if (!change || !target) {
  finish({ state: 'waiting', summary: 'No concrete target for a change.', question: '要改哪个文件、把什么改成什么？例如：src/x.js 里 "A" -> "B"', handbacks, acked }, log)
}
const path = `${directory}/${target}`
const before = readFileSync(path, 'utf8')
if (!before.includes(change.from)) {
  finish({ state: 'dropped', summary: `"${change.from}" does not occur in ${target}; nothing to change.`, handbacks, acked }, log)
}
writeFileSync(path, before.replaceAll(change.from, change.to))
execFileSync('git', ['-C', directory, 'add', target])
execFileSync('git', ['-C', directory, '-c', 'user.name=superagent', '-c', 'user.email=superagent@localhost', 'commit', '-m', `fix: "${change.from}" -> "${change.to}" in ${target}`])
log.push(`changed ${target}`)
finish({
  state: 'ready',
  summary: `Replaced "${change.from}" with "${change.to}" in ${target} and committed. No tests were run (mock agent).`,
  pull_request: { title: `fix: ${change.from} -> ${change.to} in ${target}`, body: `## Problem\n${turn.ticket.title}\n\n## Change\nReplace \`${change.from}\` with \`${change.to}\` in \`${target}\`.\n\n## Verification\nNot run (mock agent).` },
  handbacks, acked,
}, log)
