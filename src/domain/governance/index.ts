export type {
  ActivationFailure,
  ActivationPhase,
  ActivationSnapshot,
  ActivationState,
  ActivationStatus,
  RollbackPlan,
  ApprovalAuthority,
  ApprovalDecision,
  ApprovalFingerprintInput,
  ApprovalRecord,
  ApprovalSummary,
  InspectSummary,
  EligibilityDenial,
  EligibilityResult,
  ExtensionActivation,
  ExtensionGovernance,
  ExtensionRecovery,
  TrustedApprovalInput,
} from './types.js'
export {
  ACTIVATION_PHASES,
  ACTIVATION_STATES,
  APPROVAL_DECISIONS,
  TrustedAuthorityCredential,
} from './types.js'
export {
  ActivationDeniedError,
  GovernanceAuthorityError,
  GovernanceContractError,
  RollbackDeniedError,
  UninstallDeniedError,
} from './errors.js'
export { analyzePluginDependents, type PluginDependencyResult, type PluginDependent } from './dependents.js'
export { approvalFingerprint, approvalSummary, fingerprintFromCandidate } from './fingerprint.js'
export { InMemoryActivationRuntime, type ActivationPrepareContext, type ActivationRuntime } from './runtime.js'
export { GovernanceService, SimulatedCrashError, type ActivationInterrupt, type GovernanceHydrate } from './service.js'
export { RecoveryRoot } from './root.js'
