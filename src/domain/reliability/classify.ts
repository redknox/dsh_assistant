import type { CandidateManifest } from '../candidate/types.js'
import type { RiskClass } from './types.js'
import { RISK_CLASSES } from './types.js'

const MUTATING = /\.(create|write|delete|set|update|execute|append|remove)$/
const CONTROL = /^(governance|recovery|approval)\./

export function riskRank(value: RiskClass): number {
  return RISK_CLASSES.indexOf(value)
}

export function isMutatingCapability(id: string): boolean {
  return MUTATING.test(id)
}

export function deriveRiskClass(manifest: Pick<CandidateManifest, 'owner' | 'capabilities' | 'permissions' | 'secrets' | 'effects'>): RiskClass {
  const control = manifest.capabilities.some((item) => CONTROL.test(item))
    || manifest.permissions.some((item) => item.includes('recovery.') || item.includes('approval.authority') || item === 'recovery-root')
    || manifest.owner.includes('recovery')
  if (control) return 'R4'
  const mutating = manifest.capabilities.some(isMutatingCapability)
  const credentialed = manifest.secrets.length > 0 || manifest.effects.secrets.length > 0
  const networked = manifest.effects.network.length > 0
  const processed = manifest.effects.process.length > 0
  if (processed || (mutating && (credentialed || networked))) return 'R3'
  if (manifest.effects.filesystem.length > 0 || mutating) return 'R2'
  if (networked || credentialed) return 'R1'
  return 'R0'
}
