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
}

class SkillLifecycleService extends Service {
  constructor(ctx: Context, private readonly store: SkillService) {
    super(ctx, 'skillLifecycle')
  }

  list() { return this.store.list() }
  get(id: string) { return this.store.get(id) }
  inspect(id: string) { return this.store.inspect(id) }
  create(input: Parameters<SkillService['create']>[0]) { return this.store.create(input) }
  importLocal(sourceDir: string) { return this.store.importLocal(sourceDir) }
  writeFile(id: string, relativePath: string, content: string) { return this.store.writeFile(id, relativePath, content) }
  validate(id: string) { return this.store.validate(id) }
  seal(id: string) { return this.store.seal(id) }
  review(id: string) { return this.store.review(id) }
  requestApproval(id: string) { return this.store.requestApproval(id) }
  approve(id: string, fingerprint: string) { return this.store.approve(id, fingerprint) }
  activate(id: string) { return this.store.activate(id) }
  disable(name: string) { return this.store.disable(name) }
  uninstall(name: string, acknowledgedDependents?: readonly string[]) { return this.store.uninstall(name, acknowledgedDependents) }
  reactivate(name: string, version: string) { return this.store.reactivate(name, version) }
  rollback() { return this.store.rollback() }
  activeRoot() { return this.store.activeRoot() }
  catalogNames() { return this.store.catalogNames() }
}

export async function apply(ctx: Context, config: SkillPluginConfig = {}) {
  if (config.home === undefined) return
  const store = new SkillService(config.home, config.profile ?? 'assistant', () => {
    try { ctx.emit('skills/change') } catch { /* catalog consumers refetch */ }
  })
  await ctx.plugin(class extends SkillLifecycleService {
    constructor(scope: Context) {
      super(scope, store)
    }
  })
  registerSkillTools(ctx, store)
}
