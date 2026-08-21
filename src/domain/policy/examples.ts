import type { PolicyConfig } from './types.js'

/**
 * Example personal-assistant policy. Capability defaults, not one user's prefs.
 * Calendar/mail execute need confirmation (L2). Tasks may auto-execute (L3).
 * Files execute always needs confirmation and never auto-runs (L4).
 */
export const EXAMPLE_PERSONAL_POLICY: PolicyConfig = {
  rules: [
    { capability: 'calendar', intent: 'read', level: 'L0' },
    { capability: 'calendar', intent: 'propose', level: 'L1' },
    { capability: 'calendar', intent: 'execute', level: 'L2' },
    { capability: 'tasks', intent: 'read', level: 'L0' },
    { capability: 'tasks', intent: 'propose', level: 'L1' },
    { capability: 'tasks', intent: 'execute', level: 'L3' },
    { capability: 'files', intent: 'read', level: 'L0' },
    { capability: 'files', intent: 'execute', level: 'L4' },
    { capability: 'mail', intent: 'read', level: 'L0' },
    { capability: 'mail', intent: 'propose', level: 'L1' },
    { capability: 'mail', intent: 'execute', level: 'L2' },
  ],
  autoExecute: ['tasks'],
}
