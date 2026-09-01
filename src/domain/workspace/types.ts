import type { CandidateDiff } from '../candidate/types.js'
import type { DshApprovalTicket } from '../approval/types.js'
import type { SkillRevisionDiff } from '../skill/diff.js'
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

export const USER_CAPABILITY_AREAS = ['Calendar', 'Tasks', 'Files', 'Memory', 'Knowledge', 'Mail', 'Contacts', 'Web'] as const
export type UserCapabilityArea = (typeof USER_CAPABILITY_AREAS)[number]

export const USER_CAPABILITY_STATUSES = ['active', 'approval-required', 'not-connected', 'unavailable', 'safe-mode-disabled'] as const
export type UserCapabilityStatus = (typeof USER_CAPABILITY_STATUSES)[number]

export interface ObjectiveView {
  readonly text: string
  readonly status: ObjectiveStatus
}

export interface AgentTaskControlView {
  readonly maxAutonomousRounds: number
  readonly driver: 'active' | 'held'
  readonly goal?: {
    readonly id: string
    readonly revision: number
    readonly objective: string
    readonly phase: 'active' | 'paused' | 'blocked' | 'complete'
    readonly roundsStarted: number
    readonly maxGoalRounds: number
    readonly activation: 'armed' | 'disarmed'
    readonly blockedReason?: string
  }
  readonly todos: readonly {
    readonly content: string
    readonly status: 'pending' | 'in_progress' | 'completed'
  }[]
  readonly plan: {
    readonly active: boolean
    readonly pending?: boolean
  }
  readonly question?: {
    readonly id: string
    readonly header?: string
    readonly question: string
    readonly detail?: string
    readonly options: readonly { readonly label: string; readonly description?: string }[]
  }
}

export interface ContextEnduranceView {
  readonly status: 'ready' | 'degraded'
  readonly measuredTokens?: number
  readonly pressureTokens?: number
  readonly contextWindow?: number
  readonly occupancyPercent?: number
  readonly breakdown?: {
    readonly systemTokens: number
    readonly toolsTokens: number
    readonly messageTokens: number
  }
  readonly cumulativeUsage?: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens: number
    readonly cacheWriteTokens: number
  }
  readonly compaction: 'automatic' | 'unavailable'
  readonly checkpoint: 'active' | 'unavailable'
  readonly outputRetention?: {
    readonly maxInlineBytes: number
    readonly spill: 'ready' | 'unavailable'
  }
}

export interface MaterialInputView {
  readonly fileReferences: 'active' | 'unavailable'
  readonly imageStore: 'ready' | 'unavailable'
  readonly imageInput: 'unsupported'
}

export interface ActivityItem {
  readonly id: string
  readonly kind: ActivityKind
  readonly summary: string
  readonly source: string
  readonly sessionId?: string
}

export type ExecutionLogKind = 'agent-note' | 'tool-call' | 'tool-result' | 'command-run' | 'command-result'

export interface ExecutionLogEntry {
  readonly id: string
  readonly seq: number
  readonly time?: number
  readonly kind: ExecutionLogKind
  readonly label: string
  readonly detail: string
  readonly callId?: string
  readonly isError?: boolean
}

export interface ApprovalResolution {
  readonly type: 'approval/resolved'
  readonly confirmationId: string
  readonly decision: 'approve' | 'deny' | 'cancel'
  readonly outcome: 'completed' | 'resumed' | 'denied' | 'cancelled' | 'failed'
  readonly capability?: string
  readonly operation?: string
  readonly occurredAt?: string
}

export interface WebUiAcknowledgement {
  readonly text: string
  readonly action?: {
    readonly kind: 'open-capability'
    readonly label: string
    readonly capabilityId: string
  } | {
    readonly kind: 'archive-session'
    readonly label: string
    readonly sessionId: string
  }
}

export interface ApprovalCard {
  readonly id: string
  readonly kind: 'calendar-create' | 'self-extension' | 'skill' | 'other-side-effect' | 'dsh-tool'
  readonly title: string
  readonly target: string
  readonly sideEffect: string
  readonly authorityChange: string
  readonly details: readonly string[]
  readonly fingerprint: string
  readonly status: string
  readonly candidateId?: string
  readonly digest?: string
  readonly sessionId?: string
  readonly skill?: Pick<SkillProjection, 'id' | 'name' | 'version' | 'digest' | 'approvalFingerprint' | 'generation'>
  readonly decision?: {
    readonly request: string
    readonly reason: string
    readonly outcome: string
    readonly scope: string
    readonly risk: 'external-change' | 'capability-authority' | 'agent-instructions' | 'tool-execution' | 'local-write'
    readonly facts: readonly { readonly label: string; readonly value: string }[]
    readonly approveLabel: string
    readonly rejectLabel: string
  }
}

