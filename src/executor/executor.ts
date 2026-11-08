/**
 * The Executor: one git worktree, one agent session and one context directory per Ticket. Each turn is one run of the
 * deployment's CLI agent; the run's final report drives the Ticket. Launches and deliveries are durable effects.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Engine, TurnResult } from '../core/engine.ts'
import { latestAssignment, runningAssignment, type Ticket, type TicketInput } from '../core/model.ts'
import type { Executor } from '../core/ports.ts'
import type { Deployment } from '../config.ts'
import type { Settings } from '../policy.ts'
import type { ExecutionVariable } from '../sources/kind.ts'
import { Later, type Effects } from '../store/effects.ts'
import type { OutboxStore } from '../store/outbox.ts'
import type { Store } from '../store/store.ts'
import { BACKENDS, type AgentBackend } from './agents.ts'
import { blockedCommandsFor, blockedGitSubcommands, allowsFileWrite } from './capability.ts'
import { renderTurn } from './prompt.ts'
import { extractReport } from './report.ts'
import { captureDiff, commitAll, installShims, prepareWorktree } from './workspace.ts'

export interface ExecutorDeps {
  engine: () => Engine
  store: Store
  effects: Effects
  outbox: OutboxStore
  settings: () => Settings
  deployment: Deployment
  variables: () => Record<string, ExecutionVariable>
  backend?: (settings: Settings) => AgentBackend
}

/** Credentials stay with the host: Source tokens never enter a worker's environment. */
const SECRET_ENV = /^(GITHUB_TOKEN|GH_TOKEN|GITLAB_TOKEN|GITHUB_WEBHOOK_SECRET|GITLAB_WEBHOOK_SECRET|FEISHU_.*)$/
const LOG_LIMIT = 2 * 1024 * 1024

