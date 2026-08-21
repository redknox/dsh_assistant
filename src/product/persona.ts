/**
 * Product persona. Domain-adjacent product copy, not Harness identity.
 * Compiled from the TARS-NG Personality Core; injected through `ctx.systemPrompt.section`.
 */
import { compilePersonality, DEFAULT_PERSONALITY_TRAITS, DEFAULT_SITUATION } from '../domain/personality/index.js'

export const ASSISTANT_PERSONA = compilePersonality(DEFAULT_PERSONALITY_TRAITS, DEFAULT_SITUATION).core
