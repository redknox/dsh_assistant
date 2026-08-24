import { createHash } from 'node:crypto'
import { isolatedRuntimeOwner } from '../generated-runtime/trust.js'
import type { RollbackCard, WorkspaceSnapshotInput } from './types.js'

type SnapshotOwners = readonly { readonly owner: string; readonly version: string; readonly capabilities?: readonly string[] }[]

export function projectRollbackCard(input: WorkspaceSnapshotInput, systemState: string): RollbackCard | undefined {
  if (systemState === 'SAFE_MODE' || systemState === 'RECOVERY') return undefined
  if (input.recoveryRequired || input.safeMode) return undefined
  if (input.activation?.lifecycleBusy !== undefined) return undefined
  if (input.activation?.state === 'activating' || input.activation?.state === 'activation-pending' || input.activation?.state === 'rollback-pending') {
    return undefined
  }
  const current = input.activation?.current
  const target = input.activation?.rollbackTarget ?? input.activation?.lastKnownGood
  if (current === undefined || target === undefined) return undefined
  const currentOwners = keys(current.owners)
  const targetOwners = keys(target.owners)
  if (currentOwners.join('\n') === targetOwners.join('\n')) return undefined
  if (current.generation === target.generation) return undefined
  if (unverifiedTarget(input, target.owners)) return undefined
  const ownerChanges = diffOwners(current.owners, target.owners)
  const capabilityDiff = namedDiff(capabilitiesOf(input, current.owners), capabilitiesOf(input, target.owners))
  const toolDiff = namedDiff(toolsOf(input, current.owners), toolsOf(input, target.owners))
  const mountDiff = namedDiff(current.mounted ?? [], target.mounted ?? [])
  const fingerprint = rollbackFingerprint({
    currentGeneration: current.generation,
    targetGeneration: target.generation,
    currentOwners,
    targetOwners,
  })
  return {
    id: `rollback-${current.generation}-${target.generation}`,
    kind: 'system-state-rollback',
    title: 'Rollback system state',
    currentGeneration: current.generation,
    targetGeneration: target.generation,
    fingerprint,
    reason: 'An authoritative previous last-known-good snapshot is available and differs from the current system state.',
    ownerChanges,
    capabilitiesAdded: capabilityDiff.added,
    capabilitiesRemoved: capabilityDiff.removed,
    toolsAdded: toolDiff.added,
    toolsRemoved: toolDiff.removed,
    mountsAdded: mountDiff.added,
    mountsRemoved: mountDiff.removed,
    recoveryRequired: false,
    actionable: true,
  }
}

export function rollbackFingerprint(input: {
  readonly currentGeneration: number
  readonly targetGeneration: number
  readonly currentOwners: readonly string[]
  readonly targetOwners: readonly string[]
}): string {
  return createHash('sha256').update(JSON.stringify({
    currentGeneration: input.currentGeneration,
    targetGeneration: input.targetGeneration,
    currentOwners: [...input.currentOwners].sort(),
    targetOwners: [...input.targetOwners].sort(),
  })).digest('hex')
}

function keys(owners: SnapshotOwners): string[] {
  return owners.map((item) => `${item.owner}@${item.version}`).sort()
}

function diffOwners(current: SnapshotOwners, target: SnapshotOwners): RollbackCard['ownerChanges'] {
  const currentMap = new Map(current.map((item) => [item.owner, item.version]))
  const targetMap = new Map(target.map((item) => [item.owner, item.version]))
  const owners = [...new Set([...currentMap.keys(), ...targetMap.keys()])].sort()
  const changes: RollbackCard['ownerChanges'][number][] = []
  for (const owner of owners) {
    const from = currentMap.get(owner)
    const to = targetMap.get(owner)
    if (from === to) continue
    if (from === undefined && to !== undefined) {
      changes.push({ owner, to, change: 'activate' })
      continue
    }
    if (from !== undefined && to === undefined) {
      changes.push({ owner, from, change: 'disable' })
      continue
    }
    changes.push({
      owner,
      from,
      to,
      change: (to ?? '') < (from ?? '') ? 'downgrade' : 'upgrade',
    })
  }
  return changes
}

function capabilitiesOf(input: WorkspaceSnapshotInput, owners: SnapshotOwners): string[] {
  const wanted = new Set(keys(owners))
  return [...new Set(input.registry
    .filter((item) => wanted.has(`${item.owner}@${item.version}`))
    .flatMap((item) => item.capabilities))].sort()
}

function toolsOf(input: WorkspaceSnapshotInput, owners: SnapshotOwners): string[] {
  const wanted = new Set(keys(owners))
  return [...new Set(input.registry
    .filter((item) => wanted.has(`${item.owner}@${item.version}`))
    .flatMap((item) => item.tools ?? []))].sort()
}

function namedDiff(current: readonly string[], target: readonly string[]): { added: string[]; removed: string[] } {
  const now = new Set(current)
  const next = new Set(target)
  return {
    added: [...next].filter((item) => !now.has(item)).sort(),
    removed: [...now].filter((item) => !next.has(item)).sort(),
  }
}

function unverifiedTarget(input: WorkspaceSnapshotInput, owners: SnapshotOwners): boolean {
  const candidates = input.candidates ?? []
  for (const owner of owners) {
    const record = input.registry.find((item) => item.owner === owner.owner && item.version === owner.version)
    if (record === undefined) return true
    if (!isolatedRuntimeOwner({ owner: record.owner, provenance: { kind: record.provenance } })) continue
    const candidate = candidates.find((item) => item.owner === owner.owner && item.version === owner.version)
    if (candidate === undefined || candidate.sealed !== true || candidate.digest === undefined || candidate.digest === '') {
      return true
    }
  }
  return false
}
