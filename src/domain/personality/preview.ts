import { compileExpression, DEFAULT_SITUATION } from './compile.js'
import { effectiveTraits } from './effective.js'
import type { PersonalityPreview, PersonalitySituation, UserPersonalityPrefs } from './types.js'

export function previewPersonalityChange(
  current: UserPersonalityPrefs,
  next: UserPersonalityPrefs,
  situation: PersonalitySituation = DEFAULT_SITUATION,
): PersonalityPreview {
  const merged = { ...current, ...next }
  const beforeTraits = effectiveTraits(current, situation)
  const afterTraits = effectiveTraits(merged, situation)
  const changed = (['humor', 'directness', 'initiative', 'verbosity'] as const)
    .filter((key) => next[key] !== undefined && next[key] !== current[key])
  return {
    before: compileExpression(beforeTraits, situation),
    after: compileExpression(afterTraits, situation),
    changed,
  }
}
