import { Service, type Context } from '@deepseek-ai/cordis'
import {
  createDefaultDiscovery,
  type CapabilityDiscovery,
  type CatalogDiscoveryOptions,
} from '../domain/discovery/index.js'
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
    capabilityDiscovery: CapabilityDiscovery
  }
}

export interface ResolutionPluginConfig {
  readonly discovery?: CatalogDiscoveryOptions
}

export class CapabilityDiscoveryService extends Service implements CapabilityDiscovery {
  constructor(
    ctx: Context,
    private readonly inner: CapabilityDiscovery,
  ) {
    super(ctx, 'capabilityDiscovery')
  }

  search(query: Parameters<CapabilityDiscovery['search']>[0]) {
    return this.inner.search(query)
  }

  inspect(identity: string) {
    return this.inner.inspect(identity)
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
export async function apply(ctx: Context, config: ResolutionPluginConfig = {}) {
  const discovery = createDefaultDiscovery(config.discovery)
  const resolver = new ResolutionService(ctx.capabilityRegistry, discovery)
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
  await ctx.plugin(class extends CapabilityDiscoveryService {
    constructor(scope: Context) {
      super(scope, discovery)
    }
  })
  ctx.effect(() => registerResolutionTools(ctx.tools, review))
}
