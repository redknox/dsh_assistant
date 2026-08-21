export type {
  ActivationFailure,
  ActivationPhase,
  ActivationSnapshot,
  ActivationState,
  ActivationStatus,
  ApprovalAuthority,
  ApprovalDecision,
  ApprovalFingerprintInput,
  ApprovalRecord,
  ApprovalSummary,
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
} from './errors.js'
export { approvalFingerprint, approvalSummary, fingerprintFromCandidate } from './fingerprint.js'
export { InMemoryActivationRuntime, type ActivationRuntime } from './runtime.js'
export { GovernanceService } from './service.js'
