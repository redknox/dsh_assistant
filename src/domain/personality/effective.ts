import { DEFAULT_PERSONALITY_TRAITS, TRAIT_CEILINGS, TRAIT_FLOORS, clampTrait } from './defaults.js'
import type { PersonalitySituation, PersonalityTraits, SituationKind, SystemState, UserPersonalityPrefs } from './types.js'

const HUMOR_SUPPRESSION_STATES: ReadonlySet<SystemState> = new Set(['SAFE_MODE', 'RECOVERY', 'BLOCKED'])
const HUMOR_SUPPRESSION_KINDS: ReadonlySet<SituationKind> = new Set(['irreversible', 'safety', 'failure'])

export function humorSuppressed(situation: PersonalitySituation): boolean {
  return HUMOR_SUPPRESSION_STATES.has(situation.systemState) || HUMOR_SUPPRESSION_KINDS.has(situation.kind)
}

export function applyUserPrefs(base: PersonalityTraits, prefs: UserPersonalityPrefs): PersonalityTraits {
  return {
    ...base,
    humor: prefs.humor === undefined ? base.humor : clampTrait(prefs.humor),
    directness: prefs.directness === undefined ? base.directness : clampTrait(prefs.directness),
    initiative: prefs.initiative === undefined ? base.initiative : clampTrait(prefs.initiative),
    verbosity: prefs.verbosity ?? base.verbosity,
    competence: Math.max(TRAIT_FLOORS.competence, base.competence),
    skepticism: Math.max(TRAIT_FLOORS.skepticism, base.skepticism),
    flattery: Math.min(TRAIT_CEILINGS.flattery, base.flattery),
    drama: TRAIT_CEILINGS.drama,
  }
}

export function effectiveTraits(prefs: UserPersonalityPrefs, situation: PersonalitySituation): PersonalityTraits {
  const applied = applyUserPrefs(DEFAULT_PERSONALITY_TRAITS, prefs)
  if (!humorSuppressed(situation)) return applied
  return {
    ...applied,
    humor: Math.min(applied.humor, 10),
    drama: 0,
    warmth: Math.min(applied.warmth, 40),
    verbosity: applied.verbosity === 'detailed' ? 'adaptive' : applied.verbosity,
  }
}
