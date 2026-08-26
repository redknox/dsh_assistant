import type { SkillDependency, SkillInvocationPolicy, SkillRecord } from './types.js'

export interface SkillNamedDiff {
  readonly added: readonly string[]
  readonly removed: readonly string[]
}

export interface SkillRevisionDiff {
  readonly from?: { readonly id: string; readonly version: string; readonly digest: string }
  readonly to: { readonly id: string; readonly version: string; readonly digest: string }
  readonly instructionChanged: boolean
  readonly instructionBeforeChars: number
  readonly instructionAfterChars: number
  readonly invocation: {
    readonly before: SkillInvocationPolicy
    readonly after: SkillInvocationPolicy
  }
  readonly resources: SkillNamedDiff
  readonly dependsOn: SkillNamedDiff
}

export function instructionBody(markdown: string): string {
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/)
  return (match?.[1] ?? markdown).trim()
}

export function namedDiff(before: readonly string[], after: readonly string[]): SkillNamedDiff {
  const prior = new Set(before)
  const next = new Set(after)
  return {
    added: [...next].filter((item) => !prior.has(item)).sort(),
    removed: [...prior].filter((item) => !next.has(item)).sort(),
  }
}

export function diffSkillRevisions(input: {
  readonly from?: SkillRecord
  readonly to: SkillRecord
  readonly fromBody?: string
  readonly toBody: string
}): SkillRevisionDiff {
  const before = instructionBody(input.fromBody ?? '')
  const after = instructionBody(input.toBody)
  return {
    ...(input.from ? { from: { id: input.from.id, version: input.from.version, digest: input.from.digest } } : {}),
    to: { id: input.to.id, version: input.to.version, digest: input.to.digest },
    instructionChanged: before !== after,
    instructionBeforeChars: before.length,
    instructionAfterChars: after.length,
    invocation: {
      before: input.from?.invocation ?? { modelInvocable: true, userInvocable: true },
      after: input.to.invocation,
    },
    resources: namedDiff(input.from?.resources ?? [], input.to.resources),
    dependsOn: namedDiff(
      (input.from?.dependsOn ?? []).map(dependencyKey),
      (input.to.dependsOn ?? []).map(dependencyKey),
    ),
  }
}

export function dependencyKey(item: SkillDependency): string {
  return `${item.name}@${item.version}`
}
