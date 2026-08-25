/** Human-maintained managed code may stay in-process. Assistant-origin and imported third-party code may not. */
export function requiresIsolatedGeneratedRuntime(input: {
  readonly owner: string
  readonly provenanceKind?: string
  readonly origin?: string
}): boolean {
  if (input.owner.startsWith('generated/') || input.owner.startsWith('third-party/')) return true
  if (input.provenanceKind === 'generated' || input.provenanceKind === 'third-party') return true
  if (input.origin === 'assistant' || input.origin === 'import') return true
  return false
}

export function isImportedThirdParty(input: {
  readonly owner?: string
  readonly provenanceKind?: string
  readonly origin?: string
}): boolean {
  return input.owner?.startsWith('third-party/') === true
    || input.provenanceKind === 'third-party'
    || input.origin === 'import'
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
