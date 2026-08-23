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
  return {
    owner: manifest.owner,
    baseVersion: base?.version ?? manifest.baseVersion,
    candidateVersion: manifest.version,
    capabilities: namedDiff(base?.capabilities.map((item) => item.id) ?? [], manifest.capabilities),
    permissions: namedDiff(base?.permissions ?? [], manifest.permissions),
    tools: namedDiff(base?.tools ?? [], manifest.tools),
    services: namedDiff(base?.services ?? [], manifest.services),
    providers: namedDiff(base?.providers ?? [], manifest.providers),
    runtimeSeams: namedDiff(base?.runtimeSeams ?? [], manifest.runtimeSeams),
    effects: manifest.effects,
    ...(manifest.runtimeContractVersion === undefined ? {} : { runtimeContractVersion: manifest.runtimeContractVersion }),
  }
}
