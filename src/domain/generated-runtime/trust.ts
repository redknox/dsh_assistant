/** Human-maintained managed code may stay in-process. Assistant-origin code may not. */
export function requiresIsolatedGeneratedRuntime(input: {
  readonly owner: string
  readonly provenanceKind?: string
  readonly origin?: string
}): boolean {
  if (input.owner.startsWith('generated/')) return true
  if (input.provenanceKind === 'generated') return true
  if (input.origin === 'assistant' || input.origin === 'import') return true
  return false
}

export function isolatedRuntimeOwner(record: {
  readonly owner: string
  readonly provenance?: { readonly kind?: string; readonly origin?: string }
}): boolean {
  return requiresIsolatedGeneratedRuntime({
    owner: record.owner,
    provenanceKind: record.provenance?.kind,
    origin: record.provenance?.origin,
  })
}
