import { Service, type Context } from '@deepseek-ai/cordis'
import {
  DEFAULT_RESOLUTION_INVENTORY,
  ResolutionService,
  type CapabilityResolution,
  type ResolutionRequest,
  type ResolutionReview,
} from '../domain/resolution/index.js'
import { registerResolutionTools } from './resolution-tools.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    capabilityResolution: CapabilityResolution
  }
}

export class CapabilityResolutionService extends Service implements CapabilityResolution {
  constructor(
    ctx: Context,
    private readonly resolver: CapabilityResolution,
  ) {
    super(ctx, 'capabilityResolution')
  }

  review(request: ResolutionRequest): ResolutionReview {
    return this.resolver.review(request)
  }
}

export const name = 'dsh-assistant-resolution'
export const inject = ['capabilityRegistry', 'tools']

/** Advisory Capability Resolution Review. Never installs, approves, or mutates registry state. */
export async function apply(ctx: Context) {
  const resolver = new ResolutionService(ctx.capabilityRegistry)
  const review: CapabilityResolution = {
    review(request) {
      return resolver.review({
        ...request,
        inventory: request.inventory ?? DEFAULT_RESOLUTION_INVENTORY,
      })
    },
  }
  await ctx.plugin(class extends CapabilityResolutionService {
    constructor(scope: Context) {
      super(scope, review)
    }
  })
  ctx.effect(() => registerResolutionTools(ctx.tools, review))
}
