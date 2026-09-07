import type { RegistryRecord } from '../registry/types.js'
import type { CandidateDiff, CandidateManifest, NamedDiff } from './types.js'

function namedDiff(current: readonly string[], next: readonly string[]): NamedDiff {
  const before = new Set(current)
  const after = new Set(next)
  return {
    added: next.filter((item) => !before.has(item)),
    removed: current.filter((item) => !after.has(item)),
    changed: [],
  }
}

export function diffAgainstBase(manifest: CandidateManifest, base?: RegistryRecord): CandidateDiff {
  const commands = namedDiff(base?.commands ?? [], manifest.commands.map((item) => item.name))
  return {
    owner: manifest.owner,
    baseVersion: base?.version ?? manifest.baseVersion,
    candidateVersion: manifest.version,
    capabilities: namedDiff(base?.capabilities.map((item) => item.id) ?? [], manifest.capabilities),
    permissions: namedDiff(base?.permissions ?? [], manifest.permissions),
    tools: namedDiff(base?.tools ?? [], manifest.tools),
    services: namedDiff(base?.services ?? [], manifest.services),
    providers: namedDiff(base?.providers ?? [], manifest.providers),
    workflows: namedDiff(base?.workflows ?? [], manifest.workflows.map((item) => item.name)),
    ...(commands.added.length === 0 && commands.removed.length === 0 && commands.changed.length === 0 ? {} : { commands }),
    runtimeSeams: namedDiff(base?.runtimeSeams ?? [], manifest.runtimeSeams),
    effects: manifest.effects,
    ...(manifest.runtimeContractVersion === undefined ? {} : { runtimeContractVersion: manifest.runtimeContractVersion }),
  }
}
