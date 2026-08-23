import type { SystemState } from '../personality/types.js'

export const ACTIVITY_KINDS = [
  'OBSERVED',
  'PLANNED',
  'RUNNING',
  'COMPLETED',
  'WAITING',
  'APPROVAL_REQUIRED',
  'BLOCKED',
  'FAILED',
  'RECOVERED',
] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

export const OBJECTIVE_STATUSES = ['active', 'blocked', 'waiting', 'done'] as const
export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number]

export const WORK_OBJECT_KINDS = [
  'assistant-response',
  'user-message',
  'objective',
  'plan',
  'evidence',
  'tool-summary',
  'proposal',
  'approval-request',
  'artifact',
  'warning',
  'failure',
  'recovery',
] as const
export type WorkObjectKind = (typeof WORK_OBJECT_KINDS)[number]

export const USER_CAPABILITY_AREAS = ['Calendar', 'Tasks', 'Files', 'Memory', 'Knowledge', 'Mail'] as const
export type UserCapabilityArea = (typeof USER_CAPABILITY_AREAS)[number]

export const USER_CAPABILITY_STATUSES = ['active', 'approval-required', 'unavailable', 'safe-mode-disabled'] as const
export type UserCapabilityStatus = (typeof USER_CAPABILITY_STATUSES)[number]

export interface ObjectiveView {
  readonly text: string
  readonly status: ObjectiveStatus
}

export interface ActivityItem {
  readonly id: string
  readonly kind: ActivityKind
  readonly summary: string
  readonly source: string
}

export interface ApprovalCard {
  readonly id: string
  readonly kind: 'calendar-create' | 'self-extension' | 'other-side-effect'
  readonly title: string
  readonly target: string
  readonly sideEffect: string
  readonly authorityChange: string
  readonly details: readonly string[]
  readonly fingerprint: string
  readonly status: string
  readonly candidateId?: string
  readonly digest?: string
}

export interface UserCapabilityView {
  readonly area: string
  readonly action: string
  readonly status: UserCapabilityStatus
  readonly advanced?: {
    readonly owner?: string
    readonly version?: string
    readonly provenance?: string
    readonly provider?: string
  }
}

export interface RecoveryView {
  readonly why: string
  readonly disabled: readonly string[]
  readonly actions: readonly string[]
}

export interface ControlStrip {
  readonly pendingApprovals: number
  readonly backgroundJobs: number
  readonly objective?: string
  readonly degradation?: string
  readonly mode: SystemState
}

export interface WorkspaceMemoryItem {
  readonly id: string
  readonly statement: string
  readonly topicKey: string
  readonly status: string
  readonly origin: string
}

export interface WorkspaceKnowledgeItem {
  readonly sourceUri: string
  readonly title?: string
  readonly excerpt?: string
}

export interface MissionControlView {
  readonly identity: 'TARS-NG'
  readonly systemState: SystemState
  readonly objective?: ObjectiveView
  readonly conversation: readonly { readonly kind: WorkObjectKind; readonly text: string }[]
  readonly activity: readonly ActivityItem[]
  readonly approvals: readonly ApprovalCard[]
  readonly capabilities: readonly UserCapabilityView[]
  readonly memory: readonly WorkspaceMemoryItem[]
  readonly knowledge: readonly WorkspaceKnowledgeItem[]
  readonly recovery?: RecoveryView
  readonly controlStrip: ControlStrip
  readonly personality: {
    readonly humor: number
    readonly directness: number
    readonly initiative: number
    readonly verbosity: string
    readonly humorSuppressed: boolean
  }
  readonly developmentControlPlaneSeparated: true
  readonly candidates?: readonly WorkbenchProjection[]
}

export interface WorkbenchProjection {
  readonly id: string
  readonly owner: string
  readonly version: string
  readonly lifecycle: string
  readonly resolutionKind?: string
  readonly sealed: boolean
  readonly validationPassed?: boolean
  readonly validationFailed?: readonly string[]
  readonly reviewState?: string
  readonly blockingFindings?: number
  readonly canRequestApproval: boolean
}

export interface WorkspaceSnapshotInput {
  readonly agentStatus?: 'idle' | 'running'
  readonly safeMode: boolean
  readonly recoveryRequired: boolean
  readonly recoveryWhy?: string
  readonly pendingConfirmations: readonly {
    readonly id: string
    readonly capability: string
    readonly operation: string
    readonly payload: Record<string, unknown>
    readonly fingerprint: string
    readonly status: string
    readonly level: string
  }[]
  readonly jobs: readonly { readonly name: string; readonly lastRunStatus?: string }[]
  readonly toolEvents: readonly {
    readonly type: 'tool/call' | 'tool/result'
    readonly name?: string
    readonly text: string
    readonly isError?: boolean
    readonly seq: number
  }[]
  readonly conversation: readonly { readonly kind: 'user' | 'assistant' | 'tool_call' | 'tool_result'; readonly text: string }[]
  readonly integrationStatus: readonly { readonly capability: string; readonly available: boolean; readonly reason?: string }[]
  readonly registry: readonly {
    readonly owner: string
    readonly version: string
    readonly provenance: string
    readonly status: string
    readonly capabilities: readonly string[]
    readonly permissions?: readonly string[]
    readonly provider?: string
    readonly providers?: readonly string[]
  }[]
  readonly extensionApprovals?: readonly {
    readonly id: string
    readonly candidateId: string
    readonly fingerprint: string
    readonly decision: string
    readonly owner: string
    readonly candidateVersion: string
    readonly digest: string
    readonly capabilitiesAdded: readonly string[]
    readonly capabilitiesRemoved: readonly string[]
    readonly permissionsAdded: readonly string[]
    readonly permissionsRemoved: readonly string[]
    readonly effects: readonly string[]
  }[]
  readonly candidates?: readonly WorkbenchProjection[]
  readonly memory: readonly WorkspaceMemoryItem[]
  readonly knowledge: readonly WorkspaceKnowledgeItem[]
  readonly objective?: ObjectiveView
  readonly personality: MissionControlView['personality']
  readonly blockedReason?: string
}
