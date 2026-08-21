const SECRET_VALUE = /bearer\s+[a-z0-9._~+/=-]+|ya29\.[0-9a-z._-]+|access_token=|refresh_token=|client_secret=|authorization:\s*\S+/i

export interface OperationalEffectFields {
  readonly filesystem: readonly string[]
  readonly network: readonly string[]
  readonly process: readonly string[]
  readonly secrets: readonly string[]
  readonly externalSystems: readonly string[]
}

/** Metadata-only secret refs. Credential values are redacted, never shown. */
export function secretAccessLabel(ref: string): string {
  const trimmed = ref.trim()
  if (trimmed === '' || SECRET_VALUE.test(trimmed)) return 'secret-access (redacted)'
  return `secret-access ${trimmed}`
}

export function flattenEffects(
  effects: OperationalEffectFields,
  declaredSecrets: readonly string[] = [],
): readonly string[] {
  const seen = new Set<string>()
  const secrets: string[] = []
  for (const ref of [...effects.secrets, ...declaredSecrets]) {
    const label = secretAccessLabel(ref)
    if (seen.has(label)) continue
    seen.add(label)
    secrets.push(label)
  }
  return [
    ...effects.externalSystems,
    ...effects.filesystem,
    ...effects.network,
    ...effects.process,
    ...secrets,
  ]
}
