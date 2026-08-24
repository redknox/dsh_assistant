import { isEligible, type CapabilityDiscovery } from '../discovery/index.js'
import type { DiscoveryFacts } from '../discovery/types.js'
import { isHostOwnedIrreplaceable, isHostProductChangeNeed } from '../activation-compatibility/index.js'
import { parseCapabilityId } from '../registry/normalize.js'
import type { RegistryRecord } from '../registry/types.js'
import type {
  CapabilityResolution,
  KnownPluginOption,
  KnownProviderOption,
  RegistryReadModel,
  ResolutionKind,
  ResolutionOption,
  ResolutionRequest,
  ResolutionReview,
  ResolutionStep,
  ResolutionTarget,
} from './types.js'

function domainOf(capability: string): string {
  return capability.slice(0, capability.indexOf('.'))
}

function capabilitiesOf(record: RegistryRecord): readonly string[] {
  return record.capabilities.map((item) => item.id)
}

function providerCompatibleWithNeed(option: KnownProviderOption, capability: string): boolean {
  return option.capabilities?.includes(capability) === true
    || option.domains?.includes(domainOf(capability)) === true
}

function wantsProviderSwap(
  providers: readonly KnownProviderOption[] | undefined,
  owner: RegistryRecord,
  capability: string,
): KnownProviderMatch | undefined {
  return providers?.find((item) => (
    providerCompatibleWithNeed(item, capability)
    && owner.runtimeSeams.includes(item.seam)
    && item.provider !== owner.provider
  ))
}

interface KnownProviderMatch {
  readonly provider: string
  readonly seam: string
}

export class ResolutionService implements CapabilityResolution {
  constructor(
    private readonly registry: RegistryReadModel,
    private readonly discovery?: CapabilityDiscovery,
  ) {}

