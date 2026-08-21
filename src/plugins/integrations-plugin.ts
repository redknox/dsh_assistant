import { Service, type Context } from '@deepseek-ai/cordis'
import { FakeIntegrationSuite } from '../adapters/integrations/fake-providers.js'
import { IntegrationHub } from '../domain/integrations/hub.js'
import { registerIntegrationTools } from './integration-tools.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    integrations: IntegrationsService
  }
}

export class IntegrationsService extends Service {
  constructor(ctx: Context, readonly hub: IntegrationHub) {
    super(ctx, 'integrations')
  }
}

export const name = 'dsh-assistant-integrations'
export const inject = ['systemPrompt', 'tools']

export async function apply(ctx: Context) {
  const fakes = new FakeIntegrationSuite()
  await ctx.plugin(class extends IntegrationsService {
    constructor(scope: Context) {
      super(scope, fakes.hub)
    }
  })
  ctx.systemPrompt.section({
    name: 'product:integrations',
    order: 40,
    text: 'Personal integrations are provider-neutral. Prefer read tools for lookup. Mutation tools only propose drafts; do not treat a proposal as executed.',
  })
  ctx.effect(() => registerIntegrationTools(ctx.tools, fakes.hub))
}