/** A UUID derived from the Ticket, so its agent session survives host restarts. */
const sessionOf = (ticketId: string) => {
  const hex = createHash('sha256').update(`session:${ticketId}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export class WorkerExecutor implements Executor {
  readonly #d: ExecutorDeps
  readonly #running = new Map<string, { child: ChildProcess; assignmentId: string }>()
  /** Slots held by launches still preparing. */
  readonly #reserved = new Set<string>()

  constructor(deps: ExecutorDeps) { this.#d = deps }

  start(ticketId: string): void { this.#d.effects.enqueue('launch', ticketId) }
  wake(ticketId: string): void { this.#d.effects.enqueue('delivery', ticketId) }
  stop(ticketId: string): void {
    this.#d.store.afterCommit(() => {
      const run = this.#running.get(ticketId)
      if (run) run.child.kill('SIGTERM')
    })
  }

  install(): void {
    this.#d.effects.handle('launch', key => this.#launch(key), { concurrency: 4, baseMs: 5000, maxMs: 300_000, pausable: true })
    this.#d.effects.handle('delivery', key => this.#deliver(key), { concurrency: 4, baseMs: 2000, maxMs: 60_000, pausable: true })
  }

  get load(): { active: number; max: number } {
    return { active: this.#running.size + this.#reserved.size, max: this.#d.settings().executor.maxWorkers }
  }

  async shutdown(): Promise<void> {
    for (const run of this.#running.values()) run.child.kill('SIGTERM')
  }

  /**
   * The configured limit applies to worker slots, with one extra slot for a person's message: new work can never keep a
   * person from continuing an existing Ticket.
   */
  #slot(human: boolean): boolean {
    const limit = this.#d.settings().executor.maxWorkers + (human ? 1 : 0)
    return this.#running.size + this.#reserved.size < limit
  }
  #humanWaiting(ticket: Ticket): boolean {
    return ticket.undelivered.some(id => {
      const input = ticket.inputs.find(item => item.id === id)
      return (input?.kind === 'trigger' || input?.kind === 'text') && !!input.human
    })
  }
  #paths(ticket: Ticket) {
    const state = this.#d.deployment.stateDir
    return { directory: join(state, 'work', ticket.name), context: join(state, 'context', ticket.name), artifacts: join(state, 'artifacts', ticket.name) }
  }

  async #launch(ticketId: string): Promise<void> {
    const ticket = this.#d.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    if (!ticket || ticket.ended || assignment?.state !== 'pending') return
    if (this.#running.has(ticketId) || this.#reserved.has(ticketId)) throw new Later(2000, 'previous run still stopping')
    if (!this.#slot(this.#humanWaiting(ticket))) throw new Later(5000, 'no free worker slot')
    this.#reserved.add(ticketId)
    try {
      const { repository } = this.#d.deployment
      const paths = this.#paths(ticket)
      const settings = this.#d.settings()
      const execution = { directory: paths.directory, branch: `superagent/${ticket.name}`, base: repository.baseBranch, session: sessionOf(ticket.id), backend: settings.executor.agent }
      const inputs = this.#d.engine().assignmentStarted(ticketId, assignment.id, execution)
      if (!inputs) return
      try {
        await prepareWorktree(repository.path, paths.directory, execution.branch, execution.base, settings.executor.prepare, await this.#env(ticket, execution.directory))
      } catch (error) {
        this.#d.engine().turnEnded(ticketId, assignment.id, { error: `Preparing the directory failed: ${message(error)}`, unread: true })
        return
      }
      // First means the worker has never seen this Ticket; a resumed or retried Ticket has, in its session and directory.
      this.#turn(ticketId, assignment.id, inputs, ticket.assignments.every(item => item.turns === 0))
    } finally {
      this.#reserved.delete(ticketId)
    }
  }

  async #deliver(ticketId: string): Promise<void> {
    const ticket = this.#d.store.tickets.get(ticketId)
    const assignment = ticket && runningAssignment(ticket)
    // A pending Assignment takes its Inputs at launch; a running turn wakes the next itself when it ends.
    if (!ticket || ticket.ended || !assignment || this.#running.has(ticketId) || !ticket.undelivered.length) return
    if (!this.#slot(this.#humanWaiting(ticket))) throw new Later(2000, 'no free worker slot')
    const inputs = this.#d.engine().takeInputs(ticketId, assignment.id)
    if (inputs) this.#turn(ticketId, assignment.id, inputs, false)
  }

  async #env(ticket: Ticket, directory: string): Promise<NodeJS.ProcessEnv> {
    const settings = this.#d.settings()
    const capability = ticket.mandate.capability
    // Per-capability shim dir so read Mandates cannot share a write-era git wrapper.
    const shimDir = join(this.#d.deployment.stateDir, 'shims', capability)
    const shims = await installShims(
      shimDir,
      blockedCommandsFor(capability, settings.executor.blockedCommands),
      blockedGitSubcommands(capability),
    )
    const env: NodeJS.ProcessEnv = {}
    for (const [name, value] of Object.entries(process.env)) if (!SECRET_ENV.test(name)) env[name] = value
    for (const [name, variable] of Object.entries(this.#variables(ticket, directory))) env[name] = variable.value
    env.PATH = `${shims}:${process.env.PATH ?? ''}`
    return env
  }
  #variables(ticket: Ticket, directory: string): Record<string, ExecutionVariable> {
    const capability = ticket.mandate.capability
    return {
      SUPERAGENT_DIR: { value: directory, description: "The Ticket's directory, a git worktree" },
      SUPERAGENT_NAME: { value: ticket.name, description: "The Ticket's short name, also its branch name after superagent/" },
      SUPERAGENT_TICKET: { value: ticket.id, description: "The Ticket's id" },
      SUPERAGENT_CAPABILITY: { value: capability, description: 'read: analyse only; write: may change code and commit — host-enforced' },
      SUPERAGENT_BLOCKED_COMMANDS: {
        value: [...blockedCommandsFor(capability, this.#d.settings().executor.blockedCommands), ...blockedGitSubcommands(capability).map(s => `git ${s}`)].join(','),
        description: 'Commands / git subcommands workers may not run (host shim)',
      },
      ...this.#d.variables(),
    }
  }

  /** Runs one turn in the background; its end reports to the Engine, which may wake the next. */
  #turn(ticketId: string, assignmentId: string, inputs: TicketInput[], first: boolean): void {
    const run = this.#runTurn(ticketId, assignmentId, inputs, first).catch(error => {
      this.#running.delete(ticketId)
      this.#d.engine().turnEnded(ticketId, assignmentId, { error: `The turn could not run: ${message(error)}`, unread: true })
    })
    void run
  }

  async #runTurn(ticketId: string, assignmentId: string, inputs: TicketInput[], first: boolean): Promise<void> {
    const store = this.#d.store
    const ticket = store.tickets.get(ticketId)!
    const assignment = ticket.assignments.find(item => item.id === assignmentId)!
    const execution = ticket.execution!
    const settings = this.#d.settings()
    const backend = this.#d.backend?.(settings) ?? BACKENDS[settings.executor.agent]
    const paths = this.#paths(ticket)
    mkdirSync(paths.artifacts, { recursive: true })
    const turnNo = assignment.turns + 1
    const sessionKey = `session:${ticketId}`
    const session = store.kv<{ id: string; turns: number }>(sessionKey)
    const env = await this.#env(ticket, execution.directory)
    const rendered = renderTurn({
      ticket, inputs, first, repeatHistory: !backend.resumable,
      trigger: id => store.triggers.get(id),
      threadTriggers: key => store.triggers.onThread(key),
      threadReplies: key => this.#d.outbox.forConversation(key),
      rules: (ticket.mandate.basis.rules ?? []).flatMap(id => settings.policy.rules.filter(rule => rule.id === id).map(rule => ({ id, instruction: rule.instruction }))),
      variables: this.#variables(ticket, execution.directory),
      contextDir: paths.context,
    })
    env.SUPERAGENT_TURN = rendered.turnPath
    env.SUPERAGENT_CONTEXT = paths.context
    const spec = {
      directory: execution.directory, prompt: rendered.prompt, sessionId: execution.session, resume: !!session?.turns, capability: ticket.mandate.capability,
      lastMessagePath: join(paths.context, 'last-message.md'), extraArgs: settings.executor.agentArgs,
      ...settings.executor.dshRoot ? { dshRoot: settings.executor.dshRoot } : {},
    }
    const command = backend.command(spec)
    const prefix = join(paths.artifacts, `a${ticket.assignments.indexOf(assignment)}-turn${turnNo}`)
    writeFileSync(`${prefix}.prompt.md`, rendered.prompt)

    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: Error }>(resolve => {
      const child = spawn(command.command, command.args, { cwd: execution.directory, env, stdio: ['pipe', 'pipe', 'pipe'] })
      this.#running.set(ticketId, { child, assignmentId })
      let stdout = '', stderr = '', timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, settings.executor.turnTimeoutMinutes * 60_000)
      child.stdout.on('data', chunk => { if (stdout.length < LOG_LIMIT) stdout += chunk })
      child.stderr.on('data', chunk => { if (stderr.length < LOG_LIMIT) stderr += chunk })
      child.on('error', error => { clearTimeout(timer); resolve({ code: null, signal: null, stdout, stderr, timedOut, spawnError: error }) })
      child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, timedOut }) })
      child.stdin.on('error', () => { /* the agent may exit before reading its prompt */ })
      child.stdin.end(command.input)
    })
    this.#running.delete(ticketId)
    store.setKv(sessionKey, { id: execution.session, turns: (session?.turns ?? 0) + 1 })

    writeFileSync(`${prefix}.log`, `$ ${command.command} ${command.args.join(' ')}\n\n--- stdout ---\n${outcome.stdout}\n--- stderr ---\n${outcome.stderr}\n--- exit ${outcome.code ?? outcome.signal} ---\n`)
    const artifacts: NonNullable<TurnResult['artifacts']> = [{ kind: 'prompt', path: `${prefix}.prompt.md` }, { kind: 'log', path: `${prefix}.log`, summary: `exit ${outcome.code ?? outcome.signal}` }]
    const result: TurnResult = { artifacts }
    if (outcome.spawnError) result.error = `Could not start ${command.command}: ${outcome.spawnError.message}`
    else if (outcome.timedOut) result.error = `The turn exceeded ${settings.executor.turnTimeoutMinutes} minutes and was stopped.`
    else {
      let text = ''
      try { text = backend.finalText(outcome.stdout, spec) } catch (error) { result.error = message(error) }
      if (!result.error) {
        const parsed = extractReport(text)
        if ('report' in parsed) result.report = parsed.report
        else result.error = outcome.code === 0 ? parsed.error : `${command.command} exited with ${outcome.code ?? outcome.signal}: ${outcome.stderr.trim().split('\n').slice(-5).join(' ').slice(0, 600)}`
      }
    }
    await this.#collect(ticket, result, prefix, artifacts)
    this.#d.engine().turnEnded(ticketId, assignmentId, result)
  }

  /** Saves the branch's diff, and makes a proposed pull request honest: committed, and ahead of its base. */
  async #collect(ticket: Ticket, result: TurnResult, prefix: string, artifacts: NonNullable<TurnResult['artifacts']>): Promise<void> {
    const execution = ticket.execution!
    const report = result.report
    try {
      if (report?.pullRequest) {
        if (!allowsFileWrite(ticket.mandate.capability)) {
          delete report.pullRequest
          report.summary += ' (The proposed pull request was dropped: this Ticket is read-only; host Execution Policy.)'
        } else if (!await commitAll(execution.directory, execution.base, report.pullRequest.title, 'superagent <superagent@localhost>')) {
          delete report.pullRequest
          if (report.state === 'ready') Object.assign(report, { state: 'blocked', summary: `${report.summary} (Blocked by the host: a pull request was proposed but the branch has no changes.)` })
        }
      }
      const { diff, stat, untracked } = await captureDiff(execution.directory, execution.base)
      if (diff || untracked.length) {
        writeFileSync(`${prefix}.diff`, `${diff}${untracked.length ? `\n# untracked\n${untracked.join('\n')}\n` : ''}`)
        artifacts.push({ kind: 'diff', path: `${prefix}.diff`, summary: stat || `${untracked.length} untracked file(s)` })
        if (report && !allowsFileWrite(ticket.mandate.capability)) {
          report.summary += ' (Host note: read Mandate left dirty worktree — Execution Policy should have blocked writes.)'
        }
      }
    } catch (error) {
      if (report) report.summary += ` (Collecting the diff failed: ${message(error)})`
    }
  }
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
