export const TRUST_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'] as const
export type TrustLevel = (typeof TRUST_LEVELS)[number]

export type ActionIntent = 'read' | 'propose' | 'execute'

export type ConfirmationStatus = 'pending' | 'approved' | 'executing' | 'denied' | 'cancelled' | 'consumed' | 'failed'

export type PolicyDenyCode = 'denied' | 'cancelled' | 'replay' | 'mismatch' | 'unavailable' | 'in_flight' | 'failed'

export interface PolicyRule {
  readonly capability: string
  readonly intent: ActionIntent
  readonly level: TrustLevel
}

export interface PolicyConfig {
  readonly rules: readonly PolicyRule[]
  /** Capabilities allowed to auto-execute when the matching rule is L3. L4 never auto-executes. */
  readonly autoExecute: readonly string[]
}

export interface ActionRequest {
  readonly capability: string
  readonly operation: string
  readonly intent: ActionIntent
  readonly payload: Record<string, unknown>
  readonly confirmationId?: string
  readonly signal?: AbortSignal
}

export interface ConfirmationTicket {
  readonly id: string
  readonly fingerprint: string
  readonly capability: string
  readonly operation: string
  readonly payload: Record<string, unknown>
  readonly level: TrustLevel
  readonly status: ConfirmationStatus
  readonly createdAt: string
}

export interface AuditRecord {
  readonly id: string
  readonly at: string
  readonly verdict: 'allow' | 'deny' | 'pending_confirmation' | 'approved' | 'cancelled' | 'consumed'
  readonly level: TrustLevel
  readonly capability: string
  readonly operation: string
  readonly confirmationId?: string
  readonly fingerprint: string
  readonly reason: string
}

export type PolicyOutcome =
  | {
      readonly kind: 'allow'
      readonly level: TrustLevel
      readonly reason: string
      readonly confirmationId?: string
      readonly result?: unknown
    }
  | {
      readonly kind: 'deny'
      readonly level: TrustLevel
      readonly reason: string
      readonly code: PolicyDenyCode
      readonly confirmationId?: string
    }
  | {
      readonly kind: 'pending_confirmation'
      readonly level: TrustLevel
      readonly reason: string
      readonly confirmationId: string
      readonly fingerprint: string
    }

export type ActionExecutor = (payload: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
