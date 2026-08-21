import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { ActivationPrepareContext, ActivationRuntime } from '../../domain/governance/runtime.js'
import type { ActivationSnapshot } from '../../domain/governance/types.js'

interface SurfaceSnapshot {
  readonly tools: readonly string[]
  readonly services: readonly string[]
  readonly providers: readonly string[]
}

interface PriorOwnerMount {
  readonly name?: string
  readonly inject: readonly string[]
  readonly apply: Plugin
  readonly config: unknown
}

const OWNER_PLUGIN_NAMES: Readonly<Record<string, string>> = {
  'managed/integrations': 'dsh-assistant-integrations',
  'managed/personal-memory': 'dsh-assistant-memory',
  'managed/personal-knowledge': 'dsh-assistant-knowledge',
  'managed/trust-policy': 'dsh-assistant-policy',
  'managed/assistant-jobs': 'dsh-assistant-jobs',
}

const SWAP_KINDS = new Set(['evolve-owner', 'configure', 'adopt-existing', 'implement-provider'])

function packageEntries(root: string): string[] {
  const pkgPath = path.join(root, 'package.json')
  if (!existsSync(pkgPath)) return []
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      main?: string
      exports?: string | { '.'?: string | { import?: string; default?: string } }
    }
    const found: string[] = []
    if (typeof pkg.exports === 'string') found.push(pkg.exports)
    if (pkg.exports && typeof pkg.exports === 'object') {
      const exp = pkg.exports['.']
      if (typeof exp === 'string') found.push(exp)
      if (exp && typeof exp === 'object') {
        if (exp.import) found.push(exp.import)
        if (exp.default) found.push(exp.default)
      }
    }
    if (pkg.main) found.push(pkg.main)
    return found
  } catch {
    return []
  }
}

/** Resolve a sealed candidate's plugin entry from workspace/manifest/package metadata. */
export function resolveCandidateEntry(workspaceRoot: string, entryPoints: readonly string[] = []): string {
  const relatives = [
    ...entryPoints,
    ...packageEntries(workspaceRoot),
    'src/index.js',
    'src/plugin.js',
    'index.js',
    'plugin.js',
    'src/index.ts',
    'src/plugin.ts',
  ]
  const seen = new Set<string>()
  const root = path.resolve(workspaceRoot)
  for (const rel of relatives) {
    if (rel === undefined || rel === '' || seen.has(rel)) continue
    seen.add(rel)
    const unix = rel.replaceAll('\\', '/')
    if (path.isAbsolute(rel) || unix.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      continue
    }
    const abs = path.resolve(root, ...unix.split('/'))
    const inside = abs === root || abs.startsWith(`${root}${path.sep}`)
    if (!inside || !existsSync(abs)) continue
    return abs
  }
  throw new Error('candidate workspace has no mountable plugin entry')
}

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
        name: runtime.name,
        inject: Object.keys(fiber.inject ?? {}),
        apply: runtime.callback as Plugin,
        config: fiber.config,
      })
      fibers.push(fiber)
    }
  }
  return { mounts, fibers }
}

/** Production adapter: mount/unmount the sealed candidate artifact through Cordis. */
export class CordisActivationRuntime implements ActivationRuntime {
  private readonly fibers = new Map<string, { dispose: () => Promise<unknown> }>()
  private readonly baselines = new Map<string, SurfaceSnapshot>()
  private readonly priorOwners = new Map<string, PriorOwnerMount[]>()
  private currentMounted: string[] = []
  private lastContext?: ActivationPrepareContext

  constructor(private readonly ctx: Context) {}

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
    if (this.fibers.has(candidateId)) return { ok: true }
    if (context === undefined || context.workspaceRoot === '') {
      return { ok: false, diagnostics: 'candidate workspace metadata is required to mount the artifact' }
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
      return { ok: true }
    } catch (error) {
      await this.restorePriorOwner(candidateId, swapped)
      return { ok: false, diagnostics: error instanceof Error ? error.message : String(error) }
    }
  }

  async verifyHealth(candidateId: string, expected: readonly string[]): Promise<{ ok: boolean; diagnostics?: string }> {
    const declared = this.lastContext
    if (declared === undefined) return { ok: false, diagnostics: 'no candidate mount context' }
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
    this.currentMounted = [...snapshot.mounted]
  }

  mounted(): readonly string[] {
    return this.currentMounted
  }

  private async restorePriorOwner(candidateId: string, mounts: readonly PriorOwnerMount[]): Promise<void> {
    for (const prior of mounts) {
      await this.ctx.plugin({
        name: prior.name,
        inject: [...prior.inject],
        apply: prior.apply as Plugin.Function,
      }, prior.config)
    }
    this.priorOwners.delete(candidateId)
  }
}
