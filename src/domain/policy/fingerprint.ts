import { createHash } from 'node:crypto'

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

/** Stable digest of the concrete action. Confirmation binds to this, not a vague permission. */
export function actionFingerprint(capability: string, operation: string, payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({ capability, operation, payload })))
    .digest('hex')
}
