import { cloneRecord } from './normalize.js'
import type { RegistryRecord } from './types.js'

/**
 * Replaceable persistence port. Storage adapters keep snapshots;
 * they are not the domain model.
 */
export interface RegistryPersistence {
  load(): RegistryRecord[]
  save(records: readonly RegistryRecord[]): void
}

export class InMemoryRegistryPersistence implements RegistryPersistence {
  private snapshot: RegistryRecord[] = []

  load(): RegistryRecord[] {
    return this.snapshot.map(cloneRecord)
  }

  save(records: readonly RegistryRecord[]): void {
    this.snapshot = records.map(cloneRecord)
  }
}
