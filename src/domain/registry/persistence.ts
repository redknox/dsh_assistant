import type { RegistryRecordSnapshot } from './snapshot.js'

/**
 * Replaceable persistence port. Adapters store {@link RegistryRecordSnapshot}
 * DTOs only. Domain {@link import('./types.js').RegistryRecord} is decoded by the service.
 */
export interface RegistryPersistence {
  load(): readonly unknown[]
  save(records: readonly RegistryRecordSnapshot[]): void
}

export class InMemoryRegistryPersistence implements RegistryPersistence {
  constructor(private snapshot: unknown[] = []) {}

  load(): unknown[] {
    return this.snapshot.map((row) => structuredClone(row))
  }

  save(records: readonly RegistryRecordSnapshot[]): void {
    this.snapshot = records.map((row) => structuredClone(row))
  }
}
