import type { RollbackCard, WorkspaceSnapshotInput } from './types.js'

type SnapshotOwners = readonly { readonly owner: string; readonly version: string; readonly capabilities?: readonly string[] }[]

export function projectRollbackCard(input: WorkspaceSnapshotInput, systemState: string): RollbackCard | undefined {
  if (systemState === 'SAFE_MODE' || systemState === 'RECOVERY') return undefined
  if (input.recoveryRequired || input.safeMode) return undefined
  if (input.activation?.lifecycleBusy !== undefined) return undefined
  const plan = input.activation?.rollbackPlan
  if (plan === undefined || !plan.available) return undefined
  const current = input.activation?.current
  const target = input.activation?.rollbackTarget ?? input.activation?.lastKnownGood
  if (current === undefined || target === undefined) return undefined
  if (current.generation !== plan.currentGeneration || target.generation !== plan.targetGeneration) return undefined
  const ownerChanges = diffOwners(current.owners, target.owners)
  const capabilityDiff = namedDiff(capabilitiesOf(input, current.owners), capabilitiesOf(input, target.owners))
  const toolDiff = namedDiff(toolsOf(input, current.owners), toolsOf(input, target.owners))
  const mountDiff = namedDiff(current.mounted ?? [], target.mounted ?? [])
  return {
    id: plan.id,
    kind: 'system-state-rollback',
    title: 'Rollback system state',
    currentGeneration: plan.currentGeneration,
    targetGeneration: plan.targetGeneration,
    fingerprint: plan.fingerprint,
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
