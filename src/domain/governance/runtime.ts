import type { ActivationSnapshot } from './types.js'

export interface ActivationRuntime {
  snapshot(generation: number, owners: ActivationSnapshot['owners']): ActivationSnapshot
  prepare(candidateId: string): { ok: boolean; diagnostics?: string }
  verifyHealth(candidateId: string, expectedSeams: readonly string[]): { ok: boolean; diagnostics?: string }
  commit(candidateId: string): void
  restore(snapshot: ActivationSnapshot): void
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

  prepare(_candidateId: string): { ok: boolean; diagnostics?: string } {
    if (this.failPrepare) return { ok: false, diagnostics: 'prepare/mount failed' }
    return { ok: true }
  }

  verifyHealth(_candidateId: string, _expectedSeams: readonly string[]): { ok: boolean; diagnostics?: string } {
    if (this.failHealth) return { ok: false, diagnostics: 'post-activation health verification failed' }
    return { ok: true }
  }

  commit(candidateId: string): void {
    if (!this.currentMounted.includes(candidateId)) this.currentMounted = [...this.currentMounted, candidateId]
  }

  restore(snapshot: ActivationSnapshot): void {
    this.currentMounted = [...snapshot.mounted]
  }

  mounted(): readonly string[] {
    return this.currentMounted
  }
}
