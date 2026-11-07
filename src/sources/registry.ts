/** The Source instances of a deployment, and the Engine's `SourceScope`. */
import type { SourceScope } from '../core/ports.ts'
import { FeishuSource, type FeishuConfig } from './feishu.ts'
import { GithubSource, type GithubConfig } from './github.ts'
import { GitlabSource, type GitlabConfig } from './gitlab.ts'
import type { ExecutionVariable, SourceKind } from './kind.ts'

export type SourceConfig = GithubConfig | GitlabConfig | FeishuConfig

export class SourceRegistry implements SourceScope {
  readonly #sources = new Map<string, SourceKind>()

  constructor(configs: Record<string, SourceConfig>) {
    for (const [id, config] of Object.entries(configs)) {
      if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`Invalid Source id ${id}`)
      this.#sources.set(id, config.kind === 'github' ? new GithubSource(id, config)
        : config.kind === 'gitlab' ? new GitlabSource(id, config)
          : config.kind === 'feishu' ? new FeishuSource(id, config)
            : fail(`Unknown Source kind ${(config as { kind: string }).kind}`))
    }
  }

  get(id: string): SourceKind | undefined { return this.#sources.get(id) }
  all(): SourceKind[] { return [...this.#sources.values()] }

  scope(trigger: { source: string }): { listened: boolean; observed: boolean } {
    const source = this.#sources.get(trigger.source)
    return { listened: !!source?.enabled, observed: !!source?.receiveAll }
  }

  environment(): Record<string, ExecutionVariable> {
    return Object.assign({}, ...this.all().filter(source => source.enabled).map(source => source.environment()))
  }
}

function fail(message: string): never { throw new Error(message) }
