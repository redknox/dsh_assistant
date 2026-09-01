import { useRef, useState } from 'react'
import type { ActivationCard, ApprovalCard, RollbackCard } from '../../src/domain/workspace/types'
import {
  abandonCandidateActivation,
  activateGovernedCapability,
  decideApproval,
  rollbackSystemState,
  runRecovery,
} from './api'
import {
  deferActivation,
  deferSystemRollback,
  EMPTY_GOVERNANCE_INTERACTION,
  requestAbandonment,
  requestActivation,
  requestRecovery,
  requestSystemRollback,
  type GovernanceInteractionState,
  type RecoveryInteractionAction,
} from './governanceInteraction'
import type { MissionControlRuntime } from './useMissionControlRuntime'

export type GovernanceEvent =
  | { readonly action: 'approve'; readonly card: ApprovalCard }
  | { readonly action: 'reject'; readonly card: ApprovalCard }
  | { readonly action: 'defer-activation'; readonly card: ActivationCard }
  | { readonly action: 'activate'; readonly card: ActivationCard }
  | { readonly action: 'abandon-activation'; readonly card: ActivationCard }
  | { readonly action: 'defer-rollback' }
  | { readonly action: 'rollback'; readonly card: RollbackCard }
  | { readonly action: 'recover'; readonly recovery: RecoveryInteractionAction }

export interface GovernanceControl {
  readonly state: GovernanceInteractionState
  readonly dispatch: (event: GovernanceEvent) => void
}

export function useGovernanceControl(
  runtime: Pick<MissionControlRuntime, 'perform'>,
): GovernanceControl {
  const [state, setState] = useState(EMPTY_GOVERNANCE_INTERACTION)
  const stateRef = useRef<GovernanceInteractionState>(EMPTY_GOVERNANCE_INTERACTION)

  const commit = (next: GovernanceInteractionState) => {
    stateRef.current = next
    setState(next)
  }

  return {
    state,
    dispatch: (event) => {
      if (event.action === 'approve' || event.action === 'reject') {
        const decision = event.action === 'approve' ? 'approve' : 'deny'
        void runtime.perform(() => decideApproval(event.card, decision))
        return
      }
      if (event.action === 'defer-activation') {
        commit(deferActivation(stateRef.current, event.card))
        return
      }
      if (event.action === 'defer-rollback') {
        commit(deferSystemRollback(stateRef.current))
        return
      }

      const requested = event.action === 'activate'
        ? requestActivation(stateRef.current, event.card)
        : event.action === 'abandon-activation'
          ? requestAbandonment(stateRef.current, event.card)
          : event.action === 'rollback'
            ? requestSystemRollback(stateRef.current, event.card)
            : requestRecovery(stateRef.current, event.recovery)
      commit(requested.state)
      const command = requested.command
      if (command?.action === 'activate') {
        void runtime.perform(() => activateGovernedCapability(command.card, true))
      } else if (command?.action === 'abandon-activation') {
        void runtime.perform(() => abandonCandidateActivation(command.card, true))
      } else if (command?.action === 'rollback-system') {
        void runtime.perform(() => rollbackSystemState(command.card, true))
      } else if (command?.action === 'recover') {
        void runtime.perform(() => runRecovery(command.recovery, true))
      }
    },
  }
}
