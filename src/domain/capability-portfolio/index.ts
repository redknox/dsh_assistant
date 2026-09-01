import type { ToolCatalogView } from '../tool-catalog/index.js'
import type { WorkflowCatalogView } from '../workflow-catalog/index.js'
import type { MissionControlView, SkillProjection, UserPluginView } from '../workspace/types.js'

export type CapabilityPortfolioStatus = 'active' | 'disabled'
export type CapabilityImplementationKind = 'connector' | 'extension' | 'skill' | 'workflow' | 'tool'

export type CapabilityUnplugTarget =
  | { readonly kind: 'plugin'; readonly plugin: UserPluginView }
  | { readonly kind: 'skill'; readonly skill: SkillProjection }

export interface CapabilityPortfolioCard {
  readonly id: string
  readonly title: string
  readonly purpose: string
  readonly status: CapabilityPortfolioStatus
  readonly implementation: readonly CapabilityImplementationKind[]
  readonly owner?: string
  readonly version?: string
  readonly provenance?: string
  readonly provider?: string
  readonly capabilities: readonly string[]
  readonly tools: readonly string[]
  readonly workflows: readonly string[]
  readonly dependency: {
    readonly severity: 'none' | 'optional' | 'hard' | 'unresolved'
    readonly dependents: readonly string[]
  }
  readonly unplug?: CapabilityUnplugTarget
}

export interface CapabilityPortfolio {
  readonly cards: readonly CapabilityPortfolioCard[]
  readonly summary: {
    readonly total: number
    readonly active: number
    readonly attention: number
    readonly unplugReady: number
  }
}

/**
 * Joins authoritative runtime projections into user-facing capabilities.
 * It deliberately stores nothing: registries and catalogs remain the sources of truth.
 */
export function projectCapabilityPortfolio(input: {
  readonly view: Pick<MissionControlView, 'extensions' | 'plugins' | 'skills'>
  readonly tools?: ToolCatalogView
  readonly workflows?: WorkflowCatalogView
}): CapabilityPortfolio {
  const cards: CapabilityPortfolioCard[] = []
  const representedOwners = new Set<string>()
  for (const plugin of input.view.plugins ?? []) {
    if (!userAddedOwner(plugin)) continue
    if (representedOwners.has(ownerKey(plugin.owner, plugin.version))) continue
    representedOwners.add(ownerKey(plugin.owner, plugin.version))
    const workflows = workflowsFor(input.workflows, plugin.owner)
    cards.push({
      id: `extension:${ownerKey(plugin.owner, plugin.version)}`,
      title: friendlyOwner(plugin.owner),
      purpose: capabilityPurpose(plugin.capabilities, plugin.tools, workflows),
      status: 'active',
      implementation: unique<CapabilityImplementationKind>([
        'extension',
        ...(plugin.tools.length ? ['tool' as const] : implementationKinds(input.tools, plugin.owner, plugin.capabilities)),
        ...(workflows.length > 0 ? ['workflow' as const] : []),
      ]),
      owner: plugin.owner,
      version: plugin.version,
      provenance: plugin.provenance,
      capabilities: plugin.capabilities,
      tools: plugin.tools,
      workflows,
      dependency: dependencyOf(plugin),
      unplug: { kind: 'plugin', plugin },
    })
  }

  for (const extension of input.view.extensions ?? []) {
    if (!userAddedExtension(extension)) continue
    if (!['ACTIVE', 'DISABLED_REACTIVATABLE', 'DISABLED_BLOCKED'].includes(extension.lifecycle)) continue
    if (representedOwners.has(ownerKey(extension.owner, extension.version))) continue
    representedOwners.add(ownerKey(extension.owner, extension.version))
    const workflows = workflowsFor(input.workflows, extension.owner)
    cards.push({
      id: `extension:${ownerKey(extension.owner, extension.version)}`,
      title: friendlyOwner(extension.owner),
      purpose: capabilityPurpose(extension.capabilities, extension.tools, workflows),
      status: extension.lifecycle === 'ACTIVE' ? 'active' : 'disabled',
      implementation: unique<CapabilityImplementationKind>([
        'extension',
        ...(extension.tools.length ? ['tool' as const] : implementationKinds(input.tools, extension.owner, extension.capabilities)),
        ...(workflows.length > 0 ? ['workflow' as const] : []),
      ]),
      owner: extension.owner,
      version: extension.version,
      provenance: extension.provenance,
      capabilities: extension.capabilities,
      tools: extension.tools,
      workflows,
      dependency: { severity: 'none', dependents: [] },
    })
  }

  for (const skill of input.view.skills ?? []) {
    if (skill.system || !['active', 'disabled'].includes(skill.lifecycle)) continue
    cards.push({
      id: `skill:${skill.id}`,
      title: skill.name,
      purpose: skill.description || skill.whenToUse || 'Reusable Agent instructions.',
      status: skill.lifecycle === 'active' ? 'active' : 'disabled',
      implementation: ['skill'],
      owner: `skill/${skill.name}`,
      version: skill.version,
      provenance: skill.provenance,
      capabilities: [],
      tools: [],
      workflows: [],
      dependency: {
        severity: skill.dependents.length > 0 ? 'hard' : 'none',
        dependents: skill.dependents,
      },
      ...(skill.lifecycle === 'active' ? { unplug: { kind: 'skill' as const, skill } } : {}),
    })
  }

  cards.sort((left, right) => statusRank(left.status) - statusRank(right.status) || left.title.localeCompare(right.title))
  return {
    cards,
    summary: {
      total: cards.length,
      active: cards.filter((item) => item.status === 'active').length,
      attention: cards.filter((item) => item.status !== 'active').length,
      unplugReady: cards.filter((item) => item.unplug && item.dependency.severity !== 'unresolved').length,
    },
  }
}

