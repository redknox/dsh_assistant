import type { CandidateManifest } from '../candidate/types.js'
import type { RiskClass } from './types.js'
import { RISK_CLASSES } from './types.js'

const CONTROL = /^(governance|recovery|approval)\./

export function riskRank(value: RiskClass): number {
  return RISK_CLASSES.indexOf(value)
}

export function deriveRiskClass(manifest: Pick<CandidateManifest, 'owner' | 'capabilities' | 'permissions' | 'secrets' | 'effects'>): RiskClass {
  const control = manifest.capabilities.some((item) => CONTROL.test(item))
    || manifest.permissions.some((item) => item.includes('recovery.') || item.includes('approval.authority') || item === 'recovery-root')
    || manifest.owner.includes('recovery')
  if (control) return 'R4'
  const credentialed = manifest.secrets.length > 0 || manifest.effects.secrets.length > 0
  const networked = manifest.effects.network.length > 0
  const processed = manifest.effects.process.length > 0
  const external = networked || credentialed
  const remoteMutate = manifest.effects.remoteSideEffect !== 'read-only'
  if (processed || (external && remoteMutate)) return 'R3'
  if (manifest.effects.filesystem.length > 0) return 'R2'
  if (external) return 'R1'
  return 'R0'
}