export interface ActivationCard {
  readonly id: string
  readonly kind: 'self-extension-activate' | 'skill-activate'
  readonly title: string
  readonly owner: string
  readonly version: string
  readonly candidateId: string
  readonly digest: string
  readonly fingerprint: string
  readonly runtimeContractVersion?: string
  readonly isolatedRuntime: boolean
  readonly capabilitiesAdded: readonly string[]
  readonly capabilitiesRemoved: readonly string[]
  readonly capabilitiesChanged: readonly string[]
  readonly permissionsAdded: readonly string[]
  readonly permissionsRemoved: readonly string[]
  readonly permissionsChanged: readonly string[]
  readonly toolsAdded: readonly string[]
  readonly toolsRemoved: readonly string[]
  readonly toolsChanged: readonly string[]
  readonly workflowsAdded: readonly string[]
  readonly workflowsRemoved: readonly string[]
  readonly workflowsChanged: readonly string[]
  readonly effects: readonly string[]
  readonly eligibilityOk: boolean
  readonly eligibilityDenials: readonly string[]
  readonly status: ExtensionLifecycleState
  readonly details: readonly string[]
  readonly sessionId?: string
  readonly skill?: Pick<SkillProjection, 'id' | 'name' | 'version' | 'digest' | 'approvalFingerprint' | 'generation'>
  readonly release?: {
    readonly request: string
    readonly stage: 'ready' | 'reactivate' | 'retry' | 'working' | 'blocked'
    readonly reason: string
    readonly outcome: string
    readonly scope: string
    readonly facts: readonly { readonly label: string; readonly value: string }[]
  }
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

export interface ExtensionRecord {
  readonly id: string
  readonly owner: string
  readonly version: string
  readonly candidateId?: string
  readonly digest?: string
  readonly provenance: string
  readonly provenanceOrigin?: string
  readonly capabilities: readonly string[]
  readonly tools: readonly string[]
  readonly lifecycle: ExtensionLifecycleState
  readonly registryStatus: string
  readonly mounted: boolean
  readonly eligibilityOk: boolean
  readonly eligibilityDenials: readonly string[]
  readonly newerAuthoritative: boolean
  readonly reviewState?: string
  readonly validationPassed?: boolean
  readonly approvalDecision?: string
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
  readonly exitReady?: boolean
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

export interface WorkBriefView {
  readonly status: string
  readonly runId?: string
  readonly generatedAt?: string
  readonly markdown?: string
}

export interface MissionControlView {
  readonly identity: 'TARS-NG'
  readonly systemState: SystemState
  readonly objective?: ObjectiveView
  readonly taskControl?: AgentTaskControlView
  readonly conversation: readonly { readonly kind: WorkObjectKind; readonly text: string }[]
  readonly activity: readonly ActivityItem[]
  readonly executionLog?: readonly ExecutionLogEntry[]
  readonly approvals: readonly ApprovalCard[]
  readonly skills?: readonly SkillProjection[]
  readonly skillCatalog?: {
    readonly state: 'ok' | 'empty' | 'degraded' | 'withheld'
    readonly failed: readonly string[]
    readonly recoveryRequired: boolean
    readonly detail?: string
  }
  readonly skillRollback?: { readonly name: string; readonly version: string; readonly digest: string; readonly generation: number }
  readonly approvalResolutions: readonly ApprovalResolution[]
  readonly activations: readonly ActivationCard[]
  readonly plugins: readonly UserPluginView[]
  readonly extensions: readonly ExtensionRecord[]
  readonly rollback?: RollbackCard
  readonly capabilities: readonly UserCapabilityView[]
  readonly memory: readonly WorkspaceMemoryItem[]
  readonly knowledge: readonly WorkspaceKnowledgeItem[]
  readonly workBrief?: WorkBriefView
  readonly contextEndurance?: ContextEnduranceView
  readonly materialInput?: MaterialInputView
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
  readonly runtimeContext?: {
    readonly profile: string
    readonly profileIdentity?: string
    readonly workspaceLabel: string
    readonly workspaceIdentity: string
    readonly sessionId: string
    readonly sessionPersistence: 'persistent' | 'unavailable' | 'recovery-required'
    readonly safeMode: boolean
    readonly profileCompositionError?: string
  }
  readonly sessions?: SessionCatalogView
}

export interface SessionTopicView {
  readonly id: string
  readonly title: string
  readonly lifecycle: 'active' | 'archived'
  readonly createdAt: string
  readonly lastActivityAt: string
  readonly preview?: string
  readonly persistence: 'persistent' | 'unavailable' | 'recovery-required'
  readonly current: boolean
  readonly management?: boolean
}

export interface SessionCatalogView {
  readonly schemaVersion: number
  readonly revision: number
  readonly currentSessionId: string
  readonly health: 'ok' | 'absent' | 'recovery-required'
  readonly activeCount: number
  readonly archivedCount: number
  readonly sessions: readonly SessionTopicView[]
}

export interface SkillProjection {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly profile: string
  readonly provenance: string
  readonly origin: string
  readonly lifecycle: string
  readonly sealed: boolean
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
  readonly description: string
  readonly whenToUse?: string
  readonly resources: readonly string[]
  readonly validationPassed: boolean
  readonly reviewComplete: boolean
  readonly approvalDecision?: string
  readonly approvalFingerprint?: string
  readonly digest: string
  readonly baseVersion?: string
  readonly dependsOn: readonly string[]
  readonly dependents: readonly string[]
  readonly lastFailure?: {
    readonly phase: string
    readonly detail: string
  }
  readonly system: boolean
  readonly generation: number
  readonly revisionDiff?: SkillRevisionDiff
  readonly resolutionHandoff?: {
    readonly missingTools: readonly string[]
    readonly nextAction: 'capability-resolution'
  }
}

export interface WorkbenchProjection {
  readonly id: string
  readonly owner: string
  readonly version: string
  readonly digest?: string
  readonly baseVersion?: string
  readonly provenance?: { readonly kind: string; readonly origin?: string }
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
  readonly dshApprovals?: readonly DshApprovalTicket[]
  readonly jobs: readonly {
    readonly name: string
    readonly lastRunStatus?: string
    readonly lastRunId?: string
    readonly lastRunSummary?: string
    readonly lastRunFinishedAt?: string
  }[]
  readonly toolEvents: readonly {
    readonly type: 'tool/call' | 'tool/result'
    readonly name?: string
    readonly text: string
    readonly isError?: boolean
    readonly seq: number
  }[]
  readonly executionLog?: readonly ExecutionLogEntry[]
  readonly conversation: readonly { readonly kind: 'user' | 'assistant' | 'tool_call' | 'tool_result'; readonly text: string }[]
  readonly integrationStatus: readonly { readonly capability: string; readonly available: boolean; readonly configured?: boolean; readonly reason?: string; readonly provider?: string }[]
  readonly autoExecuteCapabilities?: readonly string[]
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
    readonly workflowsAdded?: readonly string[]
    readonly workflowsRemoved?: readonly string[]
    readonly workflowsChanged?: readonly string[]
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
    readonly lifecycleBusy?: 'activation' | 'uninstall' | 'disable' | 'recovery'
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
  readonly contextEndurance?: ContextEnduranceView
  readonly materialInput?: MaterialInputView
  readonly objective?: ObjectiveView
  readonly taskControl?: AgentTaskControlView
  readonly personality: MissionControlView['personality']
  readonly blockedReason?: string
  readonly runtimeContext?: MissionControlView['runtimeContext']
  readonly sessions?: SessionCatalogView
  readonly approvalOrigins?: Readonly<Record<string, string>>
  readonly skills?: readonly SkillProjection[]
  readonly skillCatalog?: {
    readonly state: 'ok' | 'empty' | 'degraded' | 'withheld'
    readonly failed: readonly string[]
    readonly recoveryRequired: boolean
    readonly detail?: string
  }
  readonly skillEvents?: readonly {
    readonly id: string
    readonly kind: string
    readonly name?: string
    readonly version?: string
    readonly detail?: string
  }[]
  readonly skillRollback?: { readonly name: string; readonly version: string; readonly digest: string; readonly generation: number }
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
