export type IntegrationCapability = 'mail' | 'calendar' | 'contacts' | 'files' | 'tasks'

export type IntegrationTrust = 'read' | 'propose' | 'execute'

export type IntegrationErrorCode = 'unavailable' | 'invalid_request' | 'provider_failure' | 'cancelled'

export class IntegrationError extends Error {
  readonly code: IntegrationErrorCode
  readonly capability: IntegrationCapability

  constructor(capability: IntegrationCapability, code: IntegrationErrorCode, message: string) {
    super(message)
    this.name = 'IntegrationError'
    this.capability = capability
    this.code = code
  }
}

export interface Availability {
  readonly available: boolean
  readonly reason?: string
}

export interface PageQuery {
  readonly limit?: number
  readonly cursor?: string
  readonly signal?: AbortSignal
}

export interface Page<T> {
  readonly items: readonly T[]
  readonly nextCursor?: string
}

export interface ProposedMutation<T> {
  readonly trust: 'propose'
  readonly summary: string
  readonly draft: T
}

export const MAX_PAGE_SIZE = 20

export function throwIfAborted(capability: IntegrationCapability, signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new IntegrationError(capability, 'cancelled', `${capability} request was cancelled`)
  }
}