function dependencyOf(plugin: UserPluginView): CapabilityPortfolioCard['dependency'] {
  return {
    severity: plugin.dependency.severity,
    dependents: plugin.dependency.dependents
      .filter((item) => item.kind !== 'historical')
      .map((item) => `${item.owner}@${item.version} · ${item.requiredCapability}`),
  }
}

function toolsFor(catalog: ToolCatalogView | undefined, owner: string | undefined, capabilities: readonly string[]): readonly string[] {
  if (!catalog) return []
  const claims = new Set(capabilities)
  return catalog.tools
    .filter((tool) => (owner !== undefined && tool.owner === owner) || tool.capabilities.some((item) => claims.has(item)))
    .map((tool) => tool.name)
}

function implementationKinds(catalog: ToolCatalogView | undefined, owner: string | undefined, capabilities: readonly string[]): readonly CapabilityImplementationKind[] {
  return toolsFor(catalog, owner, capabilities).length > 0 ? ['tool'] : []
}

function workflowsFor(catalog: WorkflowCatalogView | undefined, owner: string | undefined): readonly string[] {
  if (!catalog || owner === undefined) return []
  return catalog.workflows.filter((item) => item.owner === owner).map((item) => item.name)
}

function userAddedOwner(plugin: UserPluginView): boolean {
  return plugin.owner.startsWith('generated/') || plugin.provenance === 'third-party'
}

function userAddedExtension(extension: MissionControlView['extensions'][number]): boolean {
  return extension.owner.startsWith('generated/') || extension.provenance === 'third-party'
}

function capabilityPurpose(capabilities: readonly string[], tools: readonly string[] = [], workflows: readonly string[] = []): string {
  if (capabilities.length > 0) return capabilities.join(' · ')
  if (workflows.length > 0) return workflows.join(' · ')
  if (tools.length > 0) return tools.join(' · ')
  return 'Governed user-added capability.'
}

function friendlyOwner(owner: string): string {
  const name = owner.split('/').at(-1) ?? owner
  return name.split('-').map((part) => part ? `${part[0]?.toUpperCase()}${part.slice(1)}` : '').join(' ')
}

function ownerKey(owner: string, version: string): string {
  return `${owner}@${version}`
}

function unique<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)]
}

function statusRank(status: CapabilityPortfolioStatus): number {
  if (status === 'active') return 0
  return 1
}
