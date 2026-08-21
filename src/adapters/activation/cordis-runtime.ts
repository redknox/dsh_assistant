import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ActivationPrepareContext, ActivationRuntime } from '../../domain/governance/runtime.js'
import type { ActivationSnapshot } from '../../domain/governance/types.js'

function probeName(candidateId: string): string {
  return `activated__${candidateId.replaceAll(/[^A-Za-z0-9_]/g, '_')}`
}

function textOutput() {
  return {
    schema: { type: 'string' as const },
    render(_args: unknown, value: string) {
      return [{ type: 'text' as const, text: value }]
    },
  }
}

/** Production adapter: mount/unmount a real Cordis fiber for the candidate. */
export class CordisActivationRuntime implements ActivationRuntime {
  private readonly fibers = new Map<string, { dispose: () => Promise<unknown> }>()
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
    try {
      const fiber = await this.ctx.plugin({
        name: `activated:${candidateId}`,
        inject: ['tools'],
        apply: (scope: Context) => {
          const dispose = scope.tools.register(defineTool({
            name: probeName(candidateId),
            description: 'Governed activation probe. Not a capability grant.',
            parameters: {},
            output: textOutput(),
            async execute() {
              return 'mounted'
            },
          }))
          scope.effect(() => dispose)
        },
      })
      this.fibers.set(candidateId, fiber)
      return { ok: true }
    } catch (error) {
      return { ok: false, diagnostics: error instanceof Error ? error.message : String(error) }
    }
  }

  async verifyHealth(candidateId: string, expected: readonly string[]): Promise<{ ok: boolean; diagnostics?: string }> {
    if (!this.ctx.tools.get(probeName(candidateId))) {
      return { ok: false, diagnostics: `activation probe ${probeName(candidateId)} is not mounted` }
    }
    const missing: string[] = []
    for (const name of this.lastContext?.tools ?? []) {
      if (name !== '' && this.ctx.tools.get(name) === undefined) missing.push(`tool:${name}`)
    }
    for (const name of this.lastContext?.services ?? []) {
      if (name !== '' && this.ctx.get(name) === undefined) missing.push(`service:${name}`)
    }
    const tools = this.ctx.tools as { list?: () => { name: string }[] }
    const listed = typeof tools.list === 'function' ? tools.list().map((item) => item.name) : []
    const duplicates = listed.filter((name, index) => listed.indexOf(name) !== index)
    if (duplicates.length > 0) return { ok: false, diagnostics: `duplicate tools: ${duplicates.join(', ')}` }
    if (missing.length > 0) return { ok: false, diagnostics: `missing public seams: ${missing.join(', ')}` }
    void expected
    return { ok: true }
  }

  async commit(candidateId: string): Promise<void> {
    if (!this.currentMounted.includes(candidateId)) this.currentMounted = [...this.currentMounted, candidateId]
  }

  async restore(snapshot: ActivationSnapshot): Promise<void> {
    for (const [id, fiber] of this.fibers) {
      if (!snapshot.mounted.includes(id)) {
        await fiber.dispose()
        this.fibers.delete(id)
      }
    }
    this.currentMounted = [...snapshot.mounted]
  }

  mounted(): readonly string[] {
    return this.currentMounted
  }
}
