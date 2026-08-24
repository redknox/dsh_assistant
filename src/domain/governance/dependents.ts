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
    readonly pluginDependencies?: readonly { readonly capability?: string; readonly strength?: string }[]
  }[]
}): PluginDependencyResult {
  try {
    if (input.owner === '' || input.version === '') {
      return { severity: 'unresolved', dependents: [] }
    }
    const provided = new Set(input.capabilities)
    const dependents: PluginDependent[] = []
    for (const record of input.registry) {
      if (record.owner === input.owner && record.version === input.version) continue
      if (record.owner === '' || record.version === '') {
        return { severity: 'unresolved', dependents: [] }
      }
      const declared = record.pluginDependencies
      if (declared === undefined) continue
      for (const item of declared) {
        if (item.capability === undefined || item.capability === '') {
          return { severity: 'unresolved', dependents: [] }
        }
        if (item.strength !== 'hard' && item.strength !== 'optional') {
          return { severity: 'unresolved', dependents: [] }
        }
        if (!provided.has(item.capability)) continue
        dependents.push({
          owner: record.owner,
          version: record.version,
          requiredCapability: item.capability,
          kind: record.status === 'active' ? item.strength : 'historical',
        })
      }
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
