import { parseCapabilityId, parseOwnerId, parseVersion } from '../registry/normalize.js'
import type { ExtensionProvenance } from '../registry/types.js'
import type { ResolutionKind, ResolutionReview } from '../resolution/types.js'
import { CandidateContractError } from './errors.js'
import type { CandidateManifest, CandidateManifestInput, OperationalEffects, RemoteSideEffect } from './types.js'
import { REMOTE_SIDE_EFFECTS } from './types.js'

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
  if (review.kind === 'new-plugin' || owner.startsWith('generated/')) {
    return { kind: 'generated', origin: 'assistant' }
  }
  return { kind: 'managed', origin: 'human' }
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
  return {
    owner: parseOwnerId(owner),
    version: parseVersion(version),
    provenance,
    baseVersion: baseVersion === undefined ? undefined : parseVersion(baseVersion),
    resolutionKind: review.kind,
    resolutionCapability: parseCapabilityId(review.capability),
    resolutionNeed: review.need,
    capabilities: (input.capabilities ?? []).map((item) => parseCapabilityId(item)),
    permissions: [...(input.permissions ?? [])],
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
  }
}

export function emptyOperationalEffects(): OperationalEffects {
  return emptyEffects()
}
