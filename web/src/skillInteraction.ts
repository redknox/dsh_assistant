import type { SkillProjection } from '../../src/domain/workspace/types'

export type SkillInteractionAction = 'approve' | 'reject' | 'activate' | 'disable' | 'cancel-disable' | 'reactivate' | 'uninstall' | 'rollback'
type SkillInteractionCommandAction = Exclude<SkillInteractionAction, 'cancel-disable'>

export interface SkillInteractionState {
  readonly confirmingSkill?: string
  readonly armedSkill?: string
  readonly dependents?: { readonly id: string; readonly values: readonly string[] }
}

export interface SkillInteractionCommand {
  readonly action: SkillInteractionCommandAction
  readonly skill?: SkillProjection
  readonly acknowledgeDependents?: boolean
  readonly dependents?: readonly string[]
}

export const EMPTY_SKILL_INTERACTION: SkillInteractionState = {}

export function requestSkillInteraction(
  state: SkillInteractionState,
  action: SkillInteractionAction,
  skill?: SkillProjection,
): { readonly state: SkillInteractionState; readonly command?: SkillInteractionCommand } {
  if (action === 'cancel-disable') {
    return { state: { ...state, armedSkill: undefined, dependents: undefined } }
  }
  if (action === 'uninstall') {
    if (skill === undefined) {
      return { state: { ...state, confirmingSkill: undefined, dependents: undefined } }
    }
    if (state.confirmingSkill !== skill.id) {
      return { state: { ...state, confirmingSkill: skill.id, dependents: undefined } }
    }
    return destructiveCommand(state, action, skill, { ...state })
  }

  if (action === 'disable') {
    if (skill === undefined) return { state }
    const key = `disable:${skill.id}`
    if (state.armedSkill !== key && state.dependents?.id !== skill.id) {
      return { state: { ...state, armedSkill: key, dependents: undefined } }
    }
    return destructiveCommand(state, action, skill, { ...state, armedSkill: undefined })
  }

  const key = action === 'rollback' ? 'rollback' : `${action}:${skill?.id ?? ''}`
  if (state.armedSkill !== key) return { state: { ...state, armedSkill: key } }
  return {
    state: { ...state, armedSkill: undefined },
    command: { action, ...(skill ? { skill } : {}) },
  }
}

export function requireSkillDependents(
  state: SkillInteractionState,
  action: 'disable' | 'uninstall',
  skill: SkillProjection,
  dependents: readonly string[],
): SkillInteractionState {
  return {
    ...state,
    ...(action === 'disable' ? { armedSkill: `disable:${skill.id}` } : {}),
    dependents: { id: skill.id, values: dependents },
  }
}

export function completeSkillInteraction(state: SkillInteractionState): SkillInteractionState {
  return { ...state, confirmingSkill: undefined, dependents: undefined }
}

function destructiveCommand(
  state: SkillInteractionState,
  action: 'disable' | 'uninstall',
  skill: SkillProjection,
  next: SkillInteractionState,
): { readonly state: SkillInteractionState; readonly command: SkillInteractionCommand } {
  const acknowledge = state.dependents?.id === skill.id
  return {
    state: next,
    command: {
      action,
      skill,
      acknowledgeDependents: acknowledge,
      dependents: acknowledge ? state.dependents?.values ?? [] : [],
    },
  }
}
