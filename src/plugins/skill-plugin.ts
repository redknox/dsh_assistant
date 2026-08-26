import { Service, type Context } from '@deepseek-ai/cordis'
import { SkillService } from '../domain/skill/index.js'
import { registerSkillTools } from './skill-tools.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    skillLifecycle: SkillService
  }
}

export const name = 'dsh-assistant-skills'
export const inject = ['tools']

export interface SkillPluginConfig {
  readonly home?: string
  readonly profile?: string
  readonly inspectOnly?: boolean
  readonly bindStore?: (store: SkillService) => void
}

class SkillLifecycleService extends Service {
  constructor(ctx: Context, private readonly store: SkillService) {
    super(ctx, 'skillLifecycle')
  }

  list() { return this.store.list() }
  get(id: string) { return this.store.get(id) }
  inspect(id: string) { return this.store.inspect(id) }
  listFiles(id: string) { return this.store.listFiles(id) }
  readFile(id: string, relativePath: string) { return this.store.readFile(id, relativePath) }
  create(input: Parameters<SkillService['create']>[0]) { return this.store.create(input) }
  importLocal(sourceDir: string) { return this.store.importLocal(sourceDir) }
  writeFile(id: string, relativePath: string, content: string) { return this.store.writeFile(id, relativePath, content) }
  validate(id: string) { return this.store.validate(id) }
  seal(id: string) { return this.store.seal(id) }
  requestReview(id: string, review: Parameters<SkillService['requestReview']>[1]) {
    return this.store.requestReview(id, review)
  }
  requestApproval(id: string, review: Parameters<SkillService['requestApproval']>[1]) {
    return this.store.requestApproval(id, review)
  }
  activeRoot() { return this.store.activeRoot() }
  catalogNames() { return this.store.catalogNames() }
  health() { return this.store.health() }
}

export async function apply(ctx: Context, config: SkillPluginConfig = {}) {
  if (config.home === undefined) return
  const store = new SkillService(config.home, config.profile ?? 'assistant')
  config.bindStore?.(store)
  await ctx.plugin(class extends SkillLifecycleService {
    constructor(scope: Context) {
      super(scope, store)
    }
  })
  registerSkillTools(ctx, store, { inspectOnly: config.inspectOnly === true })
}
