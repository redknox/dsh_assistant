import { parseCapabilityId, parseOwnerId, parsePermission, parseVersion } from '../registry/normalize.js'
import type { ExtensionProvenance } from '../registry/types.js'
import type { ResolutionKind, ResolutionReview } from '../resolution/types.js'
import { CandidateContractError } from './errors.js'
import type { CandidateManifest, CandidateManifestInput, OperationalEffects, PluginCapabilityDependency, RemoteSideEffect } from './types.js'
import { PLUGIN_DEPENDENCY_STRENGTHS, REMOTE_SIDE_EFFECTS } from './types.js'

const CHANGE_KINDS: readonly ResolutionKind[] = [
  'configure',
  'evolve-owner',
  'adopt-existing',
  'implement-provider',
  'new-plugin',
]

const emptyEffects = (): OperationalEffects => ({
  filesystem: [],
  network: [],
  process: [],
  secrets: [],
  externalSystems: [],
  remoteSideEffect: 'none',
})

function resolveRemoteSideEffect(effects: Partial<OperationalEffects>): RemoteSideEffect {
  if (effects.remoteSideEffect !== undefined && (REMOTE_SIDE_EFFECTS as readonly string[]).includes(effects.remoteSideEffect)) {
    return effects.remoteSideEffect
  }
  const external = (effects.network ?? []).length > 0 || (effects.secrets ?? []).length > 0
  return external ? 'mutate' : 'none'
}

export function assertChangeReview(review: ResolutionReview): void {
  if (!CHANGE_KINDS.includes(review.kind)) {
    throw new CandidateContractError(`resolution kind ${review.kind} does not justify a candidate`)
  }
}

export function defaultProvenance(review: ResolutionReview, owner: string): ExtensionProvenance {
  if (owner.startsWith('third-party/')) {
    return { kind: 'third-party', origin: 'import' }
  }
  if (review.kind === 'new-plugin' || owner.startsWith('generated/')) {
    return { kind: 'generated', origin: 'assistant' }
  }
  return { kind: 'managed', origin: 'assistant' }
}

export function normalizeManifest(
  review: ResolutionReview,
  owner: string,
  version: string,
  baseVersion: string | undefined,
  provenance: ExtensionProvenance,
  input: CandidateManifestInput = {},
): CandidateManifest {
  assertChangeReview(review)
  const effects = input.effects ?? {}
  const permissions = (input.permissions ?? []).map(parsePermission)
  const runtimeContractVersion = resolveRuntimeContractVersion(provenance.kind, input.runtimeContractVersion)
  return {
    owner: parseOwnerId(owner),
    version: parseVersion(version),
    provenance,
    baseVersion: baseVersion === undefined ? undefined : parseVersion(baseVersion),
    resolutionKind: review.kind,
    resolutionCapability: parseCapabilityId(review.capability),
    resolutionNeed: review.need,
    capabilities: (input.capabilities ?? []).map((item) => parseCapabilityId(item)),
    permissions,
    runtimeSeams: [...(input.runtimeSeams ?? [])],
    tools: [...(input.tools ?? [])],
    services: [...(input.services ?? [])],
    providers: [...(input.providers ?? [])],
    secrets: [...(input.secrets ?? [])],
    configRequired: [...(input.configRequired ?? [])],
    effects: {
      filesystem: [...(effects.filesystem ?? [])],
      network: [...(effects.network ?? [])],
      process: [...(effects.process ?? [])],
      secrets: [...(effects.secrets ?? [])],
      externalSystems: [...(effects.externalSystems ?? [])],
      remoteSideEffect: resolveRemoteSideEffect(effects),
    },
    entryPoints: [...(input.entryPoints ?? [])],
    validationTasks: (input.validationTasks ?? []).map((task) => ({
      name: task.name,
      argv: task.argv === undefined ? undefined : [...task.argv],
      script: task.script,
    })),
    riskModel: input.riskModel,
    runtimeContractVersion,
    pluginDependencies: normalizePluginDependencies(input.pluginDependencies),
  }
}

function normalizePluginDependencies(input?: readonly PluginCapabilityDependency[]): readonly PluginCapabilityDependency[] {
  if (input === undefined) return []
  return input.map((item, index) => {
    if (!item || typeof item.capability !== 'string' || !(PLUGIN_DEPENDENCY_STRENGTHS as readonly string[]).includes(item.strength)) {
      throw new CandidateContractError(`malformed pluginDependencies[${index}]`)
    }
    return { capability: parseCapabilityId(item.capability), strength: item.strength }
  })
}

function resolveRuntimeContractVersion(provenanceKind: string, requested?: string): string | undefined {
  if (requested === '') return undefined
  if (requested !== undefined) return requested
  return provenanceKind === 'generated' || provenanceKind === 'third-party'
    ? 'generated-extension-api/v1'
    : undefined
}

export function emptyOperationalEffects(): OperationalEffects {
  return emptyEffects()
}
