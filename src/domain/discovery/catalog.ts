import { classifyDiscovery } from './eligibility.js'
import { normalizeDiscoveredCapability } from './normalize.js'
import { EMPTY_EFFECTS } from './types.js'
import type {
  CapabilityDiscovery,
  DiscoveredCapability,
  DiscoveryQuery,
  DiscoveryReport,
  DiscoveryReportStatus,
} from './types.js'

export interface CatalogDiscoveryOptions {
  readonly records?: readonly DiscoveredCapability[]
  readonly raw?: readonly Record<string, unknown>[]
  readonly status?: DiscoveryReportStatus
  readonly source?: string
}

/** Local catalog. Never imports, installs, or executes package code. */
export class CatalogDiscovery implements CapabilityDiscovery {
  private readonly records: readonly DiscoveredCapability[]
  private readonly status: DiscoveryReportStatus
  private readonly source: string

  constructor(options: CatalogDiscoveryOptions = {}) {
    this.status = options.status ?? 'ok'
    this.source = options.source ?? 'catalog'
    const fromRaw = (options.raw ?? [])
      .map((item) => normalizeDiscoveredCapability(item))
      .filter((item): item is DiscoveredCapability => item !== undefined)
    this.records = [...(options.records ?? []), ...fromRaw]
  }

  search(query: DiscoveryQuery): DiscoveryReport {
    if (this.status === 'unavailable') {
      return { status: 'unavailable', query, records: [], diagnostics: [`${this.source} discovery is unavailable`] }
    }
    const records = this.records.map((item) => classifyDiscovery(item, query))
    return {
      status: this.status,
      query,
      records,
      diagnostics: this.status === 'incomplete' ? [`${this.source} discovery is incomplete`] : [],
    }
  }

  inspect(identity: string): DiscoveredCapability | undefined {
    return this.records.find((item) => item.identity === identity)
  }
}

export class CompositeDiscovery implements CapabilityDiscovery {
  constructor(private readonly providers: readonly CapabilityDiscovery[]) {}

  search(query: DiscoveryQuery): DiscoveryReport {
    if (this.providers.length === 0) {
      return { status: 'unavailable', query, records: [], diagnostics: ['no discovery providers are configured'] }
    }
    const reports = this.providers.map((provider) => provider.search(query))
    const records = reports.flatMap((item) => item.records)
    const diagnostics = reports.flatMap((item) => item.diagnostics)
    const statuses = reports.map((item) => item.status)
    const status: DiscoveryReportStatus = statuses.includes('unavailable')
      ? 'unavailable'
      : statuses.includes('incomplete')
        ? 'incomplete'
        : 'ok'
    return { status, query, records, diagnostics }
  }

  inspect(identity: string): DiscoveredCapability | undefined {
    for (const provider of this.providers) {
      const found = provider.inspect(identity)
      if (found !== undefined) return found
    }
    return undefined
  }
}

export const DSH_NATIVE_CATALOG: readonly DiscoveredCapability[] = [
  {
    identity: 'dsh/schedule',
    source: 'dsh-public',
    provenance: 'dsh-core',
    version: '0.1.0-rc.8',
    capabilities: ['schedule.reminders.create', 'schedule.jobs.run'],
    seams: ['dsh.schedule'],
    tools: [],
    permissions: [],
    effects: EMPTY_EFFECTS,
    configRequired: [],
    credentialRequirements: [],
    runtimeDependencies: ['@deepseek-ai/dsh-schedule'],
    dshCompatibility: '0.1.0-rc.8',
    status: 'available',
    eligibility: 'eligible',
    unexpectedFields: [],
  },
  {
    identity: 'dsh/llm',
    source: 'dsh-public',
    provenance: 'dsh-core',
    version: '0.1.0-rc.8',
    capabilities: ['llm.provider'],
    seams: ['dsh.llm'],
    tools: [],
    permissions: [],
    effects: EMPTY_EFFECTS,
    configRequired: [],
    credentialRequirements: ['llm.api-key'],
    runtimeDependencies: ['@deepseek-ai/dsh-llm'],
    dshCompatibility: '0.1.0-rc.8',
    provider: 'dsh-llm',
    status: 'available',
    eligibility: 'eligible',
    unexpectedFields: [],
  },
  {
    identity: 'dsh/jobs',
    source: 'dsh-public',
    provenance: 'dsh-core',
    version: '0.1.0-rc.8',
    capabilities: ['jobs.run'],
    seams: ['dsh.jobs'],
    tools: [],
    permissions: [],
    effects: EMPTY_EFFECTS,
    configRequired: [],
    credentialRequirements: [],
    runtimeDependencies: ['@deepseek-ai/dsh-jobs-local'],
    dshCompatibility: '0.1.0-rc.8',
    status: 'available',
    eligibility: 'eligible',
    unexpectedFields: [],
  },
  {
    identity: 'dsh/tools',
    source: 'dsh-public',
    provenance: 'dsh-core',
    version: '0.1.0-rc.8',
    capabilities: ['tools.register'],
    seams: ['dsh.tools'],
    tools: [],
    permissions: [],
    effects: EMPTY_EFFECTS,
    configRequired: [],
    credentialRequirements: [],
    runtimeDependencies: ['@deepseek-ai/dsh-tools'],
    dshCompatibility: '0.1.0-rc.8',
    status: 'available',
    eligibility: 'eligible',
    unexpectedFields: [],
  },
]

export function createDefaultDiscovery(thirdParty: CatalogDiscoveryOptions = {}): CapabilityDiscovery {
  return new CompositeDiscovery([
    new CatalogDiscovery({ records: DSH_NATIVE_CATALOG, source: 'dsh-native', status: 'ok' }),
    new CatalogDiscovery({
      records: thirdParty.records,
      raw: thirdParty.raw,
      source: thirdParty.source ?? 'trusted-plugin-catalog',
      status: thirdParty.status ?? 'incomplete',
    }),
  ])
}
