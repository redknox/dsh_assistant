import type { ActivationSnapshot } from './types.js'

export interface ActivationPrepareContext {
  readonly workspaceRoot: string
  readonly entryPoints: readonly string[]
  readonly owner: string
  readonly resolutionKind: string
  readonly baseVersion?: string
  readonly tools: readonly string[]
  readonly services: readonly string[]
  readonly providers: readonly string[]
  readonly runtimeSeams: readonly string[]
}

export interface ActivationRuntime {
  snapshot(generation: number, owners: ActivationSnapshot['owners']): ActivationSnapshot
  prepare(candidateId: string, context?: ActivationPrepareContext): Promise<{ ok: boolean; diagnostics?: string }>
  verifyHealth(candidateId: string, expectedSeams: readonly string[]): Promise<{ ok: boolean; diagnostics?: string }>
  commit(candidateId: string): Promise<void>
  restore(snapshot: ActivationSnapshot): Promise<void>
  mounted(): readonly string[]
}

export class InMemoryActivationRuntime implements ActivationRuntime {
  private currentMounted: string[] = []
  failPrepare = false
  failHealth = false

  snapshot(generation: number, owners: ActivationSnapshot['owners']): ActivationSnapshot {
    return {
      generation,
      capturedAt: new Date().toISOString(),
      owners,
      profileIdentity: 'assistant-core',
      mounted: [...this.currentMounted],
    }
  }

  async prepare(_candidateId: string): Promise<{ ok: boolean; diagnostics?: string }> {
    if (this.failPrepare) return { ok: false, diagnostics: 'prepare/mount failed' }
    return { ok: true }
  }

  async verifyHealth(_candidateId: string, _expectedSeams: readonly string[]): Promise<{ ok: boolean; diagnostics?: string }> {
    if (this.failHealth) return { ok: false, diagnostics: 'post-activation health verification failed' }
    return { ok: true }
  }

  async commit(candidateId: string): Promise<void> {
    if (!this.currentMounted.includes(candidateId)) this.currentMounted = [...this.currentMounted, candidateId]
  }

  async restore(snapshot: ActivationSnapshot): Promise<void> {
    this.currentMounted = [...snapshot.mounted]
  }

  mounted(): readonly string[] {
    return this.currentMounted
  }
}
