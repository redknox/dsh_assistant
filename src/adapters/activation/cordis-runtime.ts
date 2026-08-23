import { pathToFileURL } from 'node:url'
import type { Context, Plugin } from '@deepseek-ai/cordis'
import { defineTool, type ParameterSchemaSpec, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { ActivationPrepareContext, ActivationRuntime, IsolatedRuntimeFailure } from '../../domain/governance/runtime.js'
import type { ActivationSnapshot } from '../../domain/governance/types.js'
import { projectParameterSchema, projectValueSchema } from '../../domain/generated-runtime/schema.js'
import { requiresIsolatedGeneratedRuntime } from '../../domain/generated-runtime/trust.js'
import type { GeneratedToolDescriptor } from '../../domain/generated-runtime/types.js'
import { resolveCandidateEntry } from './candidate-entry.js'
import { IsolatedGeneratedRunner } from './generated-runner.js'

interface SurfaceSnapshot {
  readonly tools: readonly string[]
  readonly services: readonly string[]
  readonly providers: readonly string[]
}

interface PriorOwnerMount {
  readonly plugin: Plugin
  readonly config: unknown
  readonly candidateId?: string
  readonly owner?: string
}

const OWNER_PLUGIN_NAMES: Readonly<Record<string, string>> = {
  'managed/integrations': 'dsh-assistant-integrations',
  'managed/personal-memory': 'dsh-assistant-memory',
  'managed/personal-knowledge': 'dsh-assistant-knowledge',
  'managed/trust-policy': 'dsh-assistant-policy',
  'managed/assistant-jobs': 'dsh-assistant-jobs',
  'generated/google-calendar': 'generated-google-calendar',
}

const SWAP_KINDS = new Set(['evolve-owner', 'configure', 'adopt-existing', 'implement-provider'])

export { resolveCandidateEntry } from './candidate-entry.js'

function hasService(ctx: Context, name: string): boolean {
  try {
    return ctx.get(name) !== undefined
  } catch {
    return false
  }
}

function snapshotDeclared(ctx: Context, declared: ActivationPrepareContext): SurfaceSnapshot {
  return {
    tools: declared.tools.filter((name) => name !== '' && ctx.tools.get(name) !== undefined),
    services: declared.services.filter((name) => name !== '' && hasService(ctx, name)),
    providers: declared.providers.filter((name) => name !== '' && hasService(ctx, name)),
  }
}

function notProduced(kind: string, names: readonly string[], before: readonly string[], after: readonly string[]): string[] {
  const missing: string[] = []
  for (const name of names) {
    if (name === '') continue
    if (before.includes(name)) missing.push(`${kind}:${name} was already present; candidate did not produce it`)
    else if (!after.includes(name)) missing.push(`${kind}:${name} missing after candidate mount`)
  }
  return missing
}

function needsOwnerSwap(ctx: Context, declared: ActivationPrepareContext): boolean {
  if (SWAP_KINDS.has(declared.resolutionKind) && declared.baseVersion !== undefined) return true
  const overlapping = snapshotDeclared(ctx, declared)
  return overlapping.tools.length + overlapping.services.length + overlapping.providers.length > 0
}

function capturePriorOwner(ctx: Context, owner: string): { mounts: PriorOwnerMount[]; fibers: { dispose: () => Promise<unknown> }[] } {
  const wanted = OWNER_PLUGIN_NAMES[owner]
  const mounts: PriorOwnerMount[] = []
  const fibers: { dispose: () => Promise<unknown> }[] = []
  for (const runtime of ctx.registry.values()) {
    if (wanted !== undefined && runtime.name !== wanted) continue
    if (wanted === undefined) continue
    for (const fiber of runtime.fibers) {
      if (fiber.uid === null) continue
      mounts.push({
        plugin: {
          name: runtime.name,
          inject: Object.keys(fiber.inject ?? {}),
          apply: runtime.callback as Plugin.Function,
        },
        config: fiber.config,
      })
      fibers.push(fiber)
    }
  }
  return { mounts, fibers }
}

/** Production adapter: human-maintained managed code stays in-process; assistant-origin code is isolated. */
export class CordisActivationRuntime implements ActivationRuntime {
  private readonly fibers = new Map<string, { dispose: () => Promise<unknown> }>()
  private readonly baselines = new Map<string, SurfaceSnapshot>()
  private readonly priorOwners = new Map<string, PriorOwnerMount[]>()
  private readonly generated = new Map<string, IsolatedGeneratedRunner>()
  private readonly proxyDisposers = new Map<string, Array<() => void>>()
  private currentMounted: string[] = []
  private lastContext?: ActivationPrepareContext
  private isolatedFailure?: (failure: IsolatedRuntimeFailure) => void | Promise<void>
  private readonly candidateOwners = new Map<string, string>()
  private readonly inProcessPlugins = new Map<string, PriorOwnerMount>()
  private readonly parkedBy = new Map<string, Array<{ id: string; runner: IsolatedGeneratedRunner }>>()
  private readonly isolatedRecipes = new Map<string, ActivationPrepareContext>()

  constructor(private readonly ctx: Context) {
    ctx.effect(() => () => {
      this.unloadGenerated()
    })
  }

  snapshot(generation: number, owners: ActivationSnapshot['owners']): ActivationSnapshot {
    return {
      generation,
      capturedAt: new Date().toISOString(),
      owners,
      profileIdentity: this.ctx.get('assistantJobs') ? 'assistant-core' : 'assistant-safe',
      mounted: [...this.currentMounted],
    }
  }

  async prepare(candidateId: string, context?: ActivationPrepareContext): Promise<{ ok: boolean; diagnostics?: string }> {
    this.lastContext = context
    if (this.fibers.has(candidateId) || this.generated.has(candidateId)) return { ok: true }
    if (context === undefined || context.workspaceRoot === '') {
      return { ok: false, diagnostics: 'candidate workspace metadata is required to mount the artifact' }
    }
    if (requiresIsolatedGeneratedRuntime({
      owner: context.owner,
      provenanceKind: context.provenanceKind,
      origin: context.origin,
    })) {
      return this.prepareGenerated(candidateId, context)
    }
    let swapped: PriorOwnerMount[] = []
    try {
      if (needsOwnerSwap(this.ctx, context)) {
        const prior = capturePriorOwner(this.ctx, context.owner)
        const overlapping = snapshotDeclared(this.ctx, context)
        if (prior.fibers.length === 0 && overlapping.tools.length + overlapping.services.length > 0) {
          return { ok: false, diagnostics: `cannot locate prior owner fiber for ${context.owner}` }
        }
        for (const fiber of prior.fibers) await fiber.dispose()
        swapped = prior.mounts
        this.priorOwners.set(candidateId, swapped)
      }
      this.baselines.set(candidateId, snapshotDeclared(this.ctx, context))
      const entry = resolveCandidateEntry(context.workspaceRoot, context.entryPoints)
      const imported = await import(pathToFileURL(entry).href) as { default?: unknown }
      const plugin = imported.default ?? imported
      const fiber = await this.ctx.plugin(plugin as Plugin)
      this.fibers.set(candidateId, fiber)
      this.candidateOwners.set(candidateId, context.owner)
      this.inProcessPlugins.set(candidateId, {
        plugin: plugin as Plugin,
        config: undefined,
        candidateId,
        owner: context.owner,
      })
      return { ok: true }
    } catch (error) {
      await this.restorePriorOwner(candidateId, swapped)
      return { ok: false, diagnostics: error instanceof Error ? error.message : String(error) }
    }
  }

  async verifyHealth(candidateId: string, expected: readonly string[]): Promise<{ ok: boolean; diagnostics?: string }> {
    const declared = this.lastContext
    if (declared === undefined) return { ok: false, diagnostics: 'no candidate mount context' }
    const generated = this.generated.get(candidateId)
    if (generated !== undefined) {
      const produced = await generated.health()
      const declaredTools = declared.tools.filter((name) => name !== '')
      const missing = declaredTools.filter((name) => !produced.includes(name) || this.ctx.tools.get(name) === undefined)
      const extra = produced.filter((name) => !declaredTools.includes(name))
      if (missing.length > 0 || extra.length > 0) {
        return {
          ok: false,
          diagnostics: [
            ...missing.map((name) => `tool:${name} missing after candidate mount`),
            ...extra.map((name) => `descriptor/manifest mismatch: ${name}`),
          ].join('; '),
        }
      }
      if (declared.services.length > 0 || declared.providers.length > 0) {
        return { ok: false, diagnostics: 'generated runtime does not proxy services or providers' }
      }
      if (declaredTools.length === 0) {
        return { ok: false, diagnostics: 'candidate declared no tools, services, or providers to verify' }
      }
      return { ok: true }
    }
    if (!this.fibers.has(candidateId)) return { ok: false, diagnostics: 'candidate artifact is not mounted' }
    const before = this.baselines.get(candidateId) ?? { tools: [], services: [], providers: [] }
    const after = snapshotDeclared(this.ctx, declared)
    const missing = [
      ...notProduced('tool', declared.tools, before.tools, after.tools),
      ...notProduced('service', declared.services, before.services, after.services),
      ...notProduced('provider', declared.providers, before.providers, after.providers),
    ]
    void expected
    if (missing.length > 0) return { ok: false, diagnostics: missing.join('; ') }
    if (declared.tools.length + declared.services.length + declared.providers.length === 0) {
      return { ok: false, diagnostics: 'candidate declared no tools, services, or providers to verify' }
    }
    return { ok: true }
  }

  async commit(candidateId: string): Promise<void> {
    await this.discardParked(candidateId)
    if (!this.currentMounted.includes(candidateId)) this.currentMounted = [...this.currentMounted, candidateId]
  }

  async restore(snapshot: ActivationSnapshot): Promise<void> {
    for (const [id, fiber] of this.fibers) {
      if (snapshot.mounted.includes(id)) continue
      await fiber.dispose()
      this.fibers.delete(id)
      this.baselines.delete(id)
      await this.restorePriorOwner(id, this.priorOwners.get(id) ?? [])
    }
    const waiting: Array<Promise<void>> = []
    for (const [id, runner] of this.generated) {
      if (snapshot.mounted.includes(id)) continue
      this.dropGenerated(id, runner)
      waiting.push(runner.waitForExit())
    }
    for (const id of new Set([...this.parkedBy.keys(), ...this.priorOwners.keys()])) {
      if (snapshot.mounted.includes(id)) {
        await this.discardParked(id)
        continue
      }
      await this.restoreIsolatedSwap(id)
    }
    await Promise.all(waiting)
    for (const id of snapshot.mounted) {
      if (this.generated.has(id) || this.fibers.has(id)) continue
      const recipe = this.isolatedRecipes.get(id)
      if (recipe === undefined) continue
      const remounted = await this.prepareGenerated(id, recipe)
      if (!remounted.ok) throw new Error(remounted.diagnostics ?? `failed to remount isolated candidate ${id}`)
      await this.commit(id)
    }
    this.currentMounted = snapshot.mounted.filter((id) => this.generated.has(id) || this.fibers.has(id))
  }

  async unloadGenerated(): Promise<void> {
    const runners = [...this.generated.entries()]
    for (const [id, runner] of runners) this.dropGenerated(id, runner)
    await Promise.all(runners.map(([, runner]) => runner.waitForExit()))
    for (const id of [...this.parkedBy.keys()]) await this.discardParked(id)
  }

  mounted(): readonly string[] {
    return this.currentMounted
  }

  bindIsolatedFailure(handler: (failure: IsolatedRuntimeFailure) => void | Promise<void>): void {
    this.isolatedFailure = handler
  }

  private async prepareGenerated(candidateId: string, context: ActivationPrepareContext): Promise<{ ok: boolean; diagnostics?: string }> {
    if (context.services.length > 0 || context.providers.length > 0) {
      return { ok: false, diagnostics: 'generated runtime does not proxy services or providers' }
    }
    const swapped = await this.swapIsolatedOwner(candidateId, context)
    if (!swapped.ok) return swapped
    const runner = new IsolatedGeneratedRunner({
      candidateId,
      workspaceRoot: context.workspaceRoot,
      entryPoints: context.entryPoints,
      owner: context.owner,
      digest: context.digest,
      tools: context.tools,
      permissions: context.permissions ?? [],
      runtimeContractVersion: context.runtimeContractVersion,
    })
    const fail = async (diagnostics: string) => {
      runner.kill()
      await runner.waitForExit()
      await this.restoreIsolatedSwap(candidateId)
      return { ok: false as const, diagnostics }
    }
    const started = await runner.start()
    if (!started.ok) return fail(started.diagnostics ?? 'generated runner failed to start')
    const declaredTools = context.tools.filter((name) => name !== '')
    const produced = runner.descriptors.map((item) => item.name)
    const missing = declaredTools.filter((name) => !produced.includes(name))
    const extra = produced.filter((name) => !declaredTools.includes(name))
    if (missing.length > 0 || extra.length > 0) {
      return fail([
        ...missing.map((name) => `tool:${name} missing after candidate mount`),
        ...extra.map((name) => `descriptor/manifest mismatch: ${name}`),
      ].join('; ') || 'descriptor/manifest mismatch')
    }
    this.generated.set(candidateId, runner)
    this.candidateOwners.set(candidateId, context.owner)
    this.isolatedRecipes.set(candidateId, context)
    this.baselines.set(candidateId, snapshotDeclared(this.ctx, context))
    const disposers: Array<() => void> = []
    try {
      for (const descriptor of runner.descriptors) {
        if (this.ctx.tools.get(descriptor.name) !== undefined) {
          throw new Error(`tool:${descriptor.name} was already present; candidate did not produce it`)
        }
        disposers.push(this.ctx.tools.register(defineProxyTool(descriptor, runner)))
      }
      const unregistered = declaredTools.filter((name) => this.ctx.tools.get(name) === undefined)
      if (unregistered.length > 0) {
        throw new Error(unregistered.map((name) => `tool:${name} missing after candidate mount`).join('; '))
      }
    } catch (error) {
      for (const dispose of disposers) dispose()
      this.generated.delete(candidateId)
      return fail(error instanceof Error ? error.message : String(error))
    }
    this.proxyDisposers.set(candidateId, disposers)
    runner.onFatal = (reason) => {
      this.dropGenerated(candidateId, runner)
      return this.isolatedFailure?.({ candidateId, diagnostics: reason })
    }
    return { ok: true }
  }

  private async swapIsolatedOwner(candidateId: string, context: ActivationPrepareContext): Promise<{ ok: boolean; diagnostics?: string }> {
    const overlapping = snapshotDeclared(this.ctx, context)
    const isolatedPriors = [...this.generated.entries()].filter(([id, runner]) => (
      id !== candidateId && (runner.owner === context.owner || runner.tools.some((name) => context.tools.includes(name)))
    ))
    const fiberPriors = [...this.fibers.entries()].filter(([id]) => (
      id !== candidateId && this.candidateOwners.get(id) === context.owner
    ))
    const named = capturePriorOwner(this.ctx, context.owner)
    const shouldSwap = needsOwnerSwap(this.ctx, context) || isolatedPriors.length > 0 || fiberPriors.length > 0
    if (!shouldSwap) return { ok: true }
    if (
      isolatedPriors.length === 0
      && fiberPriors.length === 0
      && named.fibers.length === 0
      && overlapping.tools.length + overlapping.services.length > 0
    ) {
      return { ok: false, diagnostics: `cannot locate prior owner fiber for ${context.owner}` }
    }
    const parked = isolatedPriors.map(([id, runner]) => {
      this.parkGenerated(id, runner)
      return { id, runner }
    })
    this.parkedBy.set(candidateId, parked)
    const priorMounts: PriorOwnerMount[] = [...named.mounts]
    for (const fiber of named.fibers) await fiber.dispose()
    for (const [id, fiber] of fiberPriors) {
      const mount = this.inProcessPlugins.get(id)
      if (mount !== undefined) priorMounts.push({ ...mount, candidateId: id, owner: context.owner })
      await fiber.dispose()
      this.fibers.delete(id)
      this.baselines.delete(id)
      this.inProcessPlugins.delete(id)
    }
    this.priorOwners.set(candidateId, priorMounts)
    return { ok: true }
  }

  private parkGenerated(candidateId: string, runner: IsolatedGeneratedRunner): void {
    const disposers = this.proxyDisposers.get(candidateId) ?? []
    this.proxyDisposers.delete(candidateId)
    for (const dispose of disposers) dispose()
    runner.onFatal = undefined
    this.generated.delete(candidateId)
    this.baselines.delete(candidateId)
    this.currentMounted = this.currentMounted.filter((id) => id !== candidateId)
  }

  private attachFatalHandler(candidateId: string, runner: IsolatedGeneratedRunner): void {
    runner.onFatal = (reason) => {
      this.dropGenerated(candidateId, runner)
      return this.isolatedFailure?.({ candidateId, diagnostics: reason })
    }
  }

  private remountParkedRunner(id: string, runner: IsolatedGeneratedRunner): void {
    const disposers: Array<() => void> = []
    for (const descriptor of runner.descriptors) {
      if (this.ctx.tools.get(descriptor.name) !== undefined) continue
      disposers.push(this.ctx.tools.register(defineProxyTool(descriptor, runner)))
    }
    this.generated.set(id, runner)
    this.proxyDisposers.set(id, disposers)
    this.candidateOwners.set(id, runner.owner)
    this.attachFatalHandler(id, runner)
    if (!this.currentMounted.includes(id)) this.currentMounted = [...this.currentMounted, id]
  }

  private async restoreParked(candidateId: string): Promise<void> {
    const parked = this.parkedBy.get(candidateId) ?? []
    this.parkedBy.delete(candidateId)
    for (const item of parked) this.remountParkedRunner(item.id, item.runner)
  }

  private async discardParked(candidateId: string): Promise<void> {
    const parked = this.parkedBy.get(candidateId) ?? []
    this.parkedBy.delete(candidateId)
    for (const item of parked) {
      item.runner.onFatal = undefined
      item.runner.kill()
      this.candidateOwners.delete(item.id)
      await item.runner.waitForExit()
    }
  }

  private async restoreIsolatedSwap(candidateId: string): Promise<void> {
    this.generated.delete(candidateId)
    this.proxyDisposers.delete(candidateId)
    this.candidateOwners.delete(candidateId)
    this.baselines.delete(candidateId)
    await this.restoreParked(candidateId)
    await this.restorePriorOwner(candidateId, this.priorOwners.get(candidateId) ?? [])
  }

  private dropGenerated(candidateId: string, runner: IsolatedGeneratedRunner): void {
    const disposers = this.proxyDisposers.get(candidateId) ?? []
    this.proxyDisposers.delete(candidateId)
    for (const dispose of disposers) dispose()
    runner.onFatal = undefined
    runner.kill()
    this.generated.delete(candidateId)
    this.baselines.delete(candidateId)
    this.candidateOwners.delete(candidateId)
    this.currentMounted = this.currentMounted.filter((id) => id !== candidateId)
  }

  private async restorePriorOwner(candidateId: string, mounts: readonly PriorOwnerMount[]): Promise<void> {
    for (const prior of mounts) {
      const fiber = await this.ctx.plugin(prior.plugin, prior.config)
      if (prior.candidateId !== undefined) {
        this.fibers.set(prior.candidateId, fiber)
        this.baselines.delete(prior.candidateId)
        this.inProcessPlugins.set(prior.candidateId, prior)
        if (prior.owner !== undefined) this.candidateOwners.set(prior.candidateId, prior.owner)
      }
    }
    this.priorOwners.delete(candidateId)
  }
}

function defineProxyTool(descriptor: GeneratedToolDescriptor, runner: IsolatedGeneratedRunner) {
  const parameters = projectParameterSchema(descriptor.parameters) as unknown as ParameterSchemaSpec
  const schema = projectValueSchema(descriptor.output) as unknown as ValueSchemaSpec
  return defineTool({
    name: descriptor.name,
    description: descriptor.description,
    parameters,
    output: {
      schema,
      render(_args, value) {
        return [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }]
      },
    },
    async execute(args, exec) {
      return await runner.call(descriptor.name, (args ?? {}) as Record<string, unknown>, exec.signal) as never
    },
  })
}
