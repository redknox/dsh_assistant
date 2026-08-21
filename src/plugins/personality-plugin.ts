import { Service, type Context } from '@deepseek-ai/cordis'
import {
  PersonalityService,
  type PersonalitySituation,
  type TarsPersonality,
  type UserPersonalityPrefs,
} from '../domain/personality/index.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tarsPersonality: TarsPersonalityService
  }
}

export class TarsPersonalityService extends Service implements TarsPersonality {
  constructor(ctx: Context, private readonly inner: PersonalityService) {
    super(ctx, 'tarsPersonality')
  }

  profile() { return this.inner.profile() }
  setUserPrefs(prefs: UserPersonalityPrefs) { return this.inner.setUserPrefs(prefs) }
  setSituation(situation: PersonalitySituation) { this.inner.setSituation(situation) }
  currentSituation() { return this.inner.currentSituation() }
  effective(situation?: PersonalitySituation) { return this.inner.effective(situation) }
  compile(situation?: PersonalitySituation) { return this.inner.compile(situation) }
  preview(prefs: UserPersonalityPrefs, situation?: PersonalitySituation) {
    return this.inner.preview(prefs, situation)
  }
}

export interface PersonalityPluginConfig {
  readonly prefs?: UserPersonalityPrefs
}

export const name = 'dsh-assistant-personality'
export const inject = ['systemPrompt']

/** Three-layer TARS-NG personality compiled onto the public systemPrompt seam. */
export async function apply(ctx: Context, config: PersonalityPluginConfig = {}) {
  const inner = new PersonalityService(config.prefs)
  await ctx.plugin(class extends TarsPersonalityService {
    constructor(scope: Context) {
      super(scope, inner)
    }
  })
  ctx.systemPrompt.section({
    name: 'product:personality-core',
    order: 10,
    text: () => inner.compile().core,
  })
  ctx.systemPrompt.section({
    name: 'product:behavior-policy',
    order: 11,
    text: () => inner.compile().policy,
  })
  ctx.systemPrompt.context({
    name: 'product:contextual-expression',
    order: 12,
    text: () => inner.compile().expression,
  })
}