  review(request: ResolutionRequest): ResolutionReview {
    const capability = parseCapabilityId(request.capability)
    const exact = this.registry.resolveActiveOwner(capability)
    const conflicts = this.registry.conflicts().filter((item) => item.capability === capability)
    const records = this.registry.list()
    const domain = domainOf(capability)
    const domainOwners = records
      .filter((record) => record.status === 'active' && record.capabilities.some((item) => domainOf(item.id) === domain))
      .map((record) => ({
        owner: record.owner,
        version: record.version,
        capabilities: capabilitiesOf(record),
      }))
    const discovered = this.discovery?.search({ capability, need: request.need })
    const discoveryFacts: DiscoveryFacts = discovered === undefined
      ? { status: 'not-queried', records: [], rejected: [], diagnostics: [] }
      : {
        status: discovered.status,
        records: discovered.records,
        rejected: discovered.records
          .filter((item) => item.eligibility === 'rejected' || item.rejectionReason !== undefined)
          .map((item) => ({ identity: item.identity, reason: item.rejectionReason ?? item.eligibility })),
        diagnostics: discovered.diagnostics,
      }
    const eligible = discovered?.records.filter(isEligible) ?? []
    const discoveredProviders: KnownProviderOption[] = eligible
      .filter((item) => item.provider !== undefined && item.seams.length > 0)
      .flatMap((item) => item.seams.map((seam) => ({
        provider: item.provider!,
        seam,
        capabilities: item.capabilities,
        domains: [...new Set(item.capabilities.map((id) => domainOf(id)).filter((id) => id !== ''))],
      })))
    const discoveredPlugins: KnownPluginOption[] = eligible
      .filter((item) => item.provider === undefined)
      .map((item) => ({
        owner: item.identity,
        version: item.version,
        capabilities: item.capabilities,
      }))
    const knownProviders = [...(request.knownProviders ?? []), ...discoveredProviders]
    const knownPlugins = [...(request.knownPlugins ?? []), ...discoveredPlugins]
    const discoveredSeams = eligible.flatMap((item) => item.seams)

    if (exact.kind === 'conflict' || conflicts.length > 0) {
      return this.finish(request, capability, 'conflict', {
        discoveryFacts,
        registryFacts: {
          exact,
          domainOwners,
          conflicts: exact.kind === 'conflict' ? [{ capability, records: exact.records }] : conflicts,
        },
        steps: [],
        recommendation: 'Resolve the active ownership conflict before changing anything.',
        rationale: 'Conflicting active owners are inspectable facts. Resolution does not pick a winner.',
        implications: this.discoveryImplications(discoveryFacts),
        assumptions: [],
        unresolved: ['Active ownership conflict must be resolved by a human before reuse, evolve, or new-plugin.'],
      })
    }

    const exactOwner = exact.kind === 'owner' ? exact.record : undefined
    const domainOwner = exactOwner ?? records.find((record) => (
      record.status === 'active' && record.capabilities.some((item) => domainOf(item.id) === domain)
    ))
    const domainOwnerFacts = domainOwner === undefined
      ? undefined
      : {
        owner: domainOwner.owner,
        provenanceKind: domainOwner.provenance.kind,
        origin: domainOwner.provenance.origin,
        services: domainOwner.services,
        providers: domainOwner.providers,
      }
    const hostOwnedIrreplaceable = domainOwnerFacts !== undefined && isHostOwnedIrreplaceable(domainOwnerFacts)
    const explicitProviderSwap = exactOwner === undefined
      ? undefined
      : wantsProviderSwap(request.knownProviders, exactOwner, capability)
    const providerSwap = exactOwner === undefined
      ? undefined
      : wantsProviderSwap(knownProviders, exactOwner, capability)
    const configure = request.permissionOptions?.find((item) => item.satisfiesNeed && (
      item.owner === exactOwner?.owner || item.owner === domainOwner?.owner
    ))
    const adoptableKnown = knownPlugins.find((item) => item.capabilities.includes(capability))
    const inactiveAdopt = exact.kind === 'inactive'
      ? exact.records.find((record) => record.status === 'candidate' || record.status === 'disabled')
      : undefined
    const providerOnSeam = knownProviders.find((item) => {
      if (!providerCompatibleWithNeed(item, capability)) return false
      const knownSeams = new Set([
        ...(request.inventory?.seams ?? []),
        ...discoveredSeams,
        ...records.flatMap((record) => record.runtimeSeams),
      ])
      return knownSeams.has(item.seam)
    })

    const steps: ResolutionStep[] = []

    const reuseAccepted = exactOwner !== undefined
      && request.alreadySatisfied !== false
      && request.behavior === undefined
      && explicitProviderSwap === undefined
      && configure === undefined
    steps.push(this.step('reuse', reuseAccepted, reuseAccepted
      ? `${exactOwner!.owner}@${exactOwner!.version} already owns ${capability}.`
      : exactOwner === undefined
        ? 'No active owner for this exact capability.'
        : explicitProviderSwap !== undefined
          ? `Active owner uses provider ${exactOwner.provider ?? 'none'}, not ${explicitProviderSwap.provider}.`
          : configure !== undefined
            ? 'Need is a known permission/config change, not reuse of the current set.'
            : 'Requested behavior is not already satisfied by the active owner.'))
    if (reuseAccepted) {
      return this.recommend(request, capability, 'reuse', steps, exact, domainOwners, conflicts, {
        owner: exactOwner.owner,
        version: exactOwner.version,
        seam: exactOwner.runtimeSeams[0],
        provider: exactOwner.provider,
      }, `Reuse ${exactOwner.owner}@${exactOwner.version}.`, 'An active owner already exposes the requested capability.', discoveryFacts)
    }

    const configureAccepted = configure !== undefined
    steps.push(this.step('configure', configureAccepted, configureAccepted
      ? `Enabling ${configure!.permission} on ${configure!.owner} satisfies the need.`
      : 'No supplied permission/config option satisfies the need.'))
    if (configureAccepted && configure) {
      return this.recommend(request, capability, 'configure', steps, exact, domainOwners, conflicts, {
        owner: configure.owner,
        version: exactOwner?.version ?? domainOwner?.version,
        permission: configure.permission,
        seam: exactOwner?.runtimeSeams[0] ?? domainOwner?.runtimeSeams[0],
      }, `Change configuration/permissions on ${configure.owner}.`, 'The existing owner can satisfy the need if a known permission or config is enabled.', discoveryFacts)
    }

    const evolveAccepted = domainOwner !== undefined && providerSwap === undefined && !hostOwnedIrreplaceable
    steps.push(this.step('evolve-owner', evolveAccepted, evolveAccepted
      ? `${domainOwner!.owner}@${domainOwner!.version} owns the ${domain} domain; evolve it instead of minting a parallel plugin.`
      : hostOwnedIrreplaceable && domainOwner !== undefined
        ? `${domainOwner.owner} is a host-owned in-process owner; isolated assistant-origin candidates cannot replace it.`
        : 'No active owner in this capability domain.'))
    if (evolveAccepted && domainOwner) {
      return this.recommend(request, capability, 'evolve-owner', steps, exact, domainOwners, conflicts, {
        owner: domainOwner.owner,
        version: domainOwner.version,
        seam: domainOwner.runtimeSeams[0],
        provider: domainOwner.provider,
      }, `Produce a new candidate version of ${domainOwner.owner}.`, 'An existing owner already covers this domain. The smallest change is a new candidate version, not a helper/v2 plugin.', discoveryFacts)
    }

    const adoptTarget = inactiveAdopt !== undefined
      ? { owner: inactiveAdopt.owner, version: inactiveAdopt.version, seam: inactiveAdopt.runtimeSeams[0] }
      : adoptableKnown !== undefined
        ? { owner: adoptableKnown.owner, version: adoptableKnown.version ?? 'unknown' }
        : undefined
    steps.push(this.step('adopt-existing', adoptTarget !== undefined, adoptTarget !== undefined
      ? `${adoptTarget.owner}@${adoptTarget.version} already describes this capability and can be adopted instead of creating a duplicate.`
      : 'No inactive candidate, DSH-native capability, or eligible plugin provides this capability.'))
    if (adoptTarget !== undefined) {
      return this.recommend(request, capability, 'adopt-existing', steps, exact, domainOwners, conflicts, adoptTarget,
        `Adopt existing ${adoptTarget.owner}@${adoptTarget.version}.`,
        'A known candidate, DSH-native capability, or eligible plugin already provides the capability.', discoveryFacts)
    }

    const providerAccepted = providerSwap !== undefined || providerOnSeam !== undefined
    const provider = providerSwap ?? providerOnSeam
    steps.push(this.step('implement-provider', providerAccepted, providerAccepted
      ? `Implement ${provider!.provider} behind existing seam ${provider!.seam}.`
      : 'No supplied or discovered provider is compatible with a known application/DSH seam.'))
    if (providerAccepted && provider) {
      return this.recommend(request, capability, 'implement-provider', steps, exact, domainOwners, conflicts, {
        owner: exactOwner?.owner ?? domainOwner?.owner,
        version: exactOwner?.version ?? domainOwner?.version,
        seam: provider.seam,
        provider: provider.provider,
      }, `Implement provider ${provider.provider} on ${provider.seam}.`, 'The application already has a public seam. Prefer a provider/adapter over a parallel capability domain or duplicate tool.', discoveryFacts)
    }

    if (isHostProductChangeNeed(capability, domainOwnerFacts)) {
      return this.finish(request, capability, 'host-product-change-required', {
        discoveryFacts,
        registryFacts: { exact, domainOwners, conflicts },
        steps,
        target: domainOwner === undefined
          ? undefined
          : { owner: domainOwner.owner, version: domainOwner.version, seam: domainOwner.runtimeSeams[0] },
        recommendation: 'Make a trusted host product change; do not generate an isolated tool or evolve this owner.',
        rationale: 'This need is host-owned composition or an irreplaceable in-process owner. An isolated generated candidate cannot satisfy it without Registry/runtime divergence.',
        implications: [
          ...this.discoveryImplications(discoveryFacts),
          'This is a proposal only. It does not approve, install, or mount anything.',
          'Ship the change as reviewed product code, or through a later host-owned frontend-extension seam.',
        ],
        assumptions: [],
        unresolved: [],
      })
    }

    const discoveryStatus = discovered?.status
    const discoveryComplete = discoveryStatus === 'ok'
    const newPluginAccepted = request.inventory?.complete === true || discoveryComplete
    const newPluginReason = newPluginAccepted
      ? 'Registry, DSH-native seams, and the trusted catalog have no owner, seam, or adoptable provider/plugin.'
      : discoveryStatus === 'unavailable' || discoveryStatus === 'incomplete'
        ? `Discovery is ${discoveryStatus}; unknown is not proof the capability is new.`
        : 'Inventory is incomplete; absence of a record is not proof the capability is new.'
    steps.push(this.step('new-plugin', newPluginAccepted, newPluginReason))
    if (newPluginAccepted) {
      return this.recommend(request, capability, 'new-plugin', steps, exact, domainOwners, conflicts, undefined,
        'Create a genuinely new candidate plugin.',
        'Options 1–5 do not satisfy the need against an explicit complete inventory.',
        discoveryFacts,
        [
          'A new plugin remains a candidate until later governance approval.',
          'This recommendation is not authorization to install or mount code.',
          ...this.relatedFileImplications(capability, records),
        ],
      )
    }

    return this.finish(request, capability, 'insufficient-information', {
      discoveryFacts,
      registryFacts: { exact, domainOwners, conflicts },
      steps,
      recommendation: 'Gather more ownership, seam, provider, or trusted-catalog facts before deciding.',
      rationale: 'unknown is not absent. Without a complete inventory, the resolver will not treat a missing record as a new plugin.',
      implications: this.discoveryImplications(discoveryFacts),
      assumptions: [],
      unresolved: ['Need an explicit complete architecture inventory, complete trusted-catalog discovery, or a known owner/seam/provider/plugin fact.'],
    })
  }

