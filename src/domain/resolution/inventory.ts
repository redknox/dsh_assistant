import { CORE_BOOTSTRAP_INVENTORY } from '../registry/bootstrap.js'
import type { ArchitectureInventory } from './types.js'

/** Seams the Core MVP already exposes. Completeness is a caller fact, not inferred. */
export const CORE_KNOWN_SEAMS: readonly string[] = [
  ...new Set(CORE_BOOTSTRAP_INVENTORY.flatMap((record) => record.runtimeSeams)),
]

/** Default review inventory: known seams, but not a proof of absence. */
export const DEFAULT_RESOLUTION_INVENTORY: ArchitectureInventory = {
  complete: false,
  seams: CORE_KNOWN_SEAMS,
}
