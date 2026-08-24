import type { CandidateDiff } from '../candidate/types.js'
import type { SystemState } from '../personality/types.js'
import type { ActivationViewState, ExtensionLifecycleState } from './lifecycle.js'

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

export interface ActivationCard {
  readonly id: string
  readonly kind: 'self-extension-activate'
  readonly title: string
  readonly owner: string
  readonly version: string
  readonly candidateId: string
  readonly digest: string
  readonly fingerprint: string
  readonly runtimeContractVersion?: string
  readonly isolatedRuntime: true
  readonly capabilitiesAdded: readonly string[]
  readonly capabilitiesRemoved: readonly string[]
  readonly capabilitiesChanged: readonly string[]
  readonly permissionsAdded: readonly string[]
  readonly permissionsRemoved: readonly string[]
  readonly permissionsChanged: readonly string[]
  readonly toolsAdded: readonly string[]
  readonly toolsRemoved: readonly string[]
  readonly toolsChanged: readonly string[]
  readonly effects: readonly string[]
  readonly eligibilityOk: boolean
  readonly eligibilityDenials: readonly string[]
  readonly status: ExtensionLifecycleState
  readonly details: readonly string[]
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

export interface UserPluginView {
  readonly id: string
  readonly owner: string
  readonly version: string
  readonly provenance: string
  readonly candidateId?: string
  readonly digest?: string
  readonly capabilities: readonly string[]
  readonly tools: readonly string[]
  readonly mounted: boolean
  readonly registryGeneration: number
  readonly dependency: {
    readonly severity: 'none' | 'optional' | 'hard' | 'unresolved'
    readonly dependents: readonly {
      readonly owner: string
      readonly version: string
      readonly requiredCapability: string
      readonly kind: 'hard' | 'optional' | 'historical'
    }[]
  }
  readonly uninstallable: true
}

export interface RecoveryView {
  readonly why: string
  readonly disabled: readonly string[]
  readonly actions: readonly string[]
}

export interface RollbackOwnerChange {
  readonly owner: string
  readonly from?: string
  readonly to?: string
  readonly change: 'activate' | 'disable' | 'upgrade' | 'downgrade'
}

export interface RollbackCard {
  readonly id: string
  readonly kind: 'system-state-rollback'
  readonly title: 'Rollback system state'
  readonly currentGeneration: number
  readonly targetGeneration: number
  readonly fingerprint: string
  readonly reason: string
  readonly ownerChanges: readonly RollbackOwnerChange[]
  readonly capabilitiesAdded: readonly string[]
  readonly capabilitiesRemoved: readonly string[]
  readonly toolsAdded: readonly string[]
  readonly toolsRemoved: readonly string[]
  readonly mountsAdded: readonly string[]
  readonly mountsRemoved: readonly string[]
  readonly recoveryRequired: boolean
  readonly actionable: true
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
  readonly activations: readonly ActivationCard[]
  readonly plugins: readonly UserPluginView[]
  readonly rollback?: RollbackCard
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
  readonly activationFailure?: {
    readonly candidateId: string
    readonly phase: string
    readonly summary: string
    readonly rollbackSucceeded: boolean
    readonly recoveryRequired: boolean
    readonly registryActive: boolean
  }
}

export interface WorkbenchProjection {
  readonly id: string
  readonly owner: string
  readonly version: string
  readonly digest?: string
  readonly baseVersion?: string
  readonly lifecycle: string
  readonly resolutionKind?: string
  readonly resolutionCapability?: string
  readonly sealed: boolean
  readonly validationPassed?: boolean
  readonly validationFailed?: readonly string[]
  readonly reviewState?: string
  readonly blockingFindings?: number
  readonly blockerClaims?: readonly string[]
  readonly diff?: CandidateDiff
  readonly effectSummary?: readonly string[]
  readonly canRequestApproval: boolean
  readonly requestDenials?: readonly string[]
  readonly currentStep?: string
  readonly validationFailureSummary?: string
  readonly parentId?: string
  readonly leftover?: boolean
  readonly approvalState?: 'not-ready' | 'ready-for-approval' | 'approval-requested' | 'approved' | 'active'
  readonly governanceApproval?: string
  readonly activationState?: ActivationViewState
  readonly extensionLifecycle?: ExtensionLifecycleState
  readonly activationFailureSummary?: string
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
    readonly tools?: readonly string[]
    readonly runtimeSeams?: readonly string[]
    readonly pluginDependencies?: readonly { readonly capability: string; readonly strength: 'hard' | 'optional' }[]
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
    readonly capabilitiesChanged?: readonly string[]
    readonly permissionsAdded: readonly string[]
    readonly permissionsRemoved: readonly string[]
    readonly permissionsChanged?: readonly string[]
    readonly effects: readonly string[]
    readonly toolsAdded?: readonly string[]
    readonly toolsRemoved?: readonly string[]
    readonly toolsChanged?: readonly string[]
    readonly runtimeContractVersion?: string
    readonly eligibilityOk?: boolean
    readonly eligibilityDenials?: readonly string[]
  }[]
  readonly activation?: {
    readonly state: string
    readonly generation?: number
    readonly mounted?: readonly string[]
    readonly pendingCandidateId?: string
    readonly lastFailureCandidateId?: string
    readonly lifecycleBusy?: 'activation' | 'uninstall' | 'recovery'
    readonly current?: ActivationSnapshotView
    readonly rollbackTarget?: ActivationSnapshotView
    readonly lastKnownGood?: ActivationSnapshotView
    readonly lastFailure?: {
      readonly candidateId: string
      readonly phase: string
      readonly diagnostics: string
      readonly rollbackSucceeded: boolean
      readonly safeModeRequired: boolean
    }
    readonly rollbackPlan?: {
      readonly id: string
      readonly currentGeneration: number
      readonly targetGeneration: number
      readonly fingerprint: string
      readonly available: boolean
      readonly denials: readonly { readonly reason: string; readonly detail: string }[]
    }
  }
  readonly candidates?: readonly WorkbenchProjection[]
  readonly memory: readonly WorkspaceMemoryItem[]
  readonly knowledge: readonly WorkspaceKnowledgeItem[]
  readonly objective?: ObjectiveView
  readonly personality: MissionControlView['personality']
  readonly blockedReason?: string
}

export interface ActivationSnapshotView {
  readonly generation: number
  readonly mounted?: readonly string[]
  readonly owners: readonly {
    readonly owner: string
    readonly version: string
    readonly status?: string
    readonly capabilities?: readonly string[]
  }[]
}
