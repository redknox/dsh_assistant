import { compilePersonality, DEFAULT_SITUATION } from './compile.js'
import { EMPTY_PREFS } from './defaults.js'
import { applyUserPrefs, effectiveTraits } from './effective.js'
import { DEFAULT_PERSONALITY_TRAITS } from './defaults.js'
import { previewPersonalityChange } from './preview.js'
import type {
  CompiledPersonality,
  PersonalityPreview,
  PersonalityProfile,
  PersonalitySituation,
  PersonalityTraits,
  TarsPersonality,
  UserPersonalityPrefs,
} from './types.js'

export class PersonalityService implements TarsPersonality {
  private prefs: UserPersonalityPrefs
  private situation: PersonalitySituation

  constructor(
    prefs: UserPersonalityPrefs = EMPTY_PREFS,
    situation: PersonalitySituation = DEFAULT_SITUATION,
  ) {
    this.prefs = prefs
    this.situation = situation
  }

  profile(): PersonalityProfile {
    return {
      traits: applyUserPrefs(DEFAULT_PERSONALITY_TRAITS, this.prefs),
      prefs: this.prefs,
    }
  }

  setUserPrefs(prefs: UserPersonalityPrefs): PersonalityProfile {
    this.prefs = { ...this.prefs, ...prefs }
    return this.profile()
  }

  setSituation(situation: PersonalitySituation): void {
    this.situation = situation
  }

  currentSituation(): PersonalitySituation {
    return this.situation
  }

  effective(situation: PersonalitySituation = this.situation): PersonalityTraits {
    return effectiveTraits(this.prefs, situation)
  }

  compile(situation: PersonalitySituation = this.situation): CompiledPersonality {
    return compilePersonality(this.effective(situation), situation)
  }

  preview(prefs: UserPersonalityPrefs, situation: PersonalitySituation = this.situation): PersonalityPreview {
    return previewPersonalityChange(this.prefs, prefs, situation)
  }
}
