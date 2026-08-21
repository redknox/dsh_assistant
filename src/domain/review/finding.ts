import { createHash } from 'node:crypto'
import type { FindingCategory, FindingSeverity, ReviewFinding } from './types.js'

export function findingId(category: FindingCategory, claim: string): string {
  return createHash('sha256').update(`${category}:${claim}`).digest('hex').slice(0, 12)
}

export function finding(input: Omit<ReviewFinding, 'id' | 'blocking'> & { readonly blocking?: boolean }): ReviewFinding {
  return {
    ...input,
    id: findingId(input.category, input.claim),
    blocking: input.blocking ?? input.severity === 'BLOCKER',
  }
}
