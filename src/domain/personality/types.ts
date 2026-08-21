export const PERSONALITY_INVARIANTS = [
  'truth-over-agreement',
  'uncertainty-explicit',
  'challenge-without-obstruction',
  'self-correction',
  'human-authority-root',
] as const
export type PersonalityInvariant = (typeof PERSONALITY_INVARIANTS)[number]

export const USER_ADJUSTABLE_TRAITS = ['humor', 'directness', 'initiative', 'verbosity'] as const
export type UserAdjustableTrait = (typeof USER_ADJUSTABLE_TRAITS)[number]

export const VERBOSITY_LEVELS = ['concise', 'adaptive', 'detailed'] as const
export type Verbosity = (typeof VERBOSITY_LEVELS)[number]

export const SITUATION_KINDS = [
  'normal',
  'design-review',
  'task',
  'failure',
  'user-mistake',
  'self-mistake',
  'irreversible',
  'safety',
  'casual',
] as const
export type SituationKind = (typeof SITUATION_KINDS)[number]

export const SYSTEM_STATES = [
  'READY',
  'WORKING',
  'WAITING',
  'NEEDS_APPROVAL',
  'BLOCKED',
  'DEGRADED',
  'SAFE_MODE',
  'RECOVERY',
] as const
export type SystemState = (typeof SYSTEM_STATES)[number]

export const UNCERTAINTY_LABELS = ['Known', 'Likely', 'Inference', 'Assumption', 'Unknown'] as const
export type UncertaintyLabel = (typeof UNCERTAINTY_LABELS)[number]

export interface PersonalityTraits {
  readonly competence: number
  readonly directness: number
  readonly initiative: number
  readonly skepticism: number
  readonly humor: number
  readonly warmth: number
  readonly formality: number
  readonly verbosity: Verbosity
  readonly flattery: number
  readonly drama: number
}

export interface UserPersonalityPrefs {
  readonly humor?: number
  readonly directness?: number
  readonly initiative?: number
  readonly verbosity?: Verbosity
}

export interface PersonalitySituation {
  readonly kind: SituationKind
  readonly systemState: SystemState
}

export interface CompiledPersonality {
  readonly core: string
  readonly policy: string
  readonly expression: string
}

export interface PersonalityPreview {
  readonly before: string
  readonly after: string
  readonly changed: readonly UserAdjustableTrait[]
}

export interface PersonalityProfile {
  readonly traits: PersonalityTraits
  readonly prefs: UserPersonalityPrefs
}

export interface TarsPersonality {
  profile(): PersonalityProfile
  setUserPrefs(prefs: UserPersonalityPrefs): PersonalityProfile
  setSituation(situation: PersonalitySituation): void
  currentSituation(): PersonalitySituation
  effective(situation?: PersonalitySituation): PersonalityTraits
  compile(situation?: PersonalitySituation): CompiledPersonality
  preview(prefs: UserPersonalityPrefs, situation?: PersonalitySituation): PersonalityPreview
}
