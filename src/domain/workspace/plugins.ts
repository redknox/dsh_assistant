import { analyzePluginDependents } from '../governance/dependents.js'
import { isolatedRuntimeOwner } from '../generated-runtime/trust.js'
import type { UserPluginView, WorkspaceSnapshotInput } from './types.js'

export function projectUserPlugins(input: WorkspaceSnapshotInput): readonly UserPluginView[] {
  const generation = input.activation?.generation ?? 0
  const cards: UserPluginView[] = []
  for (const record of input.registry) {
    if (record.status !== 'active') continue
    if (!isolatedRuntimeOwner({ owner: record.owner, provenance: { kind: record.provenance } })) continue
    const candidate = input.candidates?.find((item) => item.owner === record.owner && item.version === record.version)
    const dependency = analyzePluginDependents({
      owner: record.owner,
      version: record.version,
      capabilities: record.capabilities,
      registry: input.registry,
    })
    cards.push({
      id: `uninst-${record.owner}@${record.version}`,
      owner: record.owner,
      version: record.version,
      provenance: record.provenance,
      candidateId: candidate?.id,
      digest: candidate?.digest,
      capabilities: [...record.capabilities],
      tools: [...(record.tools ?? [])],
      mounted: input.activation?.mounted?.includes(candidate?.id ?? '') === true,
      registryGeneration: generation,
      dependency,
      uninstallable: true,
    })
  }
  return cards
}
