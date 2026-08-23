import { detectOsNetworkSandbox } from '../candidate/os-sandbox.js'
import type { GeneratedIsolation, GeneratedRuntimeDiagnosis } from './types.js'

let activeProcesses = 0
let lastFailure: string | undefined

export function generatedIsolation(): GeneratedIsolation {
  if (process.env.TARS_NG_FORCE_GENERATED_RUNTIME_UNAVAILABLE === '1') return 'unavailable'
  const sandbox = detectOsNetworkSandbox()
  if (sandbox === undefined) return 'unavailable'
  return sandbox.kind
}

export function generatedRuntimeDiagnosis(): GeneratedRuntimeDiagnosis {
  const isolation = generatedIsolation()
  return {
    state: isolation === 'unavailable' ? 'unavailable' : 'available',
    isolation,
    activeProcesses,
    ...(lastFailure ? { lastFailure } : {}),
  }
}

export function recordGeneratedProcessStart(): void {
  activeProcesses += 1
}

export function recordGeneratedProcessStop(): void {
  activeProcesses = Math.max(0, activeProcesses - 1)
}

export function recordGeneratedRuntimeFailure(reason: string): void {
  lastFailure = sanitizeGeneratedDiagnostic(reason)
}

export function sanitizeGeneratedDiagnostic(reason: string): string {
  return reason
    .replaceAll(/ya29\.[A-Za-z0-9._-]+/g, '[redacted]')
    .replaceAll(/sk-[A-Za-z0-9._-]+/g, '[redacted]')
    .replaceAll(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replaceAll(/DEEPSEEK_API_KEY=\S+/g, 'DEEPSEEK_API_KEY=[redacted]')
    .replaceAll(/DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN=\S+/g, 'DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN=[redacted]')
    .slice(0, 500)
}

export function resetGeneratedRuntimeSupervisor(): void {
  activeProcesses = 0
  lastFailure = undefined
}
