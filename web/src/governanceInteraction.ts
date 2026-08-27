import type { ActivationCard, RollbackCard } from '../../src/domain/workspace/types'

export type RecoveryInteractionAction = 'diagnostics' | 'rollback' | 'exit-safe-mode'

export interface GovernanceInteractionState {
  readonly armedRecovery?: RecoveryInteractionAction
  readonly armedActivation?: string
  readonly armedAbandonment?: string
  readonly deferredActivations: readonly string[]
  readonly deferredRollback: boolean
  readonly armedRollback: boolean
}

export type GovernanceInteractionCommand =
  | { readonly action: 'activate'; readonly card: ActivationCard }
  | { readonly action: 'abandon-activation'; readonly card: ActivationCard }
  | { readonly action: 'rollback-system'; readonly card: RollbackCard }
  | { readonly action: 'recover'; readonly recovery: RecoveryInteractionAction }

export const EMPTY_GOVERNANCE_INTERACTION: GovernanceInteractionState = {
  deferredActivations: [],
  deferredRollback: false,
  armedRollback: false,
}

export function deferActivation(
  state: GovernanceInteractionState,
  card: ActivationCard,
): GovernanceInteractionState {
  if (state.deferredActivations.includes(card.id)) return state
  return { ...state, deferredActivations: [...state.deferredActivations, card.id] }
}

export function requestActivation(
  state: GovernanceInteractionState,
  card: ActivationCard,
): { readonly state: GovernanceInteractionState; readonly command?: GovernanceInteractionCommand } {
  if (state.armedActivation !== card.id) {
    return { state: { ...state, armedAbandonment: undefined, armedActivation: card.id } }
  }
  return {
    state: { ...state, armedActivation: undefined },
    command: { action: 'activate', card },
  }
}

export function requestAbandonment(
  state: GovernanceInteractionState,
  card: ActivationCard,
): { readonly state: GovernanceInteractionState; readonly command?: GovernanceInteractionCommand } {
  if (state.armedAbandonment !== card.id) {
    return { state: { ...state, armedActivation: undefined, armedAbandonment: card.id } }
  }
  return {
    state: { ...state, armedAbandonment: undefined },
    command: { action: 'abandon-activation', card },
  }
}

export function deferSystemRollback(state: GovernanceInteractionState): GovernanceInteractionState {
  return { ...state, armedRollback: false, deferredRollback: true }
}

export function requestSystemRollback(
  state: GovernanceInteractionState,
  card: RollbackCard,
): { readonly state: GovernanceInteractionState; readonly command?: GovernanceInteractionCommand } {
  if (!state.armedRollback) return { state: { ...state, armedRollback: true } }
  return {
    state: { ...state, armedRollback: false },
    command: { action: 'rollback-system', card },
  }
}

export function requestRecovery(
  state: GovernanceInteractionState,
  action: RecoveryInteractionAction,
): { readonly state: GovernanceInteractionState; readonly command?: GovernanceInteractionCommand } {
  if (action !== 'diagnostics' && state.armedRecovery !== action) {
    return { state: { ...state, armedRecovery: action } }
  }
  return {
    state: { ...state, armedRecovery: undefined },
    command: { action: 'recover', recovery: action },
  }
}
