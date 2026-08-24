export type PluginDependentKind = 'hard' | 'optional' | 'historical'

export interface PluginDependent {
  readonly owner: string
  readonly version: string
  readonly requiredCapability: string
  readonly kind: PluginDependentKind
}

export interface PluginDependencyResult {
  readonly severity: 'none' | 'optional' | 'hard' | 'unresolved'
  readonly dependents: readonly PluginDependent[]
}

export function analyzePluginDependents(input: {
  readonly owner: string
  readonly version: string
  readonly capabilities: readonly string[]
  readonly registry: readonly {
    readonly owner: string
    readonly version: string
    readonly status: string
    readonly runtimeSeams?: readonly string[]
    readonly providers?: readonly string[]
  }[]
}): PluginDependencyResult {
  try {
    const provided = new Set(input.capabilities)
    if (input.owner === '' || input.version === '') {
      return { severity: 'unresolved', dependents: [] }
    }
    const dependents: PluginDependent[] = []
    for (const record of input.registry) {
      if (record.owner === input.owner && record.version === input.version) continue
      if (record.owner === '' || record.version === '') {
        return { severity: 'unresolved', dependents: [] }
      }
      const seams = record.runtimeSeams ?? []
      const providers = record.providers ?? []
      const hardCap = seams.find((item) => provided.has(item))
      const optionalCap = hardCap === undefined ? providers.find((item) => provided.has(item)) : undefined
      const required = hardCap ?? optionalCap
      if (required === undefined) continue
      const kind: PluginDependentKind = record.status === 'active'
        ? (hardCap !== undefined ? 'hard' : 'optional')
        : 'historical'
      dependents.push({
        owner: record.owner,
        version: record.version,
        requiredCapability: required,
        kind,
      })
    }
    const activeHard = dependents.some((item) => item.kind === 'hard')
    const activeOptional = dependents.some((item) => item.kind === 'optional')
    return {
      severity: activeHard ? 'hard' : activeOptional ? 'optional' : 'none',
      dependents,
    }
  } catch {
    return { severity: 'unresolved', dependents: [] }
  }
}
