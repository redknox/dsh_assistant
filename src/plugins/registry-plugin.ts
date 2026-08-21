import { Service, type Context } from '@deepseek-ai/cordis'
import {
  InMemoryRegistryPersistence,
  RegistryService,
  bootstrapCoreInventory,
  type CapabilityRegistry,
} from '../domain/registry/index.js'
import { registerRegistryTools } from './registry-tools.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    capabilityRegistry: CapabilityRegistry
  }
}

export class CapabilityRegistryService extends Service implements CapabilityRegistry {
  constructor(
    ctx: Context,
    private readonly store: CapabilityRegistry,
  ) {
    super(ctx, 'capabilityRegistry')
  }

  register(input: Parameters<CapabilityRegistry['register']>[0]) {
    return this.store.register(input)
  }

  get(owner: string, version: string) {
    return this.store.get(owner, version)
  }

  list(query?: Parameters<CapabilityRegistry['list']>[0]) {
    return this.store.list(query)
  }

  resolveActiveOwner(capability: string) {
    return this.store.resolveActiveOwner(capability)
  }

  listCapabilities(owner: string, version: string) {
    return this.store.listCapabilities(owner, version)
  }

  conflicts() {
    return this.store.conflicts()
  }

  transitionStatus(owner: string, version: string, status: Parameters<CapabilityRegistry['transitionStatus']>[2]) {
    return this.store.transitionStatus(owner, version, status)
  }
}

export interface RegistryPluginConfig {
  /** Tests may skip Core MVP bootstrap and seed records themselves. */
  bootstrap?: boolean
}

export const name = 'dsh-assistant-registry'
export const inject = ['tools']

/** Descriptive registry only. Status updates never mount or unmount DSH plugins. */
export async function apply(ctx: Context, config: RegistryPluginConfig = {}) {
  const registry = new RegistryService(new InMemoryRegistryPersistence())
  if (config.bootstrap !== false) bootstrapCoreInventory((input) => registry.register(input))
  await ctx.plugin(class extends CapabilityRegistryService {
    constructor(scope: Context) {
      super(scope, registry)
    }
  })
  ctx.effect(() => registerRegistryTools(ctx.tools, registry))
}
