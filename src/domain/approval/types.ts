import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'

export type DshApprovalStatus = 'pending' | ApprovalOutcome
export type DshApprovalDecision = 'approve' | 'deny' | 'cancel'

export interface DshApprovalTicket {
  readonly id: string
  readonly requestId: string
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly arguments?: unknown
  readonly sessionId: string
  readonly fingerprint: string
  readonly status: DshApprovalStatus
  readonly createdAt: string
}

export interface OpenDshApproval {
  readonly requestId: string
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly arguments?: unknown
  readonly sessionId: string
  readonly signal?: AbortSignal
}
