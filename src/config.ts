/** The deployment: what a config file fixes for one installation. Runtime settings (Policy etc.) are stored and versioned. */
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { SettingsInput } from './policy.ts'
import type { SourceConfig } from './sources/registry.ts'

export interface Deployment {
  stateDir: string
  /** The panel listens on `host:port`; `webhookPort`, when set, is a second listener that answers only webhooks. */
  http: { host: string; port: number; webhookPort?: number }
  /** The one repository the agent works on: a local clone, its base branch and the Source that hosts its pull requests. */
  repository: { path: string; baseBranch: string; source?: string }
  sources: Record<string, SourceConfig>
  /** Settings used until the panel saves its own. */
  settings?: SettingsInput
}

export function loadDeployment(path: string): Deployment {
  const file = resolve(path)
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Deployment>
  const base = dirname(file)
  const at = (value: string) => isAbsolute(value) ? value : resolve(base, value)
  if (!raw.repository?.path) throw new Error('config: repository.path is required')
  const settings = raw.settings ? { ...raw.settings } : undefined
  if (settings?.executor && typeof (settings.executor as { dshRoot?: string }).dshRoot === 'string') {
    const root = (settings.executor as { dshRoot: string }).dshRoot
    settings.executor = { ...settings.executor, dshRoot: at(root) }
  }
  return {
    stateDir: at(raw.stateDir ?? '.state'),
    http: { host: raw.http?.host ?? '127.0.0.1', port: raw.http?.port ?? 7878, ...raw.http?.webhookPort ? { webhookPort: raw.http.webhookPort } : {} },
    repository: { path: at(raw.repository.path), baseBranch: raw.repository.baseBranch ?? 'main', ...raw.repository.source ? { source: raw.repository.source } : {} },
    sources: raw.sources ?? {},
    ...settings ? { settings } : {},
  }
}
