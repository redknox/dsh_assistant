import { isolatedRuntimeOwner } from '../generated-runtime/trust.js'
import { candidateDirName } from '../candidate/paths.js'
import type { CandidateRecord } from '../candidate/types.js'
import type { GovernanceHydrate } from '../governance/service.js'
import type { CapabilityRegistry } from '../registry/types.js'
import { DurableReviewLineage } from './review-lineage.js'
import { DurableWorkbenchStore } from './workbench-store.js'
import { DurableAuthorityStore } from './authority-store.js'
import { DurableCandidateIndex } from './candidate-index.js'
import { PersistenceIntegrityError, PersistenceSchemaError } from './errors.js'
import { ensureSelfExtensionHome, resolveAssistantHome, type SelfExtensionHome } from './home.js'

export interface DurableSelfExtension {
  readonly home: SelfExtensionHome
  readonly authority: DurableAuthorityStore
  readonly candidates: DurableCandidateIndex
  readonly reviews: DurableReviewLineage
  readonly workbench: DurableWorkbenchStore
}

export interface DurableOpenResult {
  readonly durable?: DurableSelfExtension
  readonly loadError?: Error
  readonly diagnostics: readonly string[]
}

export function openDurableSelfExtension(explicitHome?: string): DurableOpenResult {
  const root = resolveAssistantHome(explicitHome)
  if (root === undefined) return { diagnostics: [] }
  const home = ensureSelfExtensionHome(root)
  try {
    const authority = new DurableAuthorityStore(home)
    return {
      durable: {
        home,
        authority,
        candidates: new DurableCandidateIndex(home),
        reviews: new DurableReviewLineage(home, authority),
        workbench: new DurableWorkbenchStore(home),
      },
      diagnostics: [],
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    return { loadError: err, diagnostics: [err.message] }
  }
}

export function hydrateFromAuthority(authority: DurableAuthorityStore): GovernanceHydrate {
  const file = authority.snapshot()
  return {
    approvals: file.governance.approvals,
    nextApproval: file.governance.nextApproval,
    generation: file.activation.generation,
    state: file.activation.state,
    phase: file.activation.phase,
    pendingCandidateId: file.activation.pendingCandidateId,
    current: file.recovery.current,
    lastKnownGood: file.recovery.lastKnownGood,
    rollbackTarget: file.recovery.rollbackTarget,
    lastFailure: file.recovery.lastFailure,
    safeMode: file.recovery.safeMode,
    integrityVerified: file.recovery.integrityVerified,
  }
}

export function persistGovernance(authority: DurableAuthorityStore, hydrate: GovernanceHydrate): void {
  const current = authority.snapshot()
  authority.commitAll({
    schemaVersion: current.schemaVersion,
    registry: current.registry,
    governance: { approvals: hydrate.approvals, nextApproval: hydrate.nextApproval },
    activation: {
      state: hydrate.state,
      generation: hydrate.generation,
      phase: hydrate.phase,
      pendingCandidateId: hydrate.pendingCandidateId,
    },
    recovery: {
      current: hydrate.current,
      lastKnownGood: hydrate.lastKnownGood,
      rollbackTarget: hydrate.rollbackTarget,
      lastFailure: hydrate.lastFailure,
      safeMode: hydrate.safeMode,
      integrityVerified: hydrate.integrityVerified,
      diagnostics: current.recovery.diagnostics,
    },
    reviewLineage: current.reviewLineage ?? { generation: 0 },
  })
}

export function persistCandidates(
  index: DurableCandidateIndex,
  records: readonly CandidateRecord[],
  registry: CapabilityRegistry,
): void {
  const active = new Set(
    registry.list({ status: 'active' })
      .filter((record) => isolatedRuntimeOwner(record))
      .map((record) => candidateDirName(record.owner, record.version)),
  )
  index.save(records, active)
}

export function isPersistenceFailure(error: unknown): boolean {
  return error instanceof PersistenceIntegrityError || error instanceof PersistenceSchemaError
}
