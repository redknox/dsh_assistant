import type { PersonalityTraits, UserPersonalityPrefs } from './types.js'

/** Default TARS-NG behavior controls. Not cosmetic sliders. */
export const DEFAULT_PERSONALITY_TRAITS: PersonalityTraits = {
  competence: 95,
  directness: 85,
  initiative: 80,
  skepticism: 85,
  humor: 60,
  warmth: 45,
  formality: 50,
  verbosity: 'adaptive',
  flattery: 5,
  drama: 0,
}

export const TRAIT_FLOORS: Pick<PersonalityTraits, 'competence' | 'skepticism'> = {
  competence: 80,
  skepticism: 60,
}

export const TRAIT_CEILINGS: Pick<PersonalityTraits, 'flattery' | 'drama'> = {
  flattery: 15,
  drama: 0,
}

export const EMPTY_PREFS: UserPersonalityPrefs = {}

export function clampTrait(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}
