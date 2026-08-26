export interface SkillResolutionHandoff {
  readonly missingTools: readonly string[]
  readonly nextAction: 'capability-resolution'
}

const TOOL_MENTION = /`([a-z][a-z0-9_]{2,64})`/g

export function mentionedTools(body: string): readonly string[] {
  const found = new Set<string>()
  for (const match of body.matchAll(TOOL_MENTION)) {
    if (match[1] !== undefined) found.add(match[1])
  }
  return [...found].sort()
}

export function skillResolutionHandoff(
  body: string,
  knownTools: readonly string[],
): SkillResolutionHandoff | undefined {
  const known = new Set(knownTools)
  const missing = mentionedTools(body).filter((name) => !known.has(name))
  if (missing.length === 0) return undefined
  return { missingTools: missing, nextAction: 'capability-resolution' }
}