  private discoveryImplications(facts: DiscoveryFacts): string[] {
    if (facts.status === 'not-queried') return []
    const lines = [`Discovery status: ${facts.status}.`]
    if (facts.records.length > 0) {
      lines.push(`Checked ${facts.records.map((item) => `${item.identity} (${item.provenance}/${item.eligibility})`).join(', ')}.`)
    }
    for (const item of facts.rejected) lines.push(`Rejected ${item.identity}: ${item.reason}.`)
    lines.push('Discovery does not install, import, execute, approve, or activate plugin code.')
    return lines
  }

  private relatedFileImplications(capability: string, records: readonly RegistryRecord[]): string[] {
    if (domainOf(capability) === 'files') return []
    const fileOwner = records.find((record) => (
      record.status === 'active' && record.capabilities.some((item) => domainOf(item.id) === 'files')
    ))
    if (fileOwner === undefined) return []
    return [
      `${fileOwner.owner} already owns generic files.read / files.delete, but those capabilities are insufficient for ${capability} (vault-relative identity, frontmatter, tags, wikilinks).`,
      'The new plugin must reuse integrations.files confined-root primitives for vault IO and must not register a second generic filesystem service, a parallel files.* owner, or a raw node:fs vault path.',
    ]
  }

  private step(option: ResolutionOption, accepted: boolean, reason: string): ResolutionStep {
    return { option, verdict: accepted ? 'accepted' : 'rejected', reason }
  }

  private recommend(
    request: ResolutionRequest,
    capability: string,
    kind: ResolutionKind,
    steps: readonly ResolutionStep[],
    exact: ResolutionReview['registryFacts']['exact'],
    domainOwners: ResolutionReview['registryFacts']['domainOwners'],
    conflicts: ResolutionReview['registryFacts']['conflicts'],
    target: ResolutionTarget | undefined,
    recommendation: string,
    rationale: string,
    discoveryFacts: DiscoveryFacts,
    implications: readonly string[] = ['This is a proposal only. It does not approve, install, or mount anything.'],
  ): ResolutionReview {
    return this.finish(request, capability, kind, {
      discoveryFacts,
      registryFacts: { exact, domainOwners, conflicts },
      steps,
      target,
      recommendation,
      rationale,
      implications: [...this.discoveryImplications(discoveryFacts), ...implications],
      assumptions: [],
      unresolved: [],
    })
  }

  private finish(
    request: ResolutionRequest,
    capability: string,
    kind: ResolutionKind,
    parts: Omit<ResolutionReview, 'kind' | 'capability' | 'need'>,
  ): ResolutionReview {
    return {
      kind,
      capability,
      need: request.need,
      ...parts,
    }
  }
}
