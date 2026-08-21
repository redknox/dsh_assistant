import type { MemoryRecord } from './types.js'

/**
 * Replaceable persistence port. Domain records stay owned by the memory service;
 * adapters store snapshots and must not become the domain model.
 */
export interface MemoryPersistence {
  load(): MemoryRecord[]
  save(records: readonly MemoryRecord[]): void
}

export class InMemoryPersistence implements MemoryPersistence {
  private snapshot: MemoryRecord[] = []

  load(): MemoryRecord[] {
    return this.snapshot.map((record) => ({ ...record }))
  }

  save(records: readonly MemoryRecord[]): void {
    this.snapshot = records.map((record) => ({ ...record }))
  }
}
