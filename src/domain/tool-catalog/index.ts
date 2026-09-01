import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { RegistryRecord } from '../registry/types.js'

export type ToolGovernance = 'host-managed' | 'generated-governed' | 'third-party-governed'

export interface ToolCatalogEntry {
  readonly name: string
  readonly description: string
  readonly owner: string
  readonly version: string
  readonly provenance: 'managed' | 'generated' | 'third-party'
  readonly governance: ToolGovernance
  readonly runtime: 'host' | 'isolated'
  readonly lifecycle: 'active'
  readonly capabilities: readonly string[]
  readonly permissions: readonly string[]
  readonly parameters: readonly { readonly name: string; readonly required: boolean }[]
}

export interface ToolCatalogView {
  readonly summary: {
    readonly total: number
    readonly hostManaged: number
    readonly generatedGoverned: number
    readonly thirdPartyGoverned: number
  }
  readonly tools: readonly ToolCatalogEntry[]
}

/**
 * Product projection of the exact DSH tool surface visible to one Agent.
 * Registry data may explain a visible tool, but can never make an inactive tool visible.
 */
export function projectToolCatalog(
  schemas: readonly ToolSchema[],
  registry: readonly RegistryRecord[],
): ToolCatalogView {
  const active = registry.filter((record) => record.status === 'active')
  const tools = schemas
    .slice(0, 512)
    .map((schema) => projectEntry(schema, active.find((record) => record.tools.includes(schema.name))))
    .sort((left, right) => left.name.localeCompare(right.name))
  return {
    summary: {
      total: tools.length,
      hostManaged: tools.filter((item) => item.governance === 'host-managed').length,
      generatedGoverned: tools.filter((item) => item.governance === 'generated-governed').length,
      thirdPartyGoverned: tools.filter((item) => item.governance === 'third-party-governed').length,
    },
    tools,
  }
}

function projectEntry(schema: ToolSchema, owner: RegistryRecord | undefined): ToolCatalogEntry {
  if (!owner) {
    return {
      name: bounded(schema.name, 128),
      description: bounded(schema.description, 400),
      owner: 'dsh/runtime',
      version: 'current',
      provenance: 'managed',
      governance: 'host-managed',
      runtime: 'host',
      lifecycle: 'active',
      capabilities: [],
      permissions: [],
      parameters: parametersOf(schema.parameters),
    }
  }
  const governance: ToolGovernance = owner.provenance.kind === 'generated'
    ? 'generated-governed'
    : owner.provenance.kind === 'third-party'
      ? 'third-party-governed'
      : 'host-managed'
  return {
    name: bounded(schema.name, 128),
    description: bounded(schema.description, 400),
    owner: owner.owner,
    version: owner.version,
    provenance: owner.provenance.kind,
    governance,
    runtime: governance === 'host-managed' ? 'host' : 'isolated',
    lifecycle: 'active',
    capabilities: owner.capabilities.map((item) => item.id).slice(0, 64),
    permissions: owner.permissions.slice(0, 64),
    parameters: parametersOf(schema.parameters),
  }
}

function parametersOf(schema: Record<string, unknown>): readonly { readonly name: string; readonly required: boolean }[] {
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [])
  return Object.keys(properties).sort().slice(0, 32).map((name) => ({ name, required: required.has(name) }))
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
