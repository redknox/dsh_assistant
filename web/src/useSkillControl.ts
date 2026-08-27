import { useRef, useState } from 'react'
import type { SkillProjection } from '../../src/domain/workspace/types'
import { runSkillAction } from './api'
import {
  completeSkillInteraction,
  EMPTY_SKILL_INTERACTION,
  requestSkillInteraction,
  requireSkillDependents,
  type SkillInteractionAction,
  type SkillInteractionState,
} from './skillInteraction'
import type { MissionControlRuntime } from './useMissionControlRuntime'

export interface SkillControl {
  readonly state: SkillInteractionState
  readonly dispatch: (action: SkillInteractionAction, skill?: SkillProjection) => void
}

export function useSkillControl(
  runtime: Pick<MissionControlRuntime, 'view' | 'perform'>,
): SkillControl {
  const [state, setState] = useState(EMPTY_SKILL_INTERACTION)
  const stateRef = useRef<SkillInteractionState>(EMPTY_SKILL_INTERACTION)

  const commit = (next: SkillInteractionState) => {
    stateRef.current = next
    setState(next)
  }

  return {
    state,
    dispatch: (action, skill) => {
      const requested = requestSkillInteraction(stateRef.current, action, skill)
      commit(requested.state)
      const command = requested.command
      if (!command) return

      if (command.action === 'uninstall' || command.action === 'disable') {
        if (!command.skill) return
        const destructiveAction = command.action
        const target = command.skill
        void runtime.perform(async () => {
          try {
            const next = await runSkillAction({
              action: destructiveAction,
              skill: target,
              confirm: true,
              acknowledgeDependents: command.acknowledgeDependents,
              dependents: command.dependents,
            })
            commit(completeSkillInteraction(stateRef.current))
            return next
          } catch (caught) {
            const error = caught as Error & { code?: string; dependents?: readonly string[] }
            if (error.code === 'dependents-required' && error.dependents) {
              commit(requireSkillDependents(
                stateRef.current,
                destructiveAction,
                target,
                error.dependents,
              ))
            }
            throw caught
          }
        })
        return
      }

      void runtime.perform(() => runSkillAction({
        action: command.action,
        skill: command.skill,
        confirm: true,
        rollback: runtime.view?.skillRollback,
      }))
    },
  }
}
