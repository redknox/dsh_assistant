import { requiresIsolatedGeneratedRuntime } from '../generated-runtime/trust.js'
import { CORE_BOOTSTRAP_INVENTORY } from '../registry/bootstrap.js'

export type ExecutionClass = 'host-in-process' | 'isolated-generated'
export type OwnerReplaceability = 'replaceable' | 'host-owned-irreplaceable'

export const HOST_PRODUCT_DOMAINS = Object.freeze(['ui'] as const)

/** Host-declared executable seam. Catalog `ui` or self-reported capabilities are not this. */
export const TRUSTED_FRONTEND_EXTENSION_SEAM = 'ui.frontend-extension'

export const HOST_OWNED_IRREPLACEABLE_OWNERS: ReadonlySet<string> = new Set(
  CORE_BOOTSTRAP_INVENTORY
    .filter((item) => (item.services?.length ?? 0) > 0 || (item.providers?.length ?? 0) > 0)
    .map((item) => item.owner),
)

export const ACTIVATION_COMPATIBILITY_REASONS = {
  isolatedServices: 'isolated-runtime-forbids-services-or-providers',
  hostOwnedNotReplaceable: 'host-owned-owner-not-replaceable',
  hostProductChange: 'host-product-change-required',
} as const

export interface OwnerExecutionFacts {
  readonly owner: string
  readonly provenanceKind?: string
  readonly origin?: string
  readonly services?: readonly string[]
  readonly providers?: readonly string[]
}

export interface ActivationCompatibilityInput extends OwnerExecutionFacts {
  readonly resolutionKind?: string
  readonly resolutionCapability?: string
  readonly capabilities?: readonly string[]
  readonly runtimeContractVersion?: string
  readonly activeOwner?: OwnerExecutionFacts
}

export interface ActivationCompatibilityDenial {
  readonly reason: string
  readonly detail: string
}

export interface ActivationCompatibilityResult {
  readonly ok: boolean
  readonly executionClass: ExecutionClass
  readonly replaceability: OwnerReplaceability
  readonly denials: readonly ActivationCompatibilityDenial[]
}

export function domainOfCapability(capability: string): string {
  const index = capability.indexOf('.')
  return index === -1 ? capability : capability.slice(0, index)
}

export function isHostProductCapability(capability: string | undefined): boolean {
  if (capability === undefined || capability === '') return false
  return (HOST_PRODUCT_DOMAINS as readonly string[]).includes(domainOfCapability(capability))
}

export function isHostOwnedIrreplaceable(facts: OwnerExecutionFacts): boolean {
  if (HOST_OWNED_IRREPLACEABLE_OWNERS.has(facts.owner)) return true
  const services = facts.services ?? []
  const providers = facts.providers ?? []
  if (services.length === 0 && providers.length === 0) return false
  return facts.provenanceKind === 'managed' || facts.owner.startsWith('managed/')
}

export function classifyOwnerExecution(facts: OwnerExecutionFacts): {
  readonly executionClass: ExecutionClass
  readonly replaceability: OwnerReplaceability
} {
  const isolated = requiresIsolatedGeneratedRuntime({
    owner: facts.owner,
    provenanceKind: facts.provenanceKind,
    origin: facts.origin,
  })
  return {
    executionClass: isolated ? 'isolated-generated' : 'host-in-process',
    replaceability: isHostOwnedIrreplaceable(facts) ? 'host-owned-irreplaceable' : 'replaceable',
  }
}

export function isHostProductChangeNeed(capability: string, domainOwner?: OwnerExecutionFacts): boolean {
  if (isHostProductCapability(capability)) return true
  return domainOwner !== undefined && isHostOwnedIrreplaceable(domainOwner)
}

export function hasTrustedFrontendExtensionSeam(hostSeams?: readonly string[]): boolean {
  return hostSeams?.includes(TRUSTED_FRONTEND_EXTENSION_SEAM) === true
}

export function evaluateActivationCompatibility(input: ActivationCompatibilityInput): ActivationCompatibilityResult {
  const isolated = requiresIsolatedGeneratedRuntime({
    owner: input.owner,
    provenanceKind: input.provenanceKind,
    origin: input.origin,
  })
  const target = input.activeOwner ?? input
  const classified = classifyOwnerExecution({
    owner: input.owner,
    provenanceKind: input.provenanceKind,
    origin: input.origin,
    services: target.services,
    providers: target.providers,
  })
  const denials: ActivationCompatibilityDenial[] = []
  const services = input.services ?? []
  const providers = input.providers ?? []
  if (isolated && (services.length > 0 || providers.length > 0)) {
    denials.push({
      reason: ACTIVATION_COMPATIBILITY_REASONS.isolatedServices,
      detail: 'generated runtime does not proxy services or providers',
    })
  }
  if (isolated && isHostOwnedIrreplaceable(target)) {
    denials.push({
      reason: ACTIVATION_COMPATIBILITY_REASONS.hostOwnedNotReplaceable,
      detail: `${input.owner} is a host-owned in-process owner and cannot be replaced by an isolated assistant-origin candidate`,
    })
  }
  const capabilities = [
    ...(input.resolutionCapability === undefined ? [] : [input.resolutionCapability]),
    ...(input.capabilities ?? []),
  ]
  if (isolated && capabilities.some((id) => isHostProductCapability(id))) {
    denials.push({
      reason: ACTIVATION_COMPATIBILITY_REASONS.hostProductChange,
      detail: 'WUI/frontend host composition requires a trusted product change, not an isolated generated tool',
    })
  }
  return {
    ok: denials.length === 0,
    executionClass: isolated ? 'isolated-generated' : classified.executionClass,
    replaceability: isHostOwnedIrreplaceable(target) ? 'host-owned-irreplaceable' : 'replaceable',
    denials,
  }
}
